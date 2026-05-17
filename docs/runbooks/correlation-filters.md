# Correlation Filters

Reference for `operationId`, `correlationId`, and `causationId` filter args on the six telemetry view actions.

---

## What are the three IDs?

| ID | Scope | Notes |
|----|-------|-------|
| `correlationId` | Chain-stable — survives across dispatch boundaries unchanged | The anchor for "this entire workflow." When a chain root is minted, `correlationId` self-binds to `operationId`. |
| `operationId` | Single dispatch boundary crossing | A fresh UUID is minted on every `dispatch()` call. Idempotent retries reuse the same value via `AppendOptions.idempotencyKey`. |
| `causationId` | One hop only | The upstream event id that triggered the current event. Undefined for chain roots. |

Source of truth: `servers/exarchos-mcp/src/dispatch/dispatch-context.ts`.

---

## When to filter

| Goal | Filter by |
|------|-----------|
| Telemetry scoped to one whole workflow (across dispatch boundaries) | `correlationId` |
| Telemetry for one specific dispatch call only | `operationId` |
| Trace what caused a specific event one hop back | `causationId` |
| Cross-workflow rollups (e.g., all gate pass rates last week) | No filter |

---

## How — MCP

```
exarchos_view({
  view: "telemetry",
  correlationId: "cor-workflow-7a3f"
})
```

Successful response shape (abbreviated):

```json
{
  "success": true,
  "data": {
    "session": {
      "start": "2026-05-16T10:00:00.000Z",
      "totalInvocations": 42,
      "totalTokens": 18300
    },
    "tools": [
      { "tool": "exarchos_workflow", "invocations": 12, "errors": 0 }
    ],
    "hints": []
  }
}
```

The response reflects only events whose `correlationId` matches the supplied value.

---

## How — CLI

```bash
exarchos view telemetry --correlation-id cor-workflow-7a3f
```

Filter by `operationId`:

```bash
exarchos view telemetry --operation-id op-a1b2c3d4
```

Filter by `causationId`:

```bash
exarchos view telemetry --causation-id evt-upstream-99
```

Terminal output shows the same `session` + `tools` structure as the MCP response, rendered as a table.

> Note: the `--operation-id`, `--correlation-id`, and `--causation-id` flags are wired in `adapters/cli.ts` (Task 6, #1448 item 4). This runbook documents the stable contract.

---

## AsyncLocalStorage default

When an agent runs inside a `runWithDispatchContext` scope and calls a telemetry view action **without supplying any filter arg**, the helper `deriveCorrelationFilters` (in `views/tools.ts`) automatically defaults `correlationId` to the active dispatch context's `correlationId`.

This is the ergonomic "show me telemetry for the workflow I'm currently in" behavior — no manual threading required.

Rules:

- **Explicit args always win.** Supplying any of `operationId`, `correlationId`, or `causationId` disables the default entirely.
- **No active context → no default.** An uncovered call site returns an unfiltered result.
- **Observable.** The default path emits a debug log entry: `{ source: 'ctx-default', correlationId: '...' }`. Explicit args emit `{ source: 'explicit' }`. No-filter emits `{ source: 'none' }`.

---

## Supported view actions

All six actions accept the same three filter args:

| Action | Description |
|--------|-------------|
| `telemetry` | Aggregated per-tool metrics and token usage |
| `delegation_timeline` | Subagent dispatch timeline |
| `code_quality` | Quality gate pass rates and regressions |
| `eval_results` | Eval suite outcomes and calibration records |
| `quality_correlation` | Gate-to-skill correlation signals |
| `quality_attribution` | Finding attribution by skill |

---

## Out of scope

Cross-tier correlation propagation (basileus / remote MCP) is deferred per INV-3 of the correlation consumer wiring design. The ten other view actions (`pipeline`, `tasks`, and others in `TOOL_REGISTRY`) do not yet accept correlation filters; they are tracked under #1446.
