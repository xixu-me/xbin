# Contributing to Xbin

Thanks for taking the time to contribute. Xbin is a small, Cloudflare-native paste service, and thoughtful bug reports, documentation improvements, tests, and focused pull requests all make a real difference.

This guide exists to keep contribution flow predictable for both contributors and maintainers, in line with the documentation-first recommendations from [Open Source Guides](https://opensource.guide/).

## Before you start

- Read the [README](./README.md) to understand the project scope and local setup.
- Search existing issues and pull requests before opening a new one.
- For large features or design changes, open an issue before writing code so we can confirm the change fits the project.
- For security issues, do not open a public issue. Follow [SECURITY.md](./SECURITY.md).
- By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Good contributions

Contributions are especially helpful when they improve:

- correctness and test coverage
- Cloudflare deployment and operations
- PrivateBin compatibility
- security hardening
- performance and reliability
- accessibility and UX polish
- documentation and onboarding

Contributions that significantly expand scope may be declined if they pull Xbin away from its core purpose: secure, encrypted paste sharing with simple operations.

## Development setup

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create local secrets:

   ```sh
   Copy-Item .dev.vars.example .dev.vars
   ```

3. Start local development:

   ```sh
   bun run dev
   ```

4. Run the local quality checks:

   ```sh
   bun run format:check
   bun run check
   bun run test:coverage
   ```

5. If you changed bindings or Worker config, refresh generated types:

   ```sh
   bun run cf-typegen
   ```

## Coding expectations

- Follow the existing TypeScript style: tabs, single quotes, semicolons, and clear helper names.
- Keep route handling, validation, configuration, and persistence logic separated.
- Prefer small, focused changes over broad refactors.
- Add or update tests for behavioral changes. CI expects strong coverage, and patch coverage matters.
- Update documentation when behavior, commands, configuration, or contributor workflow changes.
- Never commit secrets, tokens, credentials, or private Cloudflare account data.

## Pull request checklist

Before opening a PR, please make sure that:

- the change is scoped to one coherent improvement
- tests were added or updated where appropriate
- `bun run format:check` passes
- `bun run check` passes
- `bun run test:coverage` passes
- generated Worker types were refreshed if Wrangler bindings changed
- relevant docs were updated

Conventional Commit titles are appreciated and match this repository’s existing history, for example:

- `fix(repository): avoid orphaned blob cleanup retries`
- `docs: clarify local Cloudflare setup`
- `test(http): cover legacy share-link handling`

## Issues and support

Please use the repository templates when opening issues:

- bug report for defects or regressions
- feature request for scope-aligned enhancements
- question for setup or usage help

When reporting a bug, include:

- what you expected to happen
- what actually happened
- steps to reproduce
- environment details
- sanitized logs, screenshots, or request samples when helpful

## Review and response expectations

Xbin is maintained on a best-effort schedule. Response times can vary, but a polite follow-up on an issue or pull request after 7 days is welcome.

To keep collaboration transparent and searchable, please prefer public GitHub issues and pull requests over private messages for normal support and feature discussion.

## Maintainer discretion

Maintainers may close contributions that do not fit the project’s scope, quality bar, or operational model. When that happens, we will try to explain why and point to relevant documentation so the next contribution has a clearer path.
