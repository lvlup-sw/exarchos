# RCA: `/exarchos:rehydrate` restores narrative state but not behavioral discipline

## Summary

`/exarchos:rehydrate` is documented as re-injecting "workflow state **and behavioral guidance**" into the agent context after `/clear` or compaction. In practice it injects the state half well (phase, tasks, artifacts, next-action verbs) but the behavioral half rarely arrives — when the per-workflow `behavioralGuidance` payload is empty (the common case for delegate-phase workflows), the slash-command's render template emits empty section labels and continues without fallback. The post-rehydrate agent receives plenty of *narrative* context to act on but no *imperative* to keep acting through the orchestration tools (`exarchos_event.append`, `exarchos_workflow.set`, `/exarchos:delegate`). Manual implementation becomes the path of least resistance and the workflow tracker silently desyncs from git.

## Symptom

Workflow `per-rep-drill-modifiers` reported phase `delegate`, 3/15 tasks complete, T-04 "next" — while git showed all 14 task branches merged into the integration branch and PR #165 open with green CI. Twelve task transitions completed without emitting `task.completed`, `merge.executed`, or any other event on the workflow stream.

### Reproduction Steps

1. Initialize a feature workflow: `/exarchos:ideate` → `/exarchos:plan` → `/exarchos:delegate` for the first wave of tasks. Confirm `task.completed` and `merge.executed` events land on `workflow:<feature-id>`.
2. Run `/clear` to wipe the conversation.
3. Run `/exarchos:rehydrate <feature-id>`.
4. Inspect the rehydrate envelope and observe `behavioralGuidance: { skill: "", skillRef: "" }` — empty for any workflow where the projection reducer did not populate it.
5. Ask the agent to "continue with the next task." Observe that it edits/commits/merges directly, **never invoking `exarchos_workflow.set`, `exarchos_event.append`, or dispatching subagents through `/exarchos:delegate`**.
6. Query the event stream after the agent's work: `exarchos_event action: query stream: workflow:<id>` — no new `task.*` or `merge.*` events. The workflow state remains frozen at whatever it was at rehydrate time.

### Observed Behavior

The agent reads the rehydration brief, internalizes "phase delegate, T-04 next," and executes T-04 (and every subsequent task) directly via `Edit` / `Write` / `Bash` tools. Workflow state captures none of it. A later rehydrate produces the same stale brief because the projection has no events to fold.

### Expected Behavior

After rehydrate, the agent should exhibit the same orchestration discipline it had before `/clear`: dispatch via `/exarchos:delegate` for delegate phase, emit `task.progressed` on TDD phase boundaries, call `exarchos_workflow.set` on phase transitions, etc. The rehydrated context should make those obligations as load-bearing as the next-action verb.

## Root Cause

Three reinforcing gaps, none individually fatal but jointly silent:

### 1. The projection's `behavioralGuidance` is empty for many workflows

`rehydrationReducer.initial.behavioralGuidance` ships with empty strings for `skill` and `skillRef`, and the reducer only populates them when an explicit guidance event lands on the stream. For workflows whose ideate/plan/delegate cycle never emitted such an event, the field never gets filled — even though the **phase** itself implies a well-known contract (delegate-phase agents must dispatch subagents and emit `task.completed`; synthesize-phase agents must run `/exarchos:synthesize` and not commit to the integration branch directly; etc.).

### 2. The slash-command render template is silent on empty fields

The Output Format in `commands/rehydrate.md` lists field labels under `### Behavioral Guidance` (`**Skill:**`, `**Tools:**`, `**Events to emit:**`, `**Transition:**`, `**Scripts:**`) but specifies no fallback when a field is blank. A faithful renderer either omits the section or emits headers with empty values — both produce the same effect: the agent reads "Skill: (blank)" and moves on. The command does not include any "House Rules" block describing the phase contract independent of the projection payload.

### 3. The `_eventHints.missing` channel is not surfaced

The rehydrate envelope already carries a `_eventHints.missing` array — for delegate phase it contains `{ eventType: "task.progressed", description: "Emit task.progressed via exarchos_event after each TDD phase transition (red/green/refactor)", requiredFields: [...] }`. This is the exact reminder the agent needs. The render template does not output it.

### Code Locations

| File | Lines | What it does |
|------|------|--------------|
| `commands/rehydrate.md` | 28-52 | Output Format template — lists guidance field labels, omits empty-field fallback, omits `_eventHints.missing` rendering |
| `servers/exarchos-mcp/src/projections/rehydration/reducer.ts` | `rehydrationReducer.initial` | Seeds `behavioralGuidance: { skill: "", skillRef: "" }` and only mutates on explicit guidance events |
| `servers/exarchos-mcp/src/workflow/rehydrate.ts` | 514-598 | `handleRehydrate` returns the projection document verbatim — no phase-default backfill before envelope return |

### Analysis

A delegate-phase workflow without populated guidance is the most common shape on this project (none of the active workflows in `MEMORY.md` were initialized with explicit guidance events). For the `per-rep-drill-modifiers` workflow, the post-rehydrate envelope returned to the previous session at 2026-05-08T17:23 PT included:

```json
{
  "behavioralGuidance": { "skill": "", "skillRef": "" },
  "next_actions": [
    { "verb": "delegate", "reason": "..." },
    { "verb": "merge_orchestrate", "reason": "..." }
  ],
  "_eventHints": {
    "missing": [{
      "eventType": "task.progressed",
      "description": "Emit task.progressed via exarchos_event after each TDD phase transition (red/green/refactor)",
      "requiredFields": ["taskId", "tddPhase"]
    }]
  }
}
```

The previous session's agent rendered the envelope per the slash-command template, which surfaced "Phase delegate" and "Next: T-04" but **omitted the `_eventHints.missing` array entirely** and emitted empty `Skill:` / `Tools:` / `Events to emit:` lines. The user (Reed) then started T-04 — and 11 more tasks — manually, completing all of T-04..T-15 in 2.5 hours of focused TDD with perfect commit hygiene (`(T-NN RED/GREEN/REFACTOR)` subjects, dedicated branches, first-parent merges) but zero exarchos events. The current session reproduced the bug end-to-end: rehydrated, identified the divergence, ran a dozen tool calls — and itself emitted no events, despite "knowing" the state was out of sync.

## Contributing Factors

- [x] Missing fallback — projection ships empty guidance, slash-command template doesn't fill it.
- [x] Information loss in rendering — `_eventHints.missing` carries the exact reminder needed, but the template doesn't render it.
- [x] No phase-contract baseline — every phase has a known set of obligations (delegate must dispatch + emit; synthesize must shepherd via PR; cleanup must verify merge), but none of those are encoded as render-time defaults.
- [x] Agent UX makes manual execution easier than orchestrated execution — `Edit`/`Write`/`Bash` are always one tool call away; `/exarchos:delegate` requires a worktree spin-up roundtrip. With no behavioral pressure to choose the latter, the former wins.
- [ ] Race condition / timing issue
- [ ] External dependency failure
- [ ] Configuration error
- [ ] Unclear requirements

## Fix Approach

Three complementary patches in the exarchos plugin (`~/Documents/code/lvlup-sw/exarchos`). Each is independently shippable; together they close the loop.

### Changes Required

| Layer | File | Change |
|------|------|--------|
| Projection | `servers/exarchos-mcp/src/projections/rehydration/reducer.ts` | Add a phase-default lookup for `behavioralGuidance` consumed at projection-read time (or written into `initial` per-phase). For delegate phase: `{ skill: "exarchos:delegate", tools: ["exarchos_workflow.set", "exarchos_event.append", "/exarchos:delegate"], events: ["task.assigned", "task.completed", "merge.executed"], transition: "all tasks completed + merge orchestrator terminal" }`. Mirror for ideate / plan / synthesize / shepherd / cleanup phases. |
| Handler | `servers/exarchos-mcp/src/workflow/rehydrate.ts` (`handleRehydrate`) | Before returning, if `document.behavioralGuidance` is the empty default, replace it with the phase default. Document the precedence: explicit guidance events > phase default > empty (only when phase is unknown). |
| Command | `commands/rehydrate.md` Output Format | Replace the silent-on-empty template with a "House Rules" block that always renders the phase contract and the `_eventHints.missing` payload as **mandatory** lines. Keep workflow-specific guidance below it for additive overrides. |
| Test | `src/commands-rehydrate-validation.test.ts` (or `servers/exarchos-mcp/src/workflow/rehydrate.test.ts`) | Regression: render output for a delegate-phase workflow with empty `behavioralGuidance` MUST contain the strings "House Rules", "Required events", and the verbatim text from `_eventHints.missing[].description`. |

### Sketch — `commands/rehydrate.md` Output Format

```markdown
## Workflow Rehydrated: <featureId>
**Phase:** <phase> | **Type:** <workflowType>

### House Rules (apply to every action this turn forward)
**Phase contract:** <phase-contract>
**Required events for this phase:** <_eventHints.missing rendered as bullets>
**Phase-default tools:** <tool list>
**Transition guard:** <criteria> | Pre-req: <prerequisites>

### Workflow-Specific Guidance
**Skill:** <skillRef or "(none — house rules apply)">
<compactGuidance or "(no overrides)">

### Task Progress
<task table>

### Artifacts
- Design: <path or "not created">
- Plan: <path or "not created">
- PR: <url or "not created">

### Next Action
<suggested action>

> **Discipline reminder:** every task transition this turn forward MUST land on the workflow event stream via `exarchos_event.append` or via `/exarchos:delegate` subagent emission. Direct `Edit` / `Bash` / `git` actions on task branches without corresponding events will desync the workflow tracker from reality (see RCA `docs/rca/2026-05-08-rehydrate-behavioral-gap.md` for what that looks like).
```

### Risks

- **House-rules verbosity** — adds ~20 lines to every rehydration render. Acceptable: the cost of a desync (this RCA's incident) is far higher than 20 lines per `/clear`.
- **False precision** — phase-default guidance may name tools or events that the workflow's specific config doesn't use. Mitigated by phrasing the House Rules as the *baseline* and letting workflow-specific guidance *override* below.
- **Backwards compat** — agents that already rely on the empty-section behavior do not exist (the empty sections were unintended).

## Prevention

### Immediate Actions

- [ ] File a tracking issue in the exarchos repo for the three-layer fix above. Link this RCA.
- [ ] Add a regression test in `commands-rehydrate-validation.test.ts` (or sibling): "render output for a delegate-phase workflow with empty `behavioralGuidance` MUST contain the strings 'House Rules', 'Required events', and the verbatim text from `_eventHints.missing[].description`."
- [ ] Add a runtime invariant test in the rehydration handler: post-handler, the returned `behavioralGuidance` is never the empty default for a known phase.

### Long-term Improvements

- [ ] Consider a `session.started` or `agent.action` event the harness can emit on first tool call after rehydrate, to make "the workflow is alive" observable on the stream rather than inferred from `task.*` arrivals. Would also let exarchos detect "rehydrated but never used the workflow tools" as a post-hoc telemetry signal.
- [ ] Audit other slash commands (`/exarchos:ideate`, `/exarchos:checkpoint`, etc.) for the same empty-field-silent-render pattern.
- [ ] When `behavioralGuidance` is populated but `_eventHints.missing` is non-empty, surface both — they are not redundant, the hint is event-level, the guidance is process-level.

## Timeline

| Event | Date / Time | Notes |
|---|---|---|
| Workflow initialized | 2026-05-08 11:48 PT | `exarchos_workflow.init` for `per-rep-drill-modifiers` |
| T-01 / T-02 / T-03a delegated and merged | 2026-05-08 16:34 → 17:20 PT | Clean events on stream, normal flow |
| `/clear` + `/exarchos:rehydrate` | 2026-05-08 ~17:23 PT | Handoff event recorded at sequence 71 with `eventRef.timestamp = 2026-05-09T00:23:58Z` |
| Manual T-04 RED commit | 2026-05-08 17:36 PT | First post-rehydrate work — direct `git commit`, no event |
| Manual T-04..T-15 implementation + merges | 2026-05-08 17:36 → 19:58 PT | 11 tasks, 33+ TDD commits, 12 first-parent merges into integration branch — all by `reedsalus@gmail.com`, zero workflow events |
| PR #165 opened with all CI green | 2026-05-08 (during the manual run) | Mergeable, zero reviews |
| Divergence observed | 2026-05-08 (this session) | Post-`/clear` rehydrate produced same stale brief; investigation matched git ground truth against empty event stream |

## Related

- Originating incident: workflow `per-rep-drill-modifiers` in https://github.com/lvlup-sw/ares-elite-platform (MEMORY.md `active_per_rep_modifiers.md` in that repo)
- Integration PR (consumer side): https://github.com/lvlup-sw/ares-elite-platform/pull/165
- Slash command source (this repo): `commands/rehydrate.md`
- Handler source (this repo): `servers/exarchos-mcp/src/workflow/rehydrate.ts`
- Sibling skill issue: the same empty-section pattern likely affects `/exarchos:checkpoint` and `/exarchos:reload` — not investigated in this RCA.
