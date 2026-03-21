# Security Policy

## Supported versions

Security fixes are applied on a best-effort basis to the active development line:

| Version                 | Supported    |
| ----------------------- | ------------ |
| `main`                  | Yes          |
| Older commits and forks | No guarantee |

If you are running a deployed instance, please verify the issue against the latest code on `main` before reporting it when possible.

## Reporting a vulnerability

Please do **not** open public GitHub issues for security vulnerabilities.

Use one of these private channels instead:

1. Prefer GitHub's private vulnerability reporting or security advisory flow for this repository if it is available.
2. Otherwise, use the private maintainer contact listed on [xi-xu.me](https://xi-xu.me/).

Please include:

- a clear description of the issue
- affected commit, branch, or deployment version if known
- reproduction steps or a proof of concept
- impact assessment
- any suggested mitigations if you have them

## What to expect

- Reports are reviewed on a best-effort basis.
- We will try to acknowledge valid reports within 5 business days.
- If the report is accepted, we will work on a fix and coordinate disclosure timing with the reporter when appropriate.
- Please avoid public disclosure until a fix or mitigation is available.

## Scope guidance

The most relevant areas for security reports include:

- encryption, decryption, and secret-handling flows
- access control around paste retrieval, deletion, and import
- burn-after-reading coordination
- D1, R2, queue, and Durable Object data handling
- configuration mistakes that could expose sensitive data
- injection, traversal, or cross-site scripting risks in the Worker or SPA

Non-security bugs, feature requests, and support questions should go through the normal public issue templates instead.
