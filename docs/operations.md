# Operations

Run the Worker tests and type-check before changing behavior. Apply D1 migrations only
to your own environment after reviewing their SQL. Keep public and evaluation caller
tokens separate. Use protected environments for deployments and do not auto-deploy a
consumer repository when this project is released.

Operational secrets are `ASSISTANT_PROXY_TOKEN`, `ASSISTANT_EVAL_TOKEN`, optional
provider keys, and `ASSISTANT_ADMIN_TOKEN`. Store them with `wrangler secret put`; never
place them in `wrangler.jsonc`, `.dev.vars` committed content, logs, fixtures, or GitHub
Actions variables. Rotate proxy and evaluation credentials independently.

Monitor Worker errors, D1 quota reservation failures, provider fallback rates, response
latency, and budget alerts. A D1 failure fails closed before retrieval/model use. Provider
failure returns a conservative fallback after quota reservation so usage remains bounded.

For incidents, set `ASSISTANT_FALLBACK_ONLY_MODE` to `true` in the deployed environment,
verify `/health`, and test the trusted proxy. Roll back with a previously reviewed Worker
version through Cloudflare; do not change a consuming website's pin to an unreviewed commit.
