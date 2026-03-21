/**
 * Unit tests for config parsing and request-model validation helpers.
 */
import { describe, expect, it } from 'vitest';
import { expireAtFromKey, resolveConfig } from '../src/lib/config';
import {
	assertCommentInput,
	assertPasteInput,
	assertValidId,
	getCipherSpecFromAdata,
	getEnvelopeFlags,
	HttpError,
	isCipherSpec,
	isLegacyCommentEnvelope,
	isLegacyJsonApiCall,
	parseLegacyPasteId,
} from '../src/lib/model';
import { sampleEnvelope } from './support';

describe('config helpers', () => {
	it('uses built-in defaults when env is empty', () => {
		const before = Date.now();
		const config = resolveConfig({} as Env);

		expect(config.appName).toBe('Xbin');
		expect(config.appVersion).toBe('1.0.0');
		expect(config.projectPageUrl).toBe('https://github.com/xixu-me/xbin');
		expect(config.basePath).toBe('/');
		expect(config.maxPasteBytes).toBe(10_000_000);
		expect(config.enableLegacyApi).toBe(true);
		expect(config.requireTurnstile).toBe(false);
		expect(config.supportedExpirations).toEqual(['5min', '10min', '30min', '1hour', '3hour', '6hour', '12hour', '1day', '3day', '1week']);
		expect(config.defaultExpiration).toBe('1hour');
		expect(config.turnstileSiteKey).toBeNull();
		expect(config.burnClaimTtlSeconds).toBe(120);
		expect(config.uiLanguageLabel).toBe('English');
		expect(config.uiLanguageCode).toBe('en');
		expect(config.uiLanguageName).toBe('English');
		expect(config.uiLanguageRtl).toBe(false);
		expect(config.uiLanguages.find((option) => option.id === 'en')).toMatchObject({
			label: 'English',
			name: 'English',
		});
		expect(config.uiLanguages.find((option) => option.id === 'ar')).toMatchObject({
			label: 'العربية',
			name: 'Arabic',
			rtl: true,
		});
		expect(config.uiThemeLabel).toBe('bootstrap5');
		expect(config.uiThemes).toContain('bootstrap-dark');
		expect(config.uiThemes).toContain('bootstrap-compact-page');
		expect(expireAtFromKey('1hour')).toBeGreaterThan(before);
	});

	it('uses defaults and fallbacks when env values are missing or invalid', () => {
		const config = resolveConfig({
			XBIN_SUPPORTED_EXPIRATIONS: 'bogus',
			XBIN_DEFAULT_EXPIRATION: '10min',
			XBIN_MAX_PASTE_BYTES: 'NaN',
			XBIN_ENABLE_LEGACY_API: '0',
			XBIN_REQUIRE_TURNSTILE: '1',
			TURNSTILE_SITE_KEY: 'site-key',
			XBIN_BURN_CLAIM_TTL_SECONDS: 'not-a-number',
		} as Env);

		expect(config.appName).toBe('Xbin');
		expect(config.appVersion).toBe('1.0.0');
		expect(config.projectPageUrl).toBe('https://github.com/xixu-me/xbin');
		expect(config.basePath).toBe('/');
		expect(config.maxPasteBytes).toBe(10_000_000);
		expect(config.enableLegacyApi).toBe(false);
		expect(config.requireTurnstile).toBe(true);
		expect(config.turnstileSiteKey).toBe('site-key');
		expect(config.supportedExpirations).toEqual(['5min', '10min', '30min', '1hour', '3hour', '6hour', '12hour', '1day', '3day', '1week']);
		expect(config.defaultExpiration).toBe('10min');
		expect(config.burnClaimTtlSeconds).toBe(120);
		expect(config.uiLanguageLabel).toBe('English');
		expect(config.uiLanguageCode).toBe('en');
		expect(config.uiLanguageName).toBe('English');
		expect(config.uiLanguageRtl).toBe(false);
		expect(config.uiLanguages).toHaveLength(37);
		expect(config.uiThemeLabel).toBe('bootstrap5');
		expect(config.uiThemes).toHaveLength(7);
	});

	it('parses explicit values and expiration timestamps', () => {
		const config = resolveConfig({
			XBIN_APP_NAME: 'Custom Bin',
			XBIN_APP_VERSION: '9.9.9',
			XBIN_PROJECT_PAGE_URL: 'https://example.com/project',
			XBIN_BASE_PATH: '/nested/',
			XBIN_MAX_PASTE_BYTES: '1234',
			XBIN_DEFAULT_EXPIRATION: 'never',
			XBIN_SUPPORTED_EXPIRATIONS: '5min, never, invalid',
			XBIN_ENABLE_LEGACY_API: 'true',
			XBIN_REQUIRE_TURNSTILE: '0',
			XBIN_BURN_CLAIM_TTL_SECONDS: '45',
		} as Env);

		expect(config.appName).toBe('Custom Bin');
		expect(config.appVersion).toBe('9.9.9');
		expect(config.projectPageUrl).toBe('https://example.com/project');
		expect(config.basePath).toBe('/nested/');
		expect(config.maxPasteBytes).toBe(1234);
		expect(config.enableLegacyApi).toBe(true);
		expect(config.requireTurnstile).toBe(false);
		expect(config.supportedExpirations).toEqual(['5min', 'never']);
		expect(config.defaultExpiration).toBe('never');
		expect(config.burnClaimTtlSeconds).toBe(45);
		expect(config.uiLanguageLabel).toBe('English');
		expect(config.uiLanguageCode).toBe('en');
		expect(config.uiLanguageName).toBe('English');
		expect(config.uiLanguageRtl).toBe(false);
		expect(config.uiLanguages.find((option) => option.id === 'zh')).toMatchObject({
			label: '中文',
			name: 'Chinese',
		});
		expect(config.uiThemeLabel).toBe('bootstrap5');
		expect(config.uiThemes[0]).toBe('bootstrap5');
		expect(expireAtFromKey('5min', 1_000)).toBe(301_000);
		expect(expireAtFromKey('never', 1_000)).toBeNull();
	});
});

describe('model helpers', () => {
	it('parses legacy paste identifiers and legacy API calls', () => {
		expect(parseLegacyPasteId(new URL('https://example.com/?pasteid=abcdef1234567890'))).toBe('abcdef1234567890');
		expect(parseLegacyPasteId(new URL('https://example.com/?abcdef1234567890'))).toBe('abcdef1234567890');
		expect(parseLegacyPasteId(new URL('https://example.com/?foo=bar'))).toBeNull();

		expect(
			isLegacyJsonApiCall(
				new Request('https://example.com', {
					headers: { 'X-Requested-With': 'JSONHttpRequest' },
				}),
			),
		).toBe(true);
		expect(isLegacyJsonApiCall(new Request('https://example.com'))).toBe(false);
	});

	it('validates cipher metadata helpers and envelope flags', () => {
		const spec = ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'] as const;
		expect(isCipherSpec(spec)).toBe(true);
		expect(isCipherSpec(['iv', 'salt'])).toBe(false);
		expect(getCipherSpecFromAdata(spec)).toEqual(spec);
		expect(getCipherSpecFromAdata([null, 'markdown', 1, 1])).toBeNull();
		expect(isLegacyCommentEnvelope({ adata: spec })).toBe(true);
		expect(isLegacyCommentEnvelope({ adata: [null, 'plaintext', 0, 0] })).toBe(false);

		expect(
			getEnvelopeFlags({
				...sampleEnvelope({
					adata: [spec, '', 1, 1],
				}),
			}),
		).toEqual({
			formatter: 'plaintext',
			discussionOpen: true,
			burnAfterReading: true,
		});
		expect(getEnvelopeFlags(sampleEnvelope())).toEqual({
			formatter: 'plaintext',
			discussionOpen: false,
			burnAfterReading: false,
		});
		expect(
			getEnvelopeFlags({
				...sampleEnvelope(),
				adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
			} as never),
		).toEqual({
			formatter: 'plaintext',
			discussionOpen: false,
			burnAfterReading: false,
		});
	});

	it('rejects invalid identifiers and malformed paste payloads', () => {
		expect(() => assertValidId('bad-id', 'paste identifier')).toThrowError(HttpError);
		expect(() => assertPasteInput(null, 100, ['1day'])).toThrow('Invalid data.');

		const oversized = sampleEnvelope({
			ct: 'x'.repeat(20),
			attachment: {
				v: 2,
				adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none']],
				ct: 'x'.repeat(20),
			},
		});
		expect(() => assertPasteInput(oversized, 10, ['1day'])).toThrow('Document exceeds the maximum encrypted size.');

		const conflicting = sampleEnvelope({
			adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'], 'plaintext', 1, 1],
		});
		expect(() => assertPasteInput(conflicting, 100, ['1day'])).toThrow('Burn-after-reading pastes cannot have discussions enabled.');
		expect(() => assertPasteInput(sampleEnvelope({ adata: [null, 'plaintext', 0, 0] }), 100, ['1day'])).toThrow('Invalid data.');
		expect(() =>
			assertPasteInput(
				sampleEnvelope({
					ct: 'short',
					attachment_name: {
						v: 2,
						adata: [['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none']],
						ct: 'x'.repeat(20),
					},
				}),
				10,
				['1day'],
			),
		).toThrow('Document exceeds the maximum encrypted size.');
	});

	it('normalizes paste and comment inputs', () => {
		const paste = assertPasteInput(
			sampleEnvelope({
				meta: { expire: 'invalid-expire' },
				turnstileToken: 'token-123',
			}),
			10_000,
			['1day', '1week'],
		);
		expect(paste.expireKey).toBe('1day');
		expect(paste.turnstileToken).toBe('token-123');

		const comment = assertCommentInput(
			{
				v: 2,
				adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
				ct: 'comment-ciphertext',
				parentid: 'abcdef1234567890',
				turnstileToken: 'comment-token',
			},
			10_000,
			'abcdef1234567890',
		);
		expect(comment.parentId).toBe('abcdef1234567890');
		expect(comment.turnstileToken).toBe('comment-token');

		const fallbackParent = assertCommentInput(
			{
				v: 2,
				adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
				ct: 'comment-ciphertext',
			},
			10_000,
			'abcdef1234567890',
		);
		expect(fallbackParent.parentId).toBe('abcdef1234567890');

		expect(() =>
			assertCommentInput(
				{
					v: 2,
					adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
					ct: 'comment-ciphertext',
					pasteid: 'ffffffffffffffff',
				},
				10_000,
				'abcdef1234567890',
			),
		).toThrow('Comment paste identifier does not match the route.');

		expect(() =>
			assertCommentInput(
				{
					v: 2,
					adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
					ct: 'x'.repeat(100),
				},
				10,
				'abcdef1234567890',
			),
		).toThrow('Comment exceeds the maximum encrypted size.');

		expect(() =>
			assertCommentInput(
				{
					v: 2,
					adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
					ct: 'comment-ciphertext',
					parentId: 'not-an-id',
				},
				10_000,
				'abcdef1234567890',
			),
		).toThrow('Invalid parent identifier.');

		expect(() =>
			assertCommentInput(
				{
					v: 1,
					adata: ['iv', 'salt', 100000, 256, 128, 'aes', 'gcm', 'none'],
					ct: 'comment-ciphertext',
				},
				10_000,
				'abcdef1234567890',
			),
		).toThrow('Invalid data.');

		expect(() =>
			assertCommentInput(
				{
					v: 2,
					adata: [null, 'plaintext', 0, 0],
					ct: 'comment-ciphertext',
				},
				10_000,
				'abcdef1234567890',
			),
		).toThrow('Invalid data.');
	});
});
