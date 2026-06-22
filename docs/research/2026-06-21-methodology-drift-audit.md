# Methodology Drift Audit — Verification Ladder vs. Leftover TDD

**Workflow:** `methodology-drift-audit` (discovery) · **Date:** 2026-06-21 · **Against:** v2.11.0-preview.2

## Why this audit

After the verification-ladder (epic **#1515**) and phase-kind binding (epic **#1546**,
S1–S4, closed 2026-06-19) changes, mandatory TDD was retired in favour of
**risk-proportional verification**. Yet on preview.2 the workflow still *behaves* like a
TDD shop: plans come out as `[RED]→[GREEN]→[REFACTOR]` flows, gates still demand a test
per task, and the surfaces disagree with each other enough to feel disjointed. This audit
locates the drift, names the root cause, and proposes a reconciliation order.

Method: five parallel read-only audits (commands, skills, agent prompts/rules, runtime
gates, end-to-end plan-generation trace), each judged against the canonical contract below.
The three load-bearing claims were re-verified directly against the tree.

---

## The contract (what *should* be true)

The canonical binding is `servers/exarchos-mcp/src/workflow/phase-kind.ts`
(`KIND_OBLIGATIONS` + `resolveGateSet`). The canonical prose is
`skills-src/implementation-planning/SKILL.md` (reframed by #1523).

1. **RGR is the HIGH-tier rung, not a universal law.** The "Iron Law"
   (*NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST*) and uniform `[RED]→[GREEN]→[REFACTOR]`
   task formats are **retired**.
2. **Every task is stamped** `riskTier: low|medium|high` + `boundaryTouching: boolean`, and
   verification scales off the stamp: low → typecheck+lint · medium → scoped tests +
   `check_test_adequacy` kill-probe · high → full RGR + integration suite.
3. **Gates bind by `PhaseKind`** (IMPLEMENT/PLAN/REVIEW/SYNTHESIZE/GATHER), not by
   `(workflowType:phase)`. IMPLEMENT → `verification-ladder` resolver.
4. `check_task_decomposition` is a **legitimate PLAN-kind gate**. Decomposition is not drift;
   a *universal per-task test requirement* would be.
5. **GATHER/discovery carries no verification gates.** No TDD.

---

## Core diagnosis

**The engine was rebuilt; the manual, the dashboard, and the driver's instructions still
describe the old engine.**

The runtime *binding* layer is correct. Epic #1546 genuinely routes **all** implement
phases through `resolveGateSet` — `debug-implement`, `hotfix-implement`, and
`polish-implement` no longer hardcode failing-test-first prose (the memory note claiming
they still do is **stale**). `check_tdd_compliance` was demoted to advisory/non-blocking and
is *not* a ladder gate.

The drift is concentrated in the three layers that humans and agents actually *read*, plus
one dead wire:

- **The command layer** (the first thing a user hits) still preaches the Iron Law and emits
  uniform-RGR task templates.
- **The planning SoT's own reference files** contradict the SoT's prose — they still invoke
  the Iron Law by name and lead with an RGR task template that marks the tier stamp
  *optional*.
- **The shipped implementer agent** bakes the medium-tier RGR block as a static default, and
  the tier-aware renderer that would override it (`renderImplementerPrompt`) **is never
  called on the dispatch path** — confirmed: zero production callers.
- **A handful of gate/runbook strings** still say "mandatory TDD" or block on the advisory
  TDD gate.

So the ladder is real in TypeScript and in skill *prose*, but every surface that drives plan
generation and dispatch still produces TDD shape. That gap is exactly the "disjointed,
inconsistent" feeling.

---

## Root cause: why preview.2 plans are TDD-shaped

The causal chain, hop by hop (all citations verified):

1. **Entry point overrides the SoT.** `/exarchos:plan` loads `commands/plan.md`, which opens
   with `## Iron Law … NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST` (`:23-25`), tells the
   model to decompose with `[RED], [GREEN], [REFACTOR] phases` (`:40`), and embeds a
   `## Task Format` whose `**Phase:** RED → GREEN → REFACTOR` is mandatory with **no tier
   field** (`:53-70`). The `@skills/...` reference comes *after* — the model reads "every task
   is RGR" first.
2. **The SoT skill is laddered in prose but ships an RGR-only template + examples.**
   `references/task-template.md` leads with `**Phase:** [RED | GREEN | REFACTOR]` (`:9`) and
   documents `riskTier`/`boundaryTouching` as **"optional; omit to let `classifyTask` derive
   it"** (`:12-13`) — while `SKILL.md:251` says every task *carries* a tier stamp. The only
   worked example (`references/worked-example.md`) shows six RGR tasks, no tier column. A model
   copies the example.
3. **The dispatched implementer contract is the medium-tier RGR default.** `plugin.json`
   registers the static `agents/implementer.md`, whose `## Verification` section
   unconditionally says *"Follow the high-tier discipline: 1. RED 2. GREEN 3. REFACTOR"*
   (`:149-156`). It is generated from `IMPLEMENTER.systemPrompt`, which bakes
   `DEFAULT_VERIFICATION_NOTE = buildVerificationNote({ riskTier: 'medium' })`
   (`definitions.ts:273-276`).
4. **The tier-aware path is dead on the Claude route.** `renderImplementerPrompt` /
   `buildVerificationNote` correctly select low→static / medium-high→RGR, **but the only
   callers are tests** (verified). `prepare-delegation.ts` classifies `riskTier` and
   `verificationSequence` yet emits **no rendered prompt** — so dispatch spawns the static
   medium/RGR agent and the per-task tier note never substitutes in.

**Net:** three hot-path surfaces still encode uniform RGR, and the one surface that ladders
correctly at runtime is never invoked. Closing **hops 1, 3, and 4** is the highest-leverage
fix for the user's primary symptom.

---

## Drift findings by layer

Severity: **H** = actively misdirects the methodology on a hot path · **M** = wrong but
lower-traffic or non-blocking · **L** = stale wording / examples.

### Layer 1 — Commands (user-facing entry points)

| Sev | Location | Drift | Fix |
|----|----------|-------|-----|
| H | `commands/plan.md:23-25` | `## Iron Law … NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST` | Replace with one-line ladder pointer |
| H | `commands/plan.md:37-70` | Decompose into `[RED]/[GREEN]/[REFACTOR]`; `## Task Format` mandates RGR, no `riskTier` field | Lead the task template with `riskTier`/`boundaryTouching`; make RGR high-tier-only (or defer to `task-template.md`) |
| M | `commands/plan.md:1` | `description: Create TDD implementation plan…` | Reframe to "risk-tiered implementation plan" |
| H | `commands/oneshot.md:28-34` | `## Iron Law` + *"TDD applies… **There is no exemption for small changes**"* — directly contradicts its own skill | Rewrite to mirror skill: oneshot defaults to **low tier** (static analysis) |
| M | `commands/oneshot.md:83-92` | In-session RGR loop per behaviour, no tier gate | Gate RGR on tier |
| H/Amb | `commands/tdd.md` (`:19-47`) | Uniform RGR for every step. *Intentional* opt-in (`:15`) but unsignposted — reads identical to `/plan` | Add banner: "`/tdd` forces high-tier RGR by design; use `/plan` for risk-proportional" — **or retire** (see decisions) |
| L | `commands/debug.md:104`, `commands/refactor.md:95` | "Implement with TDD" one-liners | Reword to "risk-tiered verification" when touching the others |

**Clean:** ideate, delegate, review, synthesize, shepherd, cleanup, discover, dogfood,
invariants, prune, tag, checkpoint, rehydrate, autocompact. No command references the ladder
vocabulary at all — the new model has not propagated into the command layer.

### Layer 2 — The planning SoT is internally inconsistent

`implementation-planning/SKILL.md`'s prose ladder (`:45-55`) is correct, but its own
reference files and metadata contradict it. **Reconcile the SoT with itself before using it
to fix anything downstream.**

| Sev | Location | Drift |
|----|----------|-------|
| H | `references/rationalization-refutation.md:8-10` | Invokes the **Iron Law by name** as live policy; rebuts "small change doesn't need tests" with universal test-first — denies the low-tier rung (3 hits) |
| M | `references/task-template.md:1,9,12-13` | Titled "TDD Task Template"; RGR is the headline field; `riskTier`/`boundaryTouching` marked **optional** (contradicts `SKILL.md:251`) |
| M | `references/plan-document-template.md:38` | Completion checklist "All tests written before implementation" (universal) |
| M | `SKILL.md:16,109,203-208` | Overview "TDD-based plans"; "Each task follows the TDD format"; anti-patterns list universal "write failing test first" |
| L | `references/worked-example.md` | Only RGR tasks, no `riskTier` column — strong drift-anchor for copy |

**Clean / exemplary:** `_shared/references/verification.md`,
`references/testing-strategy-guide.md` (explicitly risk-proportional, "per-behavior
red-green is opt-in").

### Layer 3 — Downstream skills

| Sev | Location | Drift |
|----|----------|-------|
| H | `delegation/references/rationalization-refutation.md:9` | "TDD is **mandatory per project rules**… Write the test first" |
| M | `delegation/SKILL.md:186,191,212,218,285,364`; `references/fix-mode.md:89` | Event table frames RGR as the universal per-task model; task-completion/fix gate chains hard-wire `check_tdd_compliance` with no tier condition |
| H | `spec-review/SKILL.md:3,16,98`; `references/review-checklist.md:31-38,70` | Makes "TDD compliance" a **universal** spec-review dimension; runs `check_tdd_compliance` per `taskId` as a hard completion criterion for every review |
| M | `quality-review/SKILL.md:204-220` | "Post-Fix Spec Compliance Check (MANDATORY)" re-runs `check_tdd_compliance` per task, no tier (rest of skill is exemplary) |
| M | `oneshot-workflow/SKILL.md:324-328,480` | Completion criterion "implemented **via TDD**"; **Example A walks a README-typo fix through `[RED]/[GREEN]`** — teaches the wrong default (body is otherwise correct) |
| M | `debug/SKILL.md:128,234`; `refactor/references/phases/overhaul-plan.md:188-205` | Phase label "(worktree + TDD)"; overhaul task template hardcodes `[RED\|GREEN\|REFACTOR]` for every refactor task |
| H | `discovery/SKILL.md:15,27` | "Explicitly **exempt from the Iron Law**" (references a retired concept) + "If you need TDD enforcement → use any other workflow type" (implies all other workflows enforce TDD universally) |
| M | `_shared/prompts/report-format.md:19-22` | Task-completion report template hardcodes a RED/GREEN checklist for every task (shared across implementers) |
| L | `delegation/references/implementer-prompt.md:169-175,447-451` | Tier-conditional template, but the **Success Criteria** block unconditionally says "Test written BEFORE implementation" |

**Clean / exemplary:** `mutation-adequacy/**` (HIGH-tier-only, advisory),
`refactor/**` characterization model, `delegation/references/implementer-prompt.md` body
(tier-conditional; Key Principle #4 = "the ladder, not blanket TDD"), brainstorming, cleanup,
synthesis, workflow-state, merge-orchestrator, prune-workflows, git-worktrees,
authoring-invariants, shepherd. `dogfood/references/root-cause-patterns.md` references the TDD
gate *diagnostically* (the over-enforcement bug the ladder fixes) — not drift.

### Layer 4 — Agent artifacts + the dispatch wiring gap

| Sev | Location | Drift |
|----|----------|-------|
| H | **wiring gap** — `agents/definitions.ts:286-309` | `renderImplementerPrompt` (tier-aware) has **zero production callers** (verified). Dispatch never renders the per-task tier prompt → static medium/RGR default ships every time. **Root cause of the symptom.** |
| H | `agents/implementer.md:149-156` (= `definitions.ts:204-216`) | Static artifact bakes the RGR block with no tier conditioning (the medium default) |
| M | `agents/implementer.md:1,9,11`; `definitions.ts:315-324` | User-facing description: "dispatching **TDD implementation** tasks… **test-first development** triggers the implementer agent" |
| L | `agents/implementer.md:30`, `agents/fixer.md:29` | Dangling `skills: [tdd-patterns]` — no such skill source exists; registered with empty content |

**Clean:** `agents/implementer.md:45` ("strict test-first ceremony applies on the medium/high
rungs, not universally"), `agents/fixer.md` (conditional tests), `agents/scaffolder.md`
(no TDD), `agents/reviewer.md`, `rules/rm-safety.md` (no TDD rule lingers),
`buildVerificationNote` logic itself (correct — just never called on dispatch).

### Layer 5 — Runtime gates (the narrow *real* drift; binding is otherwise correct)

Phase→kind→resolver map verified: `delegate`, `implementing`, `debug-implement`,
`hotfix-implement`, `polish-implement`, `overhaul-delegate` **all** bind IMPLEMENT and route
through `resolveGateSet`. The ladder gate set is `check_static_analysis`,
`check_test_adequacy`, `check_integration_suite`, `check_contract_drift`,
`check_mock_boundary` — **`check_tdd_compliance` is not in it** and is advisory by default
(`registry.ts:1672` `blocking:false`).

| Sev | Location | Drift |
|----|----------|-------|
| M | `runbooks/definitions.ts:187` | `task-fix` runbook blocks on `check_tdd_compliance onFail:'stop'` — contradicts the advisory default and the sibling `task-completion` step (`:35` `onFail:'continue'`) |
| L | `workflow/playbooks.ts:1079` (`overhaul-delegate`) | Prose calls `check_tdd_compliance` a "**mandatory** gate" **and** omits `verificationLadderGuidance()` — overhaul agents never see the ladder text |
| L | `workflow/playbooks.ts:451` (`delegate`) | "mandatory" wording for the (advisory) tdd gate — milder; ladder text *is* appended |
| M/Amb | `orchestrate/task-decomposition.ts:332` | `status = hasFiles && hasTests ? 'PASS' : 'FAIL'` — **every** task hard-FAILS decomposition without a test marker, no tier scaling (the gate the user flagged) |

---

## Coherence seams (the "disjointed" feeling)

Each is a place two layers state opposite things:

1. **`/plan` command vs. its skill** — Iron Law + mandatory RGR (`commands/plan.md:23-70`) vs.
   ladder, RGR high-tier-only (`implementation-planning/SKILL.md:45-75,251`).
2. **`/oneshot` command vs. its skill** — "no exemption for small changes"
   (`commands/oneshot.md:29-34`) vs. "defaults to the low tier"
   (`oneshot-workflow/SKILL.md:111,442-467`). Direct opposites for the same workflow.
3. **Shipped agent contract vs. the ladder code** — baked medium/RGR
   (`agents/implementer.md:149-156`) vs. `buildVerificationNote` low→static, which is never
   called on dispatch.
4. **Intra-skill** — `SKILL.md:251` ("each task carries a `riskTier` stamp") vs.
   `task-template.md:12-13` ("Risk Tier: optional").
5. **`/tdd` vs. `/plan`** — both read as uniform RGR; nothing signposts that `/plan` is the
   laddered default and `/tdd` the deliberate exception.

---

## Open product decisions (need your call before remediation)

These are not mechanical fixes — they change behaviour or retire a surface:

1. **`check_tdd_compliance`: tier-gate it, or retire it?** It exists, is registered advisory,
   and is absent from the ladder and the review contract. ~8 skill/runbook citations call it
   universally. Decide: add a `riskTier: high` guard everywhere, **or** delete it and point
   everything at `check_test_adequacy`. This determines whether those citations get a guard or
   a deletion.
2. **`check_task_decomposition`'s universal `hasTests` requirement** (`:332`): is requiring a
   test marker on *every* task at plan time (a) drift that should scale by `riskTier`, or (b) a
   deliberate **PLAN-kind structural obligation** intentionally stricter than per-task runtime
   verification? It is a PLAN gate, arguably outside the ladder's tier scaling by design.
3. **Keep or retire `/exarchos:tdd`** as an explicit always-RGR opt-in. If kept, it needs
   signposting that it is the high-tier exception, not a peer default to `/plan`.
4. **Regression/characterization flows** (debug, fixer, refactor): should a bug fix write a
   failing regression test first *regardless* of tier (a behavioural change is inherently
   test-worthy), or fold fully into the tier model?
5. **`/oneshot` philosophy reversal:** the command makes a deliberate *argument* that small
   changes get no exemption. Reconciling it reverses a stated position and could *reduce*
   verification on changes that today always get a test — owner sign-off, not a silent edit.

---

## Recommended remediation order

**Wave 1 — kill the symptom (hot path; highest leverage).**
- Wire dispatch to the tier-aware prompt: have `prepare_delegation` (or the `/delegate` step)
  call `renderImplementerPrompt` and dispatch the rendered prompt, instead of the static
  medium/RGR `agents/implementer.md`. *(Layer 4 wiring gap — the single highest-leverage fix.)*
- Rewrite `commands/plan.md` and `commands/oneshot.md` to the ladder (drop the Iron Law; tier
  the task format). *(Layer 1, hop 1.)*
- Reconcile the SoT with itself: fix `task-template.md` (lead with the tier stamp; RGR
  high-tier-only), `rationalization-refutation.md`, `plan-document-template.md`,
  `worked-example.md` (add a mixed-tier example). *(Layer 2.)*

**Wave 2 — stop universal gate enforcement.**
- Resolve decision #1, then tier-gate (or delete) `check_tdd_compliance` across `spec-review`,
  `quality-review`, `delegation` SKILL gate chains, and `runbooks/definitions.ts:187`.
- Resolve decision #2 for `check_task_decomposition`.
- Fix `playbooks.ts:451,1079` wording + append the ladder guidance to `overhaul-delegate`.

**Wave 3 — coherence + stale wording.**
- Agent descriptions ("TDD implementation"), dangling `tdd-patterns` skill refs.
- `discovery/SKILL.md` retired-Iron-Law references; `_shared/prompts/report-format.md` RED/GREEN
  template; `debug`/`refactor` one-liners; `/tdd` signposting (per decision #3).

**Process note (the meta-finding):** the new model lives in skill prose and TypeScript but
never propagated into commands, agent artifacts, shared prompt templates, or worked examples.
Whatever fixes these should also add a guard (lint/test) that fails when "Iron Law" or an
unconditional `[RED]→[GREEN]→[REFACTOR]` task template reappears in commands/agents — otherwise
the drift returns. This is well-scoped enough to feed straight into `/exarchos:ideate`.

---

## Appendix — corrections to prior notes

- **Memory was stale:** `debug-implement`/`hotfix-implement`/`polish-implement` do **not**
  still hardcode failing-test-first prose — S4 (#1546) rewrote them to risk-proportional
  language (`playbooks.ts:728/791/955`). Update `project-phase-kind-binding-spike`.
- `commands/plan.md` drift was already noted in `project-plan-command-stale-vs-ladder`; this
  audit confirms it and widens the blast radius to the SoT reference files, the shipped agent,
  and the dispatch wiring gap.
