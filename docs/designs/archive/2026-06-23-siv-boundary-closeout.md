# Design — SIV boundary-tier closeout (preview.4 drain of #1515)

- **Date:** 2026-06-23
- **Feature id:** `siv-boundary-closeout`
- **Status:** Design — feeds `/exarchos:plan`. No code committed.
- **Closes:** the open `build:preview.4` tail of epic **#1515** (risk-proportional verification pipeline) — #1529 (SIV-3 Layer B), #1531 (SIV-5), #1532 (SIV-6), #1533 (SIV-7, **dropped**) — plus the measurement close **#1561** and its blocker **#1572**.
- **Grounded against:** `docs/research/2026-06-06-structural-integration-verification.md` (the SIV-1…SIV-7 source), the live seams (`servers/exarchos-mcp/src/verbs/pure/static-analysis.ts`, `config/toolchains.ts`, `cli-commands/subagent-stop.ts`, `verbs/onboard/hooks.ts`, `skills-src/implementation-planning/references/testing-strategy-guide.md`), and `.exarchos/invariants.md`.

---

## 0. Thesis & scope

This is a **closeout**, not a new capability. Epic #1515's R1–R10 ladder and the SIV-1/2/3A/4 boundary gates already shipped; what remains is the boundary-tier tail. The SIV research already resolved each item's design forks — this design records the **disposition** of each remaining item (ship-as-specified / reshape / drop), grounds it against the current code, and hands `/plan` a tight, sequenced task set that **drains the `build:preview.4` label and lets #1515 close**.

Two user decisions (2026-06-23) shape the bundle:

1. **SIV-7 (#1533) is dropped entirely**, not reshaped. IaC-as-verification cannot be a substrate default without leaking a cloud assumption (INV-6), and SIV-5's hermetic doubles already cover the cloud-boundary *double* need. We close #1533 won't-do with a recorded rationale rather than shipping even the `terraform plan`-diff sliver — the sliver is re-openable later if a real consumer needs it.
2. **#1561 (live token-population proof) is in-scope**, which pulls in its blocker **#1572**. The only *code* deliverable there is the onboard hook-symmetry fix (Gap 1); the rest is a live dogfood run + a documented INV-4 coverage gap (Gap 2).

**In-scope build set:** SIV-3B taint rule · SIV-5 hermetic resolver · SIV-6 model-based conformance + provenance · SIV-7 drop (doc + close) · #1572 Gap-1 onboard symmetry + #1561 live proof.

**Out of scope:** real ephemeral infra provision/apply/teardown (the dropped SIV-7 tail); the `agent_id` non-cwd attribution path for Agent-tool native isolation (#1572 Gap 2 option-b — a harness-limited follow-up, documented not built).

---

## 1. Constraints (anchored to `.exarchos/invariants.md`)

- **INV-4** (platform-agnosticity / resolve-don't-bake) — every gate's guarantee is runtime-agnostic with a per-runtime impl; SIV-5's table and SIV-3B's degrade path emit *resolutions*, never baked literals.
- **INV-6** (workload-agnosticism) — the line SIV-7 crossed (hence the drop); SIV-3B/5/6 hold it (agnostic guarantee, per-runtime/per-artifact impl).
- **INV-1** (event-sourcing integrity) — new gates emit `gate.executed`; `subagent.tokens_used` is the record, folded by views, no side table.
- **INV-12** (next_actions as affordance) — SIV-5 is the constructive *target* of SIV-4's existing `next_actions` steer ("replace the mock with a hermetic double").
- **INV-5d** (action discriminator) — no new top-level tool; SIV-3B rides `check_static_analysis`, SIV-5 rides the resolver, SIV-6 is skill/doc + planner data.
- **INV-15** (single-machine frame) — reinforced by dropping SIV-7's provisioner.

---

## 2. SIV-3B — "no raw IO into core" taint rule (#1529)

**Disposition:** ship as specified. Layer A (the `dependency-cruiser` import-boundary leg) already rides `check_static_analysis` via `runBoundaryLint`; Layer B is the net-new **taint/data-flow** rule import-linters cannot express.

**Design.** Add a second boundary leg under the lint gate in `static-analysis.ts` — a **Semgrep-driven taint query** (`runRawIoTaint`) flagging the results of `JSON.parse` / `response.json()` / `req.body` / `fs.read*` that are **not immediately consumed by a registered parse function**. The parse boundary is a resolved convention (`parsers: ['src/parse/**']`), resolved like a toolchain entry so it is per-repo, not baked. The rule is **two-part** and must encode both halves or the guarantee is illusory: (a) a single parse boundary, **and** (b) no out-of-band `as Brand` / `as any` downstream — because Zod `.brand()` is compile-time-only and one stray cast defeats the whole scheme. Semgrep is the **first-class engine** here, not a non-TS fallback: the same committed `.semgrep/` ruleset expresses the guarantee across runtimes (guarantee agnostic, implementation per-runtime — INV-4 parity); absent the engine **or** its committed ruleset the leg SKIP/advisory-degrades exactly like Layer A, and only a real finding (semgrep exit 1) hard-FAILs. Couple it to the SIV-1 boundary axis so it routes on boundary-touching tasks only (R6 cheap-mix), not everywhere.

**Files:** `verbs/pure/static-analysis.ts` (the Layer-B leg), a `parse/` registry convention, `testing-strategy-guide.md` (R6 coupling). **Acceptance:** flags a raw `JSON.parse` into core not crossing a registered parser; passes when it does; flags a downstream `as Brand`; documented engine-absent degrade path; advisory-skips with no engine or no committed ruleset.

---

## 3. SIV-5 — hermetic-environment resolver (#1531)

**Disposition:** ship as specified — and it now also absorbs the cloud-double need vacated by the SIV-7 drop.

**Design.** Mirror the `contract: ContractCommands | null` field on `ToolchainCommands` exactly. Add a `hermetic` resolution table mapping a **detected unowned dependency class → its preferred high-fidelity double**: DB → Testcontainers; cloud-API → LocalStack; owned-interface → fake; third-party HTTP → Pact-verified stub. The resolver **emits the resolution, not a baked literal** (the gen-time-placeholder trap — INV-4), inheriting the 5-tier layered resolver for free. It is the **constructive half of SIV-4**: `mock-boundary.ts` already detects an agent-authored mock of an unowned dep and steers via `next_actions`; SIV-5 makes that steer land on a concrete, inspectable double (`--dry-run`-style). Encode the honesty caveats as acceptance notes: emulators (LocalStack) are *fakes of the cloud* — a higher-fidelity failure mode, not a guarantee — and Docker cost/latency forces **boundary/offline cadence, never the inner loop**.

**Files:** `config/toolchains.ts` (the `hermetic:` table / sibling resolver), `testing-strategy-guide.md`. **Acceptance:** a detected unowned dep resolves to a concrete double via the table; the resolution is inspectable; **no baked environment literal in shipped artifacts**; resolution wired as the target of SIV-4's `next_actions`.

---

## 4. SIV-6 — model-based conformance at stateful boundaries (#1532)

**Disposition:** ship as specified. This is the **highest-leverage workload-agnostic** candidate — pure in-process, no infra, generalizes across runtimes — but it is only safe with a non-negotiable provenance guardrail.

**Design.** Extend the existing `propertyTests` **"State machines"** category in `testing-strategy-guide.md` from internal HSM/circuit-breaker state to **external stateful integrations**: the agent authors a small reference model + commands; the runner fuzzes real-vs-model (`fc.commands` + `modelRun` / Hypothesis `RuleBasedStateMachine`). The reference model is an LLM-authored oracle and therefore carries the **same confirmation-bias defect as an LLM-authored mock** (fast-check's own docs: the model "should NOT be a carbon copy"; MongoDB's *retrofit* conformance model failed where the *spec-derived* sibling succeeded). So the gate **must** require the model to be: grounded in the acceptance criteria (cite acceptance-criterion IDs), kept strictly **simpler** than the implementation, authored **before/with** the code (never reverse-engineered), and validated by a **known-bad-trace rejection** check (the model must reject a seeded-wrong transition). Routed by SIV-1 to *stateful boundaries only*, risk-tiered — not everywhere.

**Files:** `testing-strategy-guide.md` (extend the State-machines row + the provenance rule), `task-template.md`. **Acceptance:** a model-based gate runs at a stateful boundary only; the provenance check rejects a model that cites no acceptance criterion OR fails to reject the seeded-bad trace.

---

## 5. SIV-7 — IaC/ephemeral-infra E2E (#1533): **DROP**

**Disposition:** drop entirely; close #1533 won't-do.

**Rationale (to be recorded on the issue and in a short RCA-style note).** SIV-7 is the one boundary candidate that is **not workload-agnostic** — it bakes in "cloud resources exist." Per its own INV-6 acceptance gate ("if the design cannot keep a cloud assumption out of substrate defaults, drop it"), and reinforced by INV-15 (the substrate must not grow a provisioner), it is inadmissible as a substrate default. The two parts that *could* have survived — the `terraform plan`-as-structural-diff review gate and an opt-in `verification.infra:` block — buy little for this repo (no cloud-coupled north-star journey exists to gate) and add config surface we would carry indefinitely. SIV-5's hermetic resolver already supplies the *double* for cloud-API boundaries (LocalStack), which is the agnostic need. We therefore close #1533 won't-do and leave the `terraform plan`-diff sliver **re-openable** as a future opt-in capability keyed on a real consumer with a detected cloud dependency.

**Files:** a short disposition note (link from the epic), `gh issue close 1533` with the rationale comment. **Acceptance:** #1533 closed with recorded rationale; no `verification.infra` / provisioner surface lands; INV-6 lint + audit stay green.

---

## 6. #1561 live token proof + #1572 — onboard symmetry & the attribution gap

**Disposition:** fix the one real code gap (#1572 Gap 1), drive the live proof through Exarchos's own dispatch, document the Agent-tool gap.

**Gap 1 — onboard hook symmetry (code).** `verbs/onboard/hooks.ts:installHook` writes **only** the `SessionStart` binding into `settings.json`; the plugin's `hooks/hooks.json` declares `SubagentStop → exarchos subagent-stop` (and `SessionEnd`), so **standalone-CLI** consumers silently get no per-subagent token attribution. Fix: extend `installHook` to also write the `SubagentStop` (and `SessionEnd`) bindings, **capability-gated** on `subagentStopEvent` / `sessionEndEvent` (INV-4), symmetric with the existing `SessionStart` path.

**The live proof (#1561).** `subagent-stop.ts:resolveTeammateByWorktree` attributes by matching the subagent `cwd` to a `worktreePath` carried on a `team.task.assigned` / `team.teammate.dispatched` event emitted **before** the agent runs. This works **only** when the orchestrator owns the worktree path — i.e. Exarchos's own **agent-team worktree dispatch**, *not* Claude-Code Agent-tool native isolation (where the harness assigns an opaque post-hoc `.claude/worktrees/agent-<id>` cwd the orchestrator cannot pre-declare; empirically 9 such dispatches produced 0 atoms). The closeout exploits this: **the SIV build work itself, delegated via Exarchos agent-team worktree dispatch, IS the representative batch** — we then confirm `exarchos_view team_performance` / `delegation_timeline` show non-empty per-teammate token metrics on the `siv-boundary-closeout` stream. Dogfood proof, no synthetic batch.

**Gap 2 — Agent-tool incompatibility (documented, not built).** Because the orchestrator cannot pre-declare cwd *or* agent_id under native isolation, the option-(b) `agent_id` attribution path cannot serve that dispatch mode anyway; it is a harness limitation, not an Exarchos bug. Record it as a known INV-4 coverage gap (logged, never failed): *live token capture requires Exarchos agent-team worktree dispatch.* A post-hoc `subagent.tokens_unattributed` reconciliation is noted as a future option, not in this bundle.

**Files:** `verbs/onboard/hooks.ts` (+ test), a coverage-gap note in `subagent-stop.ts` JSDoc / docs. **Acceptance (from #1561):** `subagent.tokens_used` present on a real feature stream after an isolated Exarchos-dispatch; per-teammate metrics non-empty in both views; the Agent-tool gap logged, never failed.

---

## 7. Sequencing & invariant conformance

**Independent, parallelizable:** SIV-3B (#1529), SIV-5 (#1531), SIV-6 (#1532) touch disjoint files (`static-analysis.ts`, `toolchains.ts`, `testing-strategy-guide.md`) and can run as parallel tasks. **SIV-5 before/with the proof**, since dispatching the SIV bundle via agent-team is the #1561 batch. **SIV-7 drop** is a doc + `gh issue close`, no code. **#1572 Gap-1** is a self-contained code task; **#1561 proof** is the final verification step that observes the bundle's own dispatch.

| Item | Risk tier | Boundary? | Primary invariants | Conformance note |
|---|---|---|---|---|
| SIV-3B taint rule | medium | yes | INV-4, INV-6, INV-1 | per-runtime degrade (Semgrep/CodeQL); advisory-skip absent backend |
| SIV-5 hermetic | medium | yes | INV-4, INV-6, INV-12 | mirrors `contract` field; emits resolution, no baked literal |
| SIV-6 conformance | medium | yes | INV-4, INV-6, INV-1 | provenance guardrail is the load-bearing half |
| SIV-7 drop | n/a | n/a | INV-6, INV-15 | removal *strengthens* both |
| #1572 Gap-1 + #1561 | low–medium | no | INV-1, INV-4 | event is the record; capability-gated; gap logged not failed |

**Closeout definition of done:** all four SIV issues + #1561/#1572 resolved; `build:preview.4` label drained; #1515 epic closeable; `npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck` (both — root tsc does **not** cover the MCP server), and INV-6 lint green.

---

## 8. Open question deferred to `/plan`

Whether SIV-3B's parse-registry convention (`parsers:`) is a `.exarchos.yml` key or a directory convention — both satisfy INV-4; `/plan` picks per the resolver's existing precedent (the `contract`/`mutation` fields are language/artifact-keyed in `toolchains.ts`, so a directory convention resolved like a toolchain entry is the likely fit). Not load-bearing for the design.
