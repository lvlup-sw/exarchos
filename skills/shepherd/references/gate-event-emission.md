# Gate Event Emission

After checking CI status for each PR, emit `gate.executed` events to the event store for quality tracking.

For each CI check result observed:

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  streamId: "<featureId>",
  event: {
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
})
```

This feeds the CodeQualityView, which tracks gate pass rates and detects quality regressions.
