# Checkpoint/Handoff Cluster Fitness — v2.9.0 vs Overhauled Milestones

**Date:** 2026-05-07
**Workflow:** `discover-checkpoint-cluster-fitness`
**Scope:** Disposition recommendations for issues #1240, #1242, #1243, #1244, #1245 (all originating from spike #1239) against the recently overhauled v2.10–v3.1 milestones.
**Decision required:** Per-issue milestone reassignment + one open question on #1240's ship vehicle.

## Executive summary

The cluster is **largely still fit at the design level** — the spike's core recommendation (event-sourced handoff on `workflow.checkpoint`, top-level `latestHandoff` projection) is sound and orthogonal to the v2.10/v2.11/v3.1 overhauls. What changed is **which milestone hosts the work**, not whether the work is needed. Four of the five issues are mis-milestoned: they were filed eagerly alongside spike #1239 on 2026-05-06, before v2.9.0 GA shipped and before the milestone overhauls clarified theme boundaries. The recommended outcome is operationally cheap: relabel four issues, leave #1240 alone, soften #1243 to a deferred backlog state.

**Trigger conditions changed:** Spike's hard-blocker #1241 closed 2026-05-08, and #1230 (sequence-number bug) was fixed on `feature/v29-bug-cluster`. #1240 is unblocked for the first time.

## Per-issue dispositions

| # | Recommendation | Rationale | Evidence |
|---|---|---|---|
| **#1240** — wire handoff into `workflow.checkpoint` + projection | **Keep in v2.9.0** (decision point: v2.9.x patch vs move to v2.10.0) | Foundation issue. Spike's primary deliverable. Now unblocked (#1241 closed, #1230 fixed). Nothing in v2.10/v2.11/v3.1 supersedes; v3.1 SDK assumes `workflow.checkpoint` shape stable. | #1241 closedAt=2026-05-08; spike doc §POC; `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md` |
| **#1242** — auto-summarized handoff fallback | **Move to v2.11.0 — Autonomous Orchestration** | Fundamentally an autonomous-orchestrator concern: "checkpoint moments fire programmatically… no operator is around to author handoff." v2.11 hosts the autonomous shepherd loop (#1120, #1263) and TDD swarm (#1121) where this composes. | #1242 motivation; v2.11 issues #1120/#1121/#1263 |
| **#1243** — `?include=handoff` query gate | **Close as deferred / move to v3.0.0 backlog** | Issue's own trigger says "Open this only after measurement shows the unconditional inclusion is too expensive." No measurement exists. Filing in v2.9.0 contradicts the trigger. | #1243 "Trigger" section |
| **#1244** — markdown-aware lint at handoff write time (DIM-8) | **Move to v2.10.0 — Agent Output Contract** | DIM-8 prose-quality enforcement at a write boundary is the v2.10 axis. Closest sibling: #1262 (quality_hint on narration spikes). The lint applies at the envelope-write layer that v2.10 is restructuring (#1287 carrier swap, #1288 outputSchema). Co-locate to avoid double-pass. | #1244 motivation; v2.10 issues #1262/#1287/#1288; `docs/designs/2026-05-07-milestone-16-mcp-alignment.md` |
| **#1245** — `@<path>` substitution on `--context` CLI flag | **Move to v2.12.0 — Process Lifecycle Verbs** *or* v3.0.0 P1 CLI Ergonomics (#1087) | Pure CLI ergonomic enhancement. Natural fit alongside `ps`/`describe`/`wait`/`export` verb work (v2.12) already restructuring `commander` argument parsing, or with #1087's P1 backlog (#1092–#1096). Not a v2.9 cross-platform/install concern. | #1245 design notes; v2.12.0 milestone scope; #1087 P1 |

## Cross-cutting findings

1. **All five inherit a stale "v2.9.0 — Cross-platform & Install" label.** Filed alongside spike #1239 on 2026-05-06 before v2.9.0 GA shipped (per `docs/contexts/2026-05-07-p4-shepherd-handoff.md`: P1/P2/P3 merged). Since GA, v2.9.0 has narrowed to install/cross-platform charter; remaining open issues are mostly P4 e2e residue. Only #1240 has a credible "ship as v2.9.x patch" story.

2. **#1109 compliance is already paid down by the spike doc.** `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md` §"Cross-cutting compliance" addresses C1 (event-sourcing integrity — handoff rides `workflow.checkpoint`, replay-reconstructable), C2 (MCP parity — single `handleCheckpoint` core), C3 (basileus-forward — keyed on `(streamId, eventRef.id)`). The v2.10 milestone-16 carrier swap (#1287) is orthogonal; the cluster does not need to re-prove invariants.

3. **Axiom-dimension coverage is uneven and intentional:**
   - #1240 — DIM-1/3/4/5/7 (foundation)
   - #1244 — DIM-8 (prose quality) explicit
   - #1242 — DIM-2 (observability) implicit via `source: 'operator' | 'auto'`
   - #1243 — DIM-1 (topology) prophylactic
   - #1245 — DIM-3 (contracts) at CLI boundary
   - DIM-6 (architecture) — none, and none needs to; spike preserves writer/reader/projection seams.

4. **Workflow Builder SDK (v3.1.0, #1258) does not threaten the cluster but does observe it.** P6 (#1252) emits `workflow.{registered, unregistered, scaffold-created, evolved}` and assumes `workflow.checkpoint` shape is stable. **Soft ordering preference:** land #1240 *before* v3.1 P1 (#1247) freezes the IR — additive `WorkflowCheckpointData` changes should ship before SDK codegen pins the schema.

5. **Pattern recognition:** "Follow-up cluster filed eagerly, milestone-themed lazily." Operationally cheap fix.

## Open questions

1. **Ship vehicle for #1240 — v2.9.x patch vs v2.10.0?** Spike doc treats it as the spike's natural production wiring (v2.9.x feasible now that #1241/#1230 are resolved). But coupling a feature ship to a "Cross-platform & Install" minor breaks theme purity. v2.10.0 is clean; the carrier swap (#1287) is non-conflicting per `docs/designs/2026-05-07-milestone-16-mcp-alignment.md` §1.1.

2. **Does v2.11.0 want #1242 in autonomous-orchestrator scope, or specifically with the shepherd daemon (#1263)?** The summarizer subagent's dispatch path is unspecified in #1242; landing it requires deciding which autonomous loop produces the summary.

3. **Does #1244's `prose-lint.ts` reuse hold under #1287's `structuredContent` carrier?** The spike said reuse the existing skill prose-lint, but that lint runs over markdown source, not Zod-validated structured payloads. May need an adapter shim — confirm with #1287 owner before relocating.

4. **`docs/plans/2026-05-06-workflow-builder-sdk-traceability.md` is a stub.** Almost every row is "to be filled." Treated as informational only, not load-bearing for this disposition. Worth flagging if it should be populated before v3.1 P1 dispatch.

5. **No dedicated "deferred-until-measured" tracking exists.** v3.0.0 currently absorbs deferred items as a generic "later" bucket. If explicit deferral state is wanted, that's a separate label/milestone decision out of scope here.

## Recommended next action

Apply the dispositions above as a **pure milestone-relabeling pass** (no scope changes, no closures except #1243 if user prefers). Resolve open question #1 first since it determines whether #1240 stays in v2.9.0 or joins v2.10.0. The relabeling is reversible and surfaces the milestone overhaul's true boundaries; if a downstream issue's true home turns out to be different, it can be re-relabeled cheaply.

## Sources consumed

- GitHub issues: #1109, #1118, #1120, #1121, #1239, #1240, #1241, #1242, #1243, #1244, #1245, #1247, #1252, #1258, #1262, #1263, #1287, #1288
- Open issue lists for milestones v2.10.0, v2.11.0, v2.12.0, v3.0.0, v3.1.0
- `docs/designs/2026-05-06-checkpoint-handoff-enrichment.md` (spike output)
- `docs/designs/2026-05-07-milestone-16-mcp-alignment.md`
- `docs/contexts/2026-05-07-p4-shepherd-handoff.md`
- `docs/plans/2026-05-06-workflow-builder-sdk-traceability.md` (stub, informational)
- `skills/claude/axiom-backend-quality/SKILL.md` — eight-dimension taxonomy
