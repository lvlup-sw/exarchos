# Spec: Empirically test the delegation pipeline (properly) — binary before/after + measured native baseline

**Date:** 2026-07-09 · **Feature:** `1670-delegation-empirical-testing` · **Depth:** standard
**Inputs:** issue #1670, PR #1669 (closes #1636), `docs/evals/2026-07-09-1636-plan-format-corpus.md` (provisional), `docs/evals/quality-ab/ANALYSIS.md` (provisional), reference: `lvlup-sw/bifrost/docs/benchmarks/2026-06-13-cpq-xeon-8573c.md` (charting standard)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document (added by `/exarchos:plan`).

## Design & Rationale

### Problem Statement

PR #1669 fixed #1636 (per-task risk-tier/boundary stamps now thread end-to-end into dispatch) and shipped a benchmark under `docs/evals/`. Review established that the benchmark **models** the system but never **executes** it, so its conclusions are marked PROVISIONAL and cannot be trusted:

1. **The binary was never run.** The deterministic arm calls the pure `classifyTask`/`renderImplementerPrompt` directly, bypassing the MCP schema/CLI — the exact path the #1636 fix changed. So its E-vs-H0 numbers are **identical on the unfixed binary** (`deriveRiskTier` already honored an explicit tier; the bug was that stamps never *reached* it). It measures the target, not the fix.
2. **The native baseline was assumed, not measured** (`NATIVE_FLAT_MODEL='opus'`). Every "vs native" model-selection claim is therefore unsupported — native may route a *mix*, making exarchos's flat-opus routing *less* differentiated, not equal.
3. **The code-quality A/B only used fully-specified tasks.** Both arms implemented-to-spec and tied at 100%; the steer's correctness value can only appear on **under-specified** tasks where edge cases must be discovered — untested.

This feature does the empirical testing properly against the *released* fixed binary, replaces every modeled number with an executed one, and charts the result to the bifrost benchmark standard.

### Chosen Approach

Three executed experiments plus a release and a publish. #1669 is **already merged** (`a240b4d8`, 2026-07-10); the remaining release step is to `/release` cut `v2.12.0-preview.2` from current `main` (which now carries the fix). Exp 1 uses **two before/after pairs**, because preview.1→preview.2 is *not* fix-isolating: both #1669 (the fix, `a240b4d8`) and #1659 (`585c154c`, a dispatch-guard change) touch the measured `prepare-delegation.ts` in that window.
  - **Causal pair (primary):** the #1669 merge commit `a240b4d8` vs its first parent `a240b4d8^` — the two differ by #1669 *alone*, isolating the fix.
  - **Released pair (secondary):** preview.1 vs preview.2 — the artifact users actually get, with every co-resident commit (notably #1659) enumerated as a documented confound, not hidden.

- **Exp 1 (fix validation)** drives `prepare_delegation` through the *real tool surface* of each binary over the stamped `docs/specs/` corpus and diffs the returned `taskClassifications`. The causal pair is the true fix-isolating before/after the deterministic arm only modeled; the released pair shows the shipped delta.
- **Exp 2 (native baseline)** is a **spike-first** measurement: prove the mechanics on ≥1 shared spec — drive real headless Claude Code so it treats the spec as its plan and delegates, then harvest native's actual per-subagent model selection, verification behavior, and token spend. Expand only once mechanics are proven.
- **Exp 3 (correctness under under-specification)** extends the `quality-ab` harness with under-specified task variants (edge cases must be discovered, not read off the spec) and re-runs E-vs-N on ≥2 models with **mechanically-run** mutation grading, not self-reported kill-probes.

Every result is charted bifrost-style (matplotlib → committed SVG + regen script + raw CSV) and the provisional caveats are removed only for claims now backed by executed data.

### Technical Design

**Binaries (DR-1/DR-2).** Build four reference points deterministically in throwaway worktrees (`npm run build`), cross-checked against the installer-downloaded release: the two tags (`v2.12.0-preview.1`, `v2.12.0-preview.2`) and the causal pair (`a240b4d8^`, `a240b4d8`). A confound-enumeration step records every commit touching the measured path (`prepare-delegation.ts`, `parse-task-stamps.ts`, `classifyTask*`) in the preview.1→preview.2 window so the released-pair delta is read with #1659 in view. The driver spawns each binary's MCP server (or invokes its CLI adapter) and calls `prepare_delegation`, capturing `taskClassifications`. **Arm asymmetry (verified):** the pre-fix binaries have **no `planPath` support** (it was added by #1669), so the before-arm is invoked with `tasks:[{id,title}]` and **no `planPath`** — its heuristic classification is the faithful "before"; the after-arm passes `planPath` so the stamp-lifting path is exercised. The corpus is the same stamped `docs/specs/` set the deterministic arm used, so the two are directly comparable.

**Native spike (DR-3).** A harness (candidate home `docs/evals/native-baseline/`) drives `claude -p` with `--output-format stream-json`, a prompt that presents the spec as the plan and instructs Task-tool delegation, and parses the session transcript for per-subagent `model`, tool calls, and token usage. The SDK path is held in reserve if transcript capture proves unreliable.

**Quality A/B (DR-4).** Extend `docs/evals/quality-ab/`: add `tasks/<name>/SPEC.underspec.md` (edge cases removed, oracle reused), and extend `grade.ts` to invoke the diff-scoped mutation gate on each produced impl. Dispatch both arms on a strong (opus) and a weak (sonnet/haiku) model.

**Latent bug (DR-5).** The real corpus is **majority 4-hash** (81 `#### Task` headers vs ~53 real `### Task NNN` headers; 7 of 11 specs are 4-hash-only), so `parseTaskBlocks`'s 3-hash-only pattern drops tier extraction on most live specs. Port `parseTaskBlocks`/`extractTaskRiskTier` in `task-decomposition.ts` to the already-correct `###`/`####` + broad-id handling that `parse-task-stamps.ts` (the SoT parser) uses and documents; regression-test against a **real 4-hash corpus spec**, and verify no regression in all three consumers (`prepare-delegation.ts`, `composite.ts`, `evals/graders/schema-grader.ts`).

**Charts (DR-6).** `docs/evals/data/2026-07-09/generate_charts.py` (matplotlib, no external services) reads committed CSV and writes committed SVGs; the benchmark md embeds them via `<img>` with alt-text, mirroring the bifrost doc's figure/caption pattern.

### Integration Points

- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`, `parse-task-stamps.ts` — the surface Exp 1 exercises through the binary (measured, not changed).
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts:145` — `parseTaskBlocks`/`extractTaskRiskTier` latent-bug fix (DR-5); consumers: `prepare-delegation.ts`, `composite.ts`, `evals/graders/schema-grader.ts`.
- `docs/evals/quality-ab/{tasks,grade.ts}` — under-specified variants + mechanical mutation grading (DR-4).
- `docs/evals/native-baseline/` (new) — Exp 2 spike harness (DR-3).
- `docs/evals/data/<date>/` (new) + a new dated `docs/evals/*.md` — raw CSV, `generate_charts.py`, SVGs, benchmark write-up (DR-6).
- `docs/evals/2026-07-09-1636-plan-format-corpus.md`, `docs/evals/quality-ab/ANALYSIS.md` — caveat removal / supersession (DR-6).
- `package.json` + `/release` — the preview.2 cut (DR-1).

### Alternatives considered

- **Exp 2 mechanics — Claude Agent SDK (fallback, not primary).** Programmatic delegation would capture per-subagent model/tools structurally rather than by scraping a transcript. Rejected as primary because it drifts from the real Claude-Code user path the experiment is supposed to observe; kept as the fallback if `claude -p` transcript capture is unreliable.
- **Exp 2 mechanics — exarchos-minus-routing as "native" (rejected).** Running exarchos with its model routing disabled is not the native baseline; it answers "exarchos without a feature," not "what does native Claude Code give for free." It cannot re-ground the model-selection claim.
- **Exp 3 tasks — author net-new under-specified tasks (rejected).** Stripping the existing three quality-ab specs reuses hidden oracles already validated against reference implementations; net-new tasks would repeat that validation cost for no added signal.
- **Charting — TS-native or HTML artifact (rejected per decision).** The user's reference is the bifrost matplotlib+SVG+regen-script standard; a committed, diff-friendly, regenerable static asset is the target, so a Python dev-only script under `docs/evals/data/` is accepted despite this being a TS repo.

### Open Questions

- **Exp 2 mechanics (resolved by the DR-3 spike):** the exact way to make headless CC treat an arbitrary spec as its plan and delegate reproducibly, and how to harvest per-subagent model + tokens. If unresolvable, DR-7 fail-honest governs.
- **Does native CC assign distinct per-subagent models at all, or inherit one?** The spike measures this; the answer determines whether the provisional "model selection ≈ no-op" claim strengthens or flips.
- **Deterministic arm's fate:** Exp 1 supersedes the modeled E-vs-H0 before/after. Resolve at `/plan` whether to retire the deterministic arm or keep it only for the model×risk-tier cross-tab detail.
- **Weak-model choice for Exp 3** (sonnet vs haiku) — resolve at `/plan`.
- **Branch base:** #1669 is now merged to `main` (`a240b4d8`). The #1670 execution branch should base off current `main` (or `main` at the preview.2 cut) so it builds on the released fix — confirm at dispatch. This spec was authored on the `#1636` worktree branch; carry it forward onto the #1670 branch.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Cut `v2.12.0-preview.2` (the released "after" binary)

#1669 is **already merged** to `main` (`a240b4d8`, 2026-07-10), so no merge step remains — run `/release` to cut `v2.12.0-preview.2` from current `main`. This is the canonical *released* Exp‑1 "after" artifact; `v2.12.0-preview.1` is the released "before". The experiment runs against *released, versioned* binaries, not the working tree. (Note: preview.2 also contains #1659 — the released pair is not fix-isolating; the causal pair in DR-2 is.)

**Acceptance criteria:**
- `git tag` lists `v2.12.0-preview.2`; the tag contains `parse-task-stamps.ts` (fix present) while `v2.12.0-preview.1` does not — establishing fix-*presence* in the released "after" (not fix-*isolation*, which is DR-2's causal pair).
- The Release workflow completes green and the single-file binary is obtainable for both tags (built from tag or downloaded via the installer).
- `package.json` version reads `2.12.0-preview.2` on `main` after release.

### DR-2: Exp 1 — fix validation via a fix-isolating before/after through the real tool surface

Run `prepare_delegation` **through the built binary** (MCP dispatch or CLI adapter — never the pure function) over the stamped `docs/specs/` corpus and diff the returned `taskClassifications`, across **two pairs**: the **causal pair** (`a240b4d8^` vs `a240b4d8` — #1669 alone) as the primary fix-isolating measurement, and the **released pair** (preview.1 vs preview.2) as the shipped-artifact delta with confounds enumerated.

**Acceptance criteria:**
- A reproducible driver captures `taskClassifications` from each binary over the same corpus and emits machine-readable diffs (committed raw data) for **both** pairs.
- **Before-arm invocation (verified):** pre-fix binaries have **no `planPath` support** (added by #1669), so the before-arm is driven with `tasks:[{id,title}]` and **no `planPath`**; its classification is heuristic (`medium`/no-boundary, no `check_integration_suite` on high-tier tasks) because the stamp-lifting code is simply absent — *not* because a schema "strips" fields.
- **After-arm:** the fixed binary, driven with `planPath`, returns `taskClassifications` carrying the plan's `high`/`boundary` stamps and `check_integration_suite` where the plan calls for it.
- The **causal-pair** diff quantifies the harm #1669 removes (count of tasks whose tier/verification changed) as the fix-isolated result; the **released-pair** diff is reported alongside it with #1659 named as a co-resident change. Both supersede the deterministic arm's modeled E-vs-H0 numbers.

### DR-3: Exp 2 — measured native baseline via headless Claude Code (spike-first)

Prove, on ≥1 shared spec, that we can drive real headless Claude Code (`claude -p`) so it regards the spec as its plan and **delegates** per-subagent, then capture native's actual behavior. Primary mechanism: real `claude -p` with per-subagent capture from the session transcript; SDK is the fallback. The exact mechanics are a **spike deliverable** — the write-up is a first-class output.

**Acceptance criteria:**
- Native delegation baseline captured on ≥1 shared spec: **per-subagent model assignment**, verification/tool behavior, and token spend, harvested from a real headless run (not assumed).
- A spike write-up documents the mechanics: how headless CC was made to treat a spec as its plan and enter delegation, how per-subagent model + tokens were captured, and how both pipelines were driven over an identical task set.
- The measured native model distribution replaces the `NATIVE_FLAT_MODEL='opus'` assumption; the "model selection vs native" claim is re-grounded on observed data (and may flip if native routes a mix).
- **Failure mode (see DR-7):** if native cannot be made to delegate reproducibly, the write-up records the negative/blocked result and the fallback attempted — no modeled substitute is admitted.

### DR-4: Exp 3 — code quality under under-specification (≥2 models, mechanical grading)

Extend `docs/evals/quality-ab/` with **under-specified** variants of the existing tasks — strip the edge-case enumeration from each `SPEC.md`, keep the already-validated hidden oracles — and re-run the E-vs-N A/B on both a strong and a weak model. Replace self-reported kill-probes with the **diff-scoped mutation gate run mechanically** by the grader.

**Acceptance criteria:**
- ≥1 under-specified variant per existing task (spec silent on the corners; oracle unchanged and still validated against the reference).
- The E-vs-N A/B is re-run on ≥2 models (strong + weak); per-cell oracle pass rate, typecheck, durable-tests, and a **grader-run** mutation-adequacy score are recorded.
- Results state plainly whether a verification→correctness delta appears under under-specification (the one condition the provisional study could not probe), including a clean-null outcome if that is what the data shows.

### DR-5: Fix `parseTaskBlocks` — it drops tier extraction on the majority of real specs

The gate-path `parseTaskBlocks` (`servers/exarchos-mcp/src/orchestrate/task-decomposition.ts:145`) matches exactly `/^###\s+Task\s+(T-[0-9]+|[0-9]+)/` — **three** hashes only. **Verified corpus distribution:** `docs/specs/` is majority **4-hash** — 81 `#### Task` headers vs ~53 real `### Task NNN` headers (≈3:2), with **7 of 11 specs authored 4-hash-only**. `parse-task-stamps.ts`'s own SoT comment documents this ("the actual corpus authors task headers as `####` ... `parseTaskBlocks` matches only `###`"). So `extractTaskRiskTier` silently drops tiers on **most live specs** — a corpus-wide gate failure, not a rare trap. Port `parseTaskBlocks` to `parse-task-stamps.ts`'s already-correct `###`/`####` + broad-id handling.

**Acceptance criteria:**
- A regression test using a **real 4-hash corpus spec** (e.g. `docs/specs/2026-07-03-wlm-reconcile-enforce.md`) proves the gate now extracts task tiers where it previously returned none (RED before → GREEN after).
- `parseTaskBlocks` accepts both `###`/`####` and the broader id token, matching `parse-task-stamps.ts`, without regressing the `### Task`/`T-NN` form; the spec/task templates are aligned to a single documented depth.
- No regression in the three consumers (`prepare-delegation.ts`, `composite.ts`, `evals/graders/schema-grader.ts`) — verified through the built gate, exercised by the integration suite (high-tier).

### DR-6: Chart and publish executed results; supersede the provisional conclusions

Publish a dated benchmark document charting all three experiments to the bifrost standard, and update `docs/evals/` so only executed claims survive.

**Acceptance criteria:**
- Charts regenerate from committed raw CSV via a `generate_charts.py` (matplotlib) script under `docs/evals/data/<date>/`; SVGs are committed and embedded in a dated `docs/evals/YYYY-MM-DD-*.md` with descriptive alt-text captions (bifrost-style).
- The PROVISIONAL caveats in `2026-07-09-1636-plan-format-corpus.md` and `quality-ab/ANALYSIS.md` are removed **only** for claims now backed by executed data; any still-unvalidated claim keeps an explicit caveat.
- `docs/evals/` conclusions reflect the measured before/after, the measured native baseline, and the under-specified A/B outcome.

### DR-7: Experiment integrity and failure modes (fail-honest, pinned, mechanical-only)

Cross-cutting guardrail enforcing the methodology that #1669 violated — this is the requirement that governs error handling and failure modes for the whole feature.

**Acceptance criteria:**
- **Fail-honest:** if any experiment cannot be *executed* (binary won't build, native won't delegate, grader won't run), the write-up records the blocked/negative result; a modeled or assumed number is never substituted for a measured one.
- **Pinned provenance:** every raw-data artifact records the exact binary version/tag, git SHA, model IDs, and date so a reader can reproduce or invalidate it.
- **Mechanical-only grading:** correctness (hidden oracle), typecheck, and mutation-adequacy enter results only when run by the harness — no self-reported metric is admitted as a result.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above. Tasks use `### Task NNN:` (3-hash) headers so the **current** gate-path `parseTaskBlocks` (3-hash-only) parses this very plan; note the majority corpus is 4-hash and is silently dropped by that same parser — which is exactly the bug DR-5 fixes.

### Scope

**Target:** Full design — all seven DR-N.
**Excluded:** None. Two open questions are resolved here rather than deferred: (a) the modeled deterministic arm is **kept only for its model×risk-tier cross-tab**; Exp 1 supersedes its before/after numbers. (b) Exp 3's two models are **opus (strong) + sonnet (weak)** — continuity with the provisional csv-line round.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Release fixed binary as `v2.12.0-preview.2` | 002, 003 |
| DR-2 | Exp 1 — before/after diff through the real tool surface | 003, 004 |
| DR-3 | Exp 2 — measured native baseline (spike-first) | 006, 007 |
| DR-4 | Exp 3 — code quality under under-specification | 008, 009, 010 |
| DR-5 | Fix `parseTaskBlocks` template↔parser heading mismatch | 005 |
| DR-6 | Chart + publish; supersede provisional conclusions | 011, 012, 013 |
| DR-7 | Experiment integrity (fail-honest, pinned, mechanical-only) | 001, 003, 004, 006, 007, 009, 010, 013 |

### Tasks

Verification scales with `riskTier` per the ladder (`@skills/_shared/references/verification.md`). Tasks touching `servers/exarchos-mcp/` require `cd servers/exarchos-mcp && npm install` in the worktree and its **separate** typecheck/test run (the root typecheck does not cover the MCP server).

### Task 001: Shared eval provenance + fail-honest helper

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7
**Files:**
- `servers/exarchos-mcp/src/evals/provenance.ts`
- `servers/exarchos-mcp/src/evals/provenance.test.ts`

A small reusable module every experiment writes through: `stampProvenance(record)` attaches `{ binaryTag, gitSha, modelIds[], date }` (required — throws if any is missing) to a raw-data artifact, and `assertMeasured(record)` throws on a record flagged `modeled`/`assumed`. **Honest limit:** this is a *convention backstop* — it enforces that provenance is present and rejects self-declared-modeled records, but it cannot structurally detect a pure-function result mislabeled as real. The structural defense against *that* (the #1669 sin) is Exp 1/2/3 driving the real binary / real headless CC / real grader; the helper is the belt, not the mechanism. `date`/`gitSha`/`binaryTag` are passed in (no ambient clock) so runs are reproducible.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe. One property test on the pure stamp core (round-trips required keys); a test that `assertMeasured` rejects a `modeled`-flagged record.
**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Cut `v2.12.0-preview.2` from main (#1669 already merged)

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-1
**Files:**
- `package.json` (version → `2.12.0-preview.2`)

#1669 is already merged (`a240b4d8`); no merge remains. Run `/release` to cut `v2.12.0-preview.2` from current `main`. Operational task — but it gates the entire Exp‑1 critical path (002→003→004→011→012→013) and depends on external release CI, so it is a schedule risk even though its own verification is trivial.

**Verification (low):** static — confirm `git tag` lists `v2.12.0-preview.2`, the tag carries the #1636 stamp-threading fix while `v2.12.0-preview.1` does not, and the Release workflow is green.
**Dependencies:** None
**Parallelizable:** Yes

### Task 003: Build the four Exp-1 binaries + enumerate confounds, with pinned provenance

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-1, DR-2, DR-7
**Files:**
- `docs/evals/data/2026-07-09/binaries.provenance.json`

Build four reference points in throwaway worktrees (`npm run build`), cross-checked against the installer release: the **causal pair** (`a240b4d8^`, `a240b4d8` — #1669 alone) and the released pair (`v2.12.0-preview.1`, `v2.12.0-preview.2`). **The causal pair and `preview.1` exist on `main`/tags today — build and measure them immediately, with no dependency on the release**; the `preview.2` row is backfilled once Task 002 cuts it. Enumerate every commit touching the measured path (`prepare-delegation.ts`, `parse-task-stamps.ts`, `classifyTask*`) in the preview.1→preview.2 window (notably #1659 `585c154c`) into the provenance record. Record each binary's tag/SHA/build-date via the Task-001 provenance shape (DR-7 pinning).

**Verification (low):** static — each available binary runs `--version` reporting the expected ref; `binaries.provenance.json` validates against the Task-001 provenance shape and lists the enumerated confounds.
**Dependencies:** 001 (the `preview.2` row waits on 002; the causal pair does not)
**Parallelizable:** No

### Task 004: Exp 1 driver — before/after diff through the real tool surface

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-2, DR-7
**Files:**
- `servers/exarchos-mcp/src/evals/benchmarks/exp1-binary-driver.ts`
- `servers/exarchos-mcp/src/evals/benchmarks/exp1-binary-driver.test.ts`
- `docs/evals/data/2026-07-09/exp1-before-after.csv`

Invoke `prepare_delegation` through each binary's **real tool surface** (spawned MCP server or CLI adapter — never the pure function) over the stamped `docs/specs/` corpus for **both** the causal pair and the released pair; capture `taskClassifications` from each; emit machine-readable before/after diffs (per-task tier + verification-step delta) as CSV, stamped via Task 001. **Before-arm:** drive pre-fix binaries with `tasks:[{id,title}]` and **no `planPath`** (that arg does not exist pre-#1669 — verified); **after-arm:** pass `planPath` to exercise stamp-lifting. **The causal-pair diff is the primary, fix-isolating result and is producible from `main` immediately (no release wait); the released-pair diff is appended once `preview.2` exists (Task 002).**

**Verification (medium):** scoped tests + kill-probe. Property test on the pure diff core (diffing two classification sets yields a symmetric, complete delta); an integration test that the before-arm (no `planPath`) shows heuristic `medium`/no-boundary and the after-arm carries the plan's `high`/`boundary` + `check_integration_suite` on a fixture pair. Fail-honest if a binary won't dispatch or rejects the before-arm invocation (DR-7).
**Dependencies:** 001, 003
**Parallelizable:** No

### Task 005: Fix `parseTaskBlocks` — parse the majority-4-hash corpus (shared-contract parser)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`
- `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`
- `skills-src/plan/references/spec-template.md`, `skills-src/plan/references/task-template.md` (align header depth)

Port `parseTaskBlocks`/`extractTaskRiskTier` to the SoT stamp parser's already-correct `###`/`####` + broad-id handling so the majority-4-hash corpus parses; align the templates to a single documented depth. This is a **shared-contract parser with three consumers** (the delegation prep, the composite dispatcher, and the eval schema-grader) → high tier. Modifies existing production code → characterization first.

**Verification (high):** scoped tests + `check_test_adequacy` kill-probe **+ the integration suite across the three consumers**; `characterizationRequired: true`. Regression tests `ParseTaskBlocks_FourHashCorpusSpec_ExtractsTiers` (on the real 4-hash corpus spec `2026-07-03-wlm-reconcile-enforce.md`, RED→GREEN) and `ParseTaskBlocks_ThreeHashLegacyId_StillParses`; a property test that heading depth ∈ {3,4} and id ∈ {`T-NN`,`NN`} both parse; the frozen `parseTaskBlocks` parity tests still pass.
**Dependencies:** None
**Parallelizable:** Yes

### Task 006: Exp 2 native-baseline spike harness

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-3, DR-7
**Files:**
- `docs/evals/native-baseline/harness.ts`
- `docs/evals/native-baseline/harness.test.ts`

Drive real headless Claude Code (`claude -p --output-format stream-json`) with a prompt that presents a shared spec as the plan and instructs Task-tool delegation; parse the session transcript for per-subagent `model`, tool/verification behavior, and token usage. SDK is the fallback if transcript capture is unreliable. Emit measured native model distribution as raw data (via Task 001).

**Verification (medium):** scoped tests + kill-probe. Test the transcript parser against a recorded fixture transcript (extracts per-subagent model + tokens correctly); fail-honest path emits a blocked-result record, never a modeled substitute (DR-7).
**Dependencies:** 001
**Parallelizable:** Yes

### Task 007: Exp 2 spike write-up + measured native distribution

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-3, DR-7
**Files:**
- `docs/evals/native-baseline/MECHANICS.md`
- `docs/evals/data/2026-07-09/exp2-native-baseline.csv`

Document the proven mechanics (how CC was made to treat a spec as its plan and delegate; how per-subagent model + tokens were captured; how both pipelines were driven over an identical task set). Commit the measured native model distribution — the artifact that retires the `NATIVE_FLAT_MODEL='opus'` assumption — stamped via the Task-001 provenance shape.

**Verification (low):** static — write-up covers all four spike questions from the AC; CSV validates against the Task-001 provenance shape.
**Dependencies:** 001, 006
**Parallelizable:** No

### Task 008: Under-specified SPEC variants (reuse validated oracles)

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-4
**Files:**
- `docs/evals/quality-ab/tasks/token-bucket/SPEC.underspec.md`
- `docs/evals/quality-ab/tasks/parse-duration/SPEC.underspec.md`
- `docs/evals/quality-ab/tasks/csv-line/SPEC.underspec.md`

For each existing task, author a variant that removes the edge-case enumeration (spec silent on the corners) while keeping the already-validated hidden oracle unchanged. The corners the oracle checks must now be *discovered*, not read off the spec.

**Verification (low):** static — each variant is strictly a subset of its full spec (no new constraints); the unchanged oracle still passes against the reference implementation.
**Dependencies:** None
**Parallelizable:** Yes

### Task 009: Mechanical mutation grading in `grade.ts`

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-4, DR-7
**Files:**
- `docs/evals/quality-ab/grade.ts`
- `docs/evals/quality-ab/grade.test.ts`

Extend the grader to run the diff-scoped mutation gate on each produced impl and record an adequacy score mechanically — replacing the provisional round's self-reported kill-probes. **Diff base:** the gate needs a diff scope + worktree; supply it by initialising a throwaway git repo per produced impl with the task **stub** as the base commit and the produced impl+tests as the working tree, so the diff-scope = stub→impl (the lines the mutation gate must find covered). Modifies existing code → characterization first.

**Verification (medium):** scoped tests + kill-probe; `characterizationRequired: true`. Test that a known-vacuous test suite scores low and a genuine suite scores high on a fixture impl; existing grader outputs unchanged for the fully-specified cells.
**Dependencies:** None
**Parallelizable:** Yes

### Task 010: Run the E-vs-N A/B on opus + sonnet over the under-specified variants

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-4, DR-7
**Files:**
- `docs/evals/quality-ab/run-underspec.ts`
- `docs/evals/data/2026-07-09/exp3-underspec-ab.csv`

Dispatch both arms (E = production verification steer, N = "implement it") over each under-specified variant on opus and sonnet; capture per-cell oracle pass rate, typecheck, durable-tests, and the Task-009 mutation score as raw data (stamped via Task 001).

**Verification (medium):** scoped tests + kill-probe. Test the results-capture/parse path against a fixture run directory (correct per-cell aggregation); fail-honest on a missing/failed cell (DR-7).
**Dependencies:** 001, 008, 009
**Parallelizable:** No

### Task 011: Generate charts (bifrost-style) + commit raw CSV and SVGs

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-6
**Files:**
- `docs/evals/data/2026-07-09/generate_charts.py`
- `docs/evals/data/2026-07-09/*.svg` (committed)

A matplotlib script (no external services) reads the committed Exp 1/2/3 CSVs and writes committed SVGs, mirroring the bifrost doc's figure pattern. Charts regenerate deterministically from committed data. The published figures include the **released-pair** delta, so this reporting step joins the release (Task 002) — the causal-pair result does not.

**Verification (low):** static — `python generate_charts.py` runs clean and emits the expected SVG set from the committed CSVs; no network access.
**Dependencies:** 002, 004, 007, 010
**Parallelizable:** No

### Task 012: Author the dated benchmark write-up

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-6
**Files:**
- `docs/evals/2026-07-09-1670-delegation-pipeline-empirical.md`

The bifrost-style benchmark doc: environment/provenance table, embedded figures via `<img>` with descriptive alt-text captions, and the executed conclusions for model selection (measured native), verification depth (binary before/after), and correctness under under-specification.

**Verification (low):** static — every embedded figure resolves to a committed SVG; `verify_doc_links` passes on the changed doc (scope to the changed file — the repo-wide tree has pre-existing broken links).
**Dependencies:** 011
**Parallelizable:** No

### Task 013: Supersede the provisional conclusions

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-6, DR-7
**Files:**
- `docs/evals/2026-07-09-1636-plan-format-corpus.md`
- `docs/evals/quality-ab/ANALYSIS.md`

Remove the PROVISIONAL caveats **only** for claims now backed by executed data; keep an explicit caveat on any claim still unvalidated. Cross-link to the new benchmark doc.

**Verification (low):** static — no PROVISIONAL banner remains over a now-executed claim; any surviving caveat names the specific unvalidated claim; links resolve.
**Dependencies:** 004, 007, 010, 012
**Parallelizable:** No

### Parallelization

**Critical path (primary, fix-isolating — not release-gated):** 001 → 003 → 004 → 011 → 012 → 013. The release (002) runs in parallel and gates only the *released-pair* rows, joined at 011; the causal-pair result flows without it.

**Wave 1 (no deps, parallel):** 001, 002, 005, 008, 009 — disjoint file sets (`src/evals/provenance.ts`, `package.json`, `src/orchestrate/task-decomposition.ts`, `quality-ab/tasks/*/SPEC.underspec.md`, `quality-ab/grade.ts`).
**Wave 2:** 003 (←001; causal pair + preview.1 build now), 006 (←001).
**Wave 3:** 004 (←001,003; causal diff now, released diff after 002), 007 (←001,006), 010 (←001,008,009).
**Wave 4 (converge):** 011 (←002,004,007,010) → 012 → 013.

Exp 2 (006→007) and Exp 3 (008/009→010) run fully in parallel with the Exp 1 chain, all three feeding the chart/publish convergence; the release (002) joins at 011.

### Completion checklist

- [ ] Every DR-N maps to at least one task in the matrix (DR-1..DR-7 all covered)
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp (1 high w/ integration suite, 5 medium w/ adequacy tests, 7 low on static)
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); 005 adds the integration suite across 3 consumers; 005/009 add characterization (existing-code edits)
- [ ] Open questions resolved (deterministic-arm fate; Exp 3 models) or deferred with rationale (branch base — confirmed at dispatch)
- [ ] Ready for `plan-review`
