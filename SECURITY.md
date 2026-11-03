# Security policy

## Supported versions

Until 1.0, only the latest 0.x release receives security fixes. Upgrade to the latest release to
receive fixes.

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Kevinjohn/oss-adonisjs-account-kit/security/advisories/new)
or by email to [cve@kevinjohngallagher.com](mailto:cve@kevinjohngallagher.com). Never open a
public issue.

Please include the affected package version or commit, runtime and database versions, a concise
reproduction, and the impact you observed. Do not include live credentials or personal data.
For account-operation concerns, include whether the affected path uses SQLite or PostgreSQL and
whether the failure occurred before or after the database commit, if known.

The maintainer will acknowledge the report, confirm the affected versions, and agree a disclosure
date with you once a fix is ready.

## Verifying a release

For a downloaded `<tarball>.tgz`, run:

```sh
shasum -a 256 <tarball>.tgz
```

The resulting SHA-256 must match the value in the GitHub release notes for that version.

## Security model

[docs/guide/security.md](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/guide/security.md)
describes what Account Kit defends against and what remains the application's responsibility. The
dependency audit assessment is in
[compatibility](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/reference/compatibility.md#dependency-audit-assessment).

## Independent review

None yet.
