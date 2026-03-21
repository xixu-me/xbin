/**
 * Edge-case tests for HTTP error handling, legacy compatibility, and background cleanup paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { buildPasteBlobKey, createPaste, getEnvelope } from '../src/lib/repository';
import { resetState, sampleEnvelope, IncomingRequest } from './support';

// Direct row insertion keeps failure-path tests precise without going through the full API.
async function insertExpiredPaste(id: string, expireAt: number): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO pastes (
			id, schema_version, blob_key, created_at, expire_at, status,
			burn_after_reading, discussion_open, formatter, has_attachment,
			delete_token_hash, comment_count, size_bytes, metadata_json
		) VALUES (?1, 2, ?2, ?3, ?4, 'active', 0, 0, 'plaintext', 0, 'hash', 0, 10, '{}')`,
	)
		.bind(id, buildPasteBlobKey(id), 1_700_000_000_000, expireAt)
		.run();
	await env.PASTES_BUCKET.put(buildPasteBlobKey(id), JSON.stringify(sampleEnvelope()));
}

beforeEach(async () => {
	await resetState();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('http and worker edge cases', () => {
	it('returns config and handles API preflight and unknown routes', async () => {
		const configResponse = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/config'),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SITE_KEY: 'site-key',
			},
			createExecutionContext(),
		);
		const config = await configResponse.json();
		expect(configResponse.status).toBe(200);
		expect(config.appVersion).toBe('1.0.0');
		expect(config.requireTurnstile).toBe(true);
		expect(config.turnstileSiteKey).toBe('site-key');
		expect(config.uiLanguageLabel).toBe('English');
		expect(config.uiLanguageCode).toBe('en');
		expect(config.uiLanguageName).toBe('English');
		expect(config.uiLanguageRtl).toBe(false);
		expect(config.uiLanguages).toHaveLength(37);
		expect(config.uiThemeLabel).toBe('bootstrap5');
		expect(config.uiThemes).toContain('bootstrap-dark-page');

		const optionsResponse = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes/abcdef1234567890', {
				method: 'OPTIONS',
			}),
			env,
			createExecutionContext(),
		);
		expect(optionsResponse.status).toBe(204);
		expect(optionsResponse.headers.get('access-control-allow-methods')).toContain('GET');

		const missingRoute = await worker.fetch(new IncomingRequest('https://example.com/api/v1/unknown'), env, createExecutionContext());
		expect(missingRoute.status).toBe(404);
	});

	it('rejects malformed payloads and invalid identifiers', async () => {
		const invalidJson = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{',
			}),
			env,
			createExecutionContext(),
		);
		expect(invalidJson.status).toBe(400);
		expect((await invalidJson.json()).error).toContain('valid JSON');

		const emptyBody = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
			}),
			env,
			createExecutionContext(),
		);
		expect(emptyBody.status).toBe(400);

		const oversized = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					sampleEnvelope({
						ct: 'x'.repeat(256),
					}),
				),
			}),
			{
				...env,
				XBIN_MAX_PASTE_BYTES: '64',
			},
			createExecutionContext(),
		);
		expect(oversized.status).toBe(413);

		const invalidId = await worker.fetch(new IncomingRequest('https://example.com/api/v1/pastes/not-an-id'), env, createExecutionContext());
		expect(invalidId.status).toBe(404);

		const missingClaimToken = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes/abcdef1234567890/consume', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
			env,
			createExecutionContext(),
		);
		expect(missingClaimToken.status).toBe(400);
	});

	it('enforces turnstile and import authorization failures', async () => {
		const missingSecret = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(sampleEnvelope()),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
			},
			createExecutionContext(),
		);
		expect(missingSecret.status).toBe(500);

		const missingToken = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(sampleEnvelope()),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SECRET_KEY: 'secret',
			},
			createExecutionContext(),
		);
		expect(missingToken.status).toBe(400);

		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							success: false,
							'error-codes': ['bad-token'],
						}),
						{
							headers: { 'content-type': 'application/json' },
						},
					),
			),
		);

		const failedTurnstile = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'CF-Connecting-IP': '203.0.113.5',
				},
				body: JSON.stringify(
					sampleEnvelope({
						turnstileToken: 'bad-token',
					}),
				),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SECRET_KEY: 'secret',
			},
			createExecutionContext(),
		);
		expect(failedTurnstile.status).toBe(400);
		expect((await failedTurnstile.json()).error).toContain('bad-token');

		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ success: false }), {
						headers: { 'content-type': 'application/json' },
					}),
			),
		);

		const failedWithoutCodes = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					sampleEnvelope({
						turnstileToken: 'bad-token',
					}),
				),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SECRET_KEY: 'secret',
			},
			createExecutionContext(),
		);
		expect(failedWithoutCodes.status).toBe(400);
		expect((await failedWithoutCodes.json()).error).toContain('Turnstile verification failed.');

		const importDisabled = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/admin/import/privatebin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
			env,
			createExecutionContext(),
		);
		expect(importDisabled.status).toBe(404);

		const importUnauthorized = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/admin/import/privatebin', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer wrong-token',
				},
				body: JSON.stringify({ pasteId: 'abcdef1234567890', paste: sampleEnvelope() }),
			}),
			{
				...env,
				IMPORT_TOKEN: 'expected-token',
			},
			createExecutionContext(),
		);
		expect(importUnauthorized.status).toBe(401);
	});

	it('covers alternate asset, import, and unexpected error branches', async () => {
		const noNavigationHints = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes?abcdef1234567890'),
			env,
			createExecutionContext(),
		);
		expect(noNavigationHints.status).toBe(404);

		const htmlShareNavigation = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes?abcdef1234567890', {
				headers: { accept: 'text/html' },
			}),
			env,
			createExecutionContext(),
		);
		expect(htmlShareNavigation.status).toBe(200);
		expect(htmlShareNavigation.headers.get('content-type')).toContain('text/html');

		const queryRoute = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes?pasteid=abcdef1234567890', {
				headers: { accept: 'text/html' },
			}),
			env,
			createExecutionContext(),
		);
		expect(queryRoute.status).toBe(404);

		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ success: true }), {
						headers: { 'content-type': 'application/json' },
					}),
			),
		);

		const turnstileAccepted = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					sampleEnvelope({
						turnstileToken: 'good-token',
					}),
				),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SECRET_KEY: 'secret',
			},
			createExecutionContext(),
		);
		expect(turnstileAccepted.status).toBe(201);

		const skippedImport = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/admin/import/privatebin', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-import-token': 'expected-token',
				},
				body: JSON.stringify({
					pasteId: '90909090abcdefab',
					paste: sampleEnvelope({
						meta: { created: 1_700_000_000, expire_date: 1 },
					}),
				}),
			}),
			{
				...env,
				IMPORT_TOKEN: 'expected-token',
			},
			createExecutionContext(),
		);
		expect(skippedImport.status).toBe(200);
		expect((await skippedImport.json()).skipped).toBe(true);

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('turnstile exploded');
			}),
		);

		const apiInternal = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					sampleEnvelope({
						turnstileToken: 'broken-token',
					}),
				),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SECRET_KEY: 'secret',
			},
			createExecutionContext(),
		);
		expect(apiInternal.status).toBe(500);
		expect((await apiInternal.json()).error).toContain('Internal server error');

		const legacyInternal = await worker.fetch(
			new IncomingRequest('https://example.com/', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'X-Requested-With': 'JSONHttpRequest',
				},
				body: JSON.stringify(
					sampleEnvelope({
						turnstileToken: 'broken-token',
					}),
				),
			}),
			{
				...env,
				XBIN_REQUIRE_TURNSTILE: 'true',
				TURNSTILE_SECRET_KEY: 'secret',
			},
			createExecutionContext(),
		);
		expect(legacyInternal.status).toBe(500);
		expect((await legacyInternal.json()).message).toContain('Internal server error');
	});

	it('supports legacy JSON API success and failure flows', async () => {
		const legacyHeaders = {
			'content-type': 'application/json',
			'X-Requested-With': 'JSONHttpRequest',
		};

		const createResponse = await worker.fetch(
			new IncomingRequest('https://example.com/', {
				method: 'POST',
				headers: legacyHeaders,
				body: JSON.stringify(
					sampleEnvelope({
						adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 1, 0],
					}),
				),
			}),
			env,
			createExecutionContext(),
		);
		const created = await createResponse.json();
		expect(createResponse.status).toBe(201);
		expect(created.status).toBe(0);
		expect(created.url).toContain(`?${created.id}`);

		const getResponse = await worker.fetch(
			new IncomingRequest(`https://example.com/?${created.id}`, {
				headers: { 'X-Requested-With': 'JSONHttpRequest' },
			}),
			env,
			createExecutionContext(),
		);
		expect(getResponse.status).toBe(200);
		expect((await getResponse.json()).status).toBe(0);

		const commentResponse = await worker.fetch(
			new IncomingRequest('https://example.com/', {
				method: 'POST',
				headers: legacyHeaders,
				body: JSON.stringify({
					v: 2,
					adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
					ct: 'legacy-comment',
					pasteid: created.id,
					parentid: created.id,
				}),
			}),
			env,
			createExecutionContext(),
		);
		expect(commentResponse.status).toBe(201);
		expect((await commentResponse.json()).status).toBe(0);

		const wrongDelete = await worker.fetch(
			new IncomingRequest(`https://example.com/?pasteid=${created.id}`, {
				method: 'DELETE',
				headers: legacyHeaders,
				body: JSON.stringify({ deletetoken: 'wrong-token' }),
			}),
			env,
			createExecutionContext(),
		);
		expect(wrongDelete.status).toBe(403);
		expect((await wrongDelete.json()).status).toBe(1);

		const deleteCtx = createExecutionContext();
		const deleteResponse = await worker.fetch(
			new IncomingRequest(`https://example.com/?pasteid=${created.id}`, {
				method: 'DELETE',
				headers: legacyHeaders,
				body: JSON.stringify({ deletetoken: created.deletetoken }),
			}),
			env,
			deleteCtx,
		);
		expect(deleteResponse.status).toBe(200);
		await waitOnExecutionContext(deleteCtx);

		const missingLegacyId = await worker.fetch(
			new IncomingRequest('https://example.com/', {
				headers: { 'X-Requested-With': 'JSONHttpRequest' },
			}),
			env,
			createExecutionContext(),
		);
		expect(missingLegacyId.status).toBe(400);
		expect((await missingLegacyId.json()).status).toBe(1);

		const wrongMethod = await worker.fetch(
			new IncomingRequest(`https://example.com/?pasteid=${created.id}`, {
				method: 'PUT',
				headers: { 'X-Requested-With': 'JSONHttpRequest' },
			}),
			env,
			createExecutionContext(),
		);
		expect(wrongMethod.status).toBe(405);
		expect((await wrongMethod.json()).status).toBe(1);
	});

	it('covers modern and legacy API edge failures', async () => {
		const created = await createPaste(
			env,
			{
				envelope: sampleEnvelope(),
				expireKey: '1day',
				turnstileToken: null,
			},
			Date.now(),
		);

		const missingDeleteToken = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${created.id}`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({}),
			}),
			env,
			createExecutionContext(),
		);
		expect(missingDeleteToken.status).toBe(400);

		const wrongDeleteToken = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${created.id}`, {
				method: 'DELETE',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deleteToken: 'wrong-token' }),
			}),
			env,
			createExecutionContext(),
		);
		expect(wrongDeleteToken.status).toBe(403);

		const discussionDisabled = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${created.id}/comments`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(sampleEnvelope({ parentId: created.id })),
			}),
			env,
			createExecutionContext(),
		);
		expect(discussionDisabled.status).toBe(400);

		await env.PASTES_BUCKET.delete(buildPasteBlobKey(created.id));
		const missingBlob = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${created.id}`),
			env,
			createExecutionContext(),
		);
		expect(missingBlob.status).toBe(404);

		const burnResponse = await worker.fetch(
			new IncomingRequest('https://example.com/api/v1/pastes', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					sampleEnvelope({
						adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 1],
					}),
				),
			}),
			env,
			createExecutionContext(),
		);
		const burned = await burnResponse.json();

		const firstRead = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${burned.id}`),
			env,
			createExecutionContext(),
		);
		expect(firstRead.status).toBe(200);

		const secondRead = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${burned.id}`),
			env,
			createExecutionContext(),
		);
		expect(secondRead.status).toBe(409);

		const wrongConsume = await worker.fetch(
			new IncomingRequest(`https://example.com/api/v1/pastes/${burned.id}/consume`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ claimToken: 'wrong-token' }),
			}),
			env,
			createExecutionContext(),
		);
		expect(wrongConsume.status).toBe(400);

		const legacyHeaders = {
			'content-type': 'application/json',
			'X-Requested-With': 'JSONHttpRequest',
		};
		const legacyPaste = await worker.fetch(
			new IncomingRequest('https://example.com/', {
				method: 'POST',
				headers: legacyHeaders,
				body: JSON.stringify(
					sampleEnvelope({
						adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 1, 0],
					}),
				),
			}),
			env,
			createExecutionContext(),
		);
		const legacyCreated = await legacyPaste.json();

		const legacyComment = await worker.fetch(
			new IncomingRequest('https://example.com/', {
				method: 'POST',
				headers: legacyHeaders,
				body: JSON.stringify({
					v: 2,
					adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
					ct: 'legacy-comment-without-parent',
					pasteid: legacyCreated.id,
				}),
			}),
			env,
			createExecutionContext(),
		);
		expect(legacyComment.status).toBe(201);

		const legacyMissingDeleteId = await worker.fetch(
			new IncomingRequest('https://example.com/?pasteid=', {
				method: 'DELETE',
				headers: legacyHeaders,
				body: JSON.stringify({ deletetoken: 'wrong-token' }),
			}),
			env,
			createExecutionContext(),
		);
		expect(legacyMissingDeleteId.status).toBe(400);
	});

	it('runs scheduled cleanup and queue processing', async () => {
		const emptyQueued: unknown[] = [];
		const emptyCtx = createExecutionContext();
		await worker.scheduled?.(
			{} as ScheduledController,
			{
				...env,
				GC_QUEUE: {
					sendBatch: async (messages: unknown[]) => {
						emptyQueued.push(...messages);
					},
				} as Queue,
			},
			emptyCtx,
		);
		await waitOnExecutionContext(emptyCtx);
		expect(emptyQueued).toHaveLength(0);

		await insertExpiredPaste('abababababababab', Date.now() - 10_000);

		const queued: unknown[] = [];
		const ctx = createExecutionContext();
		await worker.scheduled?.(
			{} as ScheduledController,
			{
				...env,
				GC_QUEUE: {
					sendBatch: async (messages: unknown[]) => {
						queued.push(...messages);
					},
				} as Queue,
			},
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(queued).toHaveLength(1);

		const created = await createPaste(
			env,
			{
				envelope: sampleEnvelope(),
				expireKey: '1day',
				turnstileToken: null,
			},
			Date.now(),
		);

		let acked = false;
		let retried = false;
		await worker.queue?.(
			{
				messages: [
					{
						body: { pasteId: created.id, finalStatus: 'expired' },
						ack() {
							acked = true;
						},
						retry() {
							retried = true;
						},
					},
				],
			} as never,
			env,
		);
		expect(acked).toBe(true);
		expect(retried).toBe(false);
		expect(await getEnvelope(env.PASTES_BUCKET, buildPasteBlobKey(created.id))).toBeNull();

		let retriedOnFailure = false;
		await worker.queue?.(
			{
				messages: [
					{
						body: { pasteId: 'ffffffffffffffff', finalStatus: 'expired' },
						ack() {
							throw new Error('ack should not run');
						},
						retry() {
							retriedOnFailure = true;
						},
					},
				],
			} as never,
			{
				...env,
				PASTES_BUCKET: {
					delete: async () => {
						throw new Error('boom');
					},
				} as R2Bucket,
			},
		);
		expect(retriedOnFailure).toBe(true);
	});
});
