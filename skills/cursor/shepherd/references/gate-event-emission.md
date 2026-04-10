# Gate Event Emission

`gate.executed` events track CI check results for quality analysis in CodeQualityView.

## Event Format

```javascript
{
  type: "gate.executed",
  data: {
    gateName: "<check-name>",
    layer: "CI",
    passed: <true|false>,
    duration: <duration-ms-if-available>,
    details: {
      skill: "shepherd",
      commit: "<head-sha>"
    }
  }
}
```

## Emission Source

The `assess_stack` composite action (`exarchos_orchestrate`) automatically emits `gate.executed` events for each CI check it observes. The shepherd skill does **not** need to emit these manually — they are handled internally by `assess_stack`.

If `assess_stack` is unavailable (fallback mode), emit manually via:
```javascript
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  stream: "<featureId>",
  event: {
    type: "gate.executed",
    data: {
      gateName: "<check-name>",
      layer: "CI",
      passed: <true|false>,
      duration: <duration-ms-if-available>,
      details: { skill: "shepherd", commit: "<head-sha>" }
    }
  }
})
```

## Downstream Consumer

CodeQualityView tracks gate pass rates and detects quality regressions. The `gatePassRate` metric per skill drives the quality signal surfaced in Step 0 of the shepherd loop.
