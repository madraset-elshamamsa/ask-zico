# Architecture

A browser calls a trusted application proxy. The proxy owns visitor identity and keeps
the Worker caller token secret. The Worker normalizes the query, retrieves candidate
chunks, hydrates original source text by chunk ID, validates model citations against the
retrieved set, and returns structured citations or a conservative fallback.

The sample corpus is local-only evidence. Production deployments supply their own
corpus, bindings, policies, observability, and model credentials.
