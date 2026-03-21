/**
 * Repository-level tests for D1, R2, import normalization, and burn-after-reading coordination.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { HttpError } from '../src/lib/model';
import {
	buildCommentBlobKey,
	buildPasteBlobKey,
	claimBurnAfterReading,
	consumeBurnAfterReading,
	coordinatorClaim,
	coordinatorConsume,
	createComment,
	createPaste,
	deleteObjectKeys,
	deletePasteByUser,
	enqueueGcMessages,
	ensurePasteReadable,
	findExpiredPasteIds,
	generateId,
	generateSecretToken,
	getCommentRows,
	getEnvelope,
	getPasteRow,
	importPrivateBinBundle,
	loadPasteResponse,
	purgePasteStorage,
	putEnvelope,
	releaseExpiredClaims,
	sha256Hex,
} from '../src/lib/repository';
import type { PasteRow, PasteStatus } from '../src/lib/types';
import { resetState, sampleEnvelope } from './support';

// Helper rows let the tests target individual repository branches without full request setup.
async function insertPasteRow(overrides: Partial<PasteRow> & { id: string }): Promise<PasteRow> {
	const row: PasteRow = {
		id: overrides.id,
		schema_version: 2,
		blob_key: overrides.blob_key ?? buildPasteBlobKey(overrides.id),
		created_at: overrides.created_at ?? 1_700_000_000_000,
		expire_at: overrides.expire_at ?? null,
		status: overrides.status ?? 'active',
		burn_after_reading: overrides.burn_after_reading ?? 0,
		discussion_open: overrides.discussion_open ?? 0,
		formatter: overrides.formatter ?? 'plaintext',
		has_attachment: overrides.has_attachment ?? 0,
		delete_token_hash: overrides.delete_token_hash ?? 'delete-hash',
		claim_token_hash: overrides.claim_token_hash ?? null,
		claim_expires_at: overrides.claim_expires_at ?? null,
		comment_count: overrides.comment_count ?? 0,
		size_bytes: overrides.size_bytes ?? 10,
		import_source: overrides.import_source ?? null,
		metadata_json: overrides.metadata_json ?? '{}',
	};

	await env.DB.prepare(
		`INSERT INTO pastes (
			id, schema_version, blob_key, created_at, expire_at, status,
			burn_after_reading, discussion_open, formatter, has_attachment,
			delete_token_hash, claim_token_hash, claim_expires_at,
			comment_count, size_bytes, import_source, metadata_json
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
	)
		.bind(
			row.id,
			row.schema_version,
			row.blob_key,
			row.created_at,
			row.expire_at,
			row.status,
			row.burn_after_reading,
			row.discussion_open,
			row.formatter,
			row.has_attachment,
			row.delete_token_hash,
			row.claim_token_hash,
			row.claim_expires_at,
			row.comment_count,
			row.size_bytes,
			row.import_source,
			row.metadata_json,
		)
		.run();

	return row;
}

beforeEach(async () => {
	await resetState();
});

describe('repository helpers', () => {
	it('stores and removes envelopes in R2', async () => {
		const pasteId = 'abcdef1234567890';
		const commentId = '1234567890abcdef';
		const pasteKey = buildPasteBlobKey(pasteId);
		const commentKey = buildCommentBlobKey(pasteId, commentId);

		expect(generateId()).toMatch(/^[a-f0-9]{16}$/);
		expect(generateSecretToken()).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(await sha256Hex('hello')).toHaveLength(64);

		await putEnvelope(env.PASTES_BUCKET, pasteKey, sampleEnvelope());
		await putEnvelope(env.PASTES_BUCKET, commentKey, sampleEnvelope({ ct: 'comment' }));

		expect((await getEnvelope(env.PASTES_BUCKET, pasteKey))?.ct).toBe('ciphertext');
		expect((await getEnvelope(env.PASTES_BUCKET, commentKey))?.ct).toBe('comment');

		await deleteObjectKeys(env.PASTES_BUCKET, [pasteKey, commentKey]);
		expect(await getEnvelope(env.PASTES_BUCKET, pasteKey)).toBeNull();
		expect(await getEnvelope(env.PASTES_BUCKET, commentKey)).toBeNull();
	});

	it('imports bundles, sanitizes imported fields, and rejects duplicates or expired pastes', async () => {
		await expect(importPrivateBinBundle(env, null as never, Date.now())).rejects.toThrow(HttpError);

		const expiredResult = await importPrivateBinBundle(
			env,
			{
				source: 'privatebin-filesystem',
				pasteId: 'aaaaaaaaaaaaaaaa',
				paste: sampleEnvelope({
					meta: { created: 1_700_000_000, expire_date: 1 },
					id: 'discard-me',
				}),
			},
			Date.now(),
		);
		expect(expiredResult).toEqual({
			id: 'aaaaaaaaaaaaaaaa',
			importedComments: 0,
			skipped: true,
			status: 'expired',
		});

		const imported = await importPrivateBinBundle(
			env,
			{
				source: 'filesystem',
				pasteId: 'bbbbbbbbbbbbbbbb',
				paste: sampleEnvelope({
					meta: { created: '1700000000', expire_date: '4102444800' },
					id: 'discard-me',
					parentId: 'discard-me-too',
				}),
				comments: [
					{
						id: 'cccccccccccccccc',
						v: 2,
						adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
						ct: 'comment-ciphertext',
						pasteid: 'bbbbbbbbbbbbbbbb',
						parentid: 'bbbbbbbbbbbbbbbb',
						parentId: 'bbbbbbbbbbbbbbbb',
						meta: { created: '1700000001' },
					},
				],
			},
			Date.now(),
		);

		expect(imported.skipped).toBe(false);
		expect(imported.importedComments).toBe(1);
		expect(imported.deleteToken).toMatch(/^[A-Za-z0-9_-]+$/);

		const storedPaste = await getEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('bbbbbbbbbbbbbbbb'));
		const storedComment = await getEnvelope(env.PASTES_BUCKET, buildCommentBlobKey('bbbbbbbbbbbbbbbb', 'cccccccccccccccc'));
		expect(storedPaste).not.toHaveProperty('id');
		expect(storedPaste).not.toHaveProperty('parentId');
		expect(storedComment).not.toHaveProperty('id');
		expect(storedComment?.pasteid).toBe('bbbbbbbbbbbbbbbb');
		expect(storedComment?.parentid).toBe('bbbbbbbbbbbbbbbb');

		await expect(
			importPrivateBinBundle(
				env,
				{
					source: 'filesystem',
					pasteId: 'bbbbbbbbbbbbbbbb',
					paste: sampleEnvelope(),
				},
				Date.now(),
			),
		).rejects.toThrow('Paste already exists.');
	});

	it('imports modern comments, falls back imported defaults, and rejects malformed bundles', async () => {
		const modernPaste = sampleEnvelope();
		delete modernPaste.meta;

		const imported = await importPrivateBinBundle(
			env,
			{
				source: '   ',
				pasteId: 'dededededededede',
				paste: modernPaste,
				comments: [
					{
						id: 'efefefefefefefef',
						v: 2,
						adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 0],
						ct: 'modern-comment-ciphertext',
					},
				],
			},
			1_700_000_000_000,
		);
		expect(imported.status).toBe('active');
		expect((await getPasteRow(env, 'dededededededede'))?.import_source).toBe('privatebin-filesystem');
		expect((await getCommentRows(env, 'dededededededede'))[0]?.parent_id).toBe('dededededededede');
		expect((await getEnvelope(env.PASTES_BUCKET, buildCommentBlobKey('dededededededede', 'efefefefefefefef')))?.pasteid).toBe(
			'dededededededede',
		);

		await expect(
			importPrivateBinBundle(
				env,
				{
					source: 'filesystem',
					pasteId: '1010101010101010',
					paste: {
						v: 2,
						adata: [null, 'plaintext', 0, 0],
						ct: 'invalid-imported-paste',
					} as never,
				},
				Date.now(),
			),
		).rejects.toThrow('Invalid imported paste.');

		await expect(
			importPrivateBinBundle(
				env,
				{
					source: 'filesystem',
					pasteId: '2020202020202020',
					paste: sampleEnvelope(),
					comments: [
						{
							id: '3030303030303030',
							v: 2,
							adata: [null, 'plaintext', 0, 0],
							ct: 'invalid-comment',
						} as never,
					],
				},
				Date.now(),
			),
		).rejects.toThrow('Invalid imported comment.');

		await expect(
			importPrivateBinBundle(
				env,
				{
					source: 'filesystem',
					pasteId: '4040404040404040',
					paste: sampleEnvelope(),
					comments: [
						{
							id: '5050505050505050',
							v: 2,
							adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
							ct: 'mismatch-comment',
							pasteid: '6060606060606060',
							parentid: '4040404040404040',
						},
					],
				},
				Date.now(),
			),
		).rejects.toThrow('Imported comment paste identifier does not match.');
	});

	it('loads paste responses, skips missing comment blobs, and deletes pastes by token', async () => {
		const created = await createPaste(
			env,
			{
				envelope: sampleEnvelope({
					meta: { expire: '1day' },
				}),
				expireKey: '1day',
				turnstileToken: null,
			},
			1_700_000_000_000,
		);

		await createComment(
			env,
			created.id,
			{
				envelope: sampleEnvelope({
					ct: 'comment-ciphertext',
				}),
				parentId: created.id,
				turnstileToken: null,
			},
			1_700_000_001_000,
		);

		const comments = await getCommentRows(env, created.id);
		await deleteObjectKeys(env.PASTES_BUCKET, [comments[0].blob_key]);

		const row = await getPasteRow(env, created.id);
		const response = await loadPasteResponse(env, row!, 1_700_000_000_500);
		expect(response?.comments).toHaveLength(0);
		expect((response?.meta as Record<string, number>).time_to_live).toBeGreaterThan(0);

		expect(await deletePasteByUser(env, created.id, 'wrong-token')).toBe(false);
		expect(await deletePasteByUser(env, created.id, created.deleteToken)).toBe(true);
		expect(await deletePasteByUser(env, created.id, created.deleteToken)).toBe(false);

		const noExpiry = await insertPasteRow({
			id: '9090909090909090',
			expire_at: null,
		});
		await putEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('9090909090909090'), sampleEnvelope());
		expect((await loadPasteResponse(env, noExpiry, Date.now()))?.meta.time_to_live).toBe(0);
	});

	it('stores attachment metadata when the envelope meta block is absent', async () => {
		const envelope = sampleEnvelope({
			attachment: {
				v: 2,
				adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none']],
				ct: 'attachment-ciphertext',
			},
			meta: undefined,
		});
		delete envelope.meta;

		const created = await createPaste(
			env,
			{
				envelope,
				expireKey: 'never',
				turnstileToken: null,
			},
			Date.now(),
		);
		const row = await getPasteRow(env, created.id);
		expect(row?.has_attachment).toBe(1);
		expect(row?.expire_at).toBeNull();

		const response = await loadPasteResponse(env, row!, Date.now());
		expect(response?.meta.time_to_live).toBe(0);
		expect(response?.meta.comment_count).toBe(0);
	});

	it('releases claims, finds expired ids, and enqueues gc batches', async () => {
		await insertPasteRow({
			id: '1111111111111111',
			status: 'claimed',
			burn_after_reading: 1,
			claim_expires_at: 10,
		});
		await insertPasteRow({
			id: '2222222222222222',
			status: 'active',
			expire_at: 20,
		});
		await insertPasteRow({
			id: '3333333333333333',
			status: 'claimed',
			expire_at: 30,
		});

		expect(await releaseExpiredClaims(env, 100)).toBe(1);
		expect(await findExpiredPasteIds(env, 100, 1)).toEqual(['2222222222222222']);

		const queued: unknown[] = [];
		await enqueueGcMessages(
			{
				...env,
				GC_QUEUE: {
					sendBatch: async (messages: unknown[]) => {
						queued.push(...messages);
					},
				} as Queue,
			},
			[
				{ pasteId: '2222222222222222', finalStatus: 'expired' },
				{ pasteId: '3333333333333333', finalStatus: 'deleted' },
			],
		);
		expect(queued).toHaveLength(2);

		await enqueueGcMessages(
			{
				...env,
				GC_QUEUE: {
					sendBatch: async () => {
						throw new Error('should not run');
					},
				} as Queue,
			},
			[],
		);
	});

	it('handles coordinator and readability edge cases', async () => {
		expect(await coordinatorClaim(env, 'ffffffffffffffff', 1000)).toEqual({
			ok: false,
			message: 'Document is unavailable.',
		});

		await insertPasteRow({
			id: '4444444444444444',
			burn_after_reading: 0,
		});
		expect(await coordinatorClaim(env, '4444444444444444', 1000)).toEqual({
			ok: false,
			message: 'Document is not burn-after-reading.',
		});

		await insertPasteRow({
			id: '5555555555555555',
			burn_after_reading: 1,
			status: 'claimed',
			claim_expires_at: Date.now() + 10_000,
		});
		expect(await coordinatorClaim(env, '5555555555555555', 1000)).toEqual({
			ok: false,
			message: 'Document is already being viewed.',
		});

		await putEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('6666666666666666'), sampleEnvelope());
		await insertPasteRow({
			id: '6666666666666666',
			burn_after_reading: 1,
		});
		const claim = await coordinatorClaim(env, '6666666666666666', 5_000);
		expect(claim.ok).toBe(true);
		expect(claim.claimToken).toBeTruthy();
		expect(await coordinatorConsume(env, '6666666666666666', 'wrong-token')).toEqual({
			ok: false,
			message: 'Invalid claim token.',
		});
		expect(await coordinatorConsume(env, '6666666666666666', claim.claimToken!)).toEqual({ ok: true });
		expect(await getEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('6666666666666666'))).toBeNull();

		expect(() => ensurePasteReadable(null, Date.now())).toThrow('Document does not exist, has expired or has been deleted.');
		const deleted = await insertPasteRow({
			id: '7777777777777777',
			status: 'deleted',
		});
		expect(() => ensurePasteReadable(deleted, Date.now())).toThrow('Document does not exist, has expired or has been deleted.');

		const readable = await insertPasteRow({
			id: '8888888888888888',
			status: 'active',
			expire_at: Date.now() + 10_000,
		});
		expect(ensurePasteReadable(readable, Date.now()).id).toBe('8888888888888888');
		expect(() =>
			ensurePasteReadable(
				{
					...readable,
					expire_at: Date.now() - 1,
				},
				Date.now(),
			),
		).toThrow('Document does not exist, has expired or has been deleted.');
		expect(await consumeBurnAfterReading(env, 'ffffffffffffffff', 'token')).toEqual({
			ok: false,
			message: 'Document cannot be consumed.',
		});
	});

	it('uses the durable object stub for claim and consume helpers', async () => {
		await putEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('9999999999999999'), sampleEnvelope());
		await insertPasteRow({
			id: '9999999999999999',
			burn_after_reading: 1,
		});

		const claim = await claimBurnAfterReading(env, '9999999999999999');
		expect(claim.ok).toBe(true);
		expect(claim.claimToken).toBeTruthy();

		const consume = await consumeBurnAfterReading(env, '9999999999999999', claim.claimToken!);
		expect(consume).toEqual({ ok: true });

		const stub = env.PASTE_COORDINATOR.get(env.PASTE_COORDINATOR.idFromName('aaaaaaaaaaaaaaaa'));
		const missingId = await stub.fetch('https://coordinator.local/claim', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		expect(missingId.status).toBe(400);
		expect((await missingId.json()).ok).toBe(false);

		const missingClaimToken = await stub.fetch('https://coordinator.local/consume', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pasteId: 'aaaaaaaaaaaaaaaa' }),
		});
		expect(missingClaimToken.status).toBe(400);
		expect((await missingClaimToken.json()).ok).toBe(false);

		const missingRoute = await stub.fetch('https://coordinator.local/unknown', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pasteId: 'aaaaaaaaaaaaaaaa' }),
		});
		expect(missingRoute.status).toBe(404);
		expect((await missingRoute.json()).ok).toBe(false);
	});

	it('purges storage and marks final statuses', async () => {
		await putEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('abababababababab'), sampleEnvelope());
		await putEnvelope(env.PASTES_BUCKET, buildCommentBlobKey('abababababababab', 'cdcdcdcdcdcdcdcd'), sampleEnvelope({ ct: 'comment' }));
		await insertPasteRow({
			id: 'abababababababab',
			comment_count: 1,
		});
		await env.DB.prepare(
			`INSERT INTO comments (id, paste_id, parent_id, blob_key, created_at, size_bytes)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(
				'cdcdcdcdcdcdcdcd',
				'abababababababab',
				'abababababababab',
				buildCommentBlobKey('abababababababab', 'cdcdcdcdcdcdcdcd'),
				Date.now(),
				10,
			)
			.run();

		await purgePasteStorage(env, 'abababababababab', 'expired');
		expect(await getEnvelope(env.PASTES_BUCKET, buildPasteBlobKey('abababababababab'))).toBeNull();
		expect(await getCommentRows(env, 'abababababababab')).toHaveLength(0);
		expect((await getPasteRow(env, 'abababababababab'))?.status).toBe('expired');
	});
});
