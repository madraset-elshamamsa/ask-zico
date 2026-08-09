# Release and public-readiness checklist

Before tagging a release candidate:

- Run `npm ci`, `npm ci --prefix worker`, `npm test`, `npm run lint:contract`,
  `npm run typecheck`, `npm run ingest:sample`, and the Worker deploy dry-run.
- Confirm the OpenAPI version, health response, fixtures, and integration documentation
  agree. Breaking contract changes require a new major contract version.
- Review dependencies, licenses, generated sample output, and the full Git diff.
- Scan the working tree and Git history for secrets, private corpus content, visitor data,
  production resource identifiers, internal-only URLs, and non-redistributable assets.
- Verify security reporting, code of conduct, contribution, branding, notice, and license
  files are present and accurate.
- Create an immutable release candidate tag and record its commit SHA for consumers.

Before changing repository visibility to public:

- Verify the private release candidate in the real consuming website using the pinned tag
  and SHA, including negative and timeout paths.
- Confirm organization owners approve the repository name, description, topics, security
  contact, branch rules, and public visibility.
- Confirm no open issue, Actions artifact, release attachment, branch, or tag exposes
  production data or credentials.
- Obtain the explicit public-release approval used by the owning team. Repository transfer,
  a green CI run, or a release candidate tag does not itself authorize public visibility.
