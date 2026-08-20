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

For multilingual traffic, also monitor `ui_locale`, `detected_language`, `answer_language`,
`translation_status`, and `translation_latency_ms`. Translation model calls contribute to
the existing model-call and estimated-cost totals. The event row stores the original user
query and the existing normalized Arabic query; it does not store another translated-text
column. Investigate increases in `failed` or `missing_config` before enabling English UI
traffic broadly.

Migration `0010_add_assistant_language_observability.sql` is additive but must be reviewed
and applied before the matching Worker version. Take the normal D1 backup/export first.
Rollback is deployment rollback plus restoring that pre-migration database backup (or a
reviewed table rebuild); SQLite does not make these five added columns independently useful
to remove during an incident.

For incidents, set `ASSISTANT_FALLBACK_ONLY_MODE` to `true` in the deployed environment,
verify `/health`, and test the trusted proxy. Roll back with a previously reviewed Worker
version through Cloudflare; do not change a consuming website's pin to an unreviewed commit.
