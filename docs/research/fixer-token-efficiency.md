# Fixer Subagent Token Efficiency — Research Report

**Tracking issue:** [#1159](https://github.com/lvlup-sw/exarchos/issues/1159)
**Date:** 2026-04-19
**Workflow:** `discover-fixer-token-efficiency`
**Status:** Discovery output. Implementation belongs in a follow-up `/exarchos:ideate` workflow.

## 1. Problem (validated)

The `exarchos-fixer` subagent, when dispatched against batches of code-review comments, costs ~12–15k tokens and 6–8 tool calls per item. On a busy PR (~50 comments) this projects to ~600k tokens and ~45 minutes per remediation round.

The per-round metrics in #1159 (rounds 1–3 on basileus PR [#159](https://github.com/lvlup-sw/basileus/pull/159) — 110/61/137 tool calls; 214k/131k/234k tokens) were observed externally via Claude Code session metadata, not via exarchos's own telemetry. **`exarchos_view team_performance` and `exarchos_view delegation_timeline` returned empty for this session**, so the baseline numbers cannot be reproduced from event-store data today. This is a data-availability gap — see Open Question Q1.

### Causes from the issue, in order

1. **Read amplification per file** (~30–40% of cost). When N comments touch the same file, the fixer Reads it N times.
2. **Investigation cost** (~30–50k tokens on the high-investigation rounds). Some fixes legitimately require cross-repo reading (round 3 inspected `Strategos.Npgsql.Internal.ExpressionTranslator` to confirm predicate-pushdown was infeasible).
3. **One-size-fits-all subagent type.** Doc/style nits go through the same heavyweight pipeline as architectural fixes.
4. **Per-cluster build+test overhead** (~6 min wall-clock on round 3). This is a safety rail; the issue marks it explicitly as **not** an optimization target.

## 2. Current architecture

### Fixer dispatch surface

| Concern | Where | Current behavior |
|---|---|---|
| Fixer agent template | [`agents/fixer.md`](../../agents/fixer.md) | Accepts `{{failureContext}}`, `{{taskDescription}}`, `{{filePaths}}` only — no source-code placeholder |
| Scaffolder agent template | [`agents/scaffolder.md`](../../agents/scaffolder.md) | Defined and dispatchable today |
| Template interpolation | [`servers/exarchos-mcp/src/agents/handler.ts:28-50`](../../servers/exarchos-mcp/src/agents/handler.ts) | String replacement only; no dynamic file Reads |
| Hook wiring | [`servers/exarchos-mcp/src/agents/generate-cc-agents.ts:15-51`](../../servers/exarchos-mcp/src/agents/generate-cc-agents.ts) | `TRIGGER_MAP` supports `pre-write`, `pre-edit`, `post-test`. **No `pre-dispatch` trigger.** |
| Review-comment ingest | [`servers/exarchos-mcp/src/orchestrate/check-pr-comments.ts:1-117`](../../servers/exarchos-mcp/src/orchestrate/check-pr-comments.ts) | Flat list per comment; no severity, no thread reply detection |
| Finding → task extraction | [`servers/exarchos-mcp/src/orchestrate/extract-fix-tasks.ts:163-171`](../../servers/exarchos-mcp/src/orchestrate/extract-fix-tasks.ts) | 1:1 mapping, no file grouping. Severity threaded through (`severity: finding.severity ?? 'MEDIUM'`) but unused downstream |
| Task classification | [`servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts:91,115-195`](../../servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts) | `classifyTask()` already routes scaffolding-keyword titles → `scaffolder` + `sonnet`. Does **not** read severity. |
| Severity catalog | [`servers/exarchos-mcp/src/review/check-catalog.ts:9,14`](../../servers/exarchos-mcp/src/review/check-catalog.ts) | `CheckSeverity = 'HIGH' \| 'MEDIUM' \| 'LOW'` exists |
| Shepherd loop | [`skills-src/shepherd/SKILL.md:20-150`](../../skills-src/shepherd/SKILL.md) | `assess → fix → resubmit` iteration ≤5x; no per-iteration batching |

### What's missing today

- File grouping anywhere in the dispatch path
- Source-code prefetch / inlining
- Severity → agent-class routing
- A `prepare_review_fixes` action on `exarchos_orchestrate`
- Per-subagent token telemetry inside exarchos's event store

## 3. Optimizations mapped to implementation surfaces

### P1 — Batch by file (highest leverage)

**Issue estimate:** ~30% token savings.
**Implementation surface:** new orchestrate action `prepare_review_fixes` (or a new step inside `extract-fix-tasks.ts`) that groups findings by `file` before emitting tasks. Each grouped task lists multiple `(line, description)` items for one file; the fixer Reads that file once.

**Effort:** Small (~1 handler + schema + 1 task-shape change). Existing `findings[]` already carry `file` and `line`.
**Risk:** Low. Only changes task granularity; doesn't change agent behavior.
**Cross-cutting:** `extract_fix_tasks` consumers — must accept multi-finding tasks. Verify `prepare_delegation` path still works.

### P2 — Pre-fetch ±40 lines of context (medium leverage, low effort)

**Issue estimate:** ~15–25% token savings (saves 50–80k of fixer Reads at cost of ~5k inlined tokens per dispatch).
**Implementation surface:** extend the fixer template (`agents/fixer.md`) with a `{{contextSnippet}}` placeholder, then add Read calls inside `prepare_review_fixes` (or `prepare_delegation` for review-derived tasks) that materialize `±N` lines around each `(file, line)` and concatenate them into the prompt.
**Effort:** Small–Medium. Need a per-task source loader; need to bound payload (cap at e.g. 20 snippets × 80 lines per task).
**Risk:** Medium. Inlining stale source if a prior fix in the same batch already mutated the file. Needs sequencing — see Open Question Q2.

### P3 — Severity-tier routing to scaffolder vs fixer

**Issue estimate:** ~10% token savings, ~30% wall-clock from parallelism.
**Implementation surface:** extend `classifyTask()` in `prepare-delegation.ts` to read the existing `severity` field. Add cases:
- `severity === 'LOW'` AND title matches doc-nit keywords (`<remarks>`, `sealed`, `sort`, `format`) → `scaffolder` + `haiku`
- `severity === 'HIGH'` → `fixer` + `opus` (current default)
- substantive non-LOW → `fixer` + `sonnet`

**Effort:** Trivial. Severity is already in the data shape (`extract-fix-tasks.ts:170`); all that's missing is consumption.
**Risk:** Low if the heuristic is conservative (i.e. only routes obvious nits to scaffolder). Mis-routing a substantive fix to scaffolder is recoverable via the existing fixer fallback path.

### P4 — Pre-resolve cross-repo investigation in the orchestrator

**Issue estimate:** 20–40k tokens per investigation-heavy item.
**Implementation surface:** there is **no existing pattern for this** (see Open Question Q3). Two candidate shapes:
- (a) An optional `directives` field on each fix task (string array) that the orchestrator populates when it has done upfront investigation. The fixer prompt template would surface `{{directives}}` as "Use approach X. Do NOT explore Y because <reason>."
- (b) A `pre_investigate` action that takes a finding and returns a directive string, invoked selectively when `severity === 'HIGH'` and the finding mentions cross-repo paths.

**Effort:** Medium–Large. (a) is a small data-shape change but only useful if a human/orchestrator actually fills it. (b) requires actually running investigation logic — hard to implement without an LLM call, in which case the savings vs. the fixer doing it itself are unclear.
**Risk:** High that (b) just relocates the cost. P4 is the weakest of the four.

## 4. Ranked recommendation

| Rank | Optimization | Leverage | Effort | Risk | Verdict |
|---|---|---|---|---|---|
| 1 | **P3** — severity routing | ~10% tokens, ~30% wall-clock | Trivial (~50 lines, classification only) | Low | **Ship first.** Severity already plumbed; only consumption is missing. Highest ratio of impact-per-line-changed. |
| 2 | **P1** — batch by file | ~30% tokens | Small (one orchestrate action + task-shape change) | Low | **Ship second.** Largest token win. Independent of P2/P3. |
| 3 | **P2** — context prefetch | ~15–25% tokens | Small–Medium | Medium (stale-source risk after intra-batch edits) | **Ship third, after P1.** Needs sequencing rules to avoid stale snippets — see Q2. |
| 4 | **P4** — pre-resolve investigation | 20–40k per item, but only on a small fraction of items | Medium–Large; design unclear | High | **Defer.** Likely just relocates the cost. Re-evaluate after P1/P2/P3 are measured. |

## 5. Open questions for ideate

- **Q1: Telemetry baseline.** Acceptance criterion #4 in #1159 demands a "≥40% token reduction" benchmark. Today we cannot measure this from event-store data — `team_performance` and `delegation_timeline` views are empty during this session. **Decide:** instrument the dispatcher to emit `subagent.tokens_used` events (and back-fill the views), or rely on manual measurement against a single representative batch (e.g. replay basileus #159 round 3 contents).
- **Q2: Stale-snippet risk for P2.** When a single batched task has 5 fixes for one file, the prefetched snippets reflect the file *before* fix 1 lands. If fix 1 shifts line numbers, fixes 2–5 see incorrect snippets. **Decide:** prefetch on each iteration, prefetch by symbol-name instead of line-range, or warn the fixer to re-Read after each Edit.
- **Q3: P4 design.** Should the orchestrator do its own investigation (LLM-backed → cost relocation) or just expose a `directives` slot for humans / future logic? **Decide:** start with the data-shape (a) and let the slot stay empty until a real use case appears.
- **Q4: `prepare_review_fixes` vs. extending `extract_fix_tasks`.** Both are viable. New action is more discoverable; extending the existing handler keeps the surface smaller. **Decide:** new action, gated on a `groupByFile: boolean` arg defaulting to `true`.
- **Q5: Build+test cadence under batching.** If P1 collapses 5 single-file tasks into 1 multi-fix task, the per-cluster build+test now covers 5x the changes per run. Failure attribution gets harder. **Decide:** keep one build per task (cheap because tasks are larger but fewer) or add a per-fix re-test inside the fixer. The issue explicitly opts to leave build+test alone, so default to "one build per task."

## 6. Recommended next step

Open `/exarchos:ideate` referencing this report as design input. Scope: P3 + P1 + P2 (deferring P4). Acceptance gate from #1159 remains valid; resolve Q1 first so the benchmark is measurable.
