---
name: oneshot-choice-state
---

# Oneshot Choice State: `implementing → ?`

The oneshot workflow has a UML *choice state* at the end of `implementing`.
Whether the workflow lands on `completed` (direct-commit) or transitions
through `synthesize` (PR) is decided by two mutually-exclusive pure-function
guards: `synthesisOptedIn` and `synthesisOptedOut`. Both are evaluated against
the current workflow state at the transition boundary; exactly one returns
`true` for every possible input.

## Inputs read by the guards

Both guards read exactly two things from state:

1. `state.oneshot.synthesisPolicy` — one of `'always' | 'never' | 'on-request'`,
   defaulted to `'on-request'` by the init schema.
2. `state._events` — the hydrated event stream. The guard counts
   `synthesize.requested` events on the stream (any count ≥ 1 means "opted in").

Nothing else. No clock reads, no filesystem, no network, no git state. This
is load-bearing for replay safety: given the same persisted state, the same
target resolves every time, and re-running finalize is idempotent.

## Decision table

| `synthesisPolicy` | `synthesize.requested` count | `synthesisOptedIn` | `synthesisOptedOut` | Resolved target |
|---|---|---|---|---|
| `'always'`     | 0  | `true`  | `false` | `synthesize` |
| `'always'`     | ≥1 | `true`  | `false` | `synthesize` |
| `'never'`      | 0  | `false` | `true`  | `completed`  |
| `'never'`      | ≥1 | `false` | `true`  | `completed`  |
| `'on-request'` | 0  | `false` | `true`  | `completed`  |
| `'on-request'` | ≥1 | `true`  | `false` | `synthesize` |

**Policy wins over event.** On `'never'`, even if a stray `synthesize.requested`
event is on the stream, the guard still routes to `completed`. Policy is the
user's declared intent; runtime events only matter when the policy explicitly
defers to them (`'on-request'`).

## Why a choice state, not a single transition with branching logic

Keeping the fork at the HSM level (two transitions, two mutually-exclusive
guards) means:

- The state machine graph visibly encodes both paths — operators reading
  `hsm-definitions.ts` see `implementing → completed` and `implementing →
  synthesize` as sibling transitions, not a hidden conditional.
- The HSM re-evaluates guards at the transition boundary, so any race
  between `finalize_oneshot` reading state and `handleSet` performing the
  transition is caught safely — if a last-millisecond event changed the
  evaluation, the HSM will refuse the wrong transition.
- Guard logic stays testable in isolation (`guards.test.ts`) without
  needing to spin up the handler.

## See also

- `servers/exarchos-mcp/src/workflow/guards.ts` — `synthesisOptedIn`,
  `synthesisOptedOut`, `oneshotPlanSet` guard implementations.
- `servers/exarchos-mcp/src/workflow/hsm-definitions.ts` — the oneshot HSM
  with the two sibling transitions from `implementing`.
- `servers/exarchos-mcp/src/orchestrate/finalize-oneshot.ts` — the handler
  that resolves the choice state and calls `handleSet`.
