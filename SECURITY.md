# Security Policy

## Reporting a vulnerability

Please report any suspected security vulnerability privately to **<security@useaura.wtf>**.

Do **not** open a public GitHub issue for security reports.

We aim to acknowledge new reports within 48 hours and to ship a fix or
mitigation within 7 days for critical issues.

## Scope

In scope:

- `aura-backend/` — REST API, auth, on-chain signing, fee collection
- `aura/` — Flutter mobile app
- `aura-landing/` and `aura-landing-v2/` — marketing sites

Out of scope:

- Third-party services (Helius, Anthropic, OpenAI, Railway, Solana RPC providers)
- Issues that require physical access to a user's unlocked device
- Self-XSS, social engineering, denial-of-service via volumetric traffic

## Coordinated disclosure

We will credit researchers who follow responsible disclosure in the release notes
of the patched version, unless you prefer to remain anonymous.

## Encryption

If you need to encrypt your report, contact us first and we will share a PGP key.
