# Architecture

A browser calls a trusted application proxy. The proxy owns visitor identity and keeps
the Worker caller token secret. The Worker normalizes the query, retrieves candidate
chunks, hydrates original source text by chunk ID, validates model citations against the
retrieved set, and returns structured citations or a conservative fallback.

The sample corpus is local-only evidence. Production deployments supply their own
corpus, bindings, policies, observability, and model credentials.

## Ownership boundary

This repository owns the Worker runtime, its D1 migrations, ingestion and evaluation
tools, the public API contract, release tags, and deployment instructions. A consuming
website owns browser UI, session and abuse controls, opaque actor/network identity,
the server-side proxy, and the pinned Ask Zico version it has reviewed.

The browser never calls the Worker directly. The proxy sends only the documented v1
payload and checks the `x-ask-zico-contract-version` response header. Production corpus
and Cloudflare resource identifiers are deployment inputs, not source-controlled assets.
