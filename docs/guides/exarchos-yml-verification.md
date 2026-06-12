# `.exarchos.yml` — the `verification:` block

Overrides the verification ladder's **gate sequences** per policy cell. Ships with
v2.11.0 (epic #1515, R2/#1517). Without this block, the built-in ladder applies —
declaring it is always optional and always additive.

## The policy model

Every delegated task carries two orthogonal classification signals (derived
mechanically, or set explicitly in the plan):

- `riskTier` — `low | medium | high` blast radius
- `boundaryTouching` — whether the task crosses an I/O / schema boundary

The pair selects one of **six policy cells**, each resolving to an ordered list of
verification gate names. The built-in table (the substrate default,
`workflow/verification-policy.ts`):

| Cell | Sequence |
|---|---|
| low | `check_static_analysis` |
| medium | `check_static_analysis → check_test_adequacy` |
| high | `check_static_analysis → check_test_adequacy → check_integration_suite` |
| low + boundary | low + `check_contract_drift` |
| medium + boundary | medium + `check_contract_drift → check_mock_boundary` |
| high + boundary | high + `check_contract_drift → check_mock_boundary` |

## Overriding cells

```yaml
verification:
  policy:
    medium: [check_static_analysis, check_test_adequacy, check_contract_drift]
    boundary:
      low: [check_static_analysis, check_contract_drift]
```

Semantics:

- **Cell-wise full replacement.** A configured cell wins verbatim; an absent cell
  falls back to the built-in cell. There is no add/remove delta merging.
- **Gate names are schema-constrained** to the registered gate set
  (`check_static_analysis`, `check_test_adequacy`, `check_integration_suite`,
  `check_contract_drift`, `check_mock_boundary`). An unknown name or a duplicate
  within a cell fails at config parse, not at gate time.
- **An explicit empty cell is valid** — `medium: []` means "run no ladder gates
  for medium-tier non-boundary tasks." The skip is visible: gate results carry
  the policy source in their skip reason (`policy: config`).
- **Resolution is observable.** The `verification-toolchain` doctor check reports
  each cell's source (`builtin` vs `config`), and every gate skipped by policy
  names the resolved sequence and its source.

## Per-workflow severity

Verification-ladder gate failures resolve to **advisory (warning)** for `oneshot`
workflows by default; `feature` / `debug` / `refactor` workflows keep blocking
semantics. An explicit per-gate severity override (`review.gates.<gate>`) always
wins over the workflow default. Severity stays on the existing `review:` surface —
the `verification:` block governs *which gates run*, not *how hard they fail*.

## What is deliberately NOT here

- **No policy seeding.** `onboard` / `doctor --fix` seed resolved *commands*
  (`test:`, `typecheck:`, `mutation:`, `lint:`) into `.exarchos.yml`, but never
  write a `verification:` block. Seeding policy would freeze today's built-in
  defaults into your repo and silently diverge as the substrate evolves — policy
  resolves at runtime, every run.
- **No custom gate names.** Sequences compose the registered gates only.
- **No per-tier severity.** The tier axis controls whether a gate runs; severity
  controls how hard a failure lands. They don't cross.

## See also

- [`toolchain-resolution.md`](toolchain-resolution.md) — how the ladder's
  commands (`test`/`typecheck`/`mutation`/`lint`/`contract`) resolve.
- `docs/designs/2026-06-11-verification-ladder-slice2.md` — the design this
  block shipped with (R2 #1517 + R9 #1524).
- `docs/designs/2026-06-09-verification-ladder-slice1.md` — the ladder itself.
