/**
 * Cloudflare Worker entrypoint for paste APIs, asset delivery, and background cleanup.
 */
import { DurableObject } from 'cloudflare:workers';
import { resolveConfig } from './lib/config';
import {
	assertCommentInput,
	assertPasteInput,
	assertValidId,
	GENERIC_MISSING_MESSAGE,
	HttpError,
	isLegacyJsonApiCall,
	parseLegacyPasteId,
} from './lib/model';
import {
	claimBurnAfterReading,
	consumeBurnAfterReading,
	coordinatorClaim,
	coordinatorConsume,
	createComment,
	createPaste,
	deletePasteByUser,
	ensurePasteReadable,
	enqueueGcMessages,
	findExpiredPasteIds,
	getPasteRow,
	importPrivateBinBundle,
	loadPasteResponse,
	purgePasteStorage,
	releaseExpiredClaims,
} from './lib/repository';
import type { GcMessage } from './lib/types';

const CREATE_PASTE_BODY_SLACK_BYTES = 512_000;
const IMPORT_BODY_SLACK_BYTES = 2_000_000;
const DELETE_PASTE_BODY_MAX_BYTES = 16_384;
const CONSUME_PASTE_BODY_MAX_BYTES = 8192;
const PASTE_ROUTE_PATTERN = /^\/api\/v1\/pastes\/([a-f0-9]{16})(?:\/(comments|consume))?$/i;

type DeletePastePayload = {
	deleteToken?: string;
	deletetoken?: string;
};

type ConsumePastePayload = {
	claimToken?: string;
};

type LegacyCommentPayload = {
	pasteid?: string;
	parentid?: string;
};

const JSON_HEADERS = {
	'content-type': 'application/json; charset=utf-8',
	'cache-control': 'no-store',
	pragma: 'no-cache',
	expires: '0',
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
	'access-control-allow-headers': 'Authorization, Content-Type, X-Import-Token, X-Requested-With',
	'access-control-expose-headers': 'X-Uncompressed-Content-Length',
} as const satisfies Record<string, string>;

const SECURITY_HEADERS = {
	'cross-origin-resource-policy': 'same-origin',
	'permissions-policy': 'browsing-topics=()',
	'referrer-policy': 'no-referrer',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
} as const satisfies Record<string, string>;

type SeoDocument = {
	title: string;
	description: string;
	robots: string;
	canonicalUrl: string;
	ogTitle: string;
	ogDescription: string;
	twitterTitle: string;
	twitterDescription: string;
};

const HOMEPAGE_ONE_LINER = 'Private, end-to-end encrypted pastebin for secure notes, code, and files.';
const HOMEPAGE_TITLE_SUFFIX = 'Private, end-to-end encrypted pastebin';

// Response helpers shared by the modern API and the legacy PrivateBin-compatible surface.
function json(data: unknown, init: ResponseInit = {}): Response {
	const body = JSON.stringify(data);
	const headers = new Headers(init.headers);
	for (const [key, value] of Object.entries(JSON_HEADERS)) {
		headers.set(key, value);
	}
	headers.set('x-uncompressed-content-length', String(body.length));
	return new Response(body, { ...init, headers });
}

function privateBinSuccess(data: Record<string, unknown>, init: ResponseInit = {}): Response {
	return json({ status: 0, ...data }, init);
}

function privateBinError(message: string, status = 400): Response {
	return json({ status: 1, message }, { status });
}

function apiError(error: unknown): Response {
	if (error instanceof HttpError) {
		return json({ error: error.message }, { status: error.status });
	}
	console.error(error);
	return json({ error: 'Internal server error.' }, { status: 500 });
}

// Request parsing and request-level validation keep the route handlers focused on behavior.
function normalizeBasePath(basePath: string): string {
	if (!basePath || basePath === '/') {
		return '/';
	}
	let start = 0;
	let end = basePath.length;
	while (start < end && basePath.charCodeAt(start) === 47) {
		start += 1;
	}
	while (end > start && basePath.charCodeAt(end - 1) === 47) {
		end -= 1;
	}
	return start === end ? '/' : `/${basePath.slice(start, end)}`;
}

function currentShareBase(url: URL, env: Env): string {
	return `${url.origin}${normalizeBasePath(resolveConfig(env).basePath)}`;
}

function currentShareUrl(url: URL, env: Env, pasteId: string): string {
	return `${currentShareBase(url, env)}?${pasteId}`;
}

function isBareShareQuery(url: URL): boolean {
	return url.search.length > 1 && !url.search.includes('=');
}

function isShareLikeNavigation(url: URL): boolean {
	const searchParams = url.searchParams;
	return isBareShareQuery(url) || searchParams.has('pasteid') || searchParams.has('deletetoken') || url.pathname === '/api/v1/pastes';
}

function buildSeoDocument(url: URL, env: Env): SeoDocument {
	const { appName } = resolveConfig(env);
	const canonicalUrl = currentShareBase(url, env);
	if (isShareLikeNavigation(url)) {
		return {
			title: `Encrypted note on ${appName}`,
			description:
				'Open a secure Xbin share link to decrypt and view a private note in your browser. Shared notes stay out of search results.',
			robots: 'noindex, noarchive',
			canonicalUrl,
			ogTitle: `Encrypted note on ${appName}`,
			ogDescription: 'Visit this link to see the note. Giving the URL to anyone allows them to access the note, too.',
			twitterTitle: `Encrypted note on ${appName}`,
			twitterDescription: 'Visit this link to see the note. Giving the URL to anyone allows them to access the note, too.',
		};
	}

	return {
		title: `${appName} - ${HOMEPAGE_TITLE_SUFFIX}`,
		description: `${appName} is a private, end-to-end encrypted pastebin for secure notes, code, and files, with passwords, expiration, and burn-after-reading links.`,
		robots: 'index,follow',
		canonicalUrl,
		ogTitle: `${appName} - ${HOMEPAGE_TITLE_SUFFIX}`,
		ogDescription: `${HOMEPAGE_ONE_LINER} Add passwords, expiration, and burn-after-reading links when you share.`,
		twitterTitle: `${appName} - ${HOMEPAGE_TITLE_SUFFIX}`,
		twitterDescription: `${HOMEPAGE_ONE_LINER} Add passwords, expiration, and burn-after-reading links when you share.`,
	};
}

function buildJsonRequest(request: Request, payload: unknown): Request {
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: JSON.stringify(payload),
	});
}

function getDeleteToken(payload: unknown): string | null {
	const candidate = payload as DeletePastePayload;
	if (typeof candidate.deleteToken === 'string') {
		return candidate.deleteToken;
	}
	return typeof candidate.deletetoken === 'string' ? candidate.deletetoken : null;
}

function getClaimToken(payload: unknown): string | null {
	const candidate = payload as ConsumePastePayload;
	return typeof candidate.claimToken === 'string' ? candidate.claimToken : null;
}

function shouldServeAppShellForShareNavigation(request: Request, url: URL): boolean {
	if (request.method !== 'GET' || url.pathname !== '/api/v1/pastes') {
		return false;
	}
	if (url.search.length <= 1 || url.search.includes('=')) {
		return false;
	}
	const accept = request.headers.get('accept') ?? '';
	return request.headers.get('sec-fetch-mode') === 'navigate' || accept.includes('text/html');
}

async function parseJsonBody(request: Request, maxBytes: number): Promise<unknown> {
	const contentLength = request.headers.get('content-length');
	if (contentLength && Number(contentLength) > maxBytes) {
		throw new HttpError(413, 'Request exceeds the maximum body size.');
	}
	const text = await request.text();
	if (text.length > maxBytes) {
		throw new HttpError(413, 'Request exceeds the maximum body size.');
	}
	if (!text) {
		throw new HttpError(400, 'Request body is required.');
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(400, 'Request body must be valid JSON.');
	}
}

async function verifyTurnstileIfRequired(request: Request, env: Env, token: string | null): Promise<void> {
	const config = resolveConfig(env);
	if (!config.requireTurnstile) {
		return;
	}
	if (!env.TURNSTILE_SECRET_KEY) {
		throw new HttpError(500, 'Turnstile is required but TURNSTILE_SECRET_KEY is missing.');
	}
	if (!token) {
		throw new HttpError(400, 'Turnstile token is required.');
	}

	const form = new FormData();
	form.set('secret', env.TURNSTILE_SECRET_KEY);
	form.set('response', token);
	const remoteIp = request.headers.get('CF-Connecting-IP');
	if (remoteIp) {
		form.set('remoteip', remoteIp);
	}

	const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		body: form,
	});
	const result = (await response.json()) as { success?: boolean; ['error-codes']?: string[] };
	if (!result.success) {
		throw new HttpError(
			400,
			`Turnstile verification failed${result['error-codes']?.length ? `: ${result['error-codes'].join(', ')}` : '.'}`,
		);
	}
}

function withSecurityHeaders(response: Response, robotsTag = 'noindex, noarchive', disableCaching = false): Response {
	const headers = new Headers(response.headers);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		headers.set(key, value);
	}
	headers.set(
		'content-security-policy',
		"default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
	);
	headers.set('x-robots-tag', robotsTag);
	if (disableCaching) {
		headers.set('cache-control', 'no-store');
		headers.set('pragma', 'no-cache');
		headers.set('expires', '0');
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// API handlers translate validated requests into repository operations and response envelopes.
async function handleCreatePaste(request: Request, env: Env, legacy = false): Promise<Response> {
	const config = resolveConfig(env);
	const payload = await parseJsonBody(request, config.maxPasteBytes + CREATE_PASTE_BODY_SLACK_BYTES);
	const input = assertPasteInput(payload, config.maxPasteBytes, config.supportedExpirations);
	await verifyTurnstileIfRequired(request, env, input.turnstileToken);

	const created = await createPaste(env, input, Date.now());
	const url = new URL(request.url);
	const shareUrl = currentShareUrl(url, env, created.id);

	if (legacy) {
		return privateBinSuccess(
			{
				id: created.id,
				url: shareUrl,
				deletetoken: created.deleteToken,
			},
			{ status: 201 },
		);
	}

	return json(
		{
			id: created.id,
			shareUrl,
			deleteToken: created.deleteToken,
		},
		{ status: 201 },
	);
}

async function handleGetPaste(request: Request, env: Env, pasteId: string, legacy = false): Promise<Response> {
	assertValidId(pasteId, 'paste identifier');
	const now = Date.now();
	const row = ensurePasteReadable(await getPasteRow(env, pasteId), now);

	let claimToken: string | undefined;
	if (row.burn_after_reading === 1) {
		const claim = await claimBurnAfterReading(env, pasteId);
		if (!claim.ok || !claim.claimToken) {
			throw new HttpError(409, claim.message ?? 'Document is already being viewed.');
		}
		claimToken = claim.claimToken;
	}

	const responsePayload = await loadPasteResponse(env, row, now);
	if (!responsePayload) {
		throw new HttpError(404, GENERIC_MISSING_MESSAGE);
	}
	if (claimToken) {
		responsePayload.claimToken = claimToken;
	}

	if (legacy) {
		return privateBinSuccess(
			{
				url: currentShareUrl(new URL(request.url), env, pasteId),
				...responsePayload,
			},
			{ status: 200 },
		);
	}

	return json(responsePayload, { status: 200 });
}

async function handleDeletePaste(request: Request, env: Env, ctx: ExecutionContext, pasteId: string, legacy = false): Promise<Response> {
	assertValidId(pasteId, 'paste identifier');
	const payload = await parseJsonBody(request, DELETE_PASTE_BODY_MAX_BYTES);
	const deleteToken = getDeleteToken(payload);
	if (!deleteToken) {
		throw new HttpError(400, 'Delete token is required.');
	}

	const deleted = await deletePasteByUser(env, pasteId, deleteToken);
	if (!deleted) {
		if (legacy) {
			return privateBinError('Wrong deletion token. Document was not deleted.', 403);
		}
		throw new HttpError(403, 'Delete token is invalid.');
	}

	ctx.waitUntil(purgePasteStorage(env, pasteId, 'deleted'));

	if (legacy) {
		return privateBinSuccess({ id: pasteId, url: currentShareUrl(new URL(request.url), env, pasteId) });
	}

	return json({ id: pasteId, deleted: true });
}

async function handleCreateComment(request: Request, env: Env, pasteId: string, legacy = false): Promise<Response> {
	assertValidId(pasteId, 'paste identifier');
	const config = resolveConfig(env);
	const payload = await parseJsonBody(request, config.maxPasteBytes);
	const input = assertCommentInput(payload, config.maxPasteBytes, pasteId);
	await verifyTurnstileIfRequired(request, env, input.turnstileToken);

	const row = ensurePasteReadable(await getPasteRow(env, pasteId), Date.now());
	if (row.burn_after_reading === 1 || row.discussion_open !== 1) {
		throw new HttpError(400, 'Discussion is disabled for this paste.');
	}

	const commentId = await createComment(env, pasteId, input, Date.now());
	if (legacy) {
		return privateBinSuccess(
			{
				id: commentId,
				url: currentShareUrl(new URL(request.url), env, pasteId),
			},
			{ status: 201 },
		);
	}
	return json({ id: commentId }, { status: 201 });
}

async function handleConsumePaste(request: Request, env: Env, pasteId: string): Promise<Response> {
	assertValidId(pasteId, 'paste identifier');
	const payload = await parseJsonBody(request, CONSUME_PASTE_BODY_MAX_BYTES);
	const claimToken = getClaimToken(payload);
	if (!claimToken) {
		throw new HttpError(400, 'Claim token is required.');
	}
	const result = await consumeBurnAfterReading(env, pasteId, claimToken);
	if (!result.ok) {
		throw new HttpError(400, result.message ?? 'Document could not be consumed.');
	}
	return json({ consumed: true });
}

async function handleConfig(env: Env): Promise<Response> {
	const config = resolveConfig(env);
	return json({
		appName: config.appName,
		appVersion: config.appVersion,
		projectPageUrl: config.projectPageUrl,
		basePath: config.basePath,
		maxPasteBytes: config.maxPasteBytes,
		defaultExpiration: config.defaultExpiration,
		supportedExpirations: config.supportedExpirations,
		requireTurnstile: config.requireTurnstile,
		turnstileSiteKey: config.turnstileSiteKey,
		uiLanguageLabel: config.uiLanguageLabel,
		uiLanguageCode: config.uiLanguageCode,
		uiLanguageName: config.uiLanguageName,
		uiLanguageRtl: config.uiLanguageRtl,
		uiLanguages: config.uiLanguages,
		uiThemeLabel: config.uiThemeLabel,
		uiThemes: config.uiThemes,
	});
}

function getImportTokenFromRequest(request: Request): string | null {
	const authorization = request.headers.get('authorization');
	if (authorization?.startsWith('Bearer ')) {
		return authorization.slice('Bearer '.length).trim();
	}
	return request.headers.get('x-import-token');
}

function assertImportAuthorized(request: Request, env: Env): void {
	if (!env.IMPORT_TOKEN) {
		throw new HttpError(404, 'Import endpoint is not enabled.');
	}
	const provided = getImportTokenFromRequest(request);
	if (!provided || provided !== env.IMPORT_TOKEN) {
		throw new HttpError(401, 'Import token is invalid.');
	}
}

async function handlePrivateBinImport(request: Request, env: Env): Promise<Response> {
	assertImportAuthorized(request, env);
	const payload = await parseJsonBody(request, resolveConfig(env).maxPasteBytes + IMPORT_BODY_SLACK_BYTES);
	const result = await importPrivateBinBundle(env, payload as Parameters<typeof importPrivateBinBundle>[1], Date.now());
	return json(result, { status: result.skipped ? 200 : 201 });
}

// Routing keeps the modern REST API and the legacy PrivateBin surface in one worker.
async function handleLegacyApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	const pasteId = parseLegacyPasteId(url);
	switch (request.method) {
		case 'GET':
			if (!pasteId) {
				throw new HttpError(400, 'Paste identifier is required.');
			}
			return handleGetPaste(request, env, pasteId, true);
		case 'POST': {
			const body = await parseJsonBody(request, resolveConfig(env).maxPasteBytes + CREATE_PASTE_BODY_SLACK_BYTES);
			const candidate = body as LegacyCommentPayload;
			if (typeof candidate.pasteid === 'string') {
				return handleCreateComment(
					buildJsonRequest(request, {
						...(body as Record<string, unknown>),
						parentId: candidate.parentid ?? candidate.pasteid,
					}),
					env,
					candidate.pasteid,
					true,
				);
			}
			return handleCreatePaste(buildJsonRequest(request, body), env, true);
		}
		case 'DELETE':
			if (!pasteId) {
				throw new HttpError(400, 'Paste identifier is required.');
			}
			return handleDeletePaste(request, env, ctx, pasteId, true);
		default:
			throw new HttpError(405, 'Method not allowed.');
	}
}

async function routeApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: JSON_HEADERS });
	}

	if (url.pathname === '/api/v1/config' && request.method === 'GET') {
		return handleConfig(env);
	}

	if (url.pathname === '/api/v1/pastes' && request.method === 'POST') {
		return handleCreatePaste(request, env);
	}

	if (url.pathname === '/api/v1/admin/import/privatebin' && request.method === 'POST') {
		return handlePrivateBinImport(request, env);
	}

	const match = url.pathname.match(PASTE_ROUTE_PATTERN);
	if (!match) {
		throw new HttpError(404, 'API route not found.');
	}
	const [, pasteId, action] = match;

	if (!action && request.method === 'GET') {
		return handleGetPaste(request, env, pasteId);
	}
	if (!action && request.method === 'DELETE') {
		return handleDeletePaste(request, env, ctx, pasteId);
	}
	if (action === 'comments' && request.method === 'POST') {
		return handleCreateComment(request, env, pasteId);
	}
	if (action === 'consume' && request.method === 'POST') {
		return handleConsumePaste(request, env, pasteId);
	}

	throw new HttpError(405, 'Method not allowed.');
}

// Asset responses are normalized because the static binding may fall back to text/plain.
function correctedAssetContentType(request: Request, assetResponse: Response): string {
	const currentType = assetResponse.headers.get('content-type') ?? '';
	if (currentType && !currentType.startsWith('text/plain')) {
		return currentType;
	}

	const pathname = new URL(request.url).pathname.toLowerCase();
	if (pathname.endsWith('.html') || pathname.endsWith('.htm')) {
		return 'text/html; charset=utf-8';
	}
	if (pathname.endsWith('.css')) {
		return 'text/css; charset=utf-8';
	}
	if (pathname.endsWith('.js') || pathname.endsWith('.mjs')) {
		return 'text/javascript; charset=utf-8';
	}
	if (pathname.endsWith('.json') || pathname.endsWith('.map')) {
		return 'application/json; charset=utf-8';
	}
	if (pathname === '/' || !pathname.includes('.')) {
		return 'text/html; charset=utf-8';
	}
	return currentType || 'application/octet-stream';
}

class AttributeRewriter {
	constructor(
		private readonly attributeName: string,
		private readonly value: string,
	) {}

	element(element: Element): void {
		element.setAttribute(this.attributeName, this.value);
	}
}

class TextRewriter {
	constructor(private readonly value: string) {}

	element(element: Element): void {
		element.setInnerContent(this.value);
	}
}

function rewriteSeoMarkup(response: Response, seo: SeoDocument): Response {
	return new HTMLRewriter()
		.on('title', new TextRewriter(seo.title))
		.on('meta#meta-robots', new AttributeRewriter('content', seo.robots))
		.on('meta#meta-description', new AttributeRewriter('content', seo.description))
		.on('link#link-canonical', new AttributeRewriter('href', seo.canonicalUrl))
		.on('meta#meta-og-url', new AttributeRewriter('content', seo.canonicalUrl))
		.on('meta#meta-og-title', new AttributeRewriter('content', seo.ogTitle))
		.on('meta#meta-og-description', new AttributeRewriter('content', seo.ogDescription))
		.on('meta#meta-twitter-title', new AttributeRewriter('content', seo.twitterTitle))
		.on('meta#meta-twitter-description', new AttributeRewriter('content', seo.twitterDescription))
		.transform(response);
}

function robotsTxt(url: URL, env: Env): string {
	const sitemapUrl = new URL('sitemap.xml', currentShareBase(url, env));
	return `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${sitemapUrl.toString()}\n`;
}

function sitemapXml(url: URL, env: Env): string {
	const homepageUrl = currentShareBase(url, env);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		'  <url>',
		`    <loc>${homepageUrl}</loc>`,
		'    <changefreq>weekly</changefreq>',
		'    <priority>1.0</priority>',
		'  </url>',
		'</urlset>',
	].join('\n');
}

async function handleAssetRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'GET' && url.pathname === '/robots.txt') {
		return withSecurityHeaders(
			new Response(robotsTxt(url, env), {
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			}),
			'index,follow',
		);
	}
	if (request.method === 'GET' && url.pathname === '/sitemap.xml') {
		return withSecurityHeaders(
			new Response(sitemapXml(url, env), {
				headers: { 'content-type': 'application/xml; charset=utf-8' },
			}),
			'index,follow',
		);
	}

	const assetResponse = await env.ASSETS.fetch(request);
	const contentType = correctedAssetContentType(request, assetResponse);
	const headers = new Headers(assetResponse.headers);
	headers.set('content-type', contentType);
	let response = new Response(assetResponse.body, {
		status: assetResponse.status,
		statusText: assetResponse.statusText,
		headers,
	});
	const seo = buildSeoDocument(url, env);
	if (contentType.includes('text/html')) {
		response = rewriteSeoMarkup(response, seo);
	}
	return withSecurityHeaders(response, seo.robots, contentType.includes('text/html'));
}

// The coordinator serializes burn-after-reading claims so only one view can consume a paste.
export class PasteCoordinator extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const payload = (await request.json()) as { pasteId?: string; claimToken?: string };
		if (!payload.pasteId) {
			return json({ ok: false, message: 'Paste identifier is required.' }, { status: 400 });
		}
		const config = resolveConfig(this.env);
		if (url.pathname === '/claim') {
			return json(await coordinatorClaim(this.env, payload.pasteId, config.burnClaimTtlSeconds * 1000));
		}
		if (url.pathname === '/consume') {
			if (!payload.claimToken) {
				return json({ ok: false, message: 'Claim token is required.' }, { status: 400 });
			}
			return json(await coordinatorConsume(this.env, payload.pasteId, payload.claimToken));
		}
		return json({ ok: false, message: 'Route not found.' }, { status: 404 });
	}
}

// Worker entrypoints handle HTTP traffic, scheduled cleanup, and queue-driven garbage collection.
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const config = resolveConfig(env);
		try {
			// Some older share links still target the API route, so browser navigations should receive
			// the SPA shell and let the client recover the query or hash locally.
			if (shouldServeAppShellForShareNavigation(request, url)) {
				return await handleAssetRequest(request, env);
			}
			if (url.pathname.startsWith('/api/')) {
				return await routeApi(request, env, ctx, url);
			}
			if (config.enableLegacyApi && isLegacyJsonApiCall(request)) {
				return await handleLegacyApi(request, env, ctx, url);
			}
			return await handleAssetRequest(request, env);
		} catch (error) {
			if (config.enableLegacyApi && isLegacyJsonApiCall(request)) {
				if (error instanceof HttpError) {
					return privateBinError(error.message, error.status);
				}
				console.error(error);
				return privateBinError('Internal server error.', 500);
			}
			return apiError(error);
		}
	},

	async scheduled(_event, env, ctx): Promise<void> {
		const now = Date.now();
		await releaseExpiredClaims(env, now);
		const expiredIds = await findExpiredPasteIds(env, now);
		if (expiredIds.length === 0) {
			return;
		}
		const messages: GcMessage[] = expiredIds.map((pasteId) => ({
			pasteId,
			finalStatus: 'expired',
		}));
		ctx.waitUntil(enqueueGcMessages(env, messages));
	},

	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			try {
				const body = message.body as GcMessage;
				await purgePasteStorage(env, body.pasteId, body.finalStatus);
				message.ack();
			} catch (error) {
				console.error('Queue processing failed', error);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
