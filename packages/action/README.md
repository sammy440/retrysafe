# retrysafe GitHub Action

Runs [retrysafe](../../README.md) on every push and pull request. Findings appear as annotations on the
exact lines, and the full report (effect maps, failing sequences, fixes) goes into the job summary.

```yaml
name: retrysafe
on: [pull_request, push]

jobs:
  retrysafe:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # only for sarif: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: sammy440/retrysafe/packages/action@main
        with:
          fail-on: error        # error | warning | info | never
          changed-only: "true"  # on PRs, only handlers whose code changed
          sarif: "false"        # also upload to code scanning
```

| Input | Default | |
|---|---|---|
| `path` | `.` | Directory to analyze |
| `version` | `latest` | retrysafe version from npm |
| `fail-on` | `error` | Fail on findings at or above this severity, or `never` |
| `changed-only` | `true` | On pull requests, report only handlers affected by the diff |
| `sarif` | `false` | Upload SARIF to GitHub code scanning |
| `args` | | Extra CLI arguments, e.g. `--min-confidence high` |

The config file (`retrysafe.config.ts`) and baseline (`.retrysafe-baseline.json`) in the analyzed
directory are picked up automatically, so existing findings recorded with `--update-baseline` do not
fail the build.
