# Security policy

## Supported versions

Security fixes go into the latest published minor version. Until 1.0, upgrade to the newest
release to receive fixes.

## Reporting a vulnerability

Report suspected vulnerabilities privately to [cve@kevinjohngallagher.com](mailto:cve@kevinjohngallagher.com).
Do not open a public issue.

Please include the affected package version or commit, runtime and database versions, a concise
reproduction, and the impact you observed. Do not include live credentials or personal data.
For account-operation concerns, include whether the affected path uses SQLite or PostgreSQL and
whether the failure occurred before or after the database commit, if known.

The maintainer will acknowledge the report, confirm the affected versions, and agree a disclosure
date with you once a fix is ready.

## Verifying a release

Releases are published from GitHub Actions with npm provenance. To check that an installed copy was
built from this repository:

```sh
npm audit signatures
```

## Security model

[docs/security.md](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/security.md) describes what Account Kit defends against and what remains
the application's responsibility. The dependency audit assessment is in
[compatibility](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/compatibility.md#dependency-audit-assessment).
