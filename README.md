# Xbin

**_[汉语](./README.zh.md)_**

[![Codecov](https://codecov.io/github/xixu-me/xbin/graph/badge.svg?token=K95DX723UT)](https://codecov.io/github/xixu-me/xbin)
[![CI](https://github.com/xixu-me/xbin/actions/workflows/ci.yml/badge.svg)](https://github.com/xixu-me/xbin/actions/workflows/ci.yml)
[![CodeQL](https://github.com/xixu-me/xbin/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/xixu-me/xbin/actions/workflows/github-code-scanning/codeql)
[![Deploy](https://github.com/xixu-me/xbin/actions/workflows/deploy.yml/badge.svg)](https://github.com/xixu-me/xbin/actions/workflows/deploy.yml)

Xbin is a PrivateBin-style, end-to-end encrypted pastebin built on Cloudflare Workers. It includes a browser app for creating and reading encrypted pastes, a modern JSON API, and a legacy PrivateBin-compatible surface for migration and interoperability.

Everything is encrypted in the browser before upload. The Worker stores encrypted payloads in R2, lifecycle metadata in D1, and uses Durable Objects plus Queues to handle burn-after-reading claims and background cleanup.

## Highlights

- Browser-side encryption with fragment-based share keys
- Optional passwords, expiration, burn-after-reading links, and per-paste delete tokens
- Plain text, syntax-highlighted code, and Markdown rendering
- Encrypted attachment upload with download and preview support
- Discussion threads for compatible pastes
- Modern REST API under `/api/v1/*`
- Legacy PrivateBin-compatible API support and filesystem import tooling
- Cloudflare-native runtime built from Workers, D1, R2, Durable Objects, Queues, and cron cleanup

## Security model

1. The browser generates a random secret key and encrypts the payload before upload.
2. The Worker stores only encrypted envelopes in R2 and metadata in D1.
3. Share links use the query string for the paste id and the URL fragment for the decryption key, for example `https://paste.example.com/?abcdef1234567890#secretKey`. The fragment is never sent to the server.
4. Optional passwords are combined with the fragment key client-side with PBKDF2 before decryption.
5. Anyone with the full share URL can decrypt the paste. Delete tokens are separate and are only returned when a paste is created or imported.

## Architecture

| Component         | Responsibility                                                                     |
| ----------------- | ---------------------------------------------------------------------------------- |
| Cloudflare Worker | HTTP API, asset delivery, SEO metadata rewriting, config endpoint, and import auth |
| Durable Object    | Serializes burn-after-reading claim and consume operations                         |
| D1                | Paste and comment metadata, lifecycle state, hashed delete tokens, burn claims     |
| R2                | Encrypted paste and comment payload blobs                                          |
| Queue             | Async purge of expired, deleted, and burned content                                |
| Cron trigger      | Releases stale burn claims and finds expired pastes every minute                   |
| `assets/` SPA     | Encrypts, decrypts, renders, and shares pastes in the browser                      |

## Getting started

### Prerequisites

- [Bun](https://bun.sh/)
- A Cloudflare account with access to Workers, D1, R2, Queues, and Durable Objects
- Wrangler authenticated locally if you plan to deploy from your machine

### Install dependencies

```sh
bun install
```

### Provision Cloudflare resources

Create your own resources before the first deploy, then replace the names and IDs in [`wrangler.jsonc`](./wrangler.jsonc).

```sh
bunx wrangler d1 create xbin
bunx wrangler r2 bucket create xbin-pastes
bunx wrangler queues create xbin-gc
```

Notes:

- This repository already contains concrete D1 and bucket identifiers in `wrangler.jsonc`. If you are forking or deploying your own copy, replace them with values from your account.
- You only need to provision D1, R2, and Queues manually. The Durable Object binding and SQLite-backed class are declared in `wrangler.jsonc` and are created as part of deployment and migration.
- This repository sets `workers_dev = false`. Before deploying your own fork, either configure your own routes or custom domain in `wrangler.jsonc`, or set `workers_dev = true` so the app has a reachable hostname.
- After changing bindings or environment variables, regenerate Worker types:

```sh
bun run cf-typegen
```

### Configure local secrets

Copy [`.dev.vars.example`](./.dev.vars.example) to `.dev.vars` and fill in any optional secrets you plan to use:

```sh
Copy-Item .dev.vars.example .dev.vars
```

Available secrets:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `IMPORT_TOKEN`

Most non-secret runtime defaults live in the `vars` section of [`wrangler.jsonc`](./wrangler.jsonc).

### Run locally

```sh
bun run dev
```

Wrangler serves the SPA and API from the same Worker entrypoint.

### Deploy with GitHub Actions

The default deployment path is GitHub Actions. For your own instance, start from a fork of [xixu-me/xbin](https://github.com/xixu-me/xbin/fork).

The release flow is:

1. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as Actions secrets in your fork.
2. Push to `main` in your fork.
3. [CI](./.github/workflows/ci.yml) runs formatting, type-checking, Wrangler type validation, tests with coverage, and a Wrangler deploy dry run.
4. If CI succeeds for that `main` push, [Deploy](./.github/workflows/deploy.yml) publishes the exact revision that passed.

Pull requests still run CI, but they do not auto-deploy. You can also trigger the deploy workflow manually through `workflow_dispatch` in your fork.

The deploy workflow ultimately runs:

```sh
bunx wrangler deploy --keep-vars --message "GitHub Actions deploy for ${GITHUB_SHA}"
```

`--keep-vars` means existing remote Worker variables are preserved unless you intentionally change them in Cloudflare or in your deployment setup.

### Deploy locally

If you need a manual deployment outside GitHub Actions:

```sh
bun run deploy
```

## Useful commands

| Command                 | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `bun run dev`           | Run the Worker locally with Wrangler              |
| `bun run start`         | Alias for local Wrangler development              |
| `bun run check`         | Type-check the TypeScript codebase                |
| `bun run test`          | Run the Worker integration test suite with Vitest |
| `bun run test:coverage` | Run tests with Istanbul coverage output           |
| `bun run format`        | Format the repository with Prettier               |
| `bun run format:check`  | Verify formatting without changing files          |
| `bun run cf-typegen`    | Refresh Worker binding types after config changes |
| `bun run deploy`        | Publish the Worker                                |

## Configuration

| Variable                      | Default                                                     | Purpose                                                                     |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `XBIN_APP_NAME`               | `Xbin`                                                      | Brand name shown in the UI and metadata                                     |
| `XBIN_APP_VERSION`            | `1.0.0`                                                     | Version surfaced by the app config endpoint and footer                      |
| `XBIN_PROJECT_PAGE_URL`       | `https://github.com/xixu-me/xbin`                           | Project link shown in the UI                                                |
| `XBIN_BASE_PATH`              | `/`                                                         | Mount path used when building share URLs, canonical URLs, and sitemap links |
| `XBIN_MAX_PASTE_BYTES`        | `10000000`                                                  | Maximum encrypted paste payload size in bytes                               |
| `XBIN_DEFAULT_EXPIRATION`     | `1hour`                                                     | Default expiration key used by the UI and API                               |
| `XBIN_SUPPORTED_EXPIRATIONS`  | `5min,10min,30min,1hour,3hour,6hour,12hour,1day,3day,1week` | Comma-separated list of expiration keys exposed by the app                  |
| `XBIN_ENABLE_LEGACY_API`      | `true`                                                      | Enables the PrivateBin-compatible JSON API surface                          |
| `XBIN_REQUIRE_TURNSTILE`      | `false`                                                     | Requires `turnstileToken` when creating pastes and comments                 |
| `XBIN_BURN_CLAIM_TTL_SECONDS` | `120`                                                       | How long a burn-after-reading claim stays reserved before being released    |
| `TURNSTILE_SITE_KEY`          | unset                                                       | Site key exposed to the client when Turnstile is enabled                    |
| `TURNSTILE_SECRET_KEY`        | unset                                                       | Secret used by the Worker to verify Turnstile tokens                        |
| `IMPORT_TOKEN`                | unset                                                       | Enables and protects the PrivateBin import endpoint                         |

The config parser also understands `1month`, `1year`, and `never` expiration keys if you choose to expose them.

## API overview

The write API accepts encrypted PrivateBin-style envelopes, not plaintext content. A minimal create request looks like this:

```json
{
	"v": 2,
	"adata": [["iv", "salt", 100000, 256, 128, "aes", "gcm", "none"], "plaintext", 0, 0],
	"ct": "ciphertext",
	"meta": { "expire": "1day" }
}
```

Core endpoints:

| Method   | Path                              | Purpose                                                            |
| -------- | --------------------------------- | ------------------------------------------------------------------ |
| `GET`    | `/api/v1/config`                  | Returns runtime UI and feature config                              |
| `POST`   | `/api/v1/pastes`                  | Creates a paste and returns `{ id, shareUrl, deleteToken }`        |
| `GET`    | `/api/v1/pastes/:id`              | Returns the encrypted paste envelope and comments                  |
| `DELETE` | `/api/v1/pastes/:id`              | Deletes a paste when given `{ "deleteToken": "..." }`              |
| `POST`   | `/api/v1/pastes/:id/comments`     | Creates a comment for a discussion-enabled paste                   |
| `POST`   | `/api/v1/pastes/:id/consume`      | Finalizes a burn-after-reading read with `{ "claimToken": "..." }` |
| `POST`   | `/api/v1/admin/import/privatebin` | Imports a PrivateBin filesystem bundle when authorized             |

Notes:

- `GET /api/v1/pastes/:id` returns a `claimToken` for burn-after-reading pastes. The client must call `/consume` after a successful decrypt.
- When Turnstile is enabled, include `turnstileToken` in the create-paste and create-comment request bodies.
- Comments are disabled for burn-after-reading pastes.

## PrivateBin compatibility and import

Xbin supports two compatibility paths:

- Legacy JSON API calls are detected via `X-Requested-With: JSONHttpRequest`.
- Older browser share URLs such as `/api/v1/pastes?<pasteId>` are served the SPA shell so the client can recover the share locally.

To import a filesystem export from PrivateBin, first set `IMPORT_TOKEN` for the Worker, then run:

```sh
bun run import:privatebin:fs -- --source /path/to/privatebin/data --base-url https://paste.example.com --token your-import-token --report ./import-report.json
```

The importer:

- Walks `*.php` paste files and sibling `.discussion/` directories
- Preserves creation and expiration metadata when present
- Skips already expired pastes
- Returns a fresh `deleteToken` for each imported paste because Xbin generates new deletion credentials during import

## Repository layout

| Path                             | Purpose                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| [`src/index.ts`](./src/index.ts) | Worker entrypoint for HTTP routes, asset serving, cron cleanup, and queue processing |
| [`src/lib/`](./src/lib)          | Config parsing, validation, data access, schema, and shared types                    |
| [`assets/`](./assets)            | Browser app, HTML shell, CSS, and vendored client-side libraries                     |
| [`scripts/`](./scripts)          | One-off tooling such as the PrivateBin filesystem importer                           |
| [`migrations/`](./migrations)    | D1 schema migrations                                                                 |
| [`test/`](./test)                | Worker integration and repository tests                                              |

## Testing and quality

The repository uses Vitest with the Cloudflare Workers pool, TypeScript type-checking, Wrangler type validation, and Prettier formatting. CI also runs a Wrangler deploy dry run before the production workflow is allowed to publish. Codecov is configured with 95% project coverage and 90% patch coverage targets, so documentation aside, code changes should usually come with tests.

A local verification pass that matches the main CI quality gates looks like this:

```sh
bun run format:check
bun run check
bunx wrangler types --check
bun run test:coverage
```

## Related docs

- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)

## License

This project is licensed under the GNU Affero General Public License v3.0. See [`LICENSE`](./LICENSE) for the full text.
