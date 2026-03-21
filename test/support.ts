/**
 * Shared test fixtures and reset helpers for worker integration tests.
 */
import { env } from 'cloudflare:test';
import { SCHEMA_STATEMENTS } from '../src/lib/schema';

export const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export function sampleEnvelope(options: Record<string, unknown> = {}) {
	return {
		v: 2,
		adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 0],
		ct: 'ciphertext',
		meta: { expire: '1day' },
		...options,
	};
}

export async function clearBucket(): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await env.PASTES_BUCKET.list({ cursor, prefix: 'pastes/' });
		for (const object of listed.objects) {
			await env.PASTES_BUCKET.delete(object.key);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

export async function resetState(): Promise<void> {
	await env.DB.batch(SCHEMA_STATEMENTS.map((statement) => env.DB.prepare(statement)));
	await env.DB.batch([env.DB.prepare('DELETE FROM comments'), env.DB.prepare('DELETE FROM pastes')]);
	await clearBucket();
}
