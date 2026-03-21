/**
 * Browser app for composing, encrypting, viewing, and sharing encrypted pastes.
 */
const THEME_STORAGE_KEY = 'theme';
const LOAD_CONFIRM_PREFIX = '-';

// Static labels and runtime state drive both the compose and read-only views.
const EXPIRATION_LABELS = {
	'5min': '5 minutes',
	'10min': '10 minutes',
	'30min': '30 minutes',
	'1hour': '1 hour',
	'3hour': '3 hours',
	'6hour': '6 hours',
	'12hour': '12 hours',
	'1day': '1 day',
	'3day': '3 days',
	'1week': '1 week',
	'1month': '1 month',
	'1year': '1 year',
	never: 'Never',
};

const DURATION_LABELS = {
	300: '5 minutes',
	600: '10 minutes',
	1800: '30 minutes',
	3600: '1 hour',
	10800: '3 hours',
	21600: '6 hours',
	43200: '12 hours',
	86400: '1 day',
	259200: '3 days',
	604800: '1 week',
	2592000: '1 month',
	31536000: '1 year',
};

const state = {
	config: null,
	page: 'compose',
	composerTab: 'editor',
	pasteId: null,
	pasteKey: null,
	claimToken: null,
	loadConfirmRequired: false,
	viewPassword: '',
	pasteData: null,
	currentFormatter: 'plaintext',
	currentAttachments: [],
	shareResultUrl: null,
	shareDeleteUrl: null,
	draftFiles: [],
	pendingAttachmentEntries: [],
	retryAction: null,
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const bootstrapApi = window.bootstrap;
const markdownConverter =
	typeof window.showdown !== 'undefined'
		? new window.showdown.Converter({
				simplifiedAutoLink: true,
				strikethrough: true,
				tables: true,
				tasklists: true,
				ghCodeBlocks: true,
				simpleLineBreaks: true,
			})
		: null;

const elements = {
	body: document.body,
	brandLink: document.getElementById('brand-link'),
	brandIcon: document.getElementById('brand-icon'),
	metaTwitterTitle: document.getElementById('meta-twitter-title'),
	metaOgTitle: document.getElementById('meta-og-title'),
	metaOgSiteName: document.getElementById('meta-og-site-name'),
	loadingindicator: document.getElementById('loadingindicator'),
	loadingindicatorText: document.getElementById('loadingindicator-text'),
	retrybutton: document.getElementById('retrybutton'),
	newbutton: document.getElementById('newbutton'),
	clonebutton: document.getElementById('clonebutton'),
	rawtextbutton: document.getElementById('rawtextbutton'),
	downloadtextbutton: document.getElementById('downloadtextbutton'),
	emaillink: document.getElementById('emaillink'),
	qrcodelink: document.getElementById('qrcodelink'),
	pasteExpiration: document.getElementById('pasteExpiration'),
	burnafterreading: document.getElementById('burnafterreading'),
	opendiscussion: document.getElementById('opendiscussion'),
	passwordinput: document.getElementById('passwordinput'),
	file: document.getElementById('file'),
	customattachment: document.getElementById('customattachment'),
	fileremovebutton: document.getElementById('fileremovebutton'),
	pasteFormatter: document.getElementById('pasteFormatter'),
	themeToggle: document.getElementById('bd-theme'),
	editorTabs: document.getElementById('editorTabs'),
	messageedit: document.getElementById('messageedit'),
	messagepreview: document.getElementById('messagepreview'),
	sendbutton: document.getElementById('sendbutton'),
	remainingtime: document.getElementById('remainingtime'),
	remainingtimeText: document.getElementById('remainingtime-text'),
	attachment: document.getElementById('attachment'),
	attachmentPreview: document.getElementById('attachmentPreview'),
	status: document.getElementById('status'),
	statusText: document.getElementById('status-text'),
	newFromAlert: document.getElementById('new-from-alert'),
	errormessage: document.getElementById('errormessage'),
	errorText: document.getElementById('error-text'),
	pastesuccess: document.getElementById('pastesuccess'),
	copyLink: document.getElementById('copyLink'),
	deletelink: document.getElementById('deletelink'),
	pastelink: document.getElementById('pastelink'),
	placeholder: document.getElementById('placeholder'),
	copyShortcutHint: document.getElementById('copyShortcutHint'),
	copyShortcutHintText: document.getElementById('copyShortcutHintText'),
	prettymessage: document.getElementById('prettymessage'),
	prettyprint: document.getElementById('prettyprint'),
	prettyMessageCopyBtn: document.getElementById('prettyMessageCopyBtn'),
	copyIcon: document.getElementById('copyIcon'),
	copySuccessIcon: document.getElementById('copySuccessIcon'),
	plaintext: document.getElementById('plaintext'),
	message: document.getElementById('message'),
	messagetab: document.getElementById('messagetab'),
	discussion: document.getElementById('discussion'),
	commentcontainer: document.getElementById('commentcontainer'),
	loadingnotice: document.getElementById('loadingnotice'),
	footerAppName: document.getElementById('footer-app-name'),
	footerVersion: document.getElementById('footer-version'),
	aboutAppName: document.getElementById('about-app-name'),
	projectPageLink: document.getElementById('project-page-link'),
	passwordmodal: document.getElementById('passwordmodal'),
	passwordform: document.getElementById('passwordform'),
	passworddecrypt: document.getElementById('passworddecrypt'),
	loadconfirmmodal: document.getElementById('loadconfirmmodal'),
	loadconfirmOpenNow: document.getElementById('loadconfirm-open-now'),
	qrcodemodal: document.getElementById('qrcodemodal'),
	qrcodeDisplay: document.getElementById('qrcode-display'),
	emailconfirmmodal: document.getElementById('emailconfirmmodal'),
	emailconfirmTimezoneCurrent: document.getElementById('emailconfirm-timezone-current'),
	emailconfirmTimezoneUtc: document.getElementById('emailconfirm-timezone-utc'),
	commenttemplate: document.getElementById('commenttemplate'),
	commenttailtemplate: document.getElementById('commenttailtemplate'),
	replytemplate: document.getElementById('replytemplate'),
	attachmenttemplate: document.getElementById('attachmenttemplate'),
	dropzone: document.getElementById('dropzone'),
	composeControls: [
		document.getElementById('expiration'),
		document.getElementById('burnafterreadingoption'),
		document.getElementById('opendiscussionoption'),
		document.getElementById('password'),
		document.getElementById('attach'),
		document.getElementById('formatter'),
	],
	passwordToggles: [...document.querySelectorAll('.toggle-password')],
};

// Encoding and crypto helpers mirror the PrivateBin-style client-side envelope format.
function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (character) => {
		switch (character) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			case "'":
				return '&#39;';
			default:
				return character;
		}
	});
}

function sanitizeUrl(url) {
	try {
		const normalized = new URL(url, window.location.origin);
		if (['http:', 'https:', 'mailto:'].includes(normalized.protocol)) {
			return normalized.href;
		}
	} catch {
		return null;
	}
	return null;
}

function bytesToBase64(bytes) {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function base64Encode(bytes) {
	return bytesToBase64(bytes);
}

function base64Decode(value) {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(bytes) {
	return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
	return base64Decode(value);
}

function randomKey() {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function buildCipherSpec() {
	const iv = crypto.getRandomValues(new Uint8Array(16));
	const salt = crypto.getRandomValues(new Uint8Array(8));
	return [base64Encode(iv), base64Encode(salt), 100000, 256, 128, 'aes', 'gcm', 'none'];
}

function getCipherSpec(envelope) {
	if (!Array.isArray(envelope?.adata)) {
		throw new Error('Envelope is missing authenticated data.');
	}
	return Array.isArray(envelope.adata[0]) ? envelope.adata[0] : envelope.adata;
}

async function deriveKey(secretKey, password, spec) {
	const secretBytes = base64UrlDecode(secretKey);
	const passwordBytes = textEncoder.encode(password ?? '');
	const material = new Uint8Array(secretBytes.length + passwordBytes.length);
	material.set(secretBytes);
	material.set(passwordBytes, secretBytes.length);

	const keyMaterial = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey']);
	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			salt: base64Decode(spec[1]),
			iterations: Number(spec[2]),
		},
		keyMaterial,
		{ name: `AES-${String(spec[6] ?? 'gcm').toUpperCase()}`, length: Number(spec[3]) },
		false,
		['encrypt', 'decrypt'],
	);
}

async function encryptCipherPayload(value, secretKey, password, adata, spec) {
	const key = await deriveKey(secretKey, password, spec);
	const cipherText = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: base64Decode(spec[0]),
			tagLength: Number(spec[4]),
			additionalData: textEncoder.encode(JSON.stringify(adata)),
		},
		key,
		textEncoder.encode(JSON.stringify(value)),
	);

	return {
		v: 2,
		adata,
		ct: base64Encode(new Uint8Array(cipherText)),
	};
}

async function encryptPasteEnvelope(value, secretKey, password, formatter, discussionOpen, burnAfterReading) {
	const spec = buildCipherSpec();
	const adata = [spec, formatter, discussionOpen ? 1 : 0, burnAfterReading ? 1 : 0];
	return encryptCipherPayload(value, secretKey, password, adata, spec);
}

async function encryptCommentEnvelope(value, secretKey, password) {
	const spec = buildCipherSpec();
	return encryptCipherPayload(value, secretKey, password, spec, spec);
}

function buildDecryptAlgorithm(spec, adata) {
	const mode = String(spec[6] ?? 'gcm').toLowerCase();
	const iv = base64Decode(spec[0]);
	if (mode === 'gcm') {
		return {
			name: 'AES-GCM',
			iv,
			tagLength: Number(spec[4]),
			additionalData: textEncoder.encode(JSON.stringify(adata)),
		};
	}
	if (mode === 'cbc') {
		return { name: 'AES-CBC', iv };
	}
	if (mode === 'ctr') {
		return { name: 'AES-CTR', counter: iv, length: 128 };
	}
	throw new Error(`Unsupported cipher mode: ${mode}`);
}

async function inflateBytes(bytes, format) {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function maybeDecompress(bytes, mode) {
	if (mode !== 'zlib') {
		return bytes;
	}
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This browser cannot decompress legacy PrivateBin payloads.');
	}
	try {
		return await inflateBytes(bytes, 'deflate');
	} catch {
		return inflateBytes(bytes, 'deflate-raw');
	}
}

async function decryptEnvelope(envelope, secretKey, password) {
	const spec = getCipherSpec(envelope);
	const key = await deriveKey(secretKey, password, spec);
	const plaintext = await crypto.subtle.decrypt(buildDecryptAlgorithm(spec, envelope.adata), key, base64Decode(envelope.ct));
	const decompressed = await maybeDecompress(new Uint8Array(plaintext), String(spec[7] ?? 'none').toLowerCase());
	return JSON.parse(textDecoder.decode(decompressed));
}

// UI chrome helpers keep the SPA shell, theme, and rendered content in sync with app state.
function humanizeExpiration(value) {
	return EXPIRATION_LABELS[value] ?? value;
}

function secondsToHuman(seconds) {
	const minute = 60;
	const hour = 3600;
	const day = 86400;
	const month = 2592000;
	if (seconds < minute) {
		return [Math.floor(seconds), 'second'];
	}
	if (seconds < hour) {
		return [Math.floor(seconds / minute), 'minute'];
	}
	if (seconds < day) {
		return [Math.floor(seconds / hour), 'hour'];
	}
	if (seconds < 2 * month) {
		return [Math.floor(seconds / day), 'day'];
	}
	return [Math.floor(seconds / month), 'month'];
}

function humanizeDuration(seconds) {
	if (DURATION_LABELS[seconds]) {
		return DURATION_LABELS[seconds];
	}
	const [value, unit] = secondsToHuman(seconds);
	return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function buildHomeUrl() {
	const basePath = state.config?.basePath ?? '/';
	return new URL(basePath, window.location.origin);
}

function buildShareUrl(shareUrlFromServer, secretKey, burnAfterReading) {
	return `${shareUrlFromServer}#${burnAfterReading ? LOAD_CONFIRM_PREFIX : ''}${secretKey}`;
}

function buildDeleteUrl(pasteId, deleteToken) {
	const url = buildHomeUrl();
	url.searchParams.set('pasteid', pasteId);
	url.searchParams.set('deletetoken', deleteToken);
	return url.toString();
}

function isSharePageLocation() {
	return Boolean(getPasteLocation().pasteId);
}

function getPasteLocation() {
	const params = new URLSearchParams(window.location.search);
	let pasteId = params.get('pasteid');
	if (!pasteId && window.location.search.startsWith('?') && !window.location.search.includes('=')) {
		pasteId = window.location.search.slice(1);
	}
	const hash = window.location.hash ? window.location.hash.slice(1) : null;
	const loadConfirmRequired = hash ? hash.startsWith(LOAD_CONFIRM_PREFIX) : false;
	const pasteKey = hash ? (loadConfirmRequired ? hash.slice(LOAD_CONFIRM_PREFIX.length) : hash) : null;
	return {
		pasteId,
		pasteKey,
		deleteToken: params.get('deletetoken'),
		loadConfirmRequired,
	};
}

function selectText(element) {
	const selection = window.getSelection();
	const range = document.createRange();
	range.selectNodeContents(element);
	selection.removeAllRanges();
	selection.addRange(range);
}

function hideLoading() {
	elements.body.classList.remove('loading');
	elements.loadingindicator.classList.add('hidden');
}

function showLoading(message) {
	elements.body.classList.add('loading');
	elements.loadingindicator.classList.remove('hidden');
	elements.loadingindicatorText.textContent = message;
}

function setRetryAction(action) {
	state.retryAction = action;
	elements.retrybutton.classList.toggle('hidden', typeof action !== 'function');
}

function showAlert(target, textElement, message, showStartOver = false) {
	textElement.textContent = message;
	target.classList.remove('hidden');
	elements.newFromAlert.classList.toggle('hidden', !showStartOver);
}

function hideStatus() {
	elements.status.classList.add('hidden');
	elements.statusText.textContent = '';
	elements.newFromAlert.classList.add('hidden');
}

function hideError() {
	elements.errormessage.classList.add('hidden');
	elements.errorText.textContent = '';
}

function hideRemaining() {
	elements.remainingtime.classList.add('hidden');
	elements.remainingtime.classList.remove('foryoureyesonly');
	elements.remainingtimeText.textContent = '';
}

function showStatus(message, showStartOver = false) {
	hideError();
	showAlert(elements.status, elements.statusText, message, showStartOver);
}

function showError(message) {
	hideStatus();
	elements.errorText.textContent = message;
	elements.errormessage.classList.remove('hidden');
}

function showRemaining(message, burnAfterReading = false) {
	elements.remainingtimeText.textContent = message;
	elements.remainingtime.classList.toggle('foryoureyesonly', burnAfterReading);
	elements.remainingtime.classList.remove('hidden');
}

function setCopyShortcutHint(message = '') {
	elements.copyShortcutHintText.innerHTML = message;
	elements.copyShortcutHint.classList.toggle('hidden', message.length === 0);
}

function setTheme(theme) {
	document.documentElement.setAttribute('data-bs-theme', theme);
	elements.themeToggle.checked = theme === 'dark';
}

function preferredTheme() {
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function initializeTheme() {
	const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
	setTheme(stored === 'light' || stored === 'dark' ? stored : preferredTheme());
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
		if (!window.localStorage.getItem(THEME_STORAGE_KEY)) {
			setTheme(preferredTheme());
		}
	});
}

function syncBranding(appName) {
	document.title = isSharePageLocation() ? `Encrypted note on ${appName}` : `${appName} - Private, end-to-end encrypted pastebin`;
	elements.brandIcon.alt = appName;
	elements.footerAppName.textContent = appName;
	elements.aboutAppName.textContent = appName;
	elements.metaTwitterTitle?.setAttribute('content', `Encrypted note on ${appName}`);
	elements.metaOgTitle?.setAttribute('content', appName);
	elements.metaOgSiteName?.setAttribute('content', appName);
}

function syncUiChrome(config) {
	syncBranding(config.appName);
	document.documentElement.lang = config.uiLanguageCode ?? 'en';
	if (config.uiLanguageRtl) {
		document.documentElement.setAttribute('dir', 'rtl');
	} else {
		document.documentElement.removeAttribute('dir');
	}
	if (elements.footerVersion) {
		elements.footerVersion.textContent = config.appVersion ?? '1.0.0';
	}
	if (elements.projectPageLink && config.projectPageUrl) {
		elements.projectPageLink.href = config.projectPageUrl;
	}
}

function renderExpirationOptions(config) {
	elements.pasteExpiration.innerHTML = '';
	for (const value of config.supportedExpirations) {
		const option = document.createElement('option');
		option.value = value;
		option.textContent = humanizeExpiration(value);
		if (value === config.defaultExpiration) {
			option.selected = true;
		}
		elements.pasteExpiration.append(option);
	}
}

function hardenLinks(container) {
	container.querySelectorAll('a').forEach((link) => {
		link.setAttribute('target', '_blank');
		link.setAttribute('rel', 'noreferrer noopener');
	});
}

function linkifyPlainText(text) {
	const escaped = escapeHtml(text);
	return escaped.replace(/((?:https?:\/\/|mailto:)[^\s<]+)/g, (match) => {
		const safeUrl = sanitizeUrl(match);
		if (!safeUrl) {
			return match;
		}
		return `<a href="${escapeHtml(safeUrl)}">${match}</a>`;
	});
}

function sanitizeHtml(html) {
	if (window.DOMPurify) {
		return window.DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
		});
	}
	return html;
}

function clearRenderedMessage() {
	elements.placeholder.classList.add('hidden');
	elements.prettymessage.classList.add('hidden');
	elements.plaintext.classList.add('hidden');
	elements.plaintext.classList.remove('markdown-view');
	elements.plaintext.innerHTML = '';
	elements.prettyprint.innerHTML = '';
}

function renderMessageContent(content, formatter) {
	clearRenderedMessage();
	if (!content) {
		elements.placeholder.classList.remove('hidden');
		return;
	}

	if (formatter === 'markdown' && markdownConverter) {
		const html = sanitizeHtml(markdownConverter.makeHtml(content));
		elements.plaintext.classList.add('markdown-view');
		elements.plaintext.innerHTML = html;
		elements.plaintext.classList.remove('hidden');
		hardenLinks(elements.plaintext);
		return;
	}

	if (formatter === 'syntaxhighlighting') {
		const escaped = escapeHtml(content);
		const highlighted = window.PR && typeof window.PR.prettyPrintOne === 'function' ? window.PR.prettyPrintOne(escaped) : escaped;
		elements.prettyprint.innerHTML = highlighted;
		elements.prettymessage.classList.remove('hidden');
		return;
	}

	elements.plaintext.innerHTML = linkifyPlainText(content).replace(/\n/g, '<br />');
	elements.plaintext.classList.remove('hidden');
	hardenLinks(elements.plaintext);
}

function renderPreview() {
	renderMessageContent(elements.message.value, elements.pasteFormatter.value);
}

function setComposerTab(tab) {
	state.composerTab = tab;
	const preview = tab === 'preview';
	elements.messageedit.classList.toggle('active', !preview);
	elements.messagepreview.classList.toggle('active', preview);
	elements.message.classList.toggle('hidden', preview);
	if (preview) {
		renderPreview();
	} else {
		clearRenderedMessage();
	}
}

function updateTopNav() {
	const isCompose = state.page === 'compose';
	const hasPaste = Boolean(state.pasteData);
	const isBurn = state.pasteData?.adata?.[3] === 1;

	elements.body.dataset.page = isCompose ? 'compose' : 'view';
	elements.body.dataset.hasPaste = hasPaste ? 'true' : 'false';

	for (const control of elements.composeControls) {
		control.classList.toggle('hidden', !isCompose);
	}

	elements.editorTabs.classList.toggle('hidden', !isCompose);
	elements.sendbutton.classList.toggle('hidden', !isCompose);
	elements.newbutton.classList.toggle('hidden', false);
	elements.clonebutton.classList.toggle('hidden', isCompose || !hasPaste || isBurn);
	elements.rawtextbutton.classList.toggle('hidden', isCompose || !hasPaste);
	elements.downloadtextbutton.classList.toggle('hidden', isCompose || !hasPaste);
	elements.emaillink.classList.toggle('hidden', isCompose || !hasPaste || isBurn);
	elements.qrcodelink.classList.toggle('hidden', isCompose || !hasPaste || isBurn);
}

// Attachment helpers support uploads from the composer and legacy nested attachment payloads.
function updateAttachmentComposerSummary() {
	elements.customattachment.innerHTML = '';
	if (state.pendingAttachmentEntries.length > 0) {
		for (const entry of state.pendingAttachmentEntries) {
			const chip = document.createElement('div');
			chip.className = 'attachment-chip';
			chip.textContent = `Attached: ${entry.name}`;
			elements.customattachment.append(chip);
		}
		elements.customattachment.classList.remove('hidden');
		return;
	}
	if (state.draftFiles.length > 0) {
		for (const file of state.draftFiles) {
			const chip = document.createElement('div');
			chip.className = 'attachment-chip';
			chip.textContent = `Attached: ${file.name}`;
			elements.customattachment.append(chip);
		}
		elements.customattachment.classList.remove('hidden');
		return;
	}
	elements.customattachment.classList.add('hidden');
}

function clearDraftAttachments() {
	state.draftFiles = [];
	state.pendingAttachmentEntries = [];
	elements.file.value = '';
	updateAttachmentComposerSummary();
}

function readAttachmentFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve({ name: file.name, dataUrl: reader.result });
		reader.onerror = () => reject(new Error('Failed to read attachment.'));
		reader.readAsDataURL(file);
	});
}

async function collectAttachmentEntries() {
	if (state.pendingAttachmentEntries.length > 0) {
		return state.pendingAttachmentEntries;
	}
	const files = state.draftFiles.length > 0 ? state.draftFiles : [...elements.file.files];
	if (files.length === 0) {
		return [];
	}
	return Promise.all(files.map((file) => readAttachmentFile(file)));
}

function normalizeAttachmentEntries(attachment, attachmentName) {
	if (Array.isArray(attachment) && Array.isArray(attachmentName)) {
		return attachment
			.map((dataUrl, index) => ({
				dataUrl,
				name: attachmentName[index] ?? `attachment-${index + 1}`,
			}))
			.filter((entry) => typeof entry.dataUrl === 'string' && typeof entry.name === 'string');
	}
	if (typeof attachment === 'string' && typeof attachmentName === 'string') {
		return [{ dataUrl: attachment, name: attachmentName }];
	}
	return [];
}

async function loadLegacyNestedAttachments(payload, secretKey, password) {
	if (!payload.attachment || !payload.attachment_name) {
		return [];
	}
	const attachment = await decryptEnvelope(payload.attachment, secretKey, password);
	const attachmentName = await decryptEnvelope(payload.attachment_name, secretKey, password);
	return normalizeAttachmentEntries(attachment.attachment, attachmentName.attachment_name);
}

function renderAttachmentPreview(entries) {
	elements.attachmentPreview.innerHTML = '';
	if (!entries.length) {
		elements.attachmentPreview.classList.add('hidden');
		return;
	}
	const previewable = entries.find((entry) => typeof entry.dataUrl === 'string' && entry.dataUrl.startsWith('data:'));
	if (!previewable) {
		elements.attachmentPreview.classList.add('hidden');
		return;
	}
	const label = document.createElement('div');
	label.className = 'attachment-preview-label';
	label.textContent = previewable.name;
	elements.attachmentPreview.append(label);
	if (previewable.dataUrl.startsWith('data:image/')) {
		const image = document.createElement('img');
		image.src = previewable.dataUrl;
		image.alt = previewable.name;
		elements.attachmentPreview.append(image);
		elements.attachmentPreview.classList.remove('hidden');
		return;
	}
	if (previewable.dataUrl.startsWith('data:application/pdf')) {
		const frame = document.createElement('iframe');
		frame.className = 'pdfPreview';
		frame.src = previewable.dataUrl;
		frame.title = previewable.name;
		elements.attachmentPreview.append(frame);
		elements.attachmentPreview.classList.remove('hidden');
		return;
	}
	elements.attachmentPreview.classList.add('hidden');
}

function renderAttachments(entries) {
	elements.attachment.innerHTML = '';
	state.currentAttachments = entries;
	if (!entries.length) {
		elements.attachment.classList.add('hidden');
		renderAttachmentPreview([]);
		return;
	}
	for (const entry of entries) {
		const template = elements.attachmenttemplate.cloneNode(true);
		template.removeAttribute('id');
		template.classList.remove('hidden');
		const link = template.querySelector('a');
		link.href = entry.dataUrl;
		link.download = entry.name;
		const attachmentLabel = link.querySelector('span');
		if (attachmentLabel) {
			attachmentLabel.textContent = `: ${entry.name}`;
		} else {
			link.textContent = `Download attachment: ${entry.name}`;
		}
		elements.attachment.append(template);
	}
	elements.attachment.classList.remove('hidden');
	renderAttachmentPreview(entries);
}

function renderRemainingTime(payload) {
	hideRemaining();
	if (payload.adata?.[3] === 1) {
		showRemaining("FOR YOUR EYES ONLY. Don't close this window, this message can't be displayed again.", true);
		return;
	}
	const ttl = Number(payload.meta?.time_to_live ?? 0);
	if (ttl > 0) {
		showRemaining(`This document will expire in ${humanizeDuration(ttl)}.`);
	}
}

function getCurrentShareUrl() {
	return state.shareResultUrl ?? window.location.href;
}

// Sharing helpers update the post-create success UI and optional delivery affordances.
function buildEmailBody(shareUrl, expirationDateText, isBurnAfterReading) {
	const lines = [];
	if (expirationDateText !== null || isBurnAfterReading) {
		lines.push('Notice:');
		if (expirationDateText !== null) {
			lines.push('');
			lines.push(`  - This link will expire after ${expirationDateText}.`);
		}
		if (isBurnAfterReading) {
			lines.push('');
			lines.push('  - This link can only be accessed once, do not use back or refresh button in your browser.');
		}
		lines.push('');
		lines.push('');
	}
	lines.push('Link:');
	lines.push(shareUrl);
	return lines.join('\n');
}

function triggerEmailSend(body) {
	window.open(`mailto:?body=${encodeURIComponent(body)}`, '_self', 'noopener,noreferrer');
}

function copyIconSuccess() {
	elements.copyIcon.style.display = 'none';
	elements.copySuccessIcon.style.display = 'block';
	window.setTimeout(() => {
		elements.copyIcon.style.display = 'block';
		elements.copySuccessIcon.style.display = 'none';
	}, 1000);
}

async function copyText(value, successMessage, useDocumentIcon = false) {
	if (!value) {
		return;
	}
	await navigator.clipboard.writeText(value);
	if (useDocumentIcon) {
		copyIconSuccess();
	}
	showStatus(successMessage);
}

function renderPasteSuccess() {
	if (!state.shareResultUrl || !state.shareDeleteUrl) {
		elements.pastesuccess.classList.add('hidden');
		elements.pastelink.innerHTML = '';
		return;
	}
	const url = state.shareResultUrl;
	elements.deletelink.href = state.shareDeleteUrl;
	const deleteLabel = elements.deletelink.querySelector('span');
	if (deleteLabel) {
		deleteLabel.textContent = 'Delete data';
	}
	elements.pastelink.innerHTML = `Your document is <a id="pasteurl" href="${escapeHtml(url)}">${escapeHtml(url)}</a> <span id="copyhint">(Hit <kbd>Ctrl</kbd>+<kbd>c</kbd> to copy)</span>`;
	elements.pastesuccess.classList.remove('hidden');
	const pasteUrl = document.getElementById('pasteurl');
	if (pasteUrl) {
		selectText(pasteUrl);
	}
}

// Discussion helpers rebuild the threaded comment tree on the client after decryption.
function createReplyForm(parentId) {
	const form = elements.replytemplate.cloneNode(true);
	form.removeAttribute('id');
	form.classList.remove('hidden');
	const nicknameInput = form.querySelector('#nickname');
	const messageInput = form.querySelector('#replymessage');
	const replyButton = form.querySelector('#replybutton');
	const status = form.querySelector('#replystatus');
	const statusText = form.querySelector('.replystatus-text');

	replyButton.addEventListener('click', async () => {
		const comment = messageInput.value.trim();
		if (!comment) {
			status.className = 'statusmessage alert alert-danger';
			statusText.textContent = 'Comment content is required.';
			status.classList.remove('hidden');
			return;
		}
		try {
			await postComment(parentId, nicknameInput.value.trim(), comment);
			form.remove();
		} catch (error) {
			status.className = 'statusmessage alert alert-danger';
			statusText.textContent = error instanceof Error ? error.message : 'Failed to post comment.';
			status.classList.remove('hidden');
		}
	});

	return form;
}

function buildCommentTree(comments) {
	const childrenByParent = new Map();
	for (const comment of comments) {
		const parentKey = comment.parentId || state.pasteId;
		if (!childrenByParent.has(parentKey)) {
			childrenByParent.set(parentKey, []);
		}
		childrenByParent.get(parentKey).push(comment);
	}
	for (const childList of childrenByParent.values()) {
		childList.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
	}
	return childrenByParent;
}

function renderCommentBranch(container, childrenByParent, parentId, depth = 0) {
	const comments = childrenByParent.get(parentId) ?? [];
	for (const comment of comments) {
		const node = elements.commenttemplate.cloneNode(true);
		node.removeAttribute('id');
		node.dataset.commentId = comment.id;
		node.classList.add(depth === 0 ? 'comment-root' : `comment-depth-${Math.min(depth, 3)}`);
		const nickname = node.querySelector('.nickname');
		if (comment.nickname) {
			nickname.textContent = comment.nickname;
		} else {
			nickname.innerHTML = '<em>Anonymous</em>';
		}
		const commentDate = node.querySelector('.commentdate');
		commentDate.textContent = comment.createdAt ? `(${new Date(comment.createdAt).toLocaleString()})` : '';
		node.querySelector('.commentdata').textContent = comment.comment || '';
		node.querySelector('.comment-reply-button').addEventListener('click', () => {
			container.querySelectorAll('.reply').forEach((reply) => {
				if (!reply.id) {
					reply.remove();
				}
			});
			node.append(createReplyForm(comment.id));
		});
		container.append(node);
		renderCommentBranch(container, childrenByParent, comment.id, depth + 1);
	}
}

function renderComments(comments) {
	elements.commentcontainer.innerHTML = '';
	const tree = buildCommentTree(comments);
	renderCommentBranch(elements.commentcontainer, tree, state.pasteId, 0);
	const tail = elements.commenttailtemplate.cloneNode(true);
	tail.removeAttribute('id');
	tail.querySelector('button').addEventListener('click', () => {
		elements.commentcontainer.append(createReplyForm(state.pasteId));
	});
	elements.commentcontainer.append(tail);
}

// Paste lifecycle actions load, consume, clone, create, and delete encrypted documents.
async function postComment(parentId, nickname, comment) {
	hideError();
	const envelope = await encryptCommentEnvelope({ comment, nickname }, state.pasteKey, state.viewPassword);
	const response = await fetch(`/api/v1/pastes/${state.pasteId}/comments`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			...envelope,
			pasteid: state.pasteId,
			parentid: parentId,
		}),
	});
	const payload = await response.json();
	if (!response.ok) {
		throw new Error(payload.error ?? 'Failed to post comment.');
	}
	await loadPaste({ preserveStatus: true });
	showStatus('Comment posted.');
}

async function consumePaste(silent = false) {
	if (!state.pasteId || !state.claimToken) {
		return;
	}
	const response = await fetch(`/api/v1/pastes/${state.pasteId}/consume`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ claimToken: state.claimToken }),
	});
	const payload = await response.json();
	if (!response.ok) {
		if (!silent) {
			showError(payload.error ?? 'Failed to burn paste.');
		}
		return;
	}
	state.claimToken = null;
	if (!silent) {
		showStatus('Paste consumed.');
	}
}

async function loadPaste({ preserveStatus = false } = {}) {
	showLoading('Loading…');
	if (!preserveStatus) {
		hideError();
		hideStatus();
	}
	hideRemaining();
	renderAttachments([]);
	clearRenderedMessage();
	elements.discussion.classList.add('hidden');

	if (!state.pasteId || !state.pasteKey) {
		hideLoading();
		showError('Paste key is missing from the URL fragment.');
		return;
	}

	try {
		const response = await fetch(`/api/v1/pastes/${state.pasteId}`);
		const payload = await response.json();
		if (!response.ok) {
			setRetryAction(() => void loadPaste());
			throw new Error(payload.error ?? 'Failed to load paste.');
		}

		let message;
		try {
			message = await decryptEnvelope(payload, state.pasteKey, state.viewPassword);
		} catch (error) {
			if (!state.viewPassword) {
				hideLoading();
				bootstrapApi?.Modal.getOrCreateInstance(elements.passwordmodal)?.show();
				setRetryAction(() => void loadPaste());
				return;
			}
			throw error;
		}

		state.claimToken = payload.claimToken ?? null;
		state.pasteData = message;
		state.currentFormatter = payload.adata?.[1] ?? 'plaintext';
		state.shareResultUrl = null;
		state.shareDeleteUrl = null;

		renderMessageContent(message.paste ?? '', state.currentFormatter);
		renderRemainingTime(payload);

		let attachments = normalizeAttachmentEntries(message.attachment, message.attachment_name);
		if (!attachments.length) {
			attachments = await loadLegacyNestedAttachments(payload, state.pasteKey, state.viewPassword);
		}
		renderAttachments(attachments);

		if (payload.adata?.[2] === 1) {
			const comments = [];
			for (const comment of payload.comments ?? []) {
				const data = await decryptEnvelope(comment, state.pasteKey, state.viewPassword);
				comments.push({
					...data,
					id: comment.id,
					parentId: comment.parentId,
					createdAt: comment.createdAt,
				});
			}
			renderComments(comments);
			elements.discussion.classList.remove('hidden');
		}

		state.page = 'view';
		updateTopNav();
		setCopyShortcutHint(
			'To copy document press on the copy button or use the clipboard shortcut <kbd>Ctrl</kbd>+<kbd>c</kbd>/<kbd>Cmd</kbd>+<kbd>c</kbd>',
		);
		setRetryAction(null);
		hideLoading();
		elements.loadingnotice.classList.add('hidden');

		if (payload.adata?.[3] === 1 && state.claimToken) {
			void consumePaste(true);
		}
	} catch (error) {
		hideLoading();
		console.error(error);
		showError(error instanceof Error ? error.message : 'Unable to decrypt the paste with the current key or password.');
	}
}

function startNewPaste(pushHistory = true) {
	state.page = 'compose';
	state.pasteId = null;
	state.pasteKey = null;
	state.claimToken = null;
	state.loadConfirmRequired = false;
	state.viewPassword = '';
	state.pasteData = null;
	state.currentFormatter = 'plaintext';
	state.currentAttachments = [];
	state.shareResultUrl = null;
	state.shareDeleteUrl = null;
	clearDraftAttachments();
	hideStatus();
	hideError();
	hideRemaining();
	renderAttachments([]);
	elements.discussion.classList.add('hidden');
	elements.commentcontainer.innerHTML = '';
	elements.message.value = '';
	elements.passwordinput.value = '';
	elements.passworddecrypt.value = '';
	elements.burnafterreading.checked = false;
	elements.opendiscussion.checked = false;
	elements.pasteFormatter.value = 'plaintext';
	elements.pasteExpiration.value = state.config?.defaultExpiration ?? elements.pasteExpiration.value;
	elements.pastesuccess.classList.add('hidden');
	setCopyShortcutHint();
	setComposerTab('editor');
	updateTopNav();
	setRetryAction(null);
	elements.loadingnotice.classList.add('hidden');

	if (pushHistory) {
		const homeUrl = buildHomeUrl();
		history.pushState({ type: 'create' }, document.title, `${homeUrl.pathname}${homeUrl.search}`);
	}
	elements.message.classList.remove('hidden');
	elements.message.focus();
}

function togglePasswordField(button) {
	const input = button.closest('.input-group')?.querySelector('.input-password');
	if (!input) {
		return;
	}
	const isHidden = input.getAttribute('type') === 'password';
	input.setAttribute('type', isHidden ? 'text' : 'password');
	const use = button.querySelector('use');
	if (use) {
		use.setAttribute('href', isHidden ? '/vendor/bootstrap-icons.svg#eye-slash' : '/vendor/bootstrap-icons.svg#eye');
	}
	button.setAttribute('title', isHidden ? 'Hide password' : 'Show password');
	button.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
}

function handleTabKey(event) {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'm') {
		event.preventDefault();
		elements.messagetab.checked = !elements.messagetab.checked;
		return;
	}
	if (event.key === 'Escape') {
		event.preventDefault();
		elements.messagetab.checked = !elements.messagetab.checked;
		return;
	}
	if (event.key === 'Tab' && elements.messagetab.checked) {
		event.preventDefault();
		const start = elements.message.selectionStart;
		const end = elements.message.selectionEnd;
		elements.message.setRangeText('\t', start, end, 'end');
	}
}

async function createPaste() {
	showLoading('Creating paste…');
	hideError();
	hideStatus();
	try {
		const content = elements.message.value;
		if (!content.trim()) {
			throw new Error('Paste content is required.');
		}
		const secretKey = randomKey();
		const formatter = elements.pasteFormatter.value;
		const burnAfterReading = elements.burnafterreading.checked;
		const discussionOpen = burnAfterReading ? false : elements.opendiscussion.checked;
		const attachmentEntries = await collectAttachmentEntries();
		const payload = { paste: content };
		if (attachmentEntries.length > 0) {
			payload.attachment = attachmentEntries.map((entry) => entry.dataUrl);
			payload.attachment_name = attachmentEntries.map((entry) => entry.name);
		}
		const envelope = await encryptPasteEnvelope(
			payload,
			secretKey,
			elements.passwordinput.value,
			formatter,
			discussionOpen,
			burnAfterReading,
		);
		envelope.meta = { expire: elements.pasteExpiration.value };

		const response = await fetch('/api/v1/pastes', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(envelope),
		});
		const result = await response.json();
		if (!response.ok) {
			throw new Error(result.error ?? 'Failed to create paste.');
		}

		state.pasteId = result.id;
		state.pasteKey = secretKey;
		state.shareResultUrl = buildShareUrl(result.shareUrl, secretKey, burnAfterReading);
		state.shareDeleteUrl = buildDeleteUrl(result.id, result.deleteToken);
		renderPasteSuccess();
		showStatus('Paste created. Share the link and store the delete token safely.');
		history.pushState({ type: 'newpaste' }, document.title, state.shareResultUrl);
		setRetryAction(null);
		hideLoading();
		elements.loadingnotice.classList.add('hidden');
	} catch (error) {
		hideLoading();
		console.error(error);
		showError(error instanceof Error ? error.message : 'Failed to create paste.');
		setRetryAction(() => void createPaste());
	}
}

async function deletePasteFromUrl(deleteToken) {
	if (!state.pasteId || !deleteToken) {
		return false;
	}
	showLoading('Deleting paste…');
	hideError();
	hideStatus();
	try {
		const response = await fetch(`/api/v1/pastes/${state.pasteId}`, {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deleteToken }),
		});
		const payload = await response.json();
		if (!response.ok) {
			throw new Error(payload.error ?? 'Failed to delete paste.');
		}
		const homeUrl = buildHomeUrl();
		history.replaceState({ type: 'create' }, document.title, `${homeUrl.pathname}${homeUrl.search}`);
		startNewPaste(false);
		showStatus('Paste deleted.', true);
		hideLoading();
		elements.loadingnotice.classList.add('hidden');
		return true;
	} catch (error) {
		hideLoading();
		console.error(error);
		showError(error instanceof Error ? error.message : 'Failed to delete paste.');
		return true;
	}
}

function cloneCurrentPaste() {
	if (!state.pasteData) {
		return;
	}
	const attachments = state.currentAttachments.map((entry) => ({ ...entry }));
	startNewPaste(false);
	state.pendingAttachmentEntries = attachments;
	updateAttachmentComposerSummary();
	elements.message.value = state.pasteData.paste ?? '';
	elements.pasteFormatter.value = state.currentFormatter;
	state.page = 'compose';
	updateTopNav();
	clearRenderedMessage();
	elements.message.classList.remove('hidden');
	showStatus(
		attachments.length
			? `The cloned file '${attachments.map((entry) => entry.name).join(', ')}' was attached to this document.`
			: 'Cloned current document.',
	);
	history.pushState({ type: 'clone' }, document.title, buildHomeUrl().toString());
}

function openRawText() {
	if (!state.pasteData?.paste) {
		return;
	}
	const popup = window.open('', '_blank', 'noopener,noreferrer');
	if (!popup) {
		showError('Unable to open a new window for raw text.');
		return;
	}
	popup.document.write(
		`<pre style="white-space: pre-wrap; word-break: break-word; font-family: monospace;">${escapeHtml(state.pasteData.paste)}</pre>`,
	);
	popup.document.close();
}

function downloadCurrentPaste() {
	if (!state.pasteData?.paste) {
		return;
	}
	const blob = new Blob([state.pasteData.paste], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `${state.pasteId ?? 'paste'}.txt`;
	link.click();
	URL.revokeObjectURL(url);
}

function showQrCode() {
	const shareUrl = getCurrentShareUrl();
	if (!shareUrl) {
		return;
	}
	elements.qrcodeDisplay.innerHTML = '';
	if (typeof window.kjua === 'function') {
		elements.qrcodeDisplay.append(
			window.kjua({
				render: 'canvas',
				text: shareUrl,
				size: 200,
				fill: document.documentElement.getAttribute('data-bs-theme') === 'dark' ? '#f8f9fa' : '#212529',
				back: document.documentElement.getAttribute('data-bs-theme') === 'dark' ? '#212529' : '#ffffff',
				quiet: 2,
			}),
		);
	} else {
		elements.qrcodeDisplay.textContent = shareUrl;
	}
	bootstrapApi?.Modal.getOrCreateInstance(elements.qrcodemodal)?.show();
}

function sendEmailLink() {
	const shareUrl = getCurrentShareUrl();
	if (!shareUrl) {
		return;
	}
	const ttl = state.pasteData?.meta?.time_to_live ?? 0;
	const isBurnAfterReading = state.pasteData?.adata?.[3] === 1;
	if (ttl > 0 && elements.emailconfirmmodal) {
		const expirationDate = new Date(Date.now() + ttl * 1000);
		expirationDate.setUTCSeconds(expirationDate.getUTCSeconds() - 30);
		expirationDate.setUTCSeconds(0);
		const modal = bootstrapApi?.Modal.getOrCreateInstance(elements.emailconfirmmodal);
		const sendWithLocale = (timeZone) => {
			const localeConfiguration = { dateStyle: 'long', timeStyle: 'long' };
			if (timeZone) {
				localeConfiguration.timeZone = timeZone;
			}
			modal?.hide();
			triggerEmailSend(buildEmailBody(shareUrl, expirationDate.toLocaleString([], localeConfiguration), isBurnAfterReading));
		};
		elements.emailconfirmTimezoneCurrent.onclick = () => sendWithLocale(undefined);
		elements.emailconfirmTimezoneUtc.onclick = () => sendWithLocale('UTC');
		modal?.show();
		return;
	}
	triggerEmailSend(buildEmailBody(shareUrl, null, isBurnAfterReading));
}

// Bootstrapping happens after config loads so event handlers can reflect server-provided options.
function initializeAttachmentDnD() {
	let dragDepth = 0;
	function assignFiles(files) {
		state.pendingAttachmentEntries = [];
		state.draftFiles = [...files];
		updateAttachmentComposerSummary();
	}
	document.addEventListener('dragenter', (event) => {
		if (!event.dataTransfer?.types?.includes('Files')) {
			return;
		}
		dragDepth += 1;
		elements.dropzone.classList.remove('hidden');
	});
	document.addEventListener('dragover', (event) => {
		if (!event.dataTransfer?.types?.includes('Files')) {
			return;
		}
		event.preventDefault();
	});
	document.addEventListener('dragleave', (event) => {
		if (!event.dataTransfer?.types?.includes('Files')) {
			return;
		}
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) {
			elements.dropzone.classList.add('hidden');
		}
	});
	document.addEventListener('drop', (event) => {
		if (!event.dataTransfer?.files?.length) {
			return;
		}
		event.preventDefault();
		dragDepth = 0;
		elements.dropzone.classList.add('hidden');
		assignFiles(event.dataTransfer.files);
	});
}

async function boot() {
	initializeTheme();
	initializeAttachmentDnD();

	window.addEventListener('popstate', () => {
		window.location.reload();
	});

	const configResponse = await fetch('/api/v1/config');
	state.config = await configResponse.json();
	syncUiChrome(state.config);
	renderExpirationOptions(state.config);
	elements.brandLink.href = buildHomeUrl().toString();
	const httpsUrl = new URL(window.location.href);
	httpsUrl.protocol = 'https:';
	const httpsLink = document.getElementById('httpslink');
	if (httpsLink) {
		httpsLink.setAttribute('href', httpsUrl.toString());
	}

	for (const toggle of elements.passwordToggles) {
		toggle.addEventListener('click', () => togglePasswordField(toggle));
	}

	elements.themeToggle.addEventListener('change', () => {
		const theme = elements.themeToggle.checked ? 'dark' : 'light';
		window.localStorage.setItem(THEME_STORAGE_KEY, theme);
		setTheme(theme);
	});

	elements.messageedit.addEventListener('click', (event) => {
		event.preventDefault();
		setComposerTab('editor');
	});
	elements.messagepreview.addEventListener('click', (event) => {
		event.preventDefault();
		setComposerTab('preview');
	});
	elements.newbutton.addEventListener('click', () => startNewPaste());
	elements.newFromAlert.addEventListener('click', () => startNewPaste());
	elements.retrybutton.addEventListener('click', () => {
		if (state.retryAction) {
			state.retryAction();
		}
	});
	elements.sendbutton.addEventListener('click', () => void createPaste());
	elements.copyLink.addEventListener('click', () => void copyText(state.shareResultUrl, 'Link copied to clipboard.'));
	elements.prettyMessageCopyBtn.addEventListener(
		'click',
		() => void copyText(state.pasteData?.paste ?? elements.message.value, 'Document copied to clipboard.', true),
	);
	elements.clonebutton.addEventListener('click', cloneCurrentPaste);
	elements.rawtextbutton.addEventListener('click', openRawText);
	elements.downloadtextbutton.addEventListener('click', downloadCurrentPaste);
	elements.qrcodelink.addEventListener('click', showQrCode);
	elements.emaillink.addEventListener('click', sendEmailLink);
	elements.message.addEventListener('input', () => {
		if (state.composerTab === 'preview') {
			renderPreview();
		}
	});
	elements.message.addEventListener('keydown', handleTabKey);
	elements.pasteFormatter.addEventListener('change', () => {
		if (state.composerTab === 'preview') {
			renderPreview();
		}
	});
	elements.burnafterreading.addEventListener('change', () => {
		if (elements.burnafterreading.checked) {
			elements.opendiscussion.checked = false;
		}
	});
	elements.opendiscussion.addEventListener('change', () => {
		if (elements.opendiscussion.checked) {
			elements.burnafterreading.checked = false;
		}
	});
	elements.file.addEventListener('change', () => {
		state.pendingAttachmentEntries = [];
		state.draftFiles = [...elements.file.files];
		updateAttachmentComposerSummary();
	});
	elements.fileremovebutton.addEventListener('click', (event) => {
		event.preventDefault();
		clearDraftAttachments();
	});
	elements.passwordform.addEventListener('submit', (event) => {
		event.preventDefault();
		state.viewPassword = elements.passworddecrypt.value;
		bootstrapApi?.Modal.getOrCreateInstance(elements.passwordmodal)?.hide();
		void loadPaste();
	});
	elements.loadconfirmOpenNow.addEventListener('click', () => {
		void loadPaste();
	});

	document.addEventListener('copy', (event) => {
		if (!state.pasteData?.paste) {
			return;
		}
		const selectedText = window.getSelection()?.toString() ?? '';
		if (selectedText.length > 0) {
			return;
		}
		event.clipboardData?.setData('text/plain', state.pasteData.paste);
		event.preventDefault();
		showStatus('Document copied to clipboard.');
	});

	const location = getPasteLocation();
	state.pasteId = location.pasteId;
	state.pasteKey = location.pasteKey;
	state.loadConfirmRequired = location.loadConfirmRequired;

	updateTopNav();

	if (location.deleteToken && state.pasteId) {
		await deletePasteFromUrl(location.deleteToken);
		return;
	}

	if (state.pasteId) {
		state.page = 'view';
		updateTopNav();
		if (state.loadConfirmRequired) {
			hideLoading();
			elements.loadingnotice.classList.add('hidden');
			bootstrapApi?.Modal.getOrCreateInstance(elements.loadconfirmmodal)?.show();
			return;
		}
		await loadPaste();
		return;
	}

	startNewPaste(false);
}

void boot();
