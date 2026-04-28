# Root Cause Patterns

Common failure patterns observed from dogfooding Exarchos workflows. Use this reference to quickly diagnose failures during `/dogfood` triage.

Each pattern includes a **Debug trace check** showing which MCP self-service queries to run for diagnosis. These queries use the same platform-agnostic tools available to any MCP client.

---

## Code Bug Patterns

### Schema Too Strict
**Symptom:** Zod validation rejects input that should be valid.
**Examples:**
- `branch: null` rejected on pending tasks (should be nullable)
- `status: "completed"` rejected (only accepts `"complete"`)
- Required fields that should be optional for certain task states

**Diagnosis:** Compare the rejected input against the Zod schema in `servers/exarchos-mcp/src/`. If the input represents a valid real-world state, the schema is too strict.

**Debug trace check:** Use `exarchos_workflow describe(actions: ['set'])` or `exarchos_event describe(eventTypes: ['...'])` to get the authoritative JSON Schema. Compare the rejected field's type/constraints against the schema output. If the schema is stricter than the domain allows, it's a code bug.

**Historical:** #876 (null branch), #941 (completed vs complete)

### Stale Cache / Sequence Divergence
**Symptom:** CAS retry loop exhaustion, `CLAIM_FAILED`, `SEQUENCE_CONFLICT` with no concurrent writers.
**Examples:**
- `.seq` file from prior session disagrees with JSONL line count
- All retries produce the same mismatch

**Diagnosis:** Check if the error occurs on first attempt with no other agents running. If so, it's a stale cache issue, not concurrency.

**Debug trace check:** Use `exarchos_event query(stream)` to count events and compare against the sequence number in the error. Use `exarchos_view telemetry` to check if there are concurrent tool invocations. A mismatch with no interleaved writers confirms stale cache.

**Historical:** #939 (stale .seq cache)

### Gate Over-Enforcement
**Symptom:** Workflow blocked by a gate that doesn't apply to the current task type.
**Examples:**
- TDD compliance gate blocks documentation-only tasks
- Manual evidence parameter accepted but not consulted for bypass

**Diagnosis:** Check if the gate has exemption logic for the task's characteristics (file types changed, task category). If not, the gate needs conditional enforcement.

**Debug trace check:** Use `exarchos_orchestrate describe(actions: ['check_tdd_compliance'])` to inspect gate metadata (blocking, dimension). Use `exarchos_view convergence` to see if this gate is systematically failing. Use `exarchos_workflow get` to check task metadata that should trigger exemptions.

**Historical:** #940 (TDD gate on docs-only tasks)

### Silent State Corruption
**Symptom:** Debug trace reveals workflow state that doesn't match the event log. Only visible via server-side inspection — the conversation shows no errors.
**Examples:**
- Events accepted but state not updated (projection bug)
- Phase field shows a value that no transition event supports
- Task status regressed to a prior state

**Diagnosis:** Compare the event stream (chronological record of what happened) against the current workflow state (projected view). If the state can't be derived from the event sequence, there's a projection or state-rebuild bug.

**Debug trace check:** Read full event log via `exarchos_event query(stream)`, then read state via `exarchos_workflow get`. Walk the events forward and verify the final state matches. Use `exarchos_workflow reconcile` to see if reconciliation produces a different state — if so, the live projection diverged.

### Topology/Engine Mismatch
**Symptom:** HSM topology defines a transition but the engine rejects it, or vice versa.
**Examples:**
- Agent attempts a transition that exists in `describe(topology)` but gets `INVALID_TRANSITION`
- Guard defined in topology never fires (guard handler not registered)
- Effect defined in topology doesn't produce expected side effect

**Diagnosis:** Compare `exarchos_workflow describe(topology)` output against actual engine behavior. The topology is the declared specification; if the engine doesn't honor it, the engine has a bug.

**Debug trace check:** Use `describe(topology: '<workflowType>')` to get the full HSM definition. Identify the transition the agent attempted. Check guards, effects, and target state. Then check `workflow.guard-failed` events in the log for the specific guard that blocked it. If the guard isn't in the topology definition but still fires, the engine has undeclared guards.

### Auto-Emission Failure
**Symptom:** An action's gate metadata declares `autoEmits` events, but those events don't appear in the event log after the action succeeds.
**Examples:**
- `task_complete` should auto-emit `task.completed` but no such event appears
- `check_tdd_compliance` should auto-emit `gate.executed` but the gate event is missing

**Diagnosis:** Compare `exarchos_orchestrate describe(actions: ['<action>'])` auto-emission metadata against `exarchos_event query(stream)` filtered for the expected event type after the action's timestamp.

**Debug trace check:** Run `describe(actions: ['<action>'])` → note `autoEmits` field. Query event log filtered by type and time range. If the event is missing, the auto-emission handler has a bug.

---

## Documentation Issue Patterns

### Schema-Doc Drift
**Symptom:** Agent constructs payloads from skill doc examples that fail Zod validation. Multiple retries with different field names.
**Examples:**
- Skill doc shows `gate` field, actual schema requires `gateName`
- Skill doc omits required fields like `taskId`
- Skill doc includes fields (`prNumbers`, `maxIterations`) that aren't in the schema

**Diagnosis:** Compare the example payloads in skill docs against the `describe` output. The `describe` API returns the authoritative JSON Schema — it is the source of truth.

**Debug trace check:** Use `exarchos_orchestrate describe(actions: ['<action>'])` or `exarchos_event describe(eventTypes: ['<type>'])` to get the authoritative schema. Diff field names, types, and required status against what skill docs prescribe. Any mismatch is schema-doc drift.

**Historical:** #964 (shepherd event payloads)

### Unknown Valid Values
**Symptom:** Agent guesses enum values and fails with `invalid_enum_value`.
**Examples:**
- Agent tries `wave.completed` when valid type is `workflow.transition`
- Agent doesn't know which event types exist

**Diagnosis:** Check if the skill docs list the valid enum values. If not, the agent has to guess — that's a documentation gap.

**Debug trace check:** Use `exarchos_event describe(emissionGuide: true)` to get the full event type catalog organized by emission source (auto/model/hook/planned). Cross-reference against what skill docs list. Missing types in the skill docs = documentation gap.

**Historical:** #741 (unknown event types)

### Path Resolution
**Symptom:** `ENOENT` errors when scripts are invoked via documented paths.
**Examples:**
- Skill references `scripts/check-tdd-compliance.sh` but script lives at `~/.claude/scripts/`
- MCP orchestrate `spawnSync` fails because CWD isn't the exarchos install dir

**Diagnosis:** Check if the script exists at the path referenced in the skill docs. Then check where the installer actually places it. Mismatch = path resolution bug.

**Debug trace check:** Use `exarchos_orchestrate describe(actions: ['<action>'])` to verify what the server expects for script paths. If the describe output shows a different path convention than skill docs, the docs need updating.

**Historical:** #942 (scripts/ relative to CWD)

### Playbook-Skill Divergence
**Symptom:** Playbook prescribes tools, events, or transition criteria that differ from what the skill docs instruct. Agent follows skill docs and fails; playbook had the correct answer.
**Examples:**
- Skill says to emit `team.started`, playbook says to emit `team.spawned`
- Skill says phase transitions on "all tasks complete", playbook says it also requires `teamDisbanded`
- Skill doesn't mention a human checkpoint that the playbook requires
- Skill lists 3 tools for a phase, playbook lists 5

**Diagnosis:** The playbook is the source of truth for phase behavior (it's served by the MCP server). If skill docs diverge, they need updating.

**Debug trace check:** Use `exarchos_workflow describe(playbook: '<workflowType>')` and compare each phase's `tools`, `events`, `transitionCriteria`, `guardPrerequisites`, and `humanCheckpoint` against the corresponding skill SKILL.md sections. Flag structural contradictions.

### Runbook-Skill Divergence
**Symptom:** Runbook prescribes steps or decision logic that differs from skill docs. Agent follows skill and misses steps or takes the wrong branch.
**Examples:**
- Skill says to run gates in order A-B-C, runbook says A-C-B
- Skill's track selection logic doesn't match the decision runbook's branches
- Skill doesn't mention required `templateVars` that the runbook expects

**Diagnosis:** Decision runbooks are authoritative for decision logic; linear runbooks are authoritative for step ordering. If skill docs encode their own decision trees that don't match, the skill needs updating.

**Debug trace check:** Use `exarchos_orchestrate runbook(phase: '<phase>')` to get the resolved runbook. Compare step ordering and decision branches against skill instructions. For decision runbooks, check that the skill references the runbook rather than encoding inline logic.

### Missing Workflow Instructions
**Symptom:** Orchestrator skips required tool calls or doesn't follow the expected workflow.
**Examples:**
- Delegation phase mutates the runtime's native task list but never calls `exarchos_workflow set`
- No events emitted during an entire workflow phase
- PR bodies don't follow the template

**Diagnosis:** Check if the skill docs explicitly instruct the agent to make these tool calls. If not, the agent has no reason to — the docs need to prescribe the correct workflow.

**Debug trace check:** Use `exarchos_event query(stream)` and filter by phase. An empty or sparse event log for a phase that should have activity indicates the agent was never told to emit events. Cross-reference with `describe(playbook)` to see what the playbook prescribes.

**Historical:** #739 (no exarchos tools during delegation), #740 (no events), #907 (PR template)

### Describe-Doc Divergence
**Symptom:** Debug trace reveals that MCP `describe` responses contain information that contradicts or supersedes what skill docs say.
**Examples:**
- Skill doc says phase X has no gates, but `describe(topology)` shows a guard on the transition
- Skill doc lists 3 required event fields, but `describe(eventTypes)` shows 5
- CompactGuidance mentions an anti-pattern the skill doc doesn't cover
- Gate metadata shows `blocking: true` but skill says it's advisory

**Diagnosis:** The describe API is the source of truth for platform-agnostic workflow metadata. If skill docs diverge from describe responses, the skill docs need updating.

**Debug trace check:** For each failure, query the relevant describe endpoint and compare its output against the skill doc that the agent was following. The discrepancy IS the documentation issue.

---

## User Error Patterns

### Sequence Violation
**Symptom:** Tool call fails because a prerequisite wasn't met.
**Examples:**
- Quality review dispatched before spec review passes
- Synthesis attempted before review phase completes
- Task completion attempted without required gate events

**Diagnosis:** Check if the skill docs describe the prerequisite. If they do and the agent skipped it, it's user error. If they don't, it's a documentation issue.

**Debug trace check:** Use `exarchos_workflow describe(topology)` to verify the transition's guards. If the guard that blocked the agent is documented in both the topology and skill docs, the agent should have known.

### Parameter Format Mismatch
**Symptom:** Tool call fails with wrong type or format, and the correct format is documented.
**Examples:**
- Passing a number where a string is expected
- Using camelCase when kebab-case is required
- Missing required field that the skill docs explicitly list

**Diagnosis:** If the skill docs clearly show the correct format and the agent didn't follow them, it's user error. If the docs are ambiguous or show the wrong format, it's a documentation issue.

**Debug trace check:** Use the appropriate `describe` action to confirm the schema matches what skill docs say. If both agree and the agent deviated, it's user error.

### Runbook Deviation
**Symptom:** Agent deviated from runbook step ordering or decision branches without justification.
**Examples:**
- Skipped a step marked `onFail: "stop"`
- Took a decision branch inconsistent with the `source` field's value
- Didn't supply required `templateVars`

**Diagnosis:** If the runbook is accessible via `exarchos_orchestrate runbook()` and the skill docs reference it, the agent should have followed it. Deviation without cause is user error.

**Debug trace check:** Use `exarchos_orchestrate runbook(id: '<id>')` to get the resolved steps. Map agent's actual execution against the step list.

### Context Loss After Compaction
**Symptom:** Agent loses track of state, teammates, or in-progress work after context compaction.
**Examples:**
- Orchestrator re-dispatches already-completed tasks
- Agent doesn't check workflow state after resume
- Agent creates duplicate branches

**Diagnosis:** Check if the skill docs include post-compaction recovery instructions. If they do, this is user error. If not, the skill needs compaction-resilience instructions (likely a documentation issue).

**Debug trace check:** Use `exarchos_workflow get` to see actual state. If the agent's assumptions diverge from server state after compaction, and the skill instructs re-orientation via `exarchos_workflow get` or `exarchos_view pipeline`, the agent should have re-checked.

**Historical:** #738 (lost teammates after compaction)

---

## Severity Guide

| Severity | Definition | Filing Priority |
|----------|-----------|----------------|
| **HIGH** | Blocks workflow progression, no workaround, or causes data loss | File immediately |
| **MEDIUM** | Degraded experience, workaround exists (e.g., change field value, use different path) | File in batch |
| **LOW** | Minor friction, single retry resolves it | Track for patterns, file if recurrent |
