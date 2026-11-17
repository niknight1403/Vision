# Vision: Hybrid AI, MCP and local/cloud deployment

## Hybrid model routing

The Vision worker uses an OpenAI-compatible primary endpoint. In Docker Compose this is local Ollama at http://ollama:11434/v1. If that request fails, a cloud fallback is attempted only when all three settings are present: LLM_FALLBACK_BASE_URL, LLM_FALLBACK_API_KEY and LLM_FALLBACK_MODEL. Both providers must support image input and JSON response mode. Provider secrets remain server-side and must never be placed in Expo public variables.

## Local setup

1. Copy infra/.env.example to infra/.env and replace every placeholder with strong random secrets.
2. Start the stack from the repository root: docker compose --env-file infra/.env -f infra/docker-compose.yml up -d --build
3. Pull the vision model: docker compose --env-file infra/.env -f infra/docker-compose.yml exec ollama ollama pull qwen2.5-vl:7b
4. Check containers: docker compose --env-file infra/.env -f infra/docker-compose.yml ps
5. Run the existing API and task worker using their npm workspace scripts. The Compose backend network is private and does not publish database, Redis, Ollama or worker ports. Use a developer-only override with 127.0.0.1 bindings if host access is required.

## Cloud setup

Deploy API and worker as separate private services in one private network. Use managed PostgreSQL/Redis or the Compose equivalents. Point the primary model endpoint to a private GPU-backed Ollama host or another OpenAI-compatible provider. Configure the optional cloud fallback as secret environment variables. Keep the Vision worker private, terminate public HTTPS at the API gateway, restrict outbound image-fetch egress, and preserve the exact hostname allowlist.

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
