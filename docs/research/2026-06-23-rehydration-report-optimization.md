# Rehydration Report Optimization — Discovery Spike (#1475)

- **Date:** 2026-06-23
- **Workflow:** `discover/1475-rehydration-report` (discovery spike, low risk)
- **Status:** Discovery output — produces *evidence*, not a redesign. Implementation belongs in a follow-up `/exarchos:ideate` (or a renderer-only PR). No production code changed by this spike.
- **Origin:** Extracted from #1395; gated on the auto-emission audit (#1474, v2.10.0 RC2) which fixed `_eventHints` so this report is no longer optimizing over an incorrect envelope.
- **Scope guard (from #1475):** does NOT redesign the rehydrate protocol or the projection schema. It measures where the current shape over- or under-serves its two consumers.

---

## 1. What actually renders the report (correcting the issue's premise)

The issue names `serialize.ts` and `playbooks.ts` as "the renderer." Tracing the live code, the human-facing block is **not produced by deterministic TypeScript at all**:

- `handleRehydrate` ([`servers/exarchos-mcp/src/workflow/rehydrate.ts`](../../servers/exarchos-mcp/src/workflow/rehydrate.ts)) returns the raw `RehydrationDocumentV4` JSON as `ToolResult.data`, plus `_meta` (`workflowExists`, `artifactLayout`, `projectionAsOf`, optional `projectionLag`). It attaches `phasePlaybook` at handler time via `composePhasePlaybook` (rehydrate.ts:596–602).
- `serializeRehydrationDocument` ([`projections/rehydration/serialize.ts`](../../servers/exarchos-mcp/src/projections/rehydration/serialize.ts)) only enforces **canonical key order** for prompt-cache prefix stability — it does not summarize, rank, or compress. It is a key-reorderer, not a report renderer.
- `renderPlaybook` ([`workflow/playbooks.ts:100`](../../servers/exarchos-mcp/src/workflow/playbooks.ts)) *looks* like the human renderer but has **zero production callers** (only referenced by its own tests). It is dead-for-rehydrate code.
- The actual human block is rendered by **the model interpreting a Markdown template in [`commands/rehydrate.md`](../../commands/rehydrate.md) → "Output Format"** (step 3: "Render the returned document as compact behavioral context"). On the CLI surface, [`adapters/cli-format.ts`](../../servers/exarchos-mcp/src/adapters/cli-format.ts) writes `result.data` to stdout verbatim (no section-aware compaction) and side-channels (`_eventHints`, `_perf`, `_meta`) to stderr.

**Consequence for both axes:** there is one artifact — the JSON document — and it is simultaneously (a) the source the model formats into the human block and (b) the prompt folded back into the resuming model's context. Optimizing the JSON improves both axes at once. There is no separate "human renderer" to tune independently; tuning axis (a) means tuning the JSON the model reads + the `commands/rehydrate.md` template.

A second drift worth flagging: `commands/rehydrate.md`'s Output Format documents an **`### Event Emission Hints`** section sourced from `_eventHints.missing`, and a **`> Discipline reminder`** blockquote — **neither is a field on `RehydrationDocumentSchema`.** `_eventHints` is injected by telemetry middleware ([`telemetry/middleware.ts:50–54`](../../servers/exarchos-mcp/src/telemetry/middleware.ts)) and is only present when events are actually missing; the Discipline reminder is a constant string baked into the template. So the human block mixes three sources (document JSON, telemetry side-channel, template constant) — relevant when reasoning about "is the Discipline reminder load-bearing on the 10th rehydrate."

---

## 2. Token-cost evidence (per-section breakdown)

Method: reconstructed a representative **feature/`delegate`** document (the heaviest phase — its playbook is the largest) from the exact string literals in `playbooks.ts` and the `v:4` schema, then measured each section with the codebase's own token heuristic (`Math.ceil(chars/4)`, the same one `rehydrate.ts:618` uses for `tokenEstimate`). Three workflow sizes. Script: reproducible; reconstructs the static playbook values verbatim.

| Section | SMALL (2 tasks) | MID (8 tasks, +handoff) | LARGE (20 tasks, +handoff) |
|---|---|---|---|
| `v` + `projectionSequence` | 8t (1.0%) | 8t (0.8%) | 8t (0.7%) |
| `workflowState` | 21t (2.6%) | 21t (2.1%) | 21t (1.9%) |
| `taskProgress` | 20t (2.5%) | 77t (7.7%) | **191t (17.1%)** |
| `decisions` (always `[]`) | 1t | 1t | 1t |
| `artifacts` | 30t (3.8%) | 30t | 30t |
| `blockers` (empty here) | 1t | 1t | 1t |
| `latestHandoff` | — | 76t (7.6%) | 76t (6.8%) |
| `recentHandoffs` | — | 76t (7.6%) | 76t (6.8%) |
| **`phasePlaybook` (TOTAL)** | **686t (86.5%)** | **686t (68.3%)** | **686t (61.3%)** |
| **Full document** | **~793t** | **~1004t** | **~1119t** |

`phasePlaybook` sub-field breakdown (constant across sizes — `delegate` phase):

| Sub-field | Tokens | Note |
|---|---|---|
| `compactGuidance` | 250t | prose; duplicated by the skill (see §3) |
| `events` | 142t | 6 model-event entries with `when`/`fields` |
| `tools` | 122t | 5 tool/action/purpose triples |
| `autoEmittedEvents` | 96t | 2 entries the model never emits |
| `skill` + `skillRef` | 16t | |
| `guardPrerequisites` | 11t | |
| `transitionCriteria` / `validationScripts` / `humanCheckpoint` | 22t | |

### Headline numbers

- **`phasePlaybook` is 61–86% of the entire envelope** and is **fixed cost** — it does not shrink on small workflows, so it dominates *most* the small/short workflows the issue worried about ("should table-vs-prose flip on 1–3 tasks?"). On a 2-task workflow, 86% of the rehydrate budget is phase boilerplate.
- **`latestHandoff` and `recentHandoffs[0]` are byte-identical.** The reducer ([`reducer.ts:629–648`](../../servers/exarchos-mcp/src/projections/rehydration/reducer.ts)) writes the *same* `entry` object to both `latestHandoff` and the head of `recentHandoffs`. So whenever any handoff exists, ~76 tokens are pure duplication, and the first `recentHandoffs` entry always restates `latestHandoff`.
- **`decisions` is always `[]`.** No `decision.*` event type is registered ([reducer.ts:905–908](../../servers/exarchos-mcp/src/projections/rehydration/reducer.ts)); the field has never carried a value in production. It is 1 token, so the cost is trivial, but it is dead surface in the schema and the `commands/rehydrate.md` mental model.
- **`taskProgress` is the only section that scales with workflow size** (20t → 191t from 2 → 20 tasks) and is the issue's "collapse completed tasks past a threshold" candidate — but it is second to the playbook even at 20 tasks.

### Trimmed-envelope A/B (illustrative)

Collapsing the LARGE document's completed tasks to a count (`{ done: 15, active: [...] }`) **and** replacing `phasePlaybook` with `skillRef`-only (`{ skillRef, humanCheckpoint }`) takes the document from **~1119t → ~228t — an 80% reduction.** The playbook collapse alone accounts for ~670 of those tokens.

---

## 3. The central axis-(b) finding: `phasePlaybook` duplicates the skill the agent already loads

`/exarchos:rehydrate` is invoked precisely when an agent is *resuming a phase it is already in*. In that situation the matching skill (`@skills/delegation/SKILL.md` for `delegate`, etc.) is **already loaded into context** — rehydrate's whole job is to re-inject *state*, not re-teach the phase.

Yet `phasePlaybook` ships, inline, content the skill already carries. Concretely, `skills-src/delegation/SKILL.md` (535 lines) already documents:

- the `task.assigned`-per-dispatch emission contract (SKILL.md:71–78, 188) — restated by `phasePlaybook.events` + `compactGuidance`;
- the `check_test_adequacy` → `check_static_analysis` → `task_complete` gate sequence (SKILL.md:218–230, 291, 370) — restated verbatim in `compactGuidance`;
- the tool surface (`exarchos_event`, `exarchos_orchestrate task_complete`) — restated by `phasePlaybook.tools`.

So on a `delegate` rehydrate, ~686 tokens (61–86% of the envelope) re-teach material already resident in context. The skill is the single source of truth for *how to run the phase*; the playbook should be a **pointer** (`skillRef`) plus the few facts the skill cannot know statically (the live `transitionCriteria`/`guardPrerequisites` for *this* workflow, and the `humanCheckpoint` flag). This is exactly #1475 axis-(b)'s hypothesis ("replaceable with `skillRef` only?") — the evidence says: largely yes, with a small dynamic remainder.

Note the `phasePlaybook` content is **100% static per (workflowType, phase)** — `composePhasePlaybook` reads a compile-time registry; nothing in it is derived from the running workflow's events. That is the strongest signal it belongs behind a reference, not inlined per-rehydrate.

---

## 4. Per-field verdict (keep / collapse / lazy / cut)

| Field | Cost | Value to model | Value to human | Verdict |
|---|---|---|---|---|
| `v`, `projectionSequence` | 8t | low (machinery) | none | **Keep** — load-bearing for cache/projection anchoring; cheap. |
| `workflowState` (featureId/phase/workflowType) | 21t | high | high (header) | **Keep** — the orienting header; cheapest high-value field. |
| `mergeOrchestrator` (sub of workflowState) | ~0–30t | high *when present* | medium | **Keep** — drives `merge_orchestrate` next-action; already optional. |
| `taskProgress` | 20–191t | high (what's left) | high | **Collapse** completed entries past a threshold (e.g. >6 tasks → `{ done: N, active: [...] }`); active tasks are the only ones that change next action. Schema migration (status quo is a flat array). |
| `decisions` | 1t | none (always `[]`) | none | **Cut** — no event ever populates it; remove from schema + template. Trivial tokens but dead surface. |
| `artifacts` | 30t | medium (paths) | high | **Keep as path-only** — already path-only (it is `Record<string,string>`), so the issue's "path-only with read-on-demand" is *already satisfied*; no inlined file bodies. Keep. |
| `blockers` | 1t+ | high when present | high | **Keep** — already absent when empty. |
| `latestHandoff` | 76t | medium | medium | **Cut** — byte-identical to `recentHandoffs[0]`; redundant. Keep `recentHandoffs`, derive "latest" as `recentHandoffs[0]`. Pure renderer/consumer change + a schema deprecation. |
| `recentHandoffs` | 76t/entry (≤3) | medium | medium | **Keep** but it absorbs `latestHandoff`. Cap already bounds it. |
| `phasePlaybook` | 686t (61–86%) | **low on rehydrate** (skill already loaded) | medium | **Collapse to `skillRef` + dynamic remainder** (`transitionCriteria`, `guardPrerequisites`, `humanCheckpoint`). Drop `tools`/`events`/`autoEmittedEvents`/`compactGuidance` from the rehydrate envelope — the skill carries them. Single biggest win (~600t). |
| `_eventHints` (side-channel, not schema) | varies | high when present | high | **Keep** — only present when events are genuinely missing; this is the corrected #1474 surface. Not redundant. |
| Discipline reminder (template constant) | ~60t | low after 1st rehydrate | low repeated | **Restructure** — fine on first rehydrate; noise on the 10th. Move to a one-line pointer-to-RCA, or gate on a "first rehydrate this session" hint. Template-only change. |

---

## 5. Recommendations, go/no-go, and migration class

Ordered by token-win-per-unit-risk:

1. **GO — collapse `phasePlaybook` to a reference on the rehydrate envelope.** Replace the inlined playbook with `{ skillRef, transitionCriteria, guardPrerequisites, humanCheckpoint }`. Saves ~600t (the bulk of the envelope). **Requires schema change** (`PhasePlaybookSchema` is currently the full shape) **+ `commands/rehydrate.md` template edit.** Risk: a runtime/harness that does *not* auto-load the skill would lose the tool/event contract — verify every Tier-1 runtime's rehydrate path loads the phase skill before cutting (INV-4 parity check). This is the one item that genuinely needs design, not just a renderer tweak.

2. **GO — drop `latestHandoff` (derive from `recentHandoffs[0]`).** Pure duplication; ~76t. **Schema deprecation** (mark optional/removed) + consumer update (`nextActionsFromResult` and the template read `recentHandoffs[0]`). Low risk; the read-side upgrade chain (v:4) already normalizes.

3. **GO — collapse completed `taskProgress` past a threshold.** `{ done: N, active: [...] }` above ~6 tasks. Up to ~150t on large workflows. **Schema change** (union the array with a collapsed shape) — moderate; the canonical-status vocabulary pin (#1359) must survive on the `active` entries.

4. **GO (renderer-only) — restructure the Discipline reminder** in `commands/rehydrate.md` to a one-line RCA pointer, optionally first-rehydrate-gated. No schema impact.

5. **GO (renderer-only) — remove the `decisions` field** from the schema initial + template, OR explicitly document it as reserved. It is dead. Trivial tokens; clarity win.

6. **DEFER — phase-aware projection** (issue's "ideate vs synthesize need different envelopes"). Once `phasePlaybook` is a reference (item 1), the residual envelope is already mostly phase-agnostic state; a full phase-specialized projection is a larger redesign with diminishing returns post-item-1. Re-evaluate after items 1–3 land.

### Axis-(a) instrumentation gap (honest limitation)

#1475 asks for think-aloud sessions on ≥3 live rehydrates and a log of the immediate next action. This spike is **static**: I did not run live human reorient-time sessions (out of scope for a low-risk static discovery, and the harness has no captured rehydrate-then-next-action telemetry today). The structural findings above (playbook dominance, handoff duplication, skill overlap) hold regardless of human-study outcome because they are properties of the JSON, not of comprehension. The think-aloud study should be **folded into the follow-up implementation issue** as a validation gate on item 1 specifically (does dropping the inlined playbook hurt reorient time when the skill is loaded?), and `workflow.rehydrated` already carries `tokenEstimate` — adding a `next-action-after-rehydrate` telemetry beat would close the measurement gap cheaply.

---

## 6. Hand-off recommendation

**Yes — recommend one follow-up implementation issue.** Scope: *"Slim the rehydration envelope: collapse `phasePlaybook` to `skillRef` + dynamic remainder, drop the duplicated `latestHandoff`, collapse completed `taskProgress` past a threshold, and align `commands/rehydrate.md` (Discipline reminder + `decisions`)."* It is a mixed renderer + schema-migration change (items 1–3 need a `v:5` envelope; items 4–5 are renderer-only and can ship immediately), so it warrants its own `/exarchos:ideate` → `/plan` cycle rather than folding into this spike. Gate item 1 on the INV-4 runtime-parity check (every runtime's rehydrate loads the phase skill) and the deferred axis-(a) think-aloud validation.

Estimated envelope reduction if all GO items land: **~1119t → ~250–350t on a large `delegate` rehydrate (~70%), ~793t → ~150t on a small one (~80%)** — and the saving is largest exactly where the issue feared it (small/short workflows, where the fixed playbook cost dominated).
