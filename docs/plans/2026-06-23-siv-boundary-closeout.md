# Implementation Plan — SIV boundary-tier closeout (preview.4 drain of #1515)

- **Date:** 2026-06-23
- **Feature id:** `siv-boundary-closeout`
- **Design:** [`docs/designs/2026-06-23-siv-boundary-closeout.md`](../designs/2026-06-23-siv-boundary-closeout.md)
- **Closes:** #1529 (SIV-3B), #1531 (SIV-5), #1532 (SIV-6), #1533 (SIV-7 — drop), #1561 + #1572 (token proof). Drains `build:preview.4`; lets #1515 close.

## Decomposition strategy

Three disjoint **code** files carry the substantive work — `orchestrate/static-analysis.ts` (SIV-3B), `config/toolchains.ts` (SIV-5), `orchestrate/onboard/hooks.ts` (#1572 Gap-1) — so Tasks 1–3 run as **parallel worktrees**. All shared-doc edits to `testing-strategy-guide.md` / `task-template.md` (the SIV-3B R6 coupling, SIV-5 caveats, and the entire SIV-6 deliverable) are funnelled into a **single doc task (Task 4)** so no two worktrees write the same reference file. The SIV-7 drop (Task 5) is doc + issue-close. The #1561 live proof (Task 6) is the closeout verification — it *observes* the bundle's own agent-team dispatch, so it runs last.

> **MCP-server tasks (1, 3, 6):** `servers/exarchos-mcp/` has a **separate** typecheck — run `cd servers/exarchos-mcp && npm run typecheck` (root `tsc` false-greens MCP type errors) and scoped `npm run test:run`. A fresh worktree needs `cd servers/exarchos-mcp && npm install` before scoped tests (nested `node_modules`).
> **Doc task (4):** any `skills-src/**` reference edit must `npm run build:skills` + update `snapshots.test.ts` (`vitest -u`) **and** the `batch-baselines/` copy; `npm run skills:guard` exit-1 pre-commit is expected until both are regenerated.

---

### Task 1: SIV-3B — "no raw IO into core" taint leg on `check_static_analysis` (#1529)
**Risk Tier:** medium
**Boundary Touching:** true

Add a second boundary leg under the lint gate in `static-analysis.ts` (sibling to the shipped Layer-A `runBoundaryLint` dependency-cruiser leg). A custom AST rule — `runRawIoTaint` — that flags results of `JSON.parse` / `response.json()` / `req.body` / `fs.read*` **not immediately consumed by a registered parse fn** (`parsers:` convention, resolved like a toolchain entry — see Task 1a decision below), AND forbids downstream `as Brand` / `as any` casts (Zod `.brand()` is compile-time-only; one stray cast defeats it). For non-TS runtimes the leg **degrades to a Semgrep/CodeQL taint query** (guarantee agnostic, impl per-runtime — INV-4); absent any backend it SKIP/advisory-degrades like Layer A. Emit `gate.executed`. Document the degrade path in the module JSDoc.

- **Decision (1a):** the parse registry is a **directory convention resolved like a toolchain entry** (`parsers: ['src/parse/**']`), not a new `.exarchos.yml` top-level key — matches the artifact/convention precedent of the `contract`/`mutation` fields in `toolchains.ts`. Resolve, don't bake.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe (test-after).
**Files:** `servers/exarchos-mcp/src/orchestrate/static-analysis.ts`, `servers/exarchos-mcp/src/orchestrate/static-analysis.test.ts` (+ a `parse/` registry fixture).
**Expected tests:** `RawIoTaint_UnparsedJsonParseIntoCore_Flags`, `RawIoTaint_ResultCrossesRegisteredParser_Passes`, `RawIoTaint_DownstreamAsBrandCast_Flags`, `RawIoTaint_NoTaintBackend_SkipsAdvisory`, `StaticAnalysis_FoldsTaintLeg_IntoReport`.
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: SIV-5 — `hermetic` resolution table on the toolchain resolver (#1531)
**Risk Tier:** high
**Boundary Touching:** true

Type reshape: add a `hermetic` field to `ToolchainCommands` (mirroring the existing `contract: ContractCommands | null`) and a `hermetic` resolution table mapping **detected unowned-dependency class → preferred high-fidelity double** (DB → Testcontainers; cloud-API → LocalStack; owned-interface → fake; third-party HTTP → Pact-verified stub). **Emit the resolution, not a baked literal** (INV-4 gen-time-placeholder trap). Seed every `BUILTIN_TOOLCHAINS` entry (the reshape — high blast). Wire it as the constructive target of SIV-4's existing `next_actions` steer in `mock-boundary.ts`: a flagged mock of an unowned dep now resolves to a concrete, inspectable double (`--dry-run`-style). Encode the honesty caveats as code comments/acceptance: emulators are fakes-of-the-cloud (higher-fidelity, not a guarantee); Docker cost ⇒ boundary/offline cadence.

**Verification (high):** medium set + the integration suite across the resolver↔mock-boundary seam (this is a type reshape touching all toolchain entries — full scoped suite, not per-file).
**Files:** `servers/exarchos-mcp/src/config/toolchains.ts`, `servers/exarchos-mcp/src/config/toolchains.test.ts`, `servers/exarchos-mcp/src/orchestrate/mock-boundary.ts`, `servers/exarchos-mcp/src/orchestrate/mock-boundary.test.ts`.
**Expected tests:** `Hermetic_DbDependency_ResolvesTestcontainers`, `Hermetic_CloudApi_ResolvesLocalStack`, `Hermetic_Resolution_IsInspectableNotBaked`, `MockBoundary_UnownedMock_NextActionsTargetsHermeticDouble`, `Toolchains_EveryBuiltin_HasHermeticField`.
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3: #1572 Gap-1 — onboard hook symmetry (SubagentStop + SessionEnd)
**Risk Tier:** medium
**Boundary Touching:** false

`onboard/hooks.ts:installHook` writes **only** the `SessionStart` binding into `settings.json`; the plugin's `hooks/hooks.json` declares `SubagentStop → exarchos subagent-stop` (+ `SessionEnd`), so standalone-CLI consumers get no per-subagent token attribution. Extend `installHook` (and `buildBindingGroup` / the settings shape) to also write the `SubagentStop` and `SessionEnd` bindings, **capability-gated** on `subagentStopEvent` / `sessionEndEvent` (INV-4), symmetric with the existing `SessionStart` path and idempotent (no duplicate group on re-onboard).

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe. Onboard into a clean `$HOME` fixture → assert all three bindings present; re-onboard → no duplicates; capability absent → binding skipped.
**Files:** `servers/exarchos-mcp/src/orchestrate/onboard/hooks.ts`, `servers/exarchos-mcp/src/orchestrate/onboard/hooks.test.ts`.
**Expected tests:** `InstallHook_WritesSubagentStopBinding_WhenCapable`, `InstallHook_WritesSessionEndBinding_WhenCapable`, `InstallHook_SkipsSubagentStop_WhenCapabilityAbsent`, `InstallHook_Reonboard_NoDuplicateBindings`.
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 4: SIV doc coupling — `testing-strategy-guide.md` + `task-template.md` (SIV-3B R6 + SIV-5 caveats + **all of SIV-6 #1532**)
**Risk Tier:** low
**Boundary Touching:** false

Single owner of the shared reference edits, to avoid worktree conflicts:
- **SIV-3B coupling:** promote parse-don't-validate (methodology E) in the R6 cheap-mix for boundary tasks; couple it to the SIV-1 boundary axis.
- **SIV-5 caveats:** the hermetic fidelity order (real > fake > stub/mock) + the boundary/offline cadence caveat.
- **SIV-6 (the whole deliverable #1532):** extend the **"State machines"** category row from internal HSM/circuit-breaker to **external stateful integrations** (agent authors a small reference model + commands; runner fuzzes real-vs-model via `fc.commands`+`modelRun` / Hypothesis `RuleBasedStateMachine`), routed by SIV-1 to stateful boundaries only. Add the **non-negotiable provenance guardrail**: the model MUST cite acceptance-criterion IDs, be kept strictly simpler than the impl, be authored before/with the code (never reverse-engineered), and include a **known-bad-trace rejection** (the model rejects a seeded-wrong transition). Add the matching provenance fields/checklist to `task-template.md`.

**Verification (low):** static — `npm run build:skills`, then `vitest -u snapshots.test.ts` + refresh the `batch-baselines/` copy; `npm run skills:guard` green; no executable gate (SIV-6's enforcement is the planner requirement + the agent's own known-bad-trace property test — an executable provenance gate is a deferred follow-up, not this bundle).
**Files:** `skills-src/implementation-planning/references/testing-strategy-guide.md`, `skills-src/implementation-planning/references/task-template.md`, regenerated `skills/**` + `batch-baselines/**`.
**Dependencies:** Task 1, Task 2 (prose references their resolved conventions — `parsers:` registry, `hermetic:` table)
**Parallelizable:** No (sole editor of the shared reference; serialize after 1, 2)

---

### Task 5: SIV-7 drop — rationale note + close #1533 (won't-do)
**Risk Tier:** low
**Boundary Touching:** false

Record the disposition: IaC-as-verification cannot be a substrate default without leaking a cloud assumption (INV-6) and pushes against INV-15; SIV-5's hermetic doubles cover the cloud-boundary *double* need; the `terraform plan`-diff sliver is re-openable later keyed on a real cloud-coupled consumer. Add a short note (link it from the #1515 epic). **No `verification.infra` / provisioner surface lands.** The `gh issue close 1533` (with the rationale comment) executes at **synthesize/merge** time, not mid-implementation.

**Verification (low):** static — INV-6 lint + audit stay green (assert no new `verification.infra` key, no provisioner import).
**Files:** `docs/designs/2026-06-23-siv-boundary-closeout.md` §5 (already written) + a one-paragraph disposition note (or epic comment).
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 6: #1561 live token-population proof + #1572 Gap-2 documentation
**Risk Tier:** low
**Boundary Touching:** false

The closeout verification. Because the SIV bundle is delegated via Exarchos's **own agent-team worktree dispatch** (orchestrator owns the worktree path, emits `team.teammate.dispatched`/`team.task.assigned` with the real cwd *before* the agent runs), that dispatch IS the #1561 representative batch. After Task 3 lands (so the hook is installed) and the bundle is dispatched, confirm `exarchos_view team_performance` and `delegation_timeline` show **non-empty per-teammate token metrics** on the `siv-boundary-closeout` stream, and that the session→workflow manifest binds the correct feature stream. Document #1572 **Gap 2** (Agent-tool native-isolation incompatibility — opaque post-hoc cwd, orchestrator cannot pre-declare cwd/agent_id) as a known INV-4 coverage limitation in the `subagent-stop.ts` JSDoc: *live token capture requires Exarchos agent-team worktree dispatch.* Note the post-hoc `subagent.tokens_unattributed` reconciliation as a future option, not built here.

**Verification (low):** observational — `subagent.tokens_used` events present on the real stream; both views non-empty; the Agent-tool gap logged, never failed.
**Files:** `servers/exarchos-mcp/src/cli-commands/subagent-stop.ts` (JSDoc coverage-gap note), a short note in the design/docs.
**Dependencies:** Task 3 (hook must be installed for the proof to populate)
**Parallelizable:** No (runs last; observes the bundle's dispatch)

---

## Parallelization summary

| Group | Tasks | Mode |
|---|---|---|
| **Wave 1 (parallel worktrees)** | Task 1 (SIV-3B), Task 2 (SIV-5), Task 3 (Gap-1), Task 5 (SIV-7 drop) | disjoint files — run concurrently |
| **Wave 2 (serial)** | Task 4 (SIV doc coupling) | depends on 1, 2; sole editor of shared references |
| **Wave 3 (closeout)** | Task 6 (#1561 proof + Gap-2 doc) | depends on 3; observes the bundle's own dispatch |

**Definition of done:** all six tasks merged; #1529/#1531/#1532 implemented, #1533 closed won't-do, #1561/#1572-Gap-1 satisfied with Gap-2 documented; `build:preview.4` label drained; #1515 closeable; `npm run test:run` (root + `servers/exarchos-mcp`), both typechecks, and INV-6 lint green.
