# Verification ladder — slice 3: mutation-adequacy backstop + cheap-mix planning default (R5 + R6)

**Date:** 2026-06-15 · **Workflow:** `verification-ladder-slice3` · **Epic:** #1515 (milestone v2.11.0 — Verification & Reliability)
**Sub-issues:** #1520 (R5 — `mutation-adequacy` boundary review dimension), #1521 (R6 — promote the cheap verification mix as the planning default)
**Predecessor:** `docs/designs/2026-06-11-verification-ladder-slice2.md` (PR #1538, merged — R2 config-resolved policy + R9 onboarding integration)
**Research basis:** `docs/research/2026-06-02-verification-pipeline-recommendations.md` §2 R5/R6, §6 open questions

## 1. Goal & scope

Slice 2 made the verification ladder configurable and resolvable end-to-end: the `mutation` command now
resolves through `resolveVerificationRuntime`, and `resolveVerificationPolicy` is the single composer of
config + the frozen table. Slice 3 closes the loop the unifying thesis demands — *"relaxing strict TDD is
only safe with an adequacy backstop"* — by shipping that backstop (R5) **in the same slice** that promotes
the lighter planning default (R6). The two are deliberately coupled: R6 omits granular per-behavior
red-green, and R5's surviving-mutant `next_actions` are the machine guard against the vacuous tests (and
vacuous PBT properties) that omission could otherwise admit.

**In scope:**

- **R5** — a new `exarchos_orchestrate` **action** `mutation-adequacy` (INV-5d: an action, never a 5th
  tool) that runs the resolved mutation command **diff-scoped**, parses the Stryker
  `mutation-testing-report-schema` (de-facto cross-language standard), and returns the fixed carrier.
- A per-runner **diff-scope augmentation** table co-located with `config/toolchains.ts` (the SoT for
  per-toolchain command knowledge): Stryker `--since`, `cargo mutants --in-diff` (already diff-native),
  mutmut / PIT equivalents.
- A `mutation-adequacy` **review dimension** wired into `review-contract.ts`, gating the **high** tier at
  the **`/review` boundary only**, backed by a new `skills-src/mutation-adequacy/SKILL.md`.
- Surviving / `NoCoverage` mutants surfaced as `next_actions` ("write a test that kills `<file>:<line>`",
  INV-12).
- **R6** — the implementation-planning references default `testingStrategy` for **medium/high** tiers to
  the cheap mix (strict/branded types + inline invariants/assertions + one PBT on the pure core + one
  acceptance north-star test), coupling the mix fields to `riskTier` so the planner emits them
  deterministically — no implementer guesswork.

**Out of scope (explicitly):** R10 governance (#1525 — mutation-score *trend* fold + `subagent.tokens_used`
telemetry; this slice only **emits** the foldable `gate.executed` events, it builds no view); full-tree /
nightly mutation orchestration (the long-running Task path is seamed but not driven — the `ps`/`describe`/
`wait` lifecycle verbs are v2.12); the LLM equivalent-mutant filter (research §6 Q2 — we accept a
sub-100% advisory threshold instead); blocking severity by default; per-tier severity; and any new MCP
tool or CLI verb. No `verification:` policy block change — the slice-2 frozen table and resolver are
untouched.

## 2. Constraints (invariant anchors)

Anchored to `.exarchos/invariants.md` (devCatalog enabled). Always-load set probed; domain entries pulled.

- **INV-5d (action-discriminator)** — `mutation-adequacy` is an **action** on `exarchos_orchestrate`; the
  four-tool surface and visible count (< 15, INV-5a) are untouched. The Stryker report schema is internal
  Zod validation now, exposed as an MCP **Resource** when #1275 lands — never a tool. Two memory traps are
  load-bearing here: the **registration-schema field collision** (a new action field must match name+type
  across actions or `buildRegistrationSchema` throws at MCP startup — `base` is already `string`
  everywhere, so reuse it verbatim) and the **composite-dispatch handler gap** (the action MUST get a
  `handleOrchestrate` branch and ride `registry` sync, tested *through* `handleOrchestrate`, not just the
  handler in isolation).
- **INV-5b (output-contract)** — fixed carrier `{ passed, mutationScore, killed, survived, noCoverage,
  total, report }`; advisory verdicts ride the same shape (`passed:false` + dimension severity, never a
  `success:false` envelope).
- **INV-10 (liveness protocol)** *(reference-only, pulled)* — the diff-scoped run emits
  `mutation.executing_started` at entry and `mutation.executed` at exit; a full-tree run is the canonical
  long-running op and hangs off a Task (SEP-1686) — seamed, not driven, this slice.
- **INV-12 (affordances)** — survivors/`NoCoverage` become `next_actions`, the perceivable repair path.
- **INV-1 (event-sourcing-integrity)** — the score trend is a left-fold over `gate.executed`; the action
  holds no score state, writes no side DB. R10 reads these events later.
- **INV-2 (facade-equivalence)** — one dispatch core, CLI+MCP parity; the dimension name lives ONLY in
  `review-contract.ts` (derived from the skill folder name), never re-declared in `playbooks.ts`/`tools.ts`.
- **INV-6 (workload-agnosticism)** — "high tier / `/review` boundary" is **policy/topology data**, not
  workflow-typed branching in skill prose. R6's tier→mix mapping is a **table** in the planning references,
  not a conditional in the skill body.
- **INV-4 (platform-agnosticity)** *(reference-only, pulled)* — the new `mutation-adequacy` skill and the
  R6 planning-reference edits are authored in `skills-src/`, then `npm run build:skills` + `skills:guard`.
  Open Q4: trace that the high-tier dimension resolves on **every** runtime path (managed / non-native
  worktrees), not just CC native isolation — the diff base and resolved mutation command must be reachable
  identically.

## 3. Architecture — the adequacy backstop

```
   /review (high tier)                         planning (medium/high tier)
        │                                              │
        ▼                                              ▼
   mutation-adequacy ACTION  ◄── INV-5d        testing-strategy-guide + task-template (R6)
        │                                       cheap mix is DATA in tier tables (INV-6):
        │ 1. resolve cmd  ── resolveVerificationRuntime (slice 2, UNCHANGED)
        │ 2. diff scope   ── per-runner table @ config/toolchains.ts  ◄── single fork, resolved
        │ 3. run scoped   ── emit mutation.executing_started (INV-10)
        │ 4. parse report ── Stryker mutation-testing-report-schema (Zod; Resource @ #1275)
        │ 5. carrier      ── {passed,mutationScore,killed,survived,noCoverage,total,report} (INV-5b)
        │ 6. survivors    ── next_actions "write a test that kills file:line" (INV-12)
        │ 7. emit         ── mutation.executed + gate.executed  ──► R10 score-trend fold (INV-1)
        ▼
   mutation-adequacy DIMENSION (review-contract.ts SoT, INV-2) — advisory, HIGH tier only
```

R5 is a **`/review`-phase dimension**, distinct from the slice-1/2 delegation-time ladder gates: review
dimensions are *skill-folder-named* (kebab-case) in `review-contract.ts`, so the dimension **is** the
`skills-src/mutation-adequacy/` folder. Execution is **synchronous-with-liveness** on the diff-scoped
common path (acceptance: `< minutes`); the full-tree run is the long-running case seamed onto a Task. The
verdict is **advisory** — `mutationScore` below a config-surfaced threshold (default soft, ~40% per the
observed real-world distribution) warns and emits survivor `next_actions`, but never blocks. R6 changes no
runtime code: it edits the planning references so the planner emits the cheap mix per tier.

## 4. Technical design

### 4.1 The `mutation-adequacy` action

New `servers/exarchos-mcp/src/verbs/gates/mutation-adequacy.ts`, registered in `registry` with a
`handleOrchestrate` dispatch branch (the DOA-action trap — a registered action with no handler branch
returns `UNKNOWN_ACTION`; the test must dispatch *through* `handleOrchestrate`). Input schema (Zod,
INV-5a): `featureId` (string), `base` (string, the review/PR base ref — reuse the existing `string` type
verbatim to dodge the field-collision trap), optional `worktreePath`, optional `threshold` override. The
handler:

1. `resolveVerificationRuntime(repoRoot).mutation` → the resolved diff-scopable command (or a Skipped
   result with reason when unresolved — never a hard fail; mirrors `verification-toolchain`).
2. Compose the diff-scope flag (§4.2) against `base`.
3. Emit `mutation.executing_started`; run the scoped command; emit `mutation.executed` (INV-10).
4. Parse stdout/report file against the internal `MutationReportSchema` (the Stryker
   `mutation-testing-report-schema` shape); tolerate a malformed/empty report by degrading to a Warning,
   not a throw (doctor-grade robustness).
5. Compute the carrier; map survivors + `NoCoverage` to `next_actions`.
6. Emit `gate.executed` (`gateName: 'mutation-adequacy'`, layer `review`) carrying `mutationScore` so R10
   can left-fold the trend (INV-1). No CAS-pin on the follow-on event (idempotency-collapse via
   `operationId`, INV-8).

### 4.2 Per-runner diff-scope augmentation

A small typed table co-located with `config/toolchains.ts` — the existing SoT for per-toolchain command
knowledge, keeping the layered-resolver idiom and never re-declaring command lists elsewhere. For each
toolchain id, how to scope the resolved mutation command to a diff base:

| Toolchain | Resolved mutation cmd | Diff-scope augmentation |
|---|---|---|
| node (Stryker) | `npx stryker run` | `+= --since=<base>` |
| dotnet (Stryker) | `dotnet stryker` | `+= --since <base>` |
| rust (cargo-mutants) | `cargo mutants --in-diff` | already diff-native (`--in-diff <patch>`) |
| python (mutmut) | `mutmut run` | path-restricted to changed files |
| java (PIT) | `mvn …:pitest …` | `+= -DtargetClasses=<changed>` |

A toolchain with no known augmentation runs unscoped **with a Warning** (and the Task-seam note), so the
`< minutes` acceptance is never silently violated. The augmentation is applied by the resolver, not the
handler — the handler stays runner-agnostic.

### 4.3 The review dimension + skill

Per `review-contract.ts`'s documented contract (dimension key MUST equal the skill folder name; do not
introduce new naming conventions), add `mutation-adequacy` to the required-reviews map **for the high tier
only** — the coupling to tier is policy data, satisfying INV-6. New `skills-src/mutation-adequacy/SKILL.md`
(`metadata.mcp-server: exarchos`, since it invokes the action) instructs the reviewer to run the action,
read the carrier, and turn survivors into concrete "kill this mutant" follow-ups; `references/` carries the
report-schema reading guide and the advisory-threshold rationale. `quality-review/SKILL.md` gains a pointer
to the new dimension. All authored in `skills-src/`, regenerated, `skills:guard`-clean (INV-4).

### 4.4 R6 — cheap mix as the planning default

`skills-src/implementation-planning/references/testing-strategy-guide.md` and `task-template.md` gain a
**tier table** (data, not prose branching — INV-6) mapping `riskTier` → the default `testingStrategy`. For
**medium/high**: strict/branded types + inline invariants/assertions + one PBT on the pure core + one
acceptance north-star test, with `propertyTests: true`, `testLayer`, and `characterizationRequired` set
from the table — granular per-behavior red-green becomes an explicit opt-in, not the default. Low tier
stays minimal. The relaxation is safe precisely because R5's mutation backstop and slice-1's git-only
`check_test_adequacy` (R3) probe both ship/shipped: the lighter mix is guarded, not unguarded.

### 4.5 Execution, liveness, and the Task seam

The diff-scoped run is synchronous within the handler, bracketed by `mutation.executing_started` /
`mutation.executed` (INV-10) so the v2.12 lifecycle verbs can observe it generically with zero
per-feature code. A full-tree run (R10 nightly/offline) is the canonical long-running op; this slice
defines the Task (SEP-1686) seam — the action accepts a `scope: 'diff' | 'full'` discriminant defaulting
to `diff` — but only `diff` is driven here. `full` returns a "deferred to R10/v2.12" advisory rather than
blocking inline for minutes, so we never ship a per-task full-mutation gate (research §6 Q3 — that would
defeat the token goal).

### 4.6 Advisory verdict + threshold

`passed` reflects `mutationScore >= threshold`, but the dimension's **severity is advisory** (warning) by
default, so a sub-threshold score surfaces survivor `next_actions` without blocking the merge — exactly
the slice-2 ladder-gate severity mechanism (`resolveGateSeverity` + `applyLadderGateSeverity`), reused, not
reinvented. The threshold is config-surfaced (default soft, ~40%) under the existing `review:`/`verification:`
config so it can be calibrated from the INV-1 score trend (research §6 Q1) without a code change. Equivalent
mutants are accepted as the reason a 100% score is neither expected nor required (research §6 Q2).

## 5. Conformance summary & known hazards

| Surface | Invariants | Note |
|---|---|---|
| `mutation-adequacy` action | INV-5d, INV-5b, INV-10, INV-8 | Action not tool; fixed carrier; liveness; idempotent re-run |
| Diff-scope table | INV-6, INV-4 | Data at the toolchains SoT; resolver-applied, runner-agnostic handler |
| Review dimension + skill | INV-2, INV-4, INV-6 | Dimension name = skill folder; high-tier is policy data |
| Survivor affordances | INV-12 | "write a test that kills file:line" |
| Score-trend emission | INV-1 | `gate.executed` left-fold; no side state (R10 reads) |
| R6 cheap mix | INV-4, INV-6 | skills-src edit + regenerate; tier table is data |

**Hazards (named traps from repo memory):**

- **Composite dispatch handler gap** — the new action must have a `handleOrchestrate` branch and pass the
  `registry` sync assertion; test dispatch *through* `handleOrchestrate`, never only the bare handler.
- **Registration-schema field collision** — reuse `base: string` and any other field name at its existing
  type; introducing `base` at a different type (or a clashing field) throws at MCP startup.
- **Long-running op blocking** — an unscoped or large-diff run could exceed dispatch budget; mitigated by
  diff-scope (§4.2) + the `full`-scope deferral (§4.5). Unaugmentable runners warn, never silently run full.
- **INV-4 runtime parity (open Q4)** — trace the high-tier dimension + mutation run on a managed
  (non-native) worktree path, not just CC native isolation; the diff base and resolved command must resolve
  identically. A test asserts the dimension resolves for the high tier independent of harness.
- **Relaxation without backstop** — R6 must not merge ahead of R5 within the slice; the bundle's merge
  order lands R5 before flipping the planning default (mirrors slice-2's high-blast ordering).
- **Review-dimension count reshape** — adding a required dimension is a cross-surface change
  (`review-contract.ts` + playbooks + engine `_requiredReviews`); high-blast, full-suite before merge.

## 6. Acceptance & test plan

- Diff-scoped mutation run completes `< minutes` on a representative PR fixture; the per-runner table
  composes the correct scope flag (Stryker `--since`, cargo-mutants `--in-diff`, …), asserted per toolchain.
- `mutation-adequacy` action returns the fixed carrier; a malformed/empty report degrades to Warning, not a
  throw; an unresolved mutation command → Skipped with reason (no hard fail).
- Survivors / `NoCoverage` emit `next_actions` of the form "write a test that kills `<file>:<line>`".
- The dimension gates **only** the high tier at the `/review` boundary; medium/low and non-`/review` phases
  are unaffected (characterization).
- `mutation.executing_started` / `mutation.executed` and `gate.executed` (with `mutationScore`) are emitted;
  a property test folds a sequence of `gate.executed` into a score trend (R10-ready, INV-1).
- Advisory: a sub-threshold score warns + emits affordances but never blocks; an explicit
  `review.gates`/config override can raise it to blocking (slice-2 severity mechanism reused).
- Dispatch-through test (`handleOrchestrate`) for the action; `registry` sync assertion green (handler-gap
  lesson).
- INV-4 parity: a test asserts the high-tier dimension resolves on a managed (non-native) worktree path.
- R6: the planner emits the cheap mix per tier; `propertyTests` / `testLayer` / `characterizationRequired`
  are set from the tier table for medium/high (no implementer guesswork); low tier minimal.
- Full: `npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck`, `npm run lint:invariants`,
  `npm run build:skills` + `npm run skills:guard` all green.
