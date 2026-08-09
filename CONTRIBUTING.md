# Contributing

Issues and focused pull requests are welcome. Before opening a change, check that it
keeps the project a citation-bound reference implementation rather than a general
chatbot framework.

Do not contribute production content, personal data, secrets, provider keys, or
Madraset branding. New corpus fixtures must be original or accompanied by explicit
reuse permission and a license. Changes to public API behavior require matching
contract fixtures and a documented versioning decision.

Before opening a pull request, run:

```powershell
npm ci
npm ci --prefix worker
npm test
npm run lint:contract
npm run typecheck
npm run ingest:sample
npm --prefix worker run deploy:dry-run
```

Do not apply D1 migrations to a shared environment as part of contribution testing.
