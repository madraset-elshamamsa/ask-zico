# Ask Zico

Ask Zico is a production reference implementation for an Arabic-first, citation-bound
retrieval-augmented assistant on Cloudflare Workers. It demonstrates controlled hybrid
retrieval, evidence hydration by stable chunk ID, citation validation, conservative
fallbacks, quota reservations, provider routing, feedback, and observability.

It is intentionally an **Ask Zico profile**, not a turnkey universal chatbot. The
Arabic/Coptic aliases, domain router, response policy, and example corpus illustrate
one deployed product's decisions. Adapt them deliberately for your own domain.

## What is included

- Cloudflare Worker, D1 migrations, and 194 regression tests.
- Corpus ingestion, KV preparation, Vectorize preparation, and evaluation tools.
- A small original Arabic sample corpus that can be generated without private paths.
- A public API contract and examples of a protected server-side proxy pattern.

## What is not included

No production corpus, visitor data, provider credentials, Cloudflare account identifiers,
Madraset El Shamamsa branding, or deployment secrets are included. See [NOTICE.md](NOTICE.md)
and [BRANDING.md](BRANDING.md).

## Quick start

Requirements: Node.js 22+ and npm. For a Worker deployment, create your own Cloudflare
account and bindings using `worker/wrangler.example.jsonc`; never copy a production
configuration.

```powershell
cd worker
npm ci
npm test
npm run typecheck
cd ..
node --test tools/generate-rag-jsonl.test.mjs
npm run ingest:sample
```

The last command writes generated sample artifacts under `.local/assistant-ingest/`.
The sample demonstrates corpus generation. A hosted response path additionally requires
your own KV, D1, Vectorize/Workers AI, caller tokens, and optional model-provider keys.

## Integration boundary

Browsers should not call the Worker with privileged credentials. Put a server-side proxy
in front of it. The proxy validates its own site/session context, creates an opaque quota
identity, and sends the private caller token to the Worker. See `examples/php-proxy/` and
[`contract/openapi.yaml`](contract/openapi.yaml).

The public contract covers `/health`, `/api/assistant/message`,
`/api/assistant/feedback`, and `/api/assistant/quota-status`. Protected evaluation and
observability endpoints are documented for maintainers, not browser clients.

## Development

```powershell
npm test
npm run typecheck
```

Release tags follow semantic versioning. A compatible integration pins a reviewed release
and validates against the published contract fixtures; no release workflow should deploy a
consumer automatically.

## Security, contributions, and licenses

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Focused issues
and pull requests are welcome under [CONTRIBUTING.md](CONTRIBUTING.md). Code is MIT-licensed;
the sample corpus has separate CC BY 4.0 terms.
