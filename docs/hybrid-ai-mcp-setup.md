# Vision: Hybrid AI, MCP and local/cloud deployment

## Hybrid model routing

The Vision worker uses an OpenAI-compatible primary endpoint. In Docker Compose this is local Ollama at http://ollama:11434/v1. If that request fails, a cloud fallback is attempted only when all three settings are present: LLM_FALLBACK_BASE_URL, LLM_FALLBACK_API_KEY and LLM_FALLBACK_MODEL. Both providers must support image input and JSON response mode. Provider secrets remain server-side and must never be placed in Expo public variables.

## Initial administrator

The approved initial administrator is niko.oeben@gmail.com. The bootstrap command creates this account with role ADMIN and a salted scrypt password hash; it never stores or prints the password.

1. Set ADMIN_BOOTSTRAP_EMAIL=niko.oeben@gmail.com and a unique ADMIN_BOOTSTRAP_PASSWORD (16-128 UTF-8 bytes) in the server's secret environment. Do not commit the password or put it in Android/Expo variables.
2. Apply database migrations first.
3. Run once from the repository root: npm run admin:bootstrap --workspace @autonomagent/api
4. Sign in through POST /v1/auth/login using that email and the configured password.
5. Remove ADMIN_BOOTSTRAP_PASSWORD from the runtime environment after successful creation.

The command is allowlisted to this exact email. It is idempotent for an already active ADMIN account, but fails closed if an account with that email already exists as a non-admin or disabled user; that case requires manual database review. The bootstrap has to be run against the target database before the account can sign in.

## Local setup

1. Copy infra/.env.example to infra/.env and replace every placeholder with strong random secrets.
2. Start the stack from the repository root: docker compose --env-file infra/.env -f infra/docker-compose.yml up -d --build
3. Pull the vision model: docker compose --env-file infra/.env -f infra/docker-compose.yml exec ollama ollama pull qwen2.5-vl:7b
4. Check containers: docker compose --env-file infra/.env -f infra/docker-compose.yml ps
5. The Compose stack builds the API and durable task worker from the repository root. The API applies Prisma migrations before starting; its port binds to 127.0.0.1 by default. Test it with curl http://127.0.0.1:8080/health. For a remote cloud host, set API_BIND_ADDRESS=0.0.0.0 only behind a TLS reverse proxy or platform ingress with firewall restrictions. Database, Redis, Ollama and the Vision worker ports remain unpublished.

## Cloud setup

Deploy the API as the only public service behind HTTPS ingress; deploy the agent task worker and Vision worker as private services in the same private network. Use managed PostgreSQL/Redis or the Compose equivalents. Point the primary model endpoint to a private GPU-backed Ollama host or another OpenAI-compatible provider. Configure the optional cloud fallback as secret environment variables. Keep worker ports private, restrict outbound image-fetch egress, and preserve the exact hostname allowlist. Set API_BIND_ADDRESS=0.0.0.0 only when a separate ingress/firewall protects the host.

## MCP client setup

mcp/servers.example.json is a local client configuration example for filesystem, PostgreSQL and GitHub MCP servers. Supply credentials through the MCP client's secret manager. Use a least-privilege database role, scope filesystem access to this checkout, and grant only necessary GitHub permissions. Do not expose stdio MCP servers as unauthenticated public endpoints.

## Android APK

The existing Android preview APK (PAPER only) workflow remains the supported build path. Use a public HTTPS API origin for a cloud-connected build. No model/provider credential belongs in the APK. After the cloud API is healthy, dispatch the workflow, inspect the APK SHA-256 and perform a physical-device install/start test before calling it release-ready.

## Validation

- docker compose --env-file infra/.env -f infra/docker-compose.yml config
- python -m pytest -q (from services/vision-worker after pip install -e .[test])
- npm ci && npm run typecheck && npm test
- npm run verify:paper --workspace @autonomagent/mobile

Config parsing and unit tests do not prove cloud credentials, model availability, network policy, deployment health or physical-device installation. Track those as separate acceptance checks.
