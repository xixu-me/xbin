# Repository Guidelines

## Project Structure & Module Organization

`src/index.ts` is the Worker entrypoint for HTTP routes, asset delivery, scheduled cleanup, and queue handling. Core domain logic lives in `src/lib/` (`config.ts`, `model.ts`, `repository.ts`, `schema.ts`, `types.ts`). Static SPA assets are served from `assets/`, one-off import tooling lives in `scripts/`, D1 schema changes live in `migrations/`, and Worker integration tests live in `test/`. GitHub Actions workflows are in `.github/workflows/`.

## Build, Test, and Development Commands

Install dependencies with `bun install`.

- `bun run dev` or `bun run start`: run the Worker locally with Wrangler.
- `bun run check`: run TypeScript type-checking without emitting files.
- `bun run test`: run Vitest in the Cloudflare Workers test pool.
- `bun run test:coverage`: run tests with Istanbul coverage output in `coverage/`.
- `bun run format` / `bun run format:check`: apply or verify Prettier formatting.
- `bun run cf-typegen`: refresh Worker binding types after Wrangler config changes.
- `bun run deploy`: publish the Worker.
- `bun run import:privatebin:fs -- --source <dir> --base-url <url> --token <token>`: import a PrivateBin filesystem export.

## Coding Style & Naming Conventions

TypeScript uses tabs, LF line endings, UTF-8, semicolons, single quotes, and a `printWidth` of 140. Follow the existing pattern of small helpers with clear names such as `handleCreatePaste`, `resolveConfig`, and `buildPasteBlobKey`. Use `PascalCase` for classes, `camelCase` for functions and variables, and keep route, storage, and validation logic separated.

## Testing Guidelines

Vitest covers `src/**/*.ts`; `.d.ts`, `scripts/`, `migrations/`, and tests are excluded from coverage. Codecov targets 95% project coverage and 90% patch coverage, so new changes should include or update tests. Add specs under `test/` with the `*.spec.ts` suffix and prefer descriptive names grouped by feature, for example `repository.spec.ts` or `http-errors.spec.ts`.

## Commit & Pull Request Guidelines

Use Conventional Commits for commit messages, for example `feat: improve homepage SEO messaging` or `fix: avoid skipping required CI workflow`. Keep each commit focused on one change, use the smallest accurate type (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, etc.), and add a scope when it clarifies the affected area, such as `feat(repository): support blob metadata lookup`. For pull requests, include a concise summary, linked issues when applicable, test evidence (`bun run test:coverage`, `bun run check`, `bun run format:check`), and screenshots for `assets/` UI changes.

## Security & Configuration Tips

Start from `.dev.vars.example` for local secrets. Do not commit real Cloudflare credentials, import tokens, or `.dev.vars` contents. If you change bindings or environment variables, update `wrangler.jsonc`, regenerate types with `bun run cf-typegen`, and verify CI still passes.
