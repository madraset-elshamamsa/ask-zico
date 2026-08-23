# Changelog

All notable changes are documented here. Ask Zico follows semantic versioning for release
tags and separately versions its HTTP contract.

## Unreleased

- Added AR/EN message classification, English-to-Arabic retrieval-query translation, direct
  English grounded answers, and unsupported-language short-circuiting.
- Advanced the HTTP contract to v1.1 with `detected_language` and `answer_language`.
- Added translation observability, an additive D1 migration, an AR/EN example client, and
  25 bilingual retrieval-parity evaluation pairs.

## 1.0.0-rc.4 — 2026-08-09

- Established the standalone Worker, D1 migrations, ingestion/evaluation tools, and original
  sample corpus under the `madraset-elshamamsa` organization.
- Published the executable OpenAPI v1 contract, fixtures, and deterministic local stub.
- Replaced the legacy beta caller with separate proxy and evaluation credentials.
- Added atomic quota reservations, fallback preservation, configurable public-site actions,
  UTF-8 checks, governance files, manual deployment guidance, and credential-free CI.
- Updated the runtime and development dependency graph to zero reported npm advisories.

RC.1 and RC.2 were private integration candidates and were superseded without deployment;
their immutable tags remain available for audit history.
