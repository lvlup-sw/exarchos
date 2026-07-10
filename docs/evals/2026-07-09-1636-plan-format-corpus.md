# Plan-Format Corpus Benchmark (#1636) — deterministic arm

Runs the production `classifyTask` / `renderImplementerPrompt` over every stamped plan-format spec in `docs/specs/`. Arms: **E** (exarchos, plan-honoring — the fix) · **H0** (true production, `{id,title}` only — the current #1636 dispatched behavior) · **H1** (heuristic ceiling, files+testLayer but no stamp) · **N** (native flat model).

> 📊 **Modeled deterministic arm — partly superseded by the executed [#1670 benchmark](2026-07-09-1670-delegation-pipeline-empirical.md).** This calls the pure `classifyTask` directly (not the MCP schema/CLI/binary). **Executed & superseded:** the **verification depth** conclusion (Dimension 2, E-vs-H0) — measured through the real spawned binary, **90/124** corpus tasks corrected, #1669 the sole cause (causal pair equals released pair, so #1659 is neutral). **NOT resolved — the native model baseline (Dimension 1) is still open:** #1670's Exp 2 pinned `--model sonnet` and so could not measure native's routing; native plan mode / dynamic workflows *do* dispatch models per subtask, and this arm's own routing (Dimension 1) collapses to `opus` because model selection ignores the risk tier — filed as a defect ([#1672](https://github.com/lvlup-sw/exarchos/issues/1672)). **Still modeled (not re-executed) — read as directional:** the Dimension-1 model mix, the **H1 heuristic-ceiling** comparison, and the **model × risk-tier cross-tab**.

## Corpus

- Stamped specs: **8**
- Tasks parsed: **100**
- Tasks carrying a `riskTier` stamp: **100** (100%)
- Tasks carrying an explicit `boundaryTouching` stamp: **63**

## Dimension 1 — model & agent selection (arm E)

Exarchos routes model via `classifyTaskCore` (scaffolding-keyword / testLayer / deps / file-count), **independent of `riskTier`**. Defaults: `scaffolder→haiku`, `implementer→opus`.

- Agent mix: {"implementer":99,"scaffolder":1}
- Model mix: {"opus":99,"haiku":1}
- **vs native flat `opus`:** 1/100 tasks (1%) routed to the cheaper `haiku` — the cost saving from per-task routing.

> **Update ([#1670](2026-07-09-1670-delegation-pipeline-empirical.md) · Exp 2 — DEFERRED):** the native baseline is **still not measured**. #1670's spike pinned `--model sonnet`, which forces a flat result, so it could not observe native's routing (Claude Code plan mode / dynamic workflows *do* dispatch models per subtask). Worse, this arm's own routing — 99/100 → `opus` — ignores the risk tier entirely, a defect filed as [#1672](https://github.com/lvlup-sw/exarchos/issues/1672). The "vs native" model comparison is blocked until #1672 is fixed and native's real unpinned routing is measured. Read the Dimension-1 numbers below as **modeled and unvalidated**.

Model × risk-tier cross-tab (does the model track blast radius?):

| risk tier | haiku | sonnet | opus |
|---|---|---|---|
| low | 0 | 0 | 6 |
| medium | 0 | 0 | 49 |
| high | 1 | 0 | 44 |

- ⚠️ high-tier tasks on the cheap `haiku` model (possible under-powering): **1**
- ⚠️ low-tier tasks on the expensive `opus` model (possible over-powering): **6**

## Dimension 2 — verification depth

> **Executed update ([#1670](2026-07-09-1670-delegation-pipeline-empirical.md) · Exp 1):** this E-vs-H0 comparison is now run **through the real binary**. The pre-fix binary has no `planPath` support, so its before-arm is the honest heuristic (all tasks flat `medium`); the fixed binary lifts the plan stamps. Result: **90/124** tasks change tier or verification (49 regain the integration rung, 66 the boundary steers), and the causal pair equals the released pair (#1659 neutral). Read the executed numbers there; the modeled ones below are directional.

### E (plan-honoring) vs H0 (true production — `{id,title}` only) — the actual #1636 harm

`registry.ts:1441` registers `tasks: z.array(z.object({ id, title }))`, so today every task reaches the classifier as `{id, title}` — no stamp, no files, no testLayer. This is what actually ships.

- Tier **match**: **49/100** (49%)
- Tier **UNDER-provisioned** (H0 weaker than plan): **45/100** (45%)  ← the harm
- Tier over-provisioned: **6/100** (6%)
- **`check_integration_suite` rung lost**: **45/100** (45%) — every planner-`high` task ships without the integration rung
- **Boundary mock-steer lost**: **51/100** (51%)

### E (plan-honoring) vs H1 (heuristic ceiling — files+testLayer, no stamp)

> ⚠️ **Still modeled — NOT re-executed by #1670.** Exp 1 drove the real binary for E-vs-H0 (true production) only; the H1 "what if the orchestrator forwarded files+testLayer" ceiling has no real-binary path (the pre-fix binary accepts no such context), so the numbers in this subsection remain a pure-function model. Read as directional.

Isolates the heuristic quality itself: even IF the orchestrator forwarded full task context (which the registry schema forbids), how well does the keyword/glob heuristic recover the plan tier?

- Tier **match** (H agrees with plan): **48/100** (48%)
- Tier **UNDER-provisioned** by heuristic (H weaker than plan): **25/100** (25%)  ← the harm
- Tier **over-provisioned** by heuristic (H stronger than plan): **27/100** (27%)
- **`check_integration_suite` rung lost** (E has it, H doesn't): **24/100** (24%)
- **Boundary mock-steer lost** (plan boundary=true, heuristic=false): **49/100** (49%)
- Boundary phantom (heuristic adds boundary the plan didn't): **0/100**

Tier confusion (`plan→heuristic`):

| plan → heuristic | count |
|---|---|
| medium→medium | 26 |
| high→medium ⚠️ under | 24 |
| medium→high | 22 |
| high→high | 21 |
| low→medium | 5 |
| medium→low ⚠️ under | 1 |
| low→low | 1 |

## Per-task detail

| spec | task | files | plan tier | heur tier | Δtier | plan bnd | heur bnd | agent | model |
|---|---|---|---|---|---|---|---|---|---|
| rc1-closeout | 001 | 2 | medium | medium | = | true ⚠️ | false | implementer | opus |
| rc1-closeout | 002 | 2 | medium | medium | = | true ⚠️ | false | implementer | opus |
| rc1-closeout | 003 | 2 | low | medium | over | false | false | implementer | opus |
| rc1-closeout | 004 | 2 | low | medium | over | false | false | implementer | opus |
| rc1-closeout | 005 | 2 | medium | medium | = | true ⚠️ | false | implementer | opus |
| rc1-closeout | 006 | 1 | medium | medium | = | false | false | implementer | opus |
| rc1-closeout | 007 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| rc1-closeout | 008 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| rc1-closeout | 010 | 2 | medium | medium | = | true ⚠️ | false | implementer | opus |
| rc1-closeout | 009 | 1 | medium | medium | = | false | false | implementer | opus |
| wlm-foundation | 001 | 2 | medium | high | over | true ⚠️ | false | implementer | opus |
| wlm-foundation | 002 | 4 | medium | high | over | true ⚠️ | false | implementer | opus |
| wlm-foundation | 003 | 4 | medium | high | over | false | false | implementer | opus |
| wlm-foundation | 004 | 4 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-foundation | 005 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-foundation | 006 | 2 | medium | medium | = | false | false | implementer | opus |
| wlm-foundation | 007 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-foundation | 008 | 4 | medium | high | over | true ⚠️ | false | implementer | opus |
| wlm-foundation | 009 | 1 | medium | low | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-operational-core | 001 | 4 | high | high | = | false | false | implementer | opus |
| wlm-operational-core | 002 | 2 | medium | medium | = | false | false | implementer | opus |
| wlm-operational-core | 003 | 2 | high | medium | ⚠️ under | false | false | implementer | opus |
| wlm-operational-core | 004 | 4 | high | high | = | false | false | implementer | opus |
| wlm-operational-core | 005 | 2 | medium | medium | = | false | false | implementer | opus |
| wlm-operational-core | 006 | 4 | high | high | = | false | false | implementer | opus |
| wlm-operational-core | 007 | 3 | medium | high | over | false | false | implementer | opus |
| wlm-operational-core | 008 | 2 | high | medium | ⚠️ under | false | false | implementer | opus |
| risk-verification-closeout | 001 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| risk-verification-closeout | 002 | 6 | high | high | = | true ⚠️ | false | implementer | opus |
| risk-verification-closeout | 003 | 2 | low | medium | over | false | false | implementer | opus |
| risk-verification-closeout | 004 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| risk-verification-closeout | 005 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| risk-verification-closeout | 006 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| risk-verification-closeout | 007 | 2 | medium | medium | = | false | false | implementer | opus |
| risk-verification-closeout | 008 | 2 | medium | medium | = | false | false | implementer | opus |
| risk-verification-closeout | 009 | 1 | medium | medium | = | false | false | implementer | opus |
| risk-verification-closeout | 010 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| risk-verification-closeout | 011 | 0 | low | medium | over | false | false | implementer | opus |
| harness-launcher | 001 | 3 | medium | high | over | false | false | implementer | opus |
| harness-launcher | 002 | 3 | medium | high | over | false | false | implementer | opus |
| harness-launcher | 003 | 2 | high | medium | ⚠️ under | true ⚠️ | false | scaffolder | haiku |
| harness-launcher | 004 | 3 | medium | high | over | true | true | implementer | opus |
| harness-launcher | 005 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 006 | 5 | high | high | = | false | false | implementer | opus |
| harness-launcher | 007 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 008 | 1 | medium | medium | = | false | false | implementer | opus |
| harness-launcher | 009 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 010 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| harness-launcher | 011 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 012 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 013 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 014 | 1 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-launcher | 015 | 3 | high | high | = | false | false | implementer | opus |
| harness-launcher | 016 | 3 | high | high | = | false | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 001 | 5 | medium | high | over | true ⚠️ | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 002 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 003 | 1 | medium | medium | = | false | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 004 | 5 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 005 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 006 | 8 | medium | high | over | true ⚠️ | false | implementer | opus |
| wlm-6-surface-and-workflow-fixes | 007 | 10 | medium | high | over | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 001 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 002 | 4 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 003 | 2 | medium | medium | = | false | false | implementer | opus |
| wlm-reconcile-enforce | 004 | 3 | medium | high | over | false | false | implementer | opus |
| wlm-reconcile-enforce | 005 | 5 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 007 | 8 | medium | high | over | false | false | implementer | opus |
| wlm-reconcile-enforce | 008 | 1 | medium | medium | = | false | false | implementer | opus |
| wlm-reconcile-enforce | 009 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 010 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 011 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 021 | 4 | high | high | = | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 012 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 013 | 1 | medium | medium | = | false | false | implementer | opus |
| wlm-reconcile-enforce | 014 | 3 | medium | high | over | false | false | implementer | opus |
| wlm-reconcile-enforce | 015 | 2 | medium | medium | = | false | false | implementer | opus |
| wlm-reconcile-enforce | 016 | 3 | medium | high | over | false | false | implementer | opus |
| wlm-reconcile-enforce | 017 | 0 | low | medium | over | false | false | implementer | opus |
| wlm-reconcile-enforce | 018 | 2 | medium | medium | = | false | false | implementer | opus |
| wlm-reconcile-enforce | 020 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| wlm-reconcile-enforce | 019 | 0 | medium | medium | = | false | false | implementer | opus |
| harness-conform-and-shrink | 001 | 2 | medium | medium | = | false | false | implementer | opus |
| harness-conform-and-shrink | 002 | 3 | medium | high | over | false | false | implementer | opus |
| harness-conform-and-shrink | 003 | 3 | medium | high | over | false | false | implementer | opus |
| harness-conform-and-shrink | 023 | 2 | medium | medium | = | false | false | implementer | opus |
| harness-conform-and-shrink | 004 | 11 | high | high | = | false | false | implementer | opus |
| harness-conform-and-shrink | 006 | 3 | medium | high | over | false | false | implementer | opus |
| harness-conform-and-shrink | 007 | 16 | medium | high | over | false | false | implementer | opus |
| harness-conform-and-shrink | 021 | 1 | low | low | = | false | false | implementer | opus |
| harness-conform-and-shrink | 010 | 3 | medium | high | over | true ⚠️ | false | implementer | opus |
| harness-conform-and-shrink | 009 | 0 | high | medium | ⚠️ under | false | false | implementer | opus |
| harness-conform-and-shrink | 011 | 2 | medium | medium | = | true ⚠️ | false | implementer | opus |
| harness-conform-and-shrink | 012 | 2 | high | medium | ⚠️ under | true ⚠️ | false | implementer | opus |
| harness-conform-and-shrink | 013 | 0 | medium | medium | = | true ⚠️ | false | implementer | opus |
| harness-conform-and-shrink | 014 | 1 | medium | medium | = | false | false | implementer | opus |
| harness-conform-and-shrink | 015 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| harness-conform-and-shrink | 016 | 4 | medium | high | over | false | false | implementer | opus |
| harness-conform-and-shrink | 017 | 3 | high | high | = | true ⚠️ | false | implementer | opus |
| harness-conform-and-shrink | 022 | 7 | medium | high | over | true | true | implementer | opus |
| harness-conform-and-shrink | 018 | 2 | medium | medium | = | false | false | implementer | opus |
