# Reading the mutation-adequacy carrier and the Stryker report

The `mutation-adequacy` action returns a **fixed carrier** under `data`. The shape is stable across
every outcome — pass, fail, and the three degrade paths — so a consumer never has to branch on success
before reading the score fields. This is the INV-5b output contract: an advisory verdict rides the same
shape (`passed: false` + dimension severity), never a `success: false` envelope.

## The carrier

```jsonc
{
  "passed": true,            // mutationScore >= threshold (advisory — see advisory-threshold.md)
  "mutationScore": 0.62,     // killed / (total − noCoverage)  [0..1]
  "killed": 31,              // mutants a test caught
  "survived": 3,             // mutants that escaped — tests ran but asserted nothing strong enough
  "noCoverage": 5,           // mutants in code NO test exercises at all
  "total": 39,               // total mutants generated within the diff scope
  "threshold": 0.40,         // effective threshold (override > config > soft default)
  "report": { /* parsed Stryker mutation-testing-report-schema */ },
  "next_actions": [
    "write a test that kills src/foo.ts:42",
    "write a test that kills src/bar.ts:108"
  ]
}
```

### How the score is computed

`mutationScore = killed / (total − noCoverage)`.

This is the Stryker convention: **`noCoverage` is excluded from the denominator**. Uncovered code does
not yet have a verdict — counting it against the score would conflate "the test is weak" with "there is
no test." A run with a `denominator` of zero (everything is `noCoverage`) yields a score of `0` rather
than dividing by zero.

The two failure modes carry different remediation:
- **`survived`** — a test exercises the line but its assertions cannot distinguish the mutated behavior.
  The fix adds or strengthens an assertion. This is the "vacuous test" the backstop exists to catch.
- **`noCoverage`** — no test touches the line at all. The fix adds a test that exercises it, then
  asserts on the observable behavior.

## The Stryker `mutation-testing-report-schema`

The `report` field is the parsed Stryker mutation-testing-report-schema — the de-facto cross-language
standard (Stryker for JS/.NET, and the schema other runners emit). The structurally relevant slice:

```jsonc
{
  "schemaVersion": "1",
  "files": {
    "src/foo.ts": {
      "language": "typescript",
      "mutants": [
        { "id": "1", "mutatorName": "ConditionalExpression",
          "status": "Survived",                 // ← the MutantStatus
          "location": { "start": { "line": 42, "column": 5 }, "end": { "line": 42, "column": 18 } } }
      ]
    }
  }
}
```

### MutantStatus values

| Status | Meaning | Counted as |
|---|---|---|
| `Killed` | a test failed when the mutant was active (good) | `killed` |
| `Survived` | all tests passed with the mutant active (bad) | `survived` |
| `NoCoverage` | no test executed the mutated code | `noCoverage` |
| `Timeout` / `RuntimeError` / `CompileError` | the mutant could not be evaluated | (unresolved — not scored) |
| `Ignored` | excluded by configuration | (unresolved — not scored) |

Only `Killed`, `Survived`, and `NoCoverage` feed the carrier. The action derives `next_actions` from
the `Survived` and `NoCoverage` mutants' `file` + `location.start.line`.

## Degrade signals

Each degrade path returns `passed: true` so the advisory gate never blocks closed-with-an-error
(doctor-grade robustness). Recognize them by their discriminant field, not by `passed`:

| Discriminant | Cause | What to do |
|---|---|---|
| `skipped: true` + `reason` | no mutation runner resolved for the repo | report the remediation (install a runner / set `mutation:` in `.exarchos.yml`); not a failure |
| `warning` + `warnings[]` | the run produced no parseable report | note the warning; do not throw |
| `deferred: true`, `scope: "full"` | `scope:"full"` was requested | re-run with the default diff scope — full-tree is deferred to R10/v2.12 |

When a degrade path returns, the score fields are all `0` and there are no `next_actions` — do not read
them as a real "everything is uncovered" result.
