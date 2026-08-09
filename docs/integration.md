# Integrating a website

Ask Zico is integrated through a trusted server-side proxy, never directly from browser
JavaScript. The consuming application checks out a reviewed release tag and commit SHA,
runs the contract tests, and implements the endpoints in `contract/openapi.yaml`.

## Local contract stub

Install root dependencies and start the deterministic stub:

```powershell
npm ci
$env:ASK_ZICO_STUB_PROXY_TOKEN = "local-contract-token"
npm run stub:contract
```

The stub listens on `127.0.0.1:8790` by default. Point the application proxy at that URL
and use the same local token. It returns stable v1 fixtures without Cloudflare, D1, KV,
Vectorize, a corpus, or model-provider credentials.

## Proxy responsibilities

- Keep `ASSISTANT_PROXY_TOKEN` server-side and redact it from logs.
- Accept only same-site requests using the consumer's existing session/CSRF controls.
- Derive opaque `actor_id` and `network_id` values; do not send raw IP addresses or email
  addresses to Ask Zico.
- Forward message, quota-status, and feedback payloads from the v1 contract.
- Set timeouts, preserve safe upstream status codes, and return a conservative local error
  when the Worker is unavailable.
- Verify `x-ask-zico-contract-version: 1.0.0` during health checks and integration tests.

`examples/php-proxy/ask-zico-proxy.php` shows the minimal transport boundary. Production
consumers must add their own authentication, request validation, rate limiting, structured
logging, and error mapping around it.

## Upgrade procedure

1. Review the Ask Zico release notes and the exact tag commit.
2. Update the consumer's tag and SHA pin together.
3. Run Ask Zico contract, Worker, ingestion, and consumer proxy integration tests.
4. Exercise message, quota, feedback, invalid-token, invalid-payload, and timeout paths.
5. Merge the consumer pin only after review; a tag name without a matching SHA is not enough.
