# CI Check Event Emission

`ci.check_observed` events track CI check results for quality analysis in CodeQualityView.

These were `gate.executed` events until the two uses of that name were split. A CI check and a gate this repository runs are different populations, and sharing one type put every GitHub check into the same `gates[...]` namespace as our own gates — so a CI job named after one of ours merged two pass rates into one number.

## Event Format

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

## Emission Source

The `assess_stack` composite action (`exarchos_orchestrate`) automatically emits `ci.check_observed` events for each CI check it observes, one per check per PR, beside the `ci.status` roll-up it emits per PR. The shepherd skill does **not** need to emit these manually — they are handled internally by `assess_stack`.

If `assess_stack` is unavailable (fallback mode), emit manually via:
```javascript
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  stream: "<featureId>",
  event: {
    type: "ci.check_observed",
    data: {
      pr: <pr-number>,
      check: "<check-name>",
      passed: <true|false>,
      skill: "shepherd"
    }
  }
})
```

## Downstream Consumer

CodeQualityView folds these into the per-skill metrics only. Driving checks green is the shepherd's outcome, so its `gatePassRate` is computed from them, and that metric drives the quality signal surfaced in Step 0 of the shepherd loop. No `gates[...]` entry is written: a CI check is not a gate this repository runs.
