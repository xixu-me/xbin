/**
 * Configuration defaults and environment normalization for the worker and browser UI.
 */
export const EXPIRE_SECONDS = {
	'5min': 300,
	'10min': 600,
	'30min': 1800,
	'1hour': 3600,
	'3hour': 10800,
	'6hour': 21600,
	'12hour': 43200,
	'1day': 86400,
	'3day': 259200,
	'1week': 604800,
	'1month': 2592000,
	'1year': 31536000,
	never: 0,
} as const;

export type ExpireKey = keyof typeof EXPIRE_SECONDS;
const DEFAULT_SUPPORTED_EXPIRATIONS = [
	'5min',
	'10min',
	'30min',
	'1hour',
	'3hour',
	'6hour',
	'12hour',
	'1day',
	'3day',
	'1week',
] as const satisfies readonly ExpireKey[];

export interface AppConfig {
	appName: string;
	appVersion: string;
	projectPageUrl: string;
	basePath: string;
	maxPasteBytes: number;
	defaultExpiration: ExpireKey;
	supportedExpirations: ExpireKey[];
	enableLegacyApi: boolean;
	requireTurnstile: boolean;
	turnstileSiteKey: string | null;
	burnClaimTtlSeconds: number;
	uiLanguageLabel: string;
	uiLanguageCode: string;
	uiLanguageName: string;
	uiLanguageRtl: boolean;
	uiLanguages: readonly UiLanguageOption[];
	uiThemeLabel: string;
	uiThemes: readonly UiThemeOption[];
}

const DEFAULT_APP_VERSION = '1.0.0';
const DEFAULT_PROJECT_PAGE_URL = 'https://github.com/xixu-me/xbin';
const DEFAULT_MAX_PASTE_BYTES = 10_000_000;
const DEFAULT_BURN_CLAIM_TTL_SECONDS = 120;
const UI_THEME_OPTIONS = [
	'bootstrap5',
	'bootstrap',
	'bootstrap-page',
	'bootstrap-dark',
	'bootstrap-dark-page',
	'bootstrap-compact',
	'bootstrap-compact-page',
] as const;

export type UiThemeOption = (typeof UI_THEME_OPTIONS)[number];

export interface UiLanguageOption {
	id: string;
	label: string;
	name: string;
	rtl?: boolean;
}

const UI_LANGUAGE_OPTIONS: readonly UiLanguageOption[] = [
	{ id: 'ar', label: 'العربية', name: 'Arabic', rtl: true },
	{ id: 'bg', label: 'български език', name: 'Bulgarian' },
	{ id: 'ca', label: 'català', name: 'Catalan' },
	{ id: 'zh', label: '中文', name: 'Chinese' },
	{ id: 'co', label: 'corsu', name: 'Corsican' },
	{ id: 'cs', label: 'čeština', name: 'Czech' },
	{ id: 'nl', label: 'Nederlands', name: 'Dutch' },
	{ id: 'en', label: 'English', name: 'English' },
	{ id: 'et', label: 'eesti', name: 'Estonian' },
	{ id: 'fi', label: 'suomi', name: 'Finnish' },
	{ id: 'fr', label: 'français', name: 'French' },
	{ id: 'de', label: 'Deutsch', name: 'German' },
	{ id: 'el', label: 'ελληνικά', name: 'Greek' },
	{ id: 'he', label: 'עברית', name: 'Hebrew', rtl: true },
	{ id: 'hi', label: 'हिन्दी', name: 'Hindi' },
	{ id: 'hu', label: 'magyar', name: 'Hungarian' },
	{ id: 'id', label: 'bahasa Indonesia', name: 'Indonesian' },
	{ id: 'it', label: 'italiano', name: 'Italian' },
	{ id: 'ja', label: '日本語', name: 'Japanese' },
	{ id: 'ko', label: '한국어', name: 'Korean' },
	{ id: 'ku', label: 'Kurdî', name: 'Kurdish' },
	{ id: 'la', label: 'lingua latina', name: 'Latin' },
	{ id: 'jbo', label: 'jbobau', name: 'Lojban' },
	{ id: 'lt', label: 'lietuvių kalba', name: 'Lithuanian' },
	{ id: 'no', label: 'Norsk', name: 'Norwegian' },
	{ id: 'oc', label: 'occitan', name: 'Occitan' },
	{ id: 'pl', label: 'polski', name: 'Polish' },
	{ id: 'pt', label: 'português', name: 'Portuguese' },
	{ id: 'ro', label: 'limba română', name: 'Romanian' },
	{ id: 'ru', label: 'Русский', name: 'Russian' },
	{ id: 'sk', label: 'slovenčina', name: 'Slovak' },
	{ id: 'sl', label: 'slovenščina', name: 'Slovene' },
	{ id: 'es', label: 'español', name: 'Spanish' },
	{ id: 'sv', label: 'svenska', name: 'Swedish' },
	{ id: 'th', label: 'ไทย', name: 'Thai' },
	{ id: 'tr', label: 'Türkçe', name: 'Turkish' },
	{ id: 'uk', label: 'українська мова', name: 'Ukrainian' },
];

const DEFAULT_UI_LANGUAGE = UI_LANGUAGE_OPTIONS.find((option) => option.id === 'en')!;
const DEFAULT_UI_THEME_LABEL: UiThemeOption = 'bootstrap5';

// Primitive parsers keep resolveConfig focused on assembling normalized runtime settings.
function parseString(value: string | undefined, fallback: string): string {
	if (typeof value !== 'string') {
		return fallback;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	return value === 'true' || value === '1';
}

function parseNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function isExpireKey(value: string): value is ExpireKey {
	return value in EXPIRE_SECONDS;
}

function parseSupportedExpirations(value: string | undefined): ExpireKey[] {
	if (!value) {
		return [...DEFAULT_SUPPORTED_EXPIRATIONS];
	}
	const entries = value
		.split(',')
		.map((entry) => entry.trim())
		.filter(isExpireKey);
	return entries.length > 0 ? entries : [...DEFAULT_SUPPORTED_EXPIRATIONS];
}

// resolveConfig collects deploy-time env vars into the shape the app expects at runtime.
export function resolveConfig(env: Env): AppConfig {
	const supportedExpirations = parseSupportedExpirations(env.XBIN_SUPPORTED_EXPIRATIONS);
	const requestedDefault = (env.XBIN_DEFAULT_EXPIRATION ?? '1hour') as ExpireKey;
	const defaultExpiration = supportedExpirations.includes(requestedDefault) ? requestedDefault : supportedExpirations[0];
	const currentLanguage = DEFAULT_UI_LANGUAGE;
	const currentTheme = DEFAULT_UI_THEME_LABEL;

	return {
		appName: parseString(env.XBIN_APP_NAME, 'Xbin'),
		appVersion: parseString(env.XBIN_APP_VERSION, DEFAULT_APP_VERSION),
		projectPageUrl: parseString(env.XBIN_PROJECT_PAGE_URL, DEFAULT_PROJECT_PAGE_URL),
		basePath: env.XBIN_BASE_PATH ?? '/',
		maxPasteBytes: parseNumber(env.XBIN_MAX_PASTE_BYTES, DEFAULT_MAX_PASTE_BYTES),
		defaultExpiration,
		supportedExpirations,
		enableLegacyApi: parseBoolean(env.XBIN_ENABLE_LEGACY_API, true),
		requireTurnstile: parseBoolean(env.XBIN_REQUIRE_TURNSTILE, false),
		turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
		burnClaimTtlSeconds: parseNumber(env.XBIN_BURN_CLAIM_TTL_SECONDS, DEFAULT_BURN_CLAIM_TTL_SECONDS),
		uiLanguageLabel: currentLanguage.label,
		uiLanguageCode: currentLanguage.id,
		uiLanguageName: currentLanguage.name,
		uiLanguageRtl: Boolean(currentLanguage.rtl),
		uiLanguages: UI_LANGUAGE_OPTIONS,
		uiThemeLabel: currentTheme,
		uiThemes: UI_THEME_OPTIONS,
	};
}

// Expiration values are stored as absolute timestamps in milliseconds for D1 queries.
export function expireAtFromKey(key: ExpireKey, now = Date.now()): number | null {
	const seconds = EXPIRE_SECONDS[key];
	return seconds === 0 ? null : now + seconds * 1000;
}
