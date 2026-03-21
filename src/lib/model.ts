/**
 * Request-model helpers that validate paste envelopes and bridge modern and legacy payloads.
 */
import type { ExpireKey } from './config';
import type { CipherEnvelope, CipherSpec, CreateCommentInput, CreatePasteInput, EnvelopeAdata, PasteEnvelopeAdata } from './types';

export const GENERIC_MISSING_MESSAGE = 'Document does not exist, has expired or has been deleted.';
const INVALID_DATA_MESSAGE = 'Invalid data.';

type PasteInputEnvelope = CipherEnvelope & {
	meta?: { expire?: string };
	turnstileToken?: string;
};

type CommentInputEnvelope = CipherEnvelope & {
	parentId?: string;
	parentid?: string;
	pasteid?: string;
	turnstileToken?: string;
};

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function isValidId(value: string): boolean {
	return /^[a-f0-9]{16}$/i.test(value);
}

export function assertValidId(value: string, label = 'identifier'): void {
	if (!isValidId(value)) {
		throw new HttpError(400, `Invalid ${label}.`);
	}
}

export function parseLegacyPasteId(url: URL): string | null {
	if (url.searchParams.has('pasteid')) {
		return url.searchParams.get('pasteid');
	}
	if (url.search.length > 1 && !url.search.includes('=')) {
		return url.search.slice(1);
	}
	return null;
}

export function isLegacyJsonApiCall(request: Request): boolean {
	return request.headers.get('X-Requested-With') === 'JSONHttpRequest';
}

export function isCipherSpec(value: unknown): value is CipherSpec {
	return (
		Array.isArray(value) &&
		value.length >= 8 &&
		typeof value[0] === 'string' &&
		typeof value[1] === 'string' &&
		typeof value[2] === 'number' &&
		typeof value[3] === 'number' &&
		typeof value[4] === 'number' &&
		typeof value[5] === 'string' &&
		typeof value[6] === 'string' &&
		typeof value[7] === 'string'
	);
}

export function isPasteEnvelopeAdata(value: unknown): value is PasteEnvelopeAdata {
	return Array.isArray(value) && value.length >= 1 && (value[0] === null || isCipherSpec(value[0]));
}

export function isLegacyCommentAdata(value: unknown): value is CipherSpec {
	return isCipherSpec(value);
}

export function isLegacyCommentEnvelope(envelope: Pick<CipherEnvelope, 'adata'>): boolean {
	return isLegacyCommentAdata(envelope.adata);
}

export function getCipherSpecFromAdata(adata: EnvelopeAdata): CipherSpec | null {
	if (isPasteEnvelopeAdata(adata)) {
		return adata[0];
	}
	if (isLegacyCommentAdata(adata)) {
		return adata;
	}
	return null;
}

export function getEnvelopeFlags(envelope: CipherEnvelope): {
	formatter: string;
	discussionOpen: boolean;
	burnAfterReading: boolean;
} {
	const adata = isPasteEnvelopeAdata(envelope.adata) ? envelope.adata : null;
	return {
		formatter: typeof adata?.[1] === 'string' && adata[1].length > 0 ? adata[1] : 'plaintext',
		discussionOpen: Number(adata?.[2] ?? 0) === 1,
		burnAfterReading: Number(adata?.[3] ?? 0) === 1,
	};
}

// Internal shape guards keep the public assert helpers readable and consistent.
function assertEnvelopeBase(envelope: unknown): asserts envelope is CipherEnvelope {
	if (!envelope || typeof envelope !== 'object') {
		throw new HttpError(400, INVALID_DATA_MESSAGE);
	}
	const candidate = envelope as Partial<CipherEnvelope>;
	if (candidate.v !== 2 || typeof candidate.ct !== 'string' || !Array.isArray(candidate.adata)) {
		throw new HttpError(400, INVALID_DATA_MESSAGE);
	}
}

function assertPasteEnvelopeShape(envelope: unknown): asserts envelope is CipherEnvelope {
	assertEnvelopeBase(envelope);
	const candidate = envelope as CipherEnvelope;
	if (!isPasteEnvelopeAdata(candidate.adata) || !candidate.adata[0]) {
		throw new HttpError(400, INVALID_DATA_MESSAGE);
	}
}

function assertCommentEnvelopeShape(envelope: unknown): asserts envelope is CipherEnvelope {
	assertEnvelopeBase(envelope);
	const candidate = envelope as CipherEnvelope;
	const spec = getCipherSpecFromAdata(candidate.adata);
	if (!spec) {
		throw new HttpError(400, INVALID_DATA_MESSAGE);
	}
}

function encryptedPayloadLength(envelope: CipherEnvelope): number {
	let total = envelope.ct.length;
	if (envelope.attachment) {
		total += encryptedPayloadLength(envelope.attachment);
	}
	if (envelope.attachment_name) {
		total += encryptedPayloadLength(envelope.attachment_name);
	}
	return total;
}

function getTurnstileToken(candidate: { turnstileToken?: string }): string | null {
	return typeof candidate.turnstileToken === 'string' ? candidate.turnstileToken : null;
}

function resolveExpireKey(requestedExpire: unknown, supportedExpirations: readonly ExpireKey[]): ExpireKey {
	return typeof requestedExpire === 'string' && supportedExpirations.includes(requestedExpire as ExpireKey)
		? (requestedExpire as ExpireKey)
		: supportedExpirations[0];
}

// Public assertions turn untyped request bodies into normalized repository inputs.
export function assertPasteInput(payload: unknown, maxPasteBytes: number, supportedExpirations: readonly ExpireKey[]): CreatePasteInput {
	assertPasteEnvelopeShape(payload);
	const envelope = payload as PasteInputEnvelope;

	if (encryptedPayloadLength(envelope) > maxPasteBytes) {
		throw new HttpError(413, 'Document exceeds the maximum encrypted size.');
	}

	const { burnAfterReading, discussionOpen } = getEnvelopeFlags(envelope);
	if (burnAfterReading && discussionOpen) {
		throw new HttpError(400, 'Burn-after-reading pastes cannot have discussions enabled.');
	}

	return {
		envelope,
		expireKey: resolveExpireKey(envelope.meta?.expire, supportedExpirations),
		turnstileToken: getTurnstileToken(envelope),
	};
}

export function assertCommentInput(payload: unknown, maxPasteBytes: number, pasteId: string): CreateCommentInput {
	assertCommentEnvelopeShape(payload);
	const candidate = payload as CommentInputEnvelope;
	if (encryptedPayloadLength(candidate) > maxPasteBytes) {
		throw new HttpError(413, 'Comment exceeds the maximum encrypted size.');
	}
	if (typeof candidate.pasteid === 'string' && candidate.pasteid !== pasteId) {
		throw new HttpError(400, 'Comment paste identifier does not match the route.');
	}
	const parentIdValue = candidate.parentId ?? candidate.parentid ?? pasteId;
	assertValidId(parentIdValue, 'parent identifier');
	return {
		envelope: candidate,
		parentId: parentIdValue,
		turnstileToken: getTurnstileToken(candidate),
	};
}
