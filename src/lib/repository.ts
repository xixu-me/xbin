/**
 * Storage and coordination helpers for D1, R2, and burn-after-reading workflow state.
 */
import { expireAtFromKey } from './config';
import type {
	BurnConsumeResult,
	BurnClaimResult,
	CipherEnvelope,
	CommentResponse,
	CommentRow,
	CreateCommentInput,
	CreatePasteInput,
	GcMessage,
	ImportedCommentEnvelope,
	PasteRow,
	PasteStatus,
	PrivateBinImportBundle,
	PrivateBinImportResult,
} from './types';
import { assertValidId, GENERIC_MISSING_MESSAGE, getEnvelopeFlags, HttpError, isLegacyCommentAdata, isPasteEnvelopeAdata } from './model';

const encoder = new TextEncoder();
const UNREADABLE_PASTE_STATUSES = new Set<PasteStatus>(['deleted', 'expired', 'burned']);

// ID and blob-key helpers keep R2 object paths predictable across worker entrypoints and tests.
function hexFromBytes(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return hexFromBytes(bytes);
}

export function generateSecretToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
	return hexFromBytes(new Uint8Array(digest));
}

export function buildPasteBlobKey(pasteId: string): string {
	return `pastes/${pasteId}/paste.json`;
}

export function buildCommentBlobKey(pasteId: string, commentId: string): string {
	return `pastes/${pasteId}/comments/${commentId}.json`;
}

export async function putEnvelope(bucket: R2Bucket, key: string, envelope: CipherEnvelope): Promise<void> {
	await bucket.put(key, JSON.stringify(envelope), {
		httpMetadata: {
			contentType: 'application/json; charset=utf-8',
		},
	});
}

export async function getEnvelope(bucket: R2Bucket, key: string): Promise<CipherEnvelope | null> {
	const object = await bucket.get(key);
	if (!object) {
		return null;
	}
	return (await object.json()) as CipherEnvelope;
}

export async function deleteObjectKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
	for (const key of keys) {
		await bucket.delete(key);
	}
}

// D1 accessors and write helpers back the worker's core paste and comment operations.
export async function getPasteRow(env: Env, pasteId: string): Promise<PasteRow | null> {
	return (await env.DB.prepare(
		`SELECT
			id, schema_version, blob_key, created_at, expire_at, status,
			burn_after_reading, discussion_open, formatter, has_attachment,
			delete_token_hash, claim_token_hash, claim_expires_at,
			comment_count, size_bytes, import_source, metadata_json
		FROM pastes
		WHERE id = ?1`,
	)
		.bind(pasteId)
		.first()) as PasteRow | null;
}

export async function getCommentRows(env: Env, pasteId: string): Promise<CommentRow[]> {
	const result = await env.DB.prepare(
		`SELECT id, paste_id, parent_id, blob_key, created_at, size_bytes
		FROM comments
		WHERE paste_id = ?1
		ORDER BY created_at ASC`,
	)
		.bind(pasteId)
		.all<CommentRow>();
	return result.results;
}

export async function createPaste(env: Env, input: CreatePasteInput, now: number): Promise<{ id: string; deleteToken: string }> {
	const pasteId = generateId();
	const deleteToken = generateSecretToken();
	const deleteTokenHash = await sha256Hex(deleteToken);
	const blobKey = buildPasteBlobKey(pasteId);
	const { formatter, discussionOpen, burnAfterReading } = getEnvelopeFlags(input.envelope);

	await putEnvelope(env.PASTES_BUCKET, blobKey, input.envelope);
	await env.DB.prepare(
		`INSERT INTO pastes (
			id, schema_version, blob_key, created_at, expire_at, status,
			burn_after_reading, discussion_open, formatter, has_attachment,
			delete_token_hash, comment_count, size_bytes, metadata_json
		) VALUES (?1, 2, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)`,
	)
		.bind(
			pasteId,
			blobKey,
			now,
			expireAtFromKey(input.expireKey, now),
			burnAfterReading ? 1 : 0,
			discussionOpen ? 1 : 0,
			formatter,
			input.envelope.attachment ? 1 : 0,
			deleteTokenHash,
			input.envelope.ct.length,
			JSON.stringify(input.envelope.meta ?? {}),
		)
		.run();

	return { id: pasteId, deleteToken };
}

export async function createComment(env: Env, pasteId: string, input: CreateCommentInput, now: number): Promise<string> {
	const commentId = generateId();
	const blobKey = buildCommentBlobKey(pasteId, commentId);

	await putEnvelope(env.PASTES_BUCKET, blobKey, input.envelope);

	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO comments (id, paste_id, parent_id, blob_key, created_at, size_bytes)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		).bind(commentId, pasteId, input.parentId, blobKey, now, input.envelope.ct.length),
		env.DB.prepare(`UPDATE pastes SET comment_count = comment_count + 1 WHERE id = ?1`).bind(pasteId),
	]);

	return commentId;
}

// Import helpers normalize PrivateBin filesystem exports before they are persisted in storage.
function timestampToMilliseconds(value: unknown, fallback: number): number {
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) {
		return fallback;
	}
	return numeric < 1_000_000_000_000 ? Math.floor(numeric * 1000) : Math.floor(numeric);
}

function importExpireAt(meta: Record<string, unknown> | undefined): number | null {
	if (!meta || !Object.hasOwn(meta, 'expire_date')) {
		return null;
	}
	const expireAt = timestampToMilliseconds(meta.expire_date, 0);
	if (expireAt <= 0) {
		return null;
	}
	return expireAt;
}

function sanitizeImportedEnvelope<T extends CipherEnvelope>(envelope: T): CipherEnvelope {
	// Imported filesystem bundles may include helper identifiers that should not be persisted in the
	// canonical envelope stored in R2.
	const sanitizedEnvelope = structuredClone(envelope) as Record<string, unknown>;
	delete sanitizedEnvelope.id;
	delete sanitizedEnvelope.createdAt;
	delete sanitizedEnvelope.parentId;
	delete sanitizedEnvelope.parent_id;
	return sanitizedEnvelope as unknown as CipherEnvelope;
}

function assertImportedPasteEnvelope(paste: unknown): asserts paste is CipherEnvelope {
	if (
		!paste ||
		typeof paste !== 'object' ||
		(paste as Partial<CipherEnvelope>).v !== 2 ||
		typeof (paste as Partial<CipherEnvelope>).ct !== 'string' ||
		!isPasteEnvelopeAdata((paste as Partial<CipherEnvelope>).adata) ||
		!(paste as CipherEnvelope).adata[0]
	) {
		throw new HttpError(400, 'Invalid imported paste.');
	}
}

function assertImportedCommentEnvelope(comment: unknown): asserts comment is ImportedCommentEnvelope {
	if (
		!comment ||
		typeof comment !== 'object' ||
		typeof (comment as Partial<ImportedCommentEnvelope>).id !== 'string' ||
		(comment as Partial<CipherEnvelope>).v !== 2 ||
		typeof (comment as Partial<CipherEnvelope>).ct !== 'string' ||
		!(
			isLegacyCommentAdata((comment as Partial<CipherEnvelope>).adata) ||
			(isPasteEnvelopeAdata((comment as Partial<CipherEnvelope>).adata) && Boolean((comment as CipherEnvelope).adata[0]))
		)
	) {
		throw new HttpError(400, 'Invalid imported comment.');
	}
}

export async function importPrivateBinBundle(env: Env, bundle: PrivateBinImportBundle, now: number): Promise<PrivateBinImportResult> {
	if (!bundle || typeof bundle !== 'object') {
		throw new HttpError(400, 'Import bundle is required.');
	}
	const pasteId = bundle.pasteId;
	assertValidId(pasteId, 'paste identifier');
	assertImportedPasteEnvelope(bundle.paste);
	const comments = Array.isArray(bundle.comments) ? bundle.comments : [];

	if (await getPasteRow(env, pasteId)) {
		throw new HttpError(409, 'Paste already exists.');
	}

	const paste = sanitizeImportedEnvelope(bundle.paste);
	const pasteMeta = (paste.meta ?? {}) as Record<string, unknown>;
	const createdAt = timestampToMilliseconds(pasteMeta.created, now);
	const expireAt = importExpireAt(pasteMeta);
	if (expireAt !== null && expireAt <= now) {
		return {
			id: pasteId,
			importedComments: 0,
			skipped: true,
			status: 'expired',
		};
	}

	const deleteToken = generateSecretToken();
	const deleteTokenHash = await sha256Hex(deleteToken);
	const { formatter, discussionOpen, burnAfterReading } = getEnvelopeFlags(paste);
	const blobKey = buildPasteBlobKey(pasteId);

	await putEnvelope(env.PASTES_BUCKET, blobKey, paste);
	await env.DB.prepare(
		`INSERT INTO pastes (
			id, schema_version, blob_key, created_at, expire_at, status,
			burn_after_reading, discussion_open, formatter, has_attachment,
			delete_token_hash, comment_count, size_bytes, import_source, metadata_json
		) VALUES (?1, 2, ?2, ?3, ?4, 'active', ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?12)`,
	)
		.bind(
			pasteId,
			blobKey,
			createdAt,
			expireAt,
			burnAfterReading ? 1 : 0,
			discussionOpen ? 1 : 0,
			formatter,
			deleteTokenHash,
			comments.length,
			paste.ct.length,
			bundle.source?.trim() || 'privatebin-filesystem',
			JSON.stringify(pasteMeta),
		)
		.run();

	for (const [index, importedComment] of comments.entries()) {
		assertImportedCommentEnvelope(importedComment);
		assertValidId(importedComment.id, 'comment identifier');
		const commentEnvelope = sanitizeImportedEnvelope(importedComment);
		const parentId = importedComment.parentId ?? importedComment.parentid ?? pasteId;
		assertValidId(parentId, 'comment parent identifier');
		if (typeof commentEnvelope.pasteid === 'string' && commentEnvelope.pasteid !== pasteId) {
			throw new HttpError(400, 'Imported comment paste identifier does not match.');
		}
		commentEnvelope.pasteid = pasteId;
		commentEnvelope.parentid = parentId;

		const commentMeta = (commentEnvelope.meta ?? {}) as Record<string, unknown>;
		const commentCreatedAt = timestampToMilliseconds(commentMeta.created, createdAt + index);
		const commentBlobKey = buildCommentBlobKey(pasteId, importedComment.id);

		await putEnvelope(env.PASTES_BUCKET, commentBlobKey, commentEnvelope);
		await env.DB.prepare(
			`INSERT INTO comments (id, paste_id, parent_id, blob_key, created_at, size_bytes)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(importedComment.id, pasteId, parentId, commentBlobKey, commentCreatedAt, commentEnvelope.ct.length)
			.run();
	}

	return {
		id: pasteId,
		deleteToken,
		importedComments: comments.length,
		skipped: false,
		status: 'active',
	};
}

export async function loadPasteResponse(
	env: Env,
	row: PasteRow,
	now: number,
): Promise<(CipherEnvelope & { id: string; comments: CommentResponse[]; claimToken?: string | null }) | null> {
	const envelope = await getEnvelope(env.PASTES_BUCKET, row.blob_key);
	if (!envelope) {
		return null;
	}

	const comments = await getCommentRows(env, row.id);
	const commentPayloads = (
		await Promise.all(
			comments.map(async (comment): Promise<CommentResponse | null> => {
				const commentEnvelope = await getEnvelope(env.PASTES_BUCKET, comment.blob_key);
				if (!commentEnvelope) {
					return null;
				}
				return {
					...commentEnvelope,
					id: comment.id,
					parentId: comment.parent_id,
					createdAt: comment.created_at,
				};
			}),
		)
	).filter((comment): comment is CommentResponse => comment !== null);

	const ttl = row.expire_at ? Math.max(0, Math.floor((row.expire_at - now) / 1000)) : 0;

	return {
		...envelope,
		id: row.id,
		meta: {
			...(envelope.meta ?? {}),
			time_to_live: ttl,
			created_at: row.created_at,
			comment_count: row.comment_count,
		},
		comments: commentPayloads,
	};
}

// Cleanup helpers mark rows first, then fan out object deletion and queue work.
export async function deletePasteByUser(env: Env, pasteId: string, deleteToken: string): Promise<boolean> {
	const row = await getPasteRow(env, pasteId);
	if (!row || UNREADABLE_PASTE_STATUSES.has(row.status)) {
		return false;
	}
	const deleteTokenHash = await sha256Hex(deleteToken);
	if (deleteTokenHash !== row.delete_token_hash) {
		return false;
	}
	await env.DB.prepare(
		`UPDATE pastes
		SET status = 'deleted', claim_token_hash = NULL, claim_expires_at = NULL
		WHERE id = ?1`,
	)
		.bind(pasteId)
		.run();
	return true;
}

export async function releaseExpiredClaims(env: Env, now: number): Promise<number> {
	const result = await env.DB.prepare(
		`UPDATE pastes
		SET status = 'active', claim_token_hash = NULL, claim_expires_at = NULL
		WHERE status = 'claimed'
		AND claim_expires_at IS NOT NULL
		AND claim_expires_at <= ?1
		AND burn_after_reading = 1`,
	)
		.bind(now)
		.run();
	return result.meta.changes ?? 0;
}

export async function findExpiredPasteIds(env: Env, now: number, limit = 100): Promise<string[]> {
	const result = await env.DB.prepare(
		`SELECT id
		FROM pastes
		WHERE status IN ('active', 'claimed')
		AND expire_at IS NOT NULL
		AND expire_at <= ?1
		ORDER BY expire_at ASC
		LIMIT ?2`,
	)
		.bind(now, limit)
		.all<{ id: string }>();
	return result.results.map((row) => row.id);
}

export async function enqueueGcMessages(env: Env, messages: GcMessage[]): Promise<void> {
	if (messages.length === 0) {
		return;
	}
	await env.GC_QUEUE.sendBatch(
		messages.map((message) => ({
			body: message,
		})),
	);
}

export async function purgePasteStorage(
	env: Env,
	pasteId: string,
	finalStatus: Extract<PasteStatus, 'expired' | 'deleted' | 'burned'>,
): Promise<void> {
	const comments = await getCommentRows(env, pasteId);
	const keys = [buildPasteBlobKey(pasteId), ...comments.map((comment) => comment.blob_key)];
	await deleteObjectKeys(env.PASTES_BUCKET, keys);
	await env.DB.batch([
		env.DB.prepare(`DELETE FROM comments WHERE paste_id = ?1`).bind(pasteId),
		env.DB.prepare(
			`UPDATE pastes
			SET status = ?2, claim_token_hash = NULL, claim_expires_at = NULL
			WHERE id = ?1`,
		).bind(pasteId, finalStatus),
	]);
}

// Durable Object RPC keeps burn-after-reading claims serialized across concurrent requests.
async function doStub(env: Env, pasteId: string): Promise<DurableObjectStub> {
	const id = env.PASTE_COORDINATOR.idFromName(pasteId);
	return env.PASTE_COORDINATOR.get(id);
}

export async function claimBurnAfterReading(env: Env, pasteId: string): Promise<BurnClaimResult> {
	const stub = await doStub(env, pasteId);
	const response = await stub.fetch('https://coordinator.local/claim', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pasteId }),
	});
	return (await response.json()) as BurnClaimResult;
}

export async function consumeBurnAfterReading(env: Env, pasteId: string, claimToken: string): Promise<BurnConsumeResult> {
	const stub = await doStub(env, pasteId);
	const response = await stub.fetch('https://coordinator.local/consume', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ pasteId, claimToken }),
	});
	return (await response.json()) as BurnConsumeResult;
}

export async function coordinatorClaim(env: Env, pasteId: string, burnClaimTtlMs: number): Promise<BurnClaimResult> {
	const row = await getPasteRow(env, pasteId);
	if (!row || UNREADABLE_PASTE_STATUSES.has(row.status)) {
		return { ok: false, message: 'Document is unavailable.' };
	}
	if (row.burn_after_reading !== 1) {
		return { ok: false, message: 'Document is not burn-after-reading.' };
	}
	const now = Date.now();
	if (row.status === 'claimed' && row.claim_expires_at && row.claim_expires_at > now) {
		return { ok: false, message: 'Document is already being viewed.' };
	}

	const claimToken = generateSecretToken();
	const claimTokenHash = await sha256Hex(claimToken);
	const claimExpiresAt = now + burnClaimTtlMs;

	await env.DB.prepare(
		`UPDATE pastes
		SET status = 'claimed', claim_token_hash = ?2, claim_expires_at = ?3
		WHERE id = ?1`,
	)
		.bind(pasteId, claimTokenHash, claimExpiresAt)
		.run();

	return { ok: true, claimToken };
}

export async function coordinatorConsume(env: Env, pasteId: string, claimToken: string): Promise<BurnConsumeResult> {
	const row = await getPasteRow(env, pasteId);
	if (!row || row.status !== 'claimed' || !row.claim_token_hash) {
		return { ok: false, message: 'Document cannot be consumed.' };
	}
	const claimTokenHash = await sha256Hex(claimToken);
	if (claimTokenHash !== row.claim_token_hash) {
		return { ok: false, message: 'Invalid claim token.' };
	}
	await purgePasteStorage(env, pasteId, 'burned');
	return { ok: true };
}

// Readability checks collapse the public-facing "missing" states into one safe error message.
export function ensurePasteReadable(row: PasteRow | null, now: number): PasteRow {
	if (!row || UNREADABLE_PASTE_STATUSES.has(row.status)) {
		throw new HttpError(404, GENERIC_MISSING_MESSAGE);
	}
	if (row.expire_at && row.expire_at <= now) {
		throw new HttpError(404, GENERIC_MISSING_MESSAGE);
	}
	return row;
}
