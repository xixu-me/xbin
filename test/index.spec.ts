/**
 * End-to-end style tests for the worker's primary HTTP routes and asset handling.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext, SELF } from 'cloudflare:test';
import worker from '../src/index';
import { SCHEMA_STATEMENTS } from '../src/lib/schema';

// This file keeps its own reset helpers so the main route tests stay self-contained.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function clearBucket(): Promise<void> {
	let cursor: string | undefined;
	do {
		const listed = await env.PASTES_BUCKET.list({ cursor, prefix: 'pastes/' });
		for (const object of listed.objects) {
			await env.PASTES_BUCKET.delete(object.key);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);
}

function sampleEnvelope(options = {}) {
	return {
		v: 2,
		adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 0],
		ct: 'ciphertext',
		meta: { expire: '1day' },
		...options,
	};
}

beforeEach(async () => {
	await env.DB.batch(SCHEMA_STATEMENTS.map((statement) => env.DB.prepare(statement)));
	await env.DB.batch([env.DB.prepare('DELETE FROM comments'), env.DB.prepare('DELETE FROM pastes')]);
	await clearBucket();
});

describe('xbin worker', () => {
	it('serves the app shell', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(response.headers.get('x-robots-tag')).toBe('index,follow');
		expect(await response.text()).toContain('Xbin');
	});

	it('marks share pages as noindex while keeping the homepage indexable', async () => {
		const shareResponse = await SELF.fetch('https://example.com/?abcdef1234567890');
		expect(shareResponse.headers.get('x-robots-tag')).toBe('noindex, noarchive');
		expect(await shareResponse.text()).toContain('Encrypted note on Xbin');
	});

	it('serves robots.txt and sitemap.xml', async () => {
		const robotsResponse = await SELF.fetch('https://example.com/robots.txt');
		expect(robotsResponse.status).toBe(200);
		expect(robotsResponse.headers.get('content-type')).toContain('text/plain');
		expect(await robotsResponse.text()).toContain('Sitemap: https://example.com/sitemap.xml');

		const sitemapResponse = await SELF.fetch('https://example.com/sitemap.xml');
		expect(sitemapResponse.status).toBe(200);
		expect(sitemapResponse.headers.get('content-type')).toContain('application/xml');
		expect(await sitemapResponse.text()).toContain('<loc>https://example.com/</loc>');
	});

	it('corrects html asset responses that arrive as text/plain', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/'),
			{
				...env,
				ASSETS: {
					fetch: async () =>
						new Response('<!doctype html><title>Xbin</title>', {
							headers: { 'content-type': 'text/plain' },
						}),
				} as Fetcher,
			},
			createExecutionContext(),
		);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Xbin');
	});

	it('corrects explicit html asset responses that arrive as text/plain', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/index.html'),
			{
				...env,
				ASSETS: {
					fetch: async () =>
						new Response('<!doctype html><title>Xbin</title>', {
							headers: { 'content-type': 'text/plain' },
						}),
				} as Fetcher,
			},
			createExecutionContext(),
		);
		expect(response.headers.get('content-type')).toContain('text/html');
	});

	it('corrects javascript asset responses that arrive as text/plain', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/app.js'),
			{
				...env,
				ASSETS: {
					fetch: async () =>
						new Response('console.log(\"ok\");', {
							headers: { 'content-type': 'text/plain' },
						}),
				} as Fetcher,
			},
			createExecutionContext(),
		);
		expect(response.headers.get('content-type')).toContain('text/javascript');
	});

	it('corrects css asset responses that arrive as text/plain', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/app.css'),
			{
				...env,
				ASSETS: {
					fetch: async () =>
						new Response('body{}', {
							headers: { 'content-type': 'text/plain' },
						}),
				} as Fetcher,
			},
			createExecutionContext(),
		);
		expect(response.headers.get('content-type')).toContain('text/css');
	});

	it('returns share URLs that point to the app shell', async () => {
		const createRequest = new IncomingRequest('https://example.com/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(sampleEnvelope()),
		});
		const createCtx = createExecutionContext();
		const createResponse = await worker.fetch(
			createRequest,
			{
				...env,
				XBIN_BASE_PATH: '/xbin',
			},
			createCtx,
		);
		const created = await createResponse.json();
		expect(createResponse.status).toBe(201);
		expect(created.shareUrl).toBe(`https://example.com/xbin?${created.id}`);
	});

	it('normalizes slash-heavy base paths without regex backtracking', async () => {
		const createRequest = new IncomingRequest('https://example.com/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(sampleEnvelope()),
		});
		const createResponse = await worker.fetch(
			createRequest,
			{
				...env,
				XBIN_BASE_PATH: `${'/'.repeat(2048)}nested${'/'.repeat(2048)}`,
			},
			createExecutionContext(),
		);
		const created = await createResponse.json();
		expect(createResponse.status).toBe(201);
		expect(created.shareUrl).toBe(`https://example.com/nested?${created.id}`);
	});

	it('serves the app shell for browser visits to old API-style share URLs', async () => {
		const response = await SELF.fetch('https://example.com/api/v1/pastes?abcdef1234567890', {
			headers: { accept: 'text/html' },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Xbin');
	});

	it('fills in missing asset content types for maps, extensionless paths, and unknown files', async () => {
		const assetEnv = {
			...env,
			ASSETS: {
				fetch: async (request: Request) => {
					const pathname = new URL(request.url).pathname;
					if (pathname.endsWith('.bin')) {
						return new Response(null);
					}
					return new Response('body');
				},
			} as Fetcher,
		};

		const mapResponse = await worker.fetch(new IncomingRequest('https://example.com/app.js.map'), assetEnv, createExecutionContext());
		expect(mapResponse.headers.get('content-type')).toContain('application/json');

		const extensionlessResponse = await worker.fetch(new IncomingRequest('https://example.com/about'), assetEnv, createExecutionContext());
		expect(extensionlessResponse.headers.get('content-type')).toContain('text/html');

		const binaryResponse = await worker.fetch(new IncomingRequest('https://example.com/archive.bin'), assetEnv, createExecutionContext());
		expect(binaryResponse.headers.get('content-type')).toBe('application/octet-stream');
	});

	it('creates, reads, and deletes a paste', async () => {
		const createRequest = new IncomingRequest('https://example.com/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(sampleEnvelope()),
		});
		const createCtx = createExecutionContext();
		const createResponse = await worker.fetch(createRequest, env, createCtx);
		const created = await createResponse.json();
		expect(createResponse.status).toBe(201);
		expect(created.id).toMatch(/^[a-f0-9]{16}$/);

		const getRequest = new IncomingRequest(`https://example.com/api/v1/pastes/${created.id}`);
		const getCtx = createExecutionContext();
		const getResponse = await worker.fetch(getRequest, env, getCtx);
		const fetched = await getResponse.json();
		expect(getResponse.status).toBe(200);
		expect(fetched.ct).toBe('ciphertext');

		const deleteRequest = new IncomingRequest(`https://example.com/api/v1/pastes/${created.id}`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deleteToken: created.deleteToken }),
		});
		const deleteCtx = createExecutionContext();
		const deleteResponse = await worker.fetch(deleteRequest, env, deleteCtx);
		expect(deleteResponse.status).toBe(200);
		await waitOnExecutionContext(deleteCtx);

		const missingResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}`);
		expect(missingResponse.status).toBe(404);
	});

	it('supports burn-after-reading claim and consume', async () => {
		const createResponse = await SELF.fetch('https://example.com/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(
				sampleEnvelope({
					adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 0, 1],
				}),
			),
		});
		const created = await createResponse.json();

		const fetchResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}`);
		const fetched = await fetchResponse.json();
		expect(fetchResponse.status).toBe(200);
		expect(typeof fetched.claimToken).toBe('string');

		const consumeResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}/consume`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ claimToken: fetched.claimToken }),
		});
		expect(consumeResponse.status).toBe(200);

		const missingResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}`);
		expect(missingResponse.status).toBe(404);
	});

	it('creates comments for discussion-enabled pastes', async () => {
		const createResponse = await SELF.fetch('https://example.com/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(
				sampleEnvelope({
					adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 1, 0],
				}),
			),
		});
		const created = await createResponse.json();

		const commentResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}/comments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(sampleEnvelope({ parentId: created.id })),
		});
		expect(commentResponse.status).toBe(201);

		const getResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}`);
		const fetched = await getResponse.json();
		expect(fetched.comments).toHaveLength(1);
	});

	it('accepts legacy PrivateBin comment envelopes', async () => {
		const createResponse = await SELF.fetch('https://example.com/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(
				sampleEnvelope({
					adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 1, 0],
				}),
			),
		});
		const created = await createResponse.json();

		const legacyComment = {
			v: 2,
			adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
			ct: 'legacy-comment-ciphertext',
			pasteid: created.id,
			parentid: created.id,
			meta: { created: 1_700_000_001 },
		};

		const commentResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}/comments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(legacyComment),
		});
		expect(commentResponse.status).toBe(201);

		const getResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${created.id}`);
		const fetched = await getResponse.json();
		expect(fetched.comments).toHaveLength(1);
		expect(fetched.comments[0].adata[0]).toBe('iv');
		expect(fetched.comments[0].parentId).toBe(created.id);
	});

	it('imports a PrivateBin filesystem bundle through the admin endpoint', async () => {
		const pasteId = 'abcdef1234567890';
		const commentId = '1234567890abcdef';
		const importRequest = new IncomingRequest('https://example.com/api/v1/admin/import/privatebin', {
			method: 'POST',
			headers: {
				authorization: 'Bearer test-import-token',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				source: 'privatebin-filesystem',
				pasteId,
				paste: sampleEnvelope({
					meta: { created: 1_700_000_000, expire_date: 4_102_444_800 },
				}),
				comments: [
					{
						id: commentId,
						v: 2,
						adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
						ct: 'imported-comment-ciphertext',
						pasteid: pasteId,
						parentid: pasteId,
						meta: { created: 1_700_000_001 },
					},
				],
			}),
		});
		const importCtx = createExecutionContext();
		const importResponse = await worker.fetch(
			importRequest,
			{
				...env,
				IMPORT_TOKEN: 'test-import-token',
			},
			importCtx,
		);
		const imported = await importResponse.json();
		expect(importResponse.status).toBe(201);
		expect(imported.id).toBe(pasteId);
		expect(imported.importedComments).toBe(1);
		expect(typeof imported.deleteToken).toBe('string');

		const getResponse = await SELF.fetch(`https://example.com/api/v1/pastes/${pasteId}`);
		const fetched = await getResponse.json();
		expect(getResponse.status).toBe(200);
		expect(fetched.id).toBe(pasteId);
		expect(fetched.comments).toHaveLength(1);
		expect(fetched.comments[0].id).toBe(commentId);
		expect(fetched.comments[0].adata[0]).toBe('iv');
		expect(fetched.meta.created_at).toBe(1_700_000_000_000);
	});
});
