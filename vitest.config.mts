/**
 * Vitest configuration for running Cloudflare Worker tests with coverage reporting.
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The Vitest pool currently bundles a slightly older Miniflare/workerd runtime than the
// top-level Wrangler CLI, so tests need to pin to the latest date that runtime supports.
const TEST_RUNTIME_COMPATIBILITY_DATE = '2026-03-10';

export default defineConfig({
	plugins: [
		cloudflareTest({
			miniflare: {
				compatibilityDate: TEST_RUNTIME_COMPATIBILITY_DATE,
			},
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		coverage: {
			provider: 'istanbul',
			reporter: ['text-summary', 'lcov', 'json-summary'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts'],
		},
		fileParallelism: false,
	},
});
