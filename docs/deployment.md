# Manual deployment

Deployment is deliberately manual for the initial release. CI verifies the same source and
performs a Wrangler dry-run, but it does not hold production credentials or deploy.

## Prepare an environment

1. Copy `worker/wrangler.example.jsonc` to the ignored `worker/wrangler.jsonc`.
2. Replace every example resource name and identifier with resources owned by your
   Cloudflare account. Keep the current compatibility date and `nodejs_compat` unless a
   reviewed change requires otherwise.
3. Create KV, D1, Vectorize, Workers AI, and rate-limit bindings named exactly as shown.
4. Review all SQL migrations, then apply them to the intended D1 database in order.
5. Load a licensed corpus into your own KV/Vectorize resources.
6. Add secrets with `wrangler secret put`; do not write secrets into either Wrangler file.

## Verify and deploy

```powershell
npm ci
npm ci --prefix worker
npm test
npm run lint:contract
npm run typecheck
npm run ingest:sample
npm --prefix worker run deploy:dry-run
cd worker
npx wrangler deploy --config wrangler.jsonc
```

After deployment, check `/health`, confirm contract version `1.0.0`, then exercise the
trusted application proxy with non-production test identities. A production deployment is
not authorized merely by merging source changes; it requires the deployment approval used
by the owning team.

## Future CI/CD

When automated deployment is introduced, use a protected GitHub environment with required
reviewers, least-privilege Cloudflare credentials, concurrency protection, a dry-run/build
artifact before deployment, and a post-deploy health/contract check. Keep pull-request CI
credential-free and never let a consumer repository deploy Ask Zico implicitly.
