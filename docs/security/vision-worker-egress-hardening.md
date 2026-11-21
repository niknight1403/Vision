# Vision Worker egress hardening runbook

## Status

The Compose network split and DNS-pinned HTTPS image fetch are covered by CI in draft PR #36. They are not deployed by this document. The current Render Blueprint deploys the API only; it does not deploy the Vision Worker or provide the worker's required private control/model network.

**Production gate:** do not expose the Vision Worker to untrusted tasks until outbound egress is explicitly restricted and the rules below are tested on the actual host.

## Required network flows

| Source | Destination | Port/protocol | Purpose |
| --- | --- | --- | --- |
| API | Vision Worker | TCP 8091, private control network | Authenticated analysis request |
| Vision Worker | API | TCP 8080, private control network | Authenticated checkpoint callback |
| Vision Worker | Ollama | TCP 11434, private model network | Local vision model |
| Vision Worker | Trusted DNS resolver | UDP/TCP 53 | Resolve exact allowlisted image hostnames |
| Vision Worker | Approved image origin IPs | TCP 443 | Download image bytes after DNS validation |
| Vision Worker | Configured fallback LLM endpoint | TCP 443, only if explicitly configured | Optional model fallback |

No other worker egress should be required. In particular, the worker must not connect to Postgres, Redis, cloud metadata endpoints, arbitrary internal networks, or arbitrary Internet destinations.

## Preferred production design: controlled egress proxy

A hostname-aware egress proxy is preferred over static firewall IP lists because marketplace/CDN image hostnames can rotate addresses.

The proxy must:
1. Accept only HTTPS CONNECT requests to port 443.
2. Enforce the same exact hostname allowlist as `VISION_ALLOWED_IMAGE_HOSTS`.
3. Resolve the hostname itself and reject the entire DNS answer set if any address is non-global.
4. Pin the TCP connection to one of those validated addresses for the lifetime of the request.
5. Preserve hostname-based TLS verification; never disable certificate checks.
6. Reject redirects or require every redirect target to be independently revalidated before following it.
7. Deny loopback, RFC1918, link-local, carrier-grade NAT, multicast, reserved, IPv6 ULA, IPv4-mapped IPv6, and cloud metadata destinations.
8. Log hostname, selected destination IP, decision, and request outcome without logging credentials or image contents.

When using a proxy, ensure the worker cannot bypass it with direct Internet access. Do not set a generic proxy variable and assume enforcement: the host firewall must deny direct worker egress except the explicitly required private control/model paths and DNS to the trusted resolver.

## Alternative: host firewall with synchronized IP sets

A firewall can permit direct HTTPS only when the validated destination IPs are inserted into a managed nftables/ipset allowlist. This is operationally more complex and must update atomically from the same validated DNS answers used by the fetcher.

Requirements:
- Use default-deny outbound policy for the worker container's host-side interface/bridge identity.
- Permit only TCP 443 to currently approved public IPs for configured image origins.
- Permit DNS only to the configured resolver; block alternate DNS and DNS-over-HTTPS bypass.
- Apply equivalent IPv4 and IPv6 rules. If IPv6 egress is not intentionally supported, disable it for the worker network and verify it cannot route around IPv4 policy.
- Explicitly block metadata ranges, private ranges, link-local, loopback, multicast, and reserved destinations before broad allow rules.
- Keep API and Ollama access on their dedicated Compose networks; do not add the worker to the `data` network.
- Do not publish Postgres, Redis, Ollama, or Vision Worker ports on the host.
- Test rules after Docker daemon restart and container recreation; Docker may modify firewall chains.

Do not copy generic `iptables` snippets into production without adapting them to the host's Docker firewall backend and testing the effective packet path. A firewall rule that is present but bypassable is not an acceptable control.

## Deployment verification checklist

Before enabling external image processing:
- [ ] Worker runs on a dedicated host/network with default-deny outbound policy.
- [ ] API and Ollama private paths work; Postgres and Redis are unreachable from the worker.
- [ ] A known allowlisted public image host is reachable over HTTPS.
- [ ] A non-allowlisted public host is blocked.
- [ ] DNS answers containing any private/reserved address are rejected.
- [ ] DNS changes between validation and connect cannot change the socket destination.
- [ ] IPv4 and IPv6 policies are both verified.
- [ ] Metadata endpoints and internal service ranges are unreachable.
- [ ] Redirects, proxy bypass, alternate DNS, and unexpected ports are blocked.
- [ ] Firewall behavior survives host restart and container recreation.
- [ ] Logs and alerting capture denied egress without exposing secrets.

## Current deployment limitation

The existing Render API service is a separate Free web service and the current Render configuration does not define a private Vision Worker service. Do not point the API at a public worker URL as a workaround. Deploy the API and worker on a platform/network that supports private service-to-service connectivity, or implement a deliberately authenticated private gateway before production use.

The API's successful `/health` response and database migrations are not evidence that specialist tasks complete end-to-end.

## Safety mode

Keep `TRADING_MODE=PAPER`, `LIVE_TRADING_ENABLED=false`, and the emergency stop enabled. This Vision workflow must not purchase items automatically; buying remains a separate, explicit human decision.
