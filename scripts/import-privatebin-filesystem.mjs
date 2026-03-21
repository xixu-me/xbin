#!/usr/bin/env node

/**
 * Imports a filesystem export from PrivateBin into the worker's admin import endpoint.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

// CLI argument parsing and filesystem discovery turn the export tree into import bundles.
function printUsage() {
	console.error(
		[
			'Usage:',
			'  node scripts/import-privatebin-filesystem.mjs --source <privatebin-data-dir> --base-url <worker-url> --token <import-token> [--report <path>]',
		].join('\n'),
	);
}

function parseArgs(argv) {
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (!current.startsWith('--')) {
			continue;
		}
		const key = current.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) {
			args[key] = 'true';
			continue;
		}
		args[key] = value;
		index += 1;
	}
	return args;
}

function isHexId(value) {
	return /^[a-f0-9]{16}$/i.test(value);
}

function stripProtectionPrefix(content) {
	const prefix = '<?php http_response_code(403); /*';
	return content.startsWith(`${prefix}\n`) ? content.slice(prefix.length + 1) : content;
}

async function readPrivateBinJson(filePath) {
	const raw = await fs.readFile(filePath, 'utf8');
	return JSON.parse(stripProtectionPrefix(raw));
}

async function collectPasteFiles(rootDir) {
	const results = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.endsWith('.discussion')) {
					continue;
				}
				stack.push(fullPath);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			const match = entry.name.match(/^([a-f0-9]{16})\.php$/i);
			if (!match) {
				continue;
			}
			results.push({ pasteId: match[1].toLowerCase(), filePath: fullPath });
		}
	}
	return results.sort((left, right) => left.pasteId.localeCompare(right.pasteId));
}

// Comment files live in sibling ".discussion" directories and are replayed in chronological order.
async function collectComments(pasteFilePath, pasteId) {
	const discussionDir = path.join(path.dirname(pasteFilePath), `${pasteId}.discussion`);
	try {
		const entries = await fs.readdir(discussionDir, { withFileTypes: true });
		const comments = [];
		for (const entry of entries) {
			if (!entry.isFile()) {
				continue;
			}
			const match = entry.name.match(new RegExp(`^${pasteId}\\.([a-f0-9]{16})\\.([a-f0-9]{16})\\.php$`, 'i'));
			if (!match) {
				continue;
			}
			const commentId = match[1].toLowerCase();
			const parentId = match[2].toLowerCase();
			const filePath = path.join(discussionDir, entry.name);
			const envelope = await readPrivateBinJson(filePath);
			comments.push({
				id: commentId,
				...envelope,
				pasteid: pasteId,
				parentid: parentId,
			});
		}
		return comments.sort((left, right) => {
			const leftCreated = Number(left.meta?.created ?? 0);
			const rightCreated = Number(right.meta?.created ?? 0);
			return leftCreated - rightCreated;
		});
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

// Each bundle is posted to the worker so the server can normalize and persist the payload.
async function importPaste(baseUrl, token, bundle) {
	const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/admin/import/privatebin`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify(bundle),
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) {
		const message = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
		throw new Error(`Failed to import ${bundle.pasteId}: ${message}`);
	}
	return payload;
}

// main wires together discovery, import execution, and optional reporting.
async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.source || !args['base-url'] || !args.token) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	const sourceDir = path.resolve(args.source);
	const baseUrl = args['base-url'];
	const token = args.token;
	const reportPath = args.report ? path.resolve(args.report) : null;
	const pasteFiles = await collectPasteFiles(sourceDir);
	const report = [];

	for (const { pasteId, filePath } of pasteFiles) {
		if (!isHexId(pasteId)) {
			continue;
		}
		const paste = await readPrivateBinJson(filePath);
		const comments = await collectComments(filePath, pasteId);
		const result = await importPaste(baseUrl, token, {
			source: 'privatebin-filesystem',
			pasteId,
			paste,
			comments,
		});
		report.push(result);
		process.stdout.write(`${pasteId}: ${result.skipped ? 'skipped expired' : `imported (${result.importedComments} comments)`}\n`);
		if (result.deleteToken) {
			process.stdout.write(`  deleteToken: ${result.deleteToken}\n`);
		}
	}

	if (reportPath) {
		await fs.mkdir(path.dirname(reportPath), { recursive: true });
		await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
