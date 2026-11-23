# CI Check Events (history)

`ci.check_observed` and `ci.status` rows hold CI results from the earlier assessment action. Exarchos reads no CI state for the shepherd, so the shepherd skill appends none of these rows.

These rows were `gate.executed` events until the two uses of that name were split. A CI check and a gate this repository runs are different populations, and sharing one type put every GitHub check into the same `gates[...]` namespace as our own gates — so a CI job named after one of ours merged two pass rates into one number.

## Event Format

The rows that exist have this form:

```javascript
{
  type: "ci.check_observed",
  data: {
    pr: <pr-number>,
    check: "<check-name>",
    passed: <true|false>,
    skill: "shepherd"
  }
}
```

## What the Shepherd Records

Read the CI state with your own tools (`gh pr checks <number>`). Record the progress of the loop with `shepherd.iteration`, and each fix with `remediation.attempted` and `remediation.succeeded`. `shepherd-event-schemas.md` gives each schema.

## Downstream Consumer

CodeQualityView still folds the historical `ci.check_observed` rows into the per-skill metrics only, and ShepherdStatusView still folds the historical `ci.status` rows. No `gates[...]` entry is written: a CI check is not a gate this repository runs.
