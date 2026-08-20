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

## Multilingual request lifecycle

The UI locale and message language are deliberately separate. A consumer sends `locale`
as `ar` or `en` for interface observability. The Worker classifies the message itself:

1. Arabic proceeds unchanged to Arabic retrieval.
2. English is translated into a concise Arabic retrieval query through direct Gemini,
   with the configured OpenRouter route used only after a qualifying provider failure.
3. Unsupported languages stop before retrieval and model use with Arabic retry guidance.
4. The grounded answer prompt asks for Arabic or English according to the detected message
   language. There is no second output-translation call.

Retrieved context always uses the original Arabic `text`. Citations remain constrained to
retrieved `chunk_id` values, and Coptic terms, hymn titles, names, and quoted terms must be
preserved exactly. Only internal evaluation/debug paths may expose the translated retrieval
query. The public response exposes only `detected_language` and `answer_language`.
