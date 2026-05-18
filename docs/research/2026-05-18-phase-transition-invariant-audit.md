# Phase-transition invariant audit (#1370)

> Audited: 18 commands in `commands/*.md`
> Audited against: `docs/architecture/invariants.md` (post-PR #1455, audited catalog)
> Date: 2026-05-18
> Methodology: walk each command's phase transitions, check INV-1..INV-6 + INV-5a/b/c/d (skip DIM-* unless cross-link warranted)
> Bundle: #1441 preview-4 invariant-audit pair (PR-2)

## Summary

- Total commands audited: 18
- Total findings: 31
- By severity: HIGH: 6 | MEDIUM: 13 | LOW: 12
- By invariant: INV-1: 7 | INV-2: 0 | INV-4: 4 | INV-5a: 2 | INV-5b: 8 | INV-5c: 1 | INV-5d: 7 | INV-6: 2
- Recommended absorption split:
  - Surgical-in-PR-2 (per-finding TDD fix): 2
  - File-as-follow-up (defer to v2.11.0 or new issue): 4 HIGH + 13 MEDIUM + 12 LOW = 29

The audit surfaces one systemic pattern that dominates the HIGH/MEDIUM tier: every workflow command that changes `state.phase` does so by instructing the model to call `exarchos_workflow action: "update"` with `updates: { phase: "<next>" }`. The registry (`servers/exarchos-mcp/src/registry.ts:339`) explicitly documents `update` as "non-phase mutation only" and `tools.update.test.ts:49 (WorkflowUpdate_RejectsUpdatesContainingPhaseField)` enforces that the runtime **rejects** `updates.phase` with `INVALID_INPUT`. The canonical surface is `action: "transition"`, which emits `workflow.transition` and runs the HSM guard. Command prose has not been migrated to the canonical surface, so every documented phase mutation either (a) errors at runtime (the model auto-corrects via `suggestedFix`) or (b) survives because the model silently dropped the `phase` field. Either way, no `workflow.transition` event is emitted — INV-1 (event-sourcing integrity), INV-5b (output contract / `suggestedFix` ergonomics), and INV-5d (action discriminator hygiene — using `update` for a `transition` job) all surface from the same root cause. This is one root-fix, eight findings.

The second systemic pattern: every phase-chaining command picks the next step by literal `Skill({ skill: "exarchos:<next>" })` invocation rather than by consuming `next_actions` from the prior tool result. INV-5b says successful `ToolResult` carries machine-actionable affordance hints — the commands don't read them. Pairing: also an INV-4 leak because `Skill({...})` is Claude-Code-specific syntax that should be tokenized through `{{CHAIN}}` (per INV-4 reference's worked example).

### Findings table (sorted by command, then severity)

| Command | Transition | Invariant | Severity | File:line | Description | Required fix | Surgical? |
|---|---|---|---|---|---|---|---|
| autocompact.md | none (settings.json edit) | INV-1 | LOW | autocompact.md:20-30 | Settings mutation is side-channel; no exarchos event emitted. Acceptable because not a workflow command, but worth noting it never appears on the event log. | Optional `session.config_changed` event for audit trail. | no |
| checkpoint.md | none (state read/write) | INV-1 | LOW | checkpoint.md:31-43 | Step 2 says "Update state file with latest progress" without binding to a specific action (`update`, `transition`, or event). Prose-level guidance only. | Replace "Update state file" with explicit `exarchos_event.append({type: 'checkpoint.saved', ...})`. | yes |
| checkpoint.md | none | INV-5b | LOW | checkpoint.md:46-79 | Output section is a Markdown template rendered from `phasePlaybook` fields, but never names where the template is fed from — no `exarchos_workflow.describe({playbook: ...})` call shown. | Add explicit call: `exarchos_workflow describe playbook=<type>` before rendering template. | yes |
| cleanup.md | (any phase) → completed | INV-1 | LOW | cleanup.md:54-65 | `action: "cleanup"` properly emits a workflow event (verified via registry). No finding on the action itself. The bash worktree-remove step (lines 67-73) is side-channel, but worktree state is not on the event log by design. | None — informational. | n/a |
| cleanup.md | n/a | INV-5b | LOW | cleanup.md:84-95 | Output Markdown doesn't reference the `next_actions` field returned by `cleanup`. | Render `next_actions` from result envelope in the "Cleanup Complete" block. | no |
| debug.md | init → triage → investigate → fix | INV-1 | MEDIUM | debug.md:68-74 | Init action emits `workflow.init`. The subsequent "update track" call uses `action: "update"` (line 72) to set `track: "hotfix" \| "thorough"` — that's non-phase so it's correct. But the prose at lines 76-101 describes the triage → investigate → fix progression without naming the canonical `transition` action for moving through debug-track phases. Implicit phase moves do not emit `workflow.transition` events. | Add explicit `exarchos_workflow action: "transition" target: "<phase>"` at each track-internal phase boundary. | no |
| debug.md | n/a | INV-5d | LOW | debug.md:67-73 | Phase progression model is described in prose, not as composite-tool action calls; reader has to infer when to emit which event. | Add the runbook table per `exarchos_orchestrate describe(runbook='debug')`. | no |
| delegate.md | delegate → review or delegate → synthesize | INV-1 | **HIGH** | delegate.md:50-55 | Auto-chain dispatches `/exarchos:review` or `/exarchos:synthesize` without emitting `task.assigned` per dispatch. Per [memory: feedback_orchestrator_task_assigned_emission], without `task.assigned` the rehydration projection's `taskProgress` is silently empty (also tracked by #1179 / #1180). The skill body shows NO task event emission discipline anywhere — zero matches for `task.assigned` in the file. | Per dispatch: emit `exarchos_event action: "append" stream: "<feature>" event: { type: "task.assigned", data: { taskId, assignedTo, branch } }` *before* the Task call. Add this to delegate.md as a numbered step preceding the auto-chain block. | yes |
| delegate.md | delegate → review/synthesize | INV-5d | **HIGH** | delegate.md:53-54 | Auto-chain prose says "Set phase to 'review'/'synthesize'" but provides no action to execute that set. The implicit interpretation is `update`, which the runtime rejects (`tools.update.test.ts:49`). Phase set should be via `transition`. | Replace "Set phase to 'review'" with explicit `exarchos_workflow action: "transition" target: "review"` call. Same for "synthesize" branch. | yes |
| delegate.md | delegate → review/synthesize | INV-4 | MEDIUM | delegate.md:53-54 | Literal `Skill({ skill: "exarchos:review", args: "..." })` inside skill source. Per INV-4 reference worked example, this is the HIGH-severity exemplar — but `commands/` ships only to Claude Code today, so practical impact is MEDIUM. Once `commands/` is tokenized through `{{CHAIN}}`, this needs `{{CHAIN next="review" args="$STATE_FILE"}}`. | Tokenize via `{{CHAIN}}` once the commands directory joins the per-runtime render pipeline. Today: file as v2.11+ follow-up. | no |
| delegate.md | delegate → review/synthesize | INV-5b | MEDIUM | delegate.md:50-55 | Auto-chain picks the next skill by literal `Skill({...})` invocation rather than by reading `next_actions` from the orchestrate result. Successful `ToolResult` already carries `next_actions` per INV-5b; commands don't consume them. | Replace "invoke `Skill({...})`" with "consume `next_actions[0]` from the orchestrate result and invoke the named skill via the runtime's chain primitive." | no |
| discover.md | none (single-line redirect to skill) | INV-5a | LOW | discover.md:5 | The command is a one-liner that delegates to `@skills/discovery/SKILL.md`. INV-5a wants tool descriptions to state "do NOT use for" guidance — `discover.md` has no scoping prose at all. | Add a short "Use when / Do NOT use when" block before the skill redirect. | no |
| dogfood.md | n/a (read-only triage) | INV-5b | LOW | dogfood.md:14-22 | Quick Start lists describe calls (`exarchos_workflow describe(topology, playbook)`, `exarchos_orchestrate describe(actions) + runbook(phase)`) but the output format (step 7 "Present the report") never references `next_actions` from these envelopes. | Add a "Suggested next actions" section sourced from the merged `next_actions` arrays. | no |
| dogfood.md | n/a | INV-6 | LOW | dogfood.md:1-32 | Skill body uses workflow-typed literals (`workflow`, `playbook`, `runbook`, phase names). Triggers are workflow-neutral but the body assumes a workflow exists. `metadata.workflow-type:` not declared in frontmatter. Per INV-6 §4 the file is a command (`commands/dogfood.md`), not a SKILL.md — so the formal lint doesn't fire, but the spirit ("workflow vocabulary in prose without scoping") applies. | Either declare `workflow-type: any` (or list the supported types) or rephrase as "for the workflow under analysis". Borderline — likely LOW dismiss. | no |
| ideate.md | (no phase) → ideate → plan | INV-1 | **HIGH** | ideate.md:63-77 | `action: "update"` is called twice (lines 63, 75) with `updates: { phase: "plan" }`. Runtime rejects this with `INVALID_INPUT` per `servers/exarchos-mcp/src/workflow/tools.update.test.ts:49` and `servers/exarchos-mcp/src/registry.ts:339` ("non-phase mutation only"). No `workflow.transition` event ever emitted for the ideate → plan boundary. | Split the call: first `action: "update" updates: { artifacts: { design: "..." } }`; then a separate `action: "transition" target: "plan"`. Update both instances. | yes |
| ideate.md | ideate → plan | INV-5d | MEDIUM | ideate.md:75 | Wrong action discriminator selected for the work being done. Same as INV-1 finding above; INV-5d framing is "use the right composite-tool action for the job". | Use `transition`, not `update`, for the phase change. (Same fix as above.) | yes |
| ideate.md | ideate → plan auto-chain | INV-4 | MEDIUM | ideate.md:83 | Literal `Skill({ skill: "exarchos:plan", args: "$DESIGN_PATH" })` in source. INV-4 worked example HIGH-severity pattern. Same Claude-Code-only practical impact note as delegate.md:53. | Tokenize via `{{CHAIN}}` post-runtime-portability work. | no |
| ideate.md | ideate → plan auto-chain | INV-5b | MEDIUM | ideate.md:73-84 | Auto-chain block ignores `next_actions` from the prior `update` result; hardcodes the next skill. | Consume `next_actions` from the workflow envelope instead of hardcoding `exarchos:plan`. | no |
| oneshot.md | implementing → completed or synthesize | INV-1 | MEDIUM | oneshot.md:68-73 | `action: "update"` at line 73 sets `phase: "implementing"` — runtime rejects per `tools.update.test.ts:49`. The intent is to transition from `plan` (default after `init`) to `implementing`. | Replace with `action: "transition" target: "implementing"` after `update artifacts.plan ...`. | yes |
| oneshot.md | implementing → finalize | INV-5d | LOW | oneshot.md:105-113 | `finalize_oneshot` is a custom orchestrate action that internally decides the next phase. The schema-discriminator pattern is honored. No INV-5d finding on the call itself. The annotated outcome table (lines 116-122) is good agent ergonomics. | None. | n/a |
| oneshot.md | implementing → completed/synthesize | INV-5b | LOW | oneshot.md:124-141 | Direct-commit and synthesize paths don't show consumption of `next_actions` from `finalize_oneshot`'s envelope. | Render `next_actions` to the user before manual `git push` or PR creation step. | no |
| plan.md | plan → plan-review → delegate | INV-1 | **HIGH** | plan.md:74-95 | Two `update` calls with `updates: { phase: "..." }` (lines 77, 94, 143). Same systemic bug — runtime rejects, no `workflow.transition` event emitted. The plan-review auto-loop (lines 102-148) compounds the issue because plan-review re-enters the same broken pattern each iteration. | Each phase set becomes a separate `transition` call; keep the `update` for `artifacts.plan` and `planReview.gaps` only. Update all three instances. | yes |
| plan.md | plan-review auto-loop | INV-5b | LOW | plan.md:102-129 | Auto-loop branch decision uses local boolean (`gapsFound`); doesn't surface `next_actions` from a structured plan-review action. There is no `plan_review` orchestrate action in the registry — the decision happens in command prose. | (Architectural — file as separate issue.) Add `exarchos_orchestrate action: "plan_review"` with a structured envelope that surfaces `gapsFound` + `next_actions`. | no |
| plan.md | plan → plan-review auto-chain | INV-4 | LOW | plan.md:126, 147 | Literal `Skill({...})` calls (same INV-4 systemic pattern as ideate.md:83 and delegate.md:53). | Tokenize. | no |
| prune.md | n/a (no phase transition) | INV-5d | LOW | prune.md:25-60 | `prune_stale_workflows` is a single orchestrate action with `dryRun` + `force` parameters; good action-discriminator hygiene. The interactive prompt for proceed/abort/force is a CLI affordance, not a workflow event. | None. | n/a |
| prune.md | n/a | INV-1 | LOW | prune.md:78-84 | The post-prune output mentions "workflow.pruned event payload for audit" — good event-sourcing alignment. No finding. | None. | n/a |
| refactor.md | (init) → explore → brief → ... | INV-1 | MEDIUM | refactor.md:65-67 | `action: "init"` is correctly used. But the multi-phase track machinery (polish vs overhaul, lines 116-131) describes auto-chaining through phases ("brief → polish-implement → polish-validate ...") without naming `transition` calls. Same gap as debug.md but more pronounced because refactor has more internal phases. | Per phase boundary in the track, document the explicit `transition` call. | no |
| refactor.md | refactor → overhaul-synthesize | INV-5d | LOW | refactor.md:91-94 | Overhaul track references `/exarchos:plan`, `/exarchos:delegate`, `/exarchos:review`, `/exarchos:synthesize` by command name — but these are command names, not orchestrate actions. The implicit action discriminator (composite-tool action) is left to the model to infer. | Add a runbook section: `exarchos_orchestrate describe(runbook='refactor')` reference. | no |
| rehydrate.md | n/a (read-only) | INV-5b | LOW | rehydrate.md:15-26 | `rehydrate` envelope is *correctly* designed to expose `next_actions` (line 65) — this is the ONE command that honors INV-5b for next-action consumption. Worth flagging as the positive exemplar. | None. (Positive exemplar — cite from delegate.md/ideate.md fix.) | n/a |
| review.md | review → synthesize OR review → delegate (fix loop) OR review → ideate (blocked) | INV-1 | **HIGH** | review.md:102-108 | Auto-chain at lines 104-106 sets `.phase` directly ("Update state `.phase = 'synthesize'`") with no composite-tool action specified. Implicit `update {phase}` is the only readable interpretation — runtime rejects per `tools.update.test.ts:49`. Even the BLOCKED branch (line 106) sets `.phase = "blocked"` without a corresponding event. | Three explicit `transition` calls, one per branch (PASS / FAIL / BLOCKED). | yes |
| review.md | review → ... | INV-5b | MEDIUM | review.md:51-62 | `check_review_verdict` is called with `pluginFindings` — good. But the auto-chain decision at lines 102-106 doesn't reference `next_actions` from the verdict envelope; it hardcodes the next skill. | Render `next_actions[0]` to pick the next chain rather than `Skill({...})` literal. | no |
| review.md | review → synthesize/delegate/ideate auto-chain | INV-4 | LOW | review.md:78-79, 104-106 | Five literal `Skill({...})` invocations including the cross-plugin ones (`axiom:audit`, `impeccable:critique`). The cross-plugin calls cannot be tokenized (the plugin set varies per runtime) so a guard is more honest than a token. | Wrap cross-plugin calls in `<!-- requires:plugin:axiom -->` / `<!-- requires:plugin:impeccable -->` guards. Tokenize the exarchos-internal `Skill({...})` calls via `{{CHAIN}}`. | no |
| shepherd.md | synthesize internal iteration | INV-1 | MEDIUM | shepherd.md:42-78 | `assess_stack` returns recommendations; the iteration emits no workflow events for the assess → fix → resubmit cycle. Cycle progress lives in `shepherd.currentIteration` (line 110) which is updated via `update` (correct for non-phase fields). Cycle boundaries aren't on the event log. | Optional `shepherd.iteration_started` / `shepherd.iteration_completed` events per loop. | no |
| shepherd.md | request approval | INV-5b | MEDIUM | shepherd.md:78-91 | `update` adds `shepherd.approvalRequested: true` and the auto-chain at lines 133-138 pauses for user input. The "Request Approval" output (lines 114-125) shows PR URL but doesn't surface `next_actions` from the assess_stack envelope. | Render `next_actions` per assess_stack recommendation. | no |
| shepherd.md | n/a | INV-5c | LOW | shepherd.md:38-45 | `code_quality` view is queried in Step 0 — good Aspire-style "query state before mutating" pattern. Positive exemplar. | None. | n/a |
| synthesize.md | synthesize → completed | INV-1 | **HIGH** | synthesize.md:80, 88, 108 | Three references to setting `phase: "completed"` via `update`. Runtime rejects per `tools.update.test.ts:49`. The post-merge phase change to `completed` happens in `cleanup.md` via `action: "cleanup"` — so this branch may simply be obsolete prose. | Either remove the "Update state `.phase = 'completed'`" instructions (since `cleanup` handles it) OR replace with `action: "transition" target: "completed"` if cleanup is optional. | yes |
| synthesize.md | synthesize → delegate (--pr-fixes loop) | INV-4 | LOW | synthesize.md:113 | Literal `Skill({ skill: "exarchos:delegate", args: "--pr-fixes ..." })`. Same INV-4 systemic pattern. | Tokenize. | no |
| synthesize.md | synthesize → completed | INV-5b | LOW | synthesize.md:60-65 | Synthesis Complete output template doesn't include `next_actions` from any composite-tool envelope; user is told "Tests: X pass" but not "Suggested: /exarchos:cleanup". | Surface `next_actions` from the most recent `exarchos_workflow` call (e.g., from PR-creation orchestrate result). | no |
| tag.md | n/a (event-only) | INV-1 | LOW | tag.md:22-38 | `exarchos_event action: "append"` — clean event-sourcing pattern. Stream is `"tags"` (separate from feature streams), correlationId is the user-provided tag. Positive exemplar of event-first discipline. | None. | n/a |
| tag.md | n/a | INV-5d | LOW | tag.md:22-38 | Composite tool used correctly (`exarchos_event` with `action: "append"`). | None. | n/a |
| tag.md | n/a | INV-6 | LOW | tag.md:1-54 | Body avoids workflow-typed literals; tag is intentionally workflow-agnostic ("annotates a session without creating workflow state", line 50). No `workflow-type:` declaration needed. Positive exemplar. | None. | n/a |
| tdd.md | none (planning template) | INV-5a | LOW | tdd.md:1-58 | TDD is a planning command, not a workflow action. No composite-tool invocation. No phase transition. The "Plan Format" is a Markdown template, not a tool surface. | None. | n/a |

## Per-command walk

### `commands/autocompact.md`
- **Transitions performed**: none — settings.json mutation only (Claude Code env var management). Side-channel by design.
- **INV-1 check**: No event emitted on settings change. LOW (side-channel; not a workflow action).
- **INV-2 check**: N/A — no composite-tool dispatch.
- **INV-4 check**: HIGH-degree Claude-Code-only by design (manages `~/.claude/settings.json`). This is the canonical case where `commands/autocompact.md` *should* be Claude Code-only (no portable equivalent across Codex/Copilot/etc.). The file ships only to Claude Code; no `{{TOKEN}}` needed. No finding.
- **INV-5a check**: Input shape is `status | on | off | <number>` — simple stringly-typed dispatch, no schema validation visible. LOW (the file isn't an MCP tool; it's a slash-command).
- **INV-5b check**: Output format is human-readable text, not an envelope. Not a `ToolResult` consumer. No finding.
- **INV-5c check**: Verbs are `status` / `on` / `off` — observation + mutation, reasonable.
- **INV-5d check**: Not a composite-tool dispatch; no action discriminator applies.
- **INV-6 check**: No workflow-typed literals; pure environment-config command. No finding.
- **Findings filed**: 1 LOW (INV-1: optional `session.config_changed` event for audit trail).

### `commands/checkpoint.md`
- **Transitions performed**: No phase transition. State read/write only. Suggests `/exarchos:rehydrate` as the resume path.
- **INV-1 check**: Step 2 ("Ensure State is Current") tells the model to update state without specifying which action. Prose says "Update state file" — could be interpreted as `update`, `transition`, or `event.append`. LOW finding (checkpoint.md:31-43).
- **INV-2 check**: N/A — no dispatch.
- **INV-4 check**: Output template renders `phasePlaybook` and `_eventHints` fields (lines 56-66) from a tool result not explicitly named in the file. Acceptable — the template is correct shape for any runtime that supports the same envelope.
- **INV-5a check**: Schema-validated inputs not required (no MCP action call). No finding.
- **INV-5b check**: The template names `next_actions` only implicitly via the `_eventHints.missing` rendering — doesn't show a `next_actions` block separately. LOW finding (checkpoint.md:46-79).
- **INV-5c check**: `exarchos_view pipeline` is a query verb, Aspire-aligned.
- **INV-5d check**: Composite tools used (`exarchos_view pipeline` at line 28) but no action discriminator naming because pipeline is a top-level action name on `exarchos_view`. OK.
- **INV-6 check**: References workflow vocabulary throughout (phase, task transition, event stream). The file is a command (commands/checkpoint.md), and INV-6 §1 scopes to SKILL.md files — formal exemption applies. LOW dismiss.
- **Findings filed**: 2 LOW (INV-1, INV-5b).

### `commands/cleanup.md`
- **Transitions performed**: (any non-terminal phase) → `completed` via `action: "cleanup"`.
- **INV-1 check**: `action: "cleanup"` is registered (`registry.ts`) and emits a workflow event (per design). The bash worktree-remove + branch-prune steps (lines 67-81) are side-channel, but worktree state is intentionally not on the event log. OK.
- **INV-2 check**: `cleanup` action exists in both CLI and MCP facades per registry. Assumed parity-tested (verify in `servers/exarchos-mcp/src/workflow/parity.test.ts` separately).
- **INV-4 check**: Uses `gh pr view` and `git worktree` — these are bash invocations from the command. Reasonable Claude Code-only assumption; the cleanup verbs are also available in other runtimes via their shell-execution surfaces. OK.
- **INV-5a check**: Schema-validated `cleanup` inputs (`mergeVerified: true`, `prUrl`, `mergedBranches`). Good.
- **INV-5b check**: Output template at lines 84-94 doesn't surface `next_actions`. LOW finding.
- **INV-5c check**: `cleanup` is a mutating verb; should default to `--dry-run`. The action's CLI flag set isn't shown in this file — that's a registry-level concern, not a command-level one.
- **INV-5d check**: Composite-tool action discriminator used correctly (`action: "cleanup"`).
- **INV-6 check**: References "workflow", "PR", "merge" — workflow-typed but the cleanup command is intentionally workflow-aware. No finding.
- **Findings filed**: 1 LOW (INV-5b).

### `commands/debug.md`
- **Transitions performed**: init → triage → investigate → fix → validate → completed (hotfix track); init → triage → investigate → rca → design → implement → review → synthesize → completed (thorough track).
- **INV-1 check**: `action: "init"` correctly used (line 68). The "update track" call (line 72) sets `track` field — non-phase mutation, `update` is correct. But the multi-phase progression described in prose at lines 86-101 names no transition calls. MEDIUM finding (debug.md:68-74) — implicit phase moves don't emit `workflow.transition`.
- **INV-2 check**: No new verbs introduced.
- **INV-4 check**: Body is Claude Code command-shaped (no `Skill({...})` literals); the `track` parameter is portable.
- **INV-5a check**: `featureId` pattern `debug-<issue-slug>` is documented (line 69) — good prose-level hint, but not enforced by schema (registry.ts featureIdSchema is generic). LOW dismiss.
- **INV-5b check**: No `ToolResult` consumption shown; auto-chain table at lines 122-130 is descriptive.
- **INV-5c check**: Verbs `--hotfix` / `--escalate` / `--switch-thorough` are mode flags, not Aspire-style; OK because they map to internal track state.
- **INV-5d check**: Phase progression is in prose, not in composite-tool action calls. LOW finding (debug.md:67-73) — should reference `exarchos_orchestrate describe(runbook='debug')`.
- **INV-6 check**: `workflowType: "debug"` declared in init call — `metadata.workflow-type` analog. Acceptable.
- **Findings filed**: 1 MEDIUM (INV-1), 1 LOW (INV-5d).

### `commands/delegate.md`
- **Transitions performed**: delegate → review (auto, normal/--fixes) OR delegate → synthesize (auto, --pr-fixes). Per-task: dispatch task subagent → task.completed → next task.
- **INV-1 check**: **HIGH finding.** Zero mentions of `task.assigned` in the file (verified by `grep -c "task" commands/delegate.md` returning only `10` total `task` matches, none of which are `task.assigned`). Per [memory: feedback_orchestrator_task_assigned_emission], absence of `task.assigned` per dispatch silently empties rehydration's `taskProgress` (tracked by #1179 / #1180). Same root cause as #1442 acceptance friction.
- **INV-2 check**: Auto-chain dispatches `Skill({...})` directly — CLI facade has no equivalent of `Skill({...})` (CLI uses subcommand chain or shell exec). Parity could break if the CLI facade is asked to interpret this. Cross-reference test gap.
- **INV-4 check**: MEDIUM finding (delegate.md:53-54) — literal `Skill({...})` is Claude-Code-syntax, should be `{{CHAIN}}` per INV-4 reference worked example.
- **INV-5a check**: Mode flags (`--fixes`, `--pr-fixes`) documented in table — good.
- **INV-5b check**: MEDIUM finding (delegate.md:50-55) — auto-chain hardcodes next skill instead of consuming `next_actions`.
- **INV-5c check**: `delegate` is the canonical Aspire-style verb (per [memory: project_basileus_mcp_posture] notes on verb reservation). OK.
- **INV-5d check**: **HIGH finding.** "Set phase to 'review'/'synthesize'" prose has no composite-tool action — the only readable interpretation is `update`, which the runtime rejects.
- **INV-6 check**: Body references workflow verbs (`/exarchos:review`, `/exarchos:synthesize`) and "task branches" — the file is a Claude Code command, not a SKILL.md; INV-6 §1 exempts.
- **Findings filed**: 2 HIGH (INV-1 task.assigned, INV-5d phase set), 2 MEDIUM (INV-4 literal Skill, INV-5b next_actions).

### `commands/discover.md`
- **Transitions performed**: None visible — single-line redirect to `@skills/discovery/SKILL.md`.
- **INV-1..INV-5d checks**: All N/A — command body delegates to a skill. Audit of the skill itself is out of scope.
- **INV-5a check**: LOW finding (discover.md:5) — no "do NOT use for" guidance at the command level.
- **INV-6 check**: N/A.
- **Findings filed**: 1 LOW (INV-5a).

### `commands/dogfood.md`
- **Transitions performed**: None — read-only diagnostic.
- **INV-1 check**: Quick Start lists `exarchos_view`, `exarchos_workflow describe`, `exarchos_event query`, `exarchos_orchestrate describe + runbook` — read-only ops, no event emission required. OK.
- **INV-2 check**: All calls are top-level composite-tool actions; CLI/MCP facade parity assumed.
- **INV-4 check**: Body is runtime-neutral apart from being a Claude Code slash-command; no `Skill({...})` calls. OK.
- **INV-5a check**: Inputs are workflow names or tool names — schema is the composite-tool schema.
- **INV-5b check**: LOW finding (dogfood.md:14-22) — output doesn't reference `next_actions` from describe/runbook envelopes.
- **INV-5c check**: All verbs used are observation verbs (`describe`, `query`, `view`, `runbook`). Excellent Aspire alignment.
- **INV-5d check**: Composite tools used with action names (`exarchos_workflow describe(topology, playbook)`, `exarchos_orchestrate describe(actions) + runbook(phase)`). Good.
- **INV-6 check**: LOW finding (dogfood.md:1-32) — workflow-vocabulary in body without `workflow-type:` declaration, but file is a command not a SKILL.md (formal exemption). Borderline.
- **Findings filed**: 1 LOW (INV-5b), 1 LOW (INV-6).

### `commands/ideate.md`
- **Transitions performed**: (no state) → ideate (init), ideate → plan (update + Skill chain).
- **INV-1 check**: **HIGH finding** (ideate.md:63-77) — two `update` calls with `phase: "plan"`. Runtime rejects per `tools.update.test.ts:49`. No `workflow.transition` event emitted; INV-1 fold integrity for the ideate→plan boundary is broken.
- **INV-2 check**: `init` and `update` are registered actions; parity-tested separately.
- **INV-4 check**: MEDIUM finding (ideate.md:83) — literal `Skill({...})`.
- **INV-5a check**: `init` schema-validated (`featureId`, `workflowType: "feature"`). Good.
- **INV-5b check**: MEDIUM finding (ideate.md:73-84) — auto-chain ignores `next_actions`.
- **INV-5c check**: No new verbs.
- **INV-5d check**: MEDIUM finding (ideate.md:75) — wrong action discriminator (`update` for what should be `transition`).
- **INV-6 check**: References `featureId` literal, but the file is a command not a SKILL.md (formal exemption).
- **Findings filed**: 1 HIGH (INV-1/INV-5d phase update — counted once under INV-1), 1 MEDIUM (INV-5d separately framed), 1 MEDIUM (INV-4), 1 MEDIUM (INV-5b).

### `commands/oneshot.md`
- **Transitions performed**: (no state) → plan (init), plan → implementing (update with phase), implementing → completed OR synthesize (finalize_oneshot).
- **INV-1 check**: MEDIUM finding (oneshot.md:68-73) — `update` with `phase: "implementing"` rejected by runtime. Same systemic bug.
- **INV-2 check**: No new verbs; `request_synthesize` and `finalize_oneshot` are registered orchestrate actions with output schemas.
- **INV-4 check**: No literal `Skill({...})` in this file. Good.
- **INV-5a check**: `synthesisPolicy: "always" | "never" | "on-request"` is a constrained enum — INV-5a aligned.
- **INV-5b check**: LOW finding (oneshot.md:124-141) — direct-commit / synthesize paths don't render `next_actions` from finalize result.
- **INV-5c check**: `finalize_oneshot` is a state-transition verb that internally decides target. Good Aspire alignment (declarative end-state, not imperative scripting).
- **INV-5d check**: LOW positive (oneshot.md:105-113) — `finalize_oneshot` correctly uses action discriminator on `exarchos_orchestrate`.
- **INV-6 check**: `workflowType: "oneshot"` declared at init. OK.
- **Findings filed**: 1 MEDIUM (INV-1), 1 LOW (INV-5b), 1 LOW positive (INV-5d — informational only).

### `commands/plan.md`
- **Transitions performed**: (incoming from ideate) → plan, plan → plan-review (update with phase), plan-review → delegate (update with phase) OR plan-review → plan --revise (auto-loop).
- **INV-1 check**: **HIGH finding** (plan.md:74-95) — three `update` calls with `phase: "..."` (lines 77, 94, 143). Same systemic bug. Compounded by auto-loop re-entering the broken pattern per iteration.
- **INV-2 check**: `update` action exists; parity OK.
- **INV-4 check**: LOW finding (plan.md:126, 147) — two `Skill({...})` literals.
- **INV-5a check**: `--revise` flag is a single string convention; not schema-validated. LOW dismiss.
- **INV-5b check**: LOW finding (plan.md:102-129) — auto-loop branches on local boolean rather than envelope `next_actions`; reflects absence of a `plan_review` orchestrate action.
- **INV-5c check**: No new verbs.
- **INV-5d check**: Same systemic bug as INV-1 (wrong action for phase change). Already counted.
- **INV-6 check**: `phase: "plan-review"`, `phase: "delegate"` — feature-workflow-typed, but the file is a Claude Code command.
- **Findings filed**: 1 HIGH (INV-1 phase update), 1 LOW (INV-4), 1 LOW (INV-5b).

### `commands/prune.md`
- **Transitions performed**: None — prune is a maintenance action that transitions targeted workflows to `cancelled`.
- **INV-1 check**: LOW positive (prune.md:78-84) — explicitly mentions `workflow.pruned` event for audit. Event-sourcing-aligned.
- **INV-2 check**: `prune_stale_workflows` is a registered orchestrate action; parity assumed.
- **INV-4 check**: No `Skill({...})` literals.
- **INV-5a check**: `dryRun: true | false`, `force: true | false` — schema-validated booleans. Good.
- **INV-5b check**: Output template (lines 70-76) is decent but doesn't surface `next_actions` from the orchestrate envelope. LOW dismiss.
- **INV-5c check**: Excellent Aspire alignment — dry-run-by-default mutating verb (line 24: "Invoke the orchestrate action in dry-run mode (default)").
- **INV-5d check**: LOW positive (prune.md:25-60) — composite-tool action with clean discriminator + parameter set.
- **INV-6 check**: Operates across all workflow types; no leak.
- **Findings filed**: 0 (all positive or dismissed).

### `commands/refactor.md`
- **Transitions performed**: explore → brief → polish-implement → polish-validate → polish-update-docs → completed (polish); explore → brief → overhaul-plan → overhaul-delegate → overhaul-review → overhaul-update-docs → synthesize → completed (overhaul).
- **INV-1 check**: MEDIUM finding (refactor.md:65-67) — `init` action used correctly, but the multi-phase track progression (lines 116-131) describes auto-chaining without naming `transition` calls. More phases than debug.md → more silent-transition exposure.
- **INV-2 check**: `init` registered; track field is non-phase update.
- **INV-4 check**: No literal `Skill({...})`.
- **INV-5a check**: `--polish`, `--explore`, `--switch-overhaul` documented; not schema-validated at the slash-command level.
- **INV-5b check**: No envelope consumption shown.
- **INV-5c check**: `--polish` / `--explore` are mode-style, similar to debug.
- **INV-5d check**: LOW finding (refactor.md:91-94) — overhaul track references commands by `/exarchos:*` name rather than orchestrate actions. Should cite `runbook='refactor'`.
- **INV-6 check**: `workflowType: "refactor"` at init — good.
- **Findings filed**: 1 MEDIUM (INV-1), 1 LOW (INV-5d).

### `commands/rehydrate.md`
- **Transitions performed**: None — read-only state restoration.
- **INV-1 check**: `exarchos_workflow action: "rehydrate"` is a read action; no events emitted. Correct.
- **INV-2 check**: `rehydrate` registered for both facades.
- **INV-4 check**: No literal `Skill({...})`.
- **INV-5a check**: `featureId` schema-validated.
- **INV-5b check**: **POSITIVE EXEMPLAR.** Line 65 explicitly says "Immediately suggests next step from the envelope's `next_actions`." Only command in the catalog that demonstrates INV-5b next_actions consumption. Use this as the model for delegate.md / ideate.md fixes.
- **INV-5c check**: `rehydrate` + fallback to `pipeline` view — observation-first verb design. Good.
- **INV-5d check**: Composite tool action discriminator used correctly.
- **INV-6 check**: References phase/playbook in output template but the rehydrate envelope shape is workflow-agnostic (works for any `workflowType`). Good.
- **Findings filed**: 0 (all positive — counted as exemplar reference).

### `commands/review.md`
- **Transitions performed**: review → synthesize (PASS), review → delegate (FAIL, fix loop), review → ideate (BLOCKED, redesign).
- **INV-1 check**: **HIGH finding** (review.md:102-108) — all three branches use "Update state `.phase = 'X'`" with no composite-tool action. The implicit `update {phase}` is rejected by runtime. Three branches × no `workflow.transition` event each = systematic event-store gap.
- **INV-2 check**: `prepare_review`, `check_review_verdict` are registered orchestrate actions; parity OK.
- **INV-4 check**: LOW finding (review.md:78-79, 104-106) — five `Skill({...})` literals, two of which (`axiom:audit`, `impeccable:critique`) are cross-plugin and should be guarded rather than tokenized.
- **INV-5a check**: `prepare_review` returns a check catalog; agent passes it to a subagent. Good schema-driven dispatch.
- **INV-5b check**: MEDIUM finding (review.md:51-62) — `check_review_verdict` envelope has `next_actions` but the auto-chain (lines 102-106) hardcodes the next skill rather than consuming them.
- **INV-5c check**: `prepare_review`, `check_review_verdict` are reasonable Aspire-aligned action verbs (prepare-then-act pattern).
- **INV-5d check**: Composite-tool action discriminator used correctly for orchestrate calls.
- **INV-6 check**: Body references `delegate`, `synthesize`, `ideate`, `review` workflow verbs — file is a command (exempt).
- **Findings filed**: 1 HIGH (INV-1 phase update — three branches counted as one finding), 1 MEDIUM (INV-5b), 1 LOW (INV-4).

### `commands/shepherd.md`
- **Transitions performed**: Synthesize-phase internal iteration (assess → fix → resubmit). No top-level phase change.
- **INV-1 check**: MEDIUM finding (shepherd.md:42-78) — iteration loop emits no per-cycle events. `shepherd.currentIteration` lives in state via `update` (non-phase, correct).
- **INV-2 check**: `assess_stack` registered; parity OK.
- **INV-4 check**: No literal `Skill({...})`.
- **INV-5a check**: `assess_stack` schema-validated; `prNumbers: [123]` is typed.
- **INV-5b check**: MEDIUM finding (shepherd.md:78-91) — output doesn't surface `next_actions` from assess_stack envelope.
- **INV-5c check**: LOW positive (shepherd.md:38-45) — `code_quality` view query before mutating action; classic Aspire "query-state-first" pattern.
- **INV-5d check**: Action discriminator clean.
- **INV-6 check**: `shepherd.*` field convention is documented; not workflow-typed in the leaky sense.
- **Findings filed**: 1 MEDIUM (INV-1), 1 MEDIUM (INV-5b), 1 LOW positive (INV-5c — informational).

### `commands/synthesize.md`
- **Transitions performed**: synthesize → completed (post-merge), synthesize → delegate (--pr-fixes loop).
- **INV-1 check**: **HIGH finding** (synthesize.md:80, 88, 108) — three references to `phase: "completed"` via `update`. Runtime rejects. Compounded by the fact that `cleanup.md`'s `action: "cleanup"` is the canonical phase-to-completed transition — so these instructions may be obsolete prose. Either fix or delete.
- **INV-2 check**: `update` and `synthesis.prUrl` registered; parity OK.
- **INV-4 check**: LOW finding (synthesize.md:113) — literal `Skill({...})`.
- **INV-5a check**: `gh pr merge` invocations are bash, not schema-validated.
- **INV-5b check**: LOW finding (synthesize.md:60-65) — synthesis-complete output template ignores `next_actions`.
- **INV-5c check**: `synthesize` verb is reasonable; the `--auto --squash` pattern aligns with [memory: feedback_stacked_pr_auto_merge_collapses_granularity] caveats handled elsewhere.
- **INV-5d check**: Same systemic phase-update issue as INV-1. Already counted.
- **INV-6 check**: Body references `feature/`, `delegate`, `synthesize`, `merge` — file is a command (exempt).
- **Findings filed**: 1 HIGH (INV-1 phase update), 1 LOW (INV-4), 1 LOW (INV-5b).

### `commands/tag.md`
- **Transitions performed**: None — single event append to `tags` stream.
- **INV-1 check**: LOW positive (tag.md:22-38) — clean event-sourcing pattern with explicit `correlationId` + `source: "user"`. Exemplary INV-1 alignment.
- **INV-2 check**: `exarchos_event action: "append"` is registered; parity OK.
- **INV-4 check**: No literal `Skill({...})`.
- **INV-5a check**: Stream name `"tags"` is a constrained literal; tag value is freeform string by design.
- **INV-5b check**: Output is human-readable confirmation (line 45) — acceptable for a one-shot annotation command.
- **INV-5c check**: `append` is a creation verb; no observation needed first because tags are append-only annotations.
- **INV-5d check**: LOW positive (tag.md:22-38) — composite-tool action discriminator used correctly.
- **INV-6 check**: LOW positive (tag.md:1-54) — body is workflow-agnostic ("annotates a session without creating workflow state"). Exemplary INV-6 alignment.
- **Findings filed**: 0 violations; 3 positive exemplars cited.

### `commands/tdd.md`
- **Transitions performed**: None — pure planning template.
- **INV-1 check**: N/A — no MCP call.
- **INV-2 check**: N/A.
- **INV-4 check**: References `npm run test:run` and `dotnet test` (line 35) — cross-platform examples. Good.
- **INV-5a check**: LOW dismiss — not a tool, no schema needed.
- **INV-5b check**: N/A.
- **INV-5c check**: N/A.
- **INV-5d check**: N/A.
- **INV-6 check**: References "plan", "implementation" — workflow-vocabulary but file is a command + template only.
- **Findings filed**: 0.

## Triage summary

### HIGH findings (6 total)

1. **delegate.md INV-1 — missing `task.assigned` emission per dispatch.** Classified `surgical-in-PR-2`. Per [memory: feedback_orchestrator_task_assigned_emission], single-step add of a numbered "1. Before dispatching each task, emit `exarchos_event action: 'append' stream: '<feature>' event: { type: 'task.assigned', data: {...} }`" block. TDD-able via `delegate.test.ts` reading the command text. One-commit fix.

2. **delegate.md INV-5d — auto-chain prose "Set phase to ..." has no action.** Classified `surgical-in-PR-2`. Replace lines 53-54 with explicit `transition` calls. Same commit as #1 plausible.

3. **ideate.md INV-1 — `update { phase: "plan" }` is rejected by runtime.** Classified `defer-to-follow-up`. The phase-update systemic bug spans 5 commands (ideate, plan, review, synthesize, oneshot) and the fix touches the same prose pattern in each. Better to file a single sweep issue: "Migrate all phase-mutation prose from `update` to `transition`" and address as one task, not per-file. Estimated 5-task TDD set, one per command.

4. **plan.md INV-1 — three `update { phase: ... }` calls.** Classified `defer-to-follow-up`. Same as #3.

5. **review.md INV-1 — three "Update state `.phase = X`" branches.** Classified `defer-to-follow-up`. Same as #3.

6. **synthesize.md INV-1 — three `phase: "completed"` updates that may be obsolete prose.** Classified `defer-to-follow-up`. Same as #3, plus a specific question: are these obsolete (cleanup.md owns the transition) or do they cover a manual-cleanup escape hatch?

### MEDIUM findings (13 total)

- **debug.md INV-1** (debug.md:68-74): file-as-follow-up. Refactor track-phase progression to explicit `transition` calls.
- **delegate.md INV-4** (delegate.md:53-54): file-as-follow-up. Tokenize `Skill({...})` via `{{CHAIN}}` once commands enter the per-runtime render pipeline.
- **delegate.md INV-5b** (delegate.md:50-55): file-as-follow-up. Consume `next_actions` rather than hardcoded skill names.
- **ideate.md INV-4** (ideate.md:83): file-as-follow-up. Same as delegate.md INV-4.
- **ideate.md INV-5b** (ideate.md:73-84): file-as-follow-up. Same envelope-consumption fix.
- **ideate.md INV-5d** (ideate.md:75): roll into the phase-mutation sweep issue.
- **oneshot.md INV-1** (oneshot.md:68-73): roll into the phase-mutation sweep issue.
- **plan.md INV-5b** (plan.md:102-129): file-as-follow-up. Architectural — propose new `plan_review` orchestrate action.
- **refactor.md INV-1** (refactor.md:65-67): file-as-follow-up. Refactor track-phase progression.
- **review.md INV-5b** (review.md:51-62): file-as-follow-up. Consume `check_review_verdict`'s `next_actions`.
- **shepherd.md INV-1** (shepherd.md:42-78): file-as-follow-up. Optional iteration events.
- **shepherd.md INV-5b** (shepherd.md:78-91): file-as-follow-up. Surface `next_actions` from assess_stack.

### LOW findings (12 total)

Default disposition: file as a single polish-nit issue (or roll into the v2.11.0 commands-portability follow-up). Brief mentions:

- autocompact.md INV-1 (optional event)
- checkpoint.md INV-1 (prose ambiguity)
- checkpoint.md INV-5b (template render)
- cleanup.md INV-5b (output template)
- debug.md INV-5d (runbook reference)
- discover.md INV-5a (scoping prose)
- dogfood.md INV-5b (envelope consumption)
- dogfood.md INV-6 (borderline)
- plan.md INV-4 (Skill literal)
- plan.md INV-5b (auto-loop architecture)
- refactor.md INV-5d (runbook reference)
- review.md INV-4 (Skill literal — cross-plugin guards needed)
- synthesize.md INV-4 (Skill literal)
- synthesize.md INV-5b (output template)

Positive exemplars (not findings, but worth citing during fix-task PRs):

- **rehydrate.md** — only command in the catalog that demonstrates INV-5b `next_actions` consumption (rehydrate.md:65). Use as the model for fixes.
- **tag.md** — exemplary INV-1 (clean event append), INV-5d (correct discriminator), INV-6 (workflow-agnostic body).
- **prune.md** — exemplary INV-5c (dry-run-by-default mutating verb).
- **shepherd.md Step 0** — exemplary INV-5c (`code_quality` query before mutating action).
- **oneshot.md `finalize_oneshot`** — exemplary INV-5d (action discriminator with declarative end-state).

## Out-of-scope cross-references

The audit surfaced two issues that aren't in `commands/` and should be filed as separate issues:

1. **No `plan_review` orchestrate action exists.** plan.md's auto-loop (lines 102-129) makes a `gapsFound` decision in command prose rather than in a structured envelope. This is an architectural gap, not a command-text gap. Out of E1 scope; file as separate issue under epic #1441 or v2.11.0.

2. **The `commands/` directory is not yet in the per-runtime render pipeline.** Every INV-4 literal-`Skill({...})` finding in this audit becomes a HIGH-severity per-runtime breakage once `commands/` ships to non-Claude runtimes. Today these are MEDIUM because the directory is Claude-Code-only-shipped. File as separate issue: "Add `commands/` to skills-renderer per-runtime tree" — likely in v2.11.0 cross-platform milestone alongside [memory: project_milestone_themes].

3. **Registry has `action: "transition"` but commands universally use `action: "update"` for phase changes.** This is the root of 5 HIGH findings. The runtime rejects, but the rejection-suggestedFix pattern means model auto-correction has silently masked the systemic bug. File as one umbrella issue: "Migrate all command-text phase-mutation prose to `action: 'transition'`" with the 5 per-command sub-issues as children. This is the single highest-leverage post-audit follow-up.
