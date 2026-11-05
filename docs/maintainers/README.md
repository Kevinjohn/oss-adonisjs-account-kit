# Maintainer records

These records support releases and are not needed to use Account Kit. They are kept in the
repository and left out of the npm package.

- [Releasing](releasing.md): the current GitHub release process and versioned documentation updates.
- [Release gate](release-gate.md): local/workflow gate boundaries, the reviewed starting baseline
  and clearly labeled historical candidate evidence.
- [Verification](verification.md): the release check list, then the dated local check results and consumer outcomes.
- [Source map](source-map.md): public subpath coverage, comment policy and deliberate compatibility differences.
- [Release assessment](release-assessment.md): how to rerun it, then the acceptance scenarios mapped to tests.
- [Manual check](manual-check.md): dated manual consumer installs.
- [Developer evaluation](developer-evaluation.md): the walkthrough tasks and their outcomes.

## Monthly

- Check each `uses:` in `.github/workflows/*.yml` for a newer release that matches its pin
  format (major tag such as `actions/checkout@v7`, or exact version such as
  `ossf/scorecard-action@v2.5.0`). Bump them in one PR.
- Check open Dependabot alerts (Security tab).
