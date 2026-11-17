# AutonomAgent Vision Swarm — 0.4.0-vision-alpha

## Included

- Authenticated ADMIN-only Vision analysis submission and task status endpoints.
- Durable PostgreSQL AgentTask queue with idempotency, lease-based worker claims, bounded retries, and task result persistence.
- Private Python Vision service with exact-host HTTPS image allowlisting, bounded image downloads, image signature checks, and configurable OpenAI-compatible vision model.
- Six parallel specialist roles: visual identification, market research, collector rarity, technical/parts, restoration, and risk/authenticity.
- Evidence-aware assessment: no verified resale valuation without at least two recent sold comparables in the matching currency.
- Expo Android client connected to API login, candidate listing, analysis submission, and task status/result polling.

## Safety and limitations

- PAPER mode only; no purchase, seller contact, reservation, payment, or listing publication.
- Image-only observations do not certify authenticity.
- Market research remains SKIPPED until an approved sold-listing provider is configured.
- Deployment requires API and Python worker processes, Postgres, LLM credentials, worker shared token, exact image-host allowlist, and outbound network egress restrictions.
- CI Android export is not a signed APK/AAB. No production deployment or APK distribution is claimed.

## Verification

GitHub Actions CI runs Python specialist tests, Prisma validation/migrations, API build/typecheck/integration tests, dependency audit, and Expo Android export. Refer to the latest CI run linked from the Vision PR before promoting this alpha to production.
