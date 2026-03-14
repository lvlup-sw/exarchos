# Root Cause Patterns

Common failure patterns observed from dogfooding Exarchos workflows. Use this reference to quickly diagnose failures during `/dogfood` triage.

---

## Code Bug Patterns

### Schema Too Strict
**Symptom:** Zod validation rejects input that should be valid.
**Examples:**
- `branch: null` rejected on pending tasks (should be nullable)
- `status: "completed"` rejected (only accepts `"complete"`)
- Required fields that should be optional for certain task states

**Diagnosis:** Compare the rejected input against the Zod schema in `servers/exarchos-mcp/src/`. If the input represents a valid real-world state, the schema is too strict.

**Historical:** #876 (null branch), #941 (completed vs complete)

### Stale Cache / Sequence Divergence
**Symptom:** CAS retry loop exhaustion, `CLAIM_FAILED`, `SEQUENCE_CONFLICT` with no concurrent writers.
**Examples:**
- `.seq` file from prior session disagrees with JSONL line count
- All retries produce the same mismatch

**Diagnosis:** Check if the error occurs on first attempt with no other agents running. If so, it's a stale cache issue, not concurrency.

**Historical:** #939 (stale .seq cache)

### Gate Over-Enforcement
**Symptom:** Workflow blocked by a gate that doesn't apply to the current task type.
**Examples:**
- TDD compliance gate blocks documentation-only tasks
- Manual evidence parameter accepted but not consulted for bypass

**Diagnosis:** Check if the gate has exemption logic for the task's characteristics (file types changed, task category). If not, the gate needs conditional enforcement.

**Historical:** #940 (TDD gate on docs-only tasks)

---

## Documentation Issue Patterns

### Schema-Doc Drift
**Symptom:** Agent constructs payloads from skill doc examples that fail Zod validation. Multiple retries with different field names.
**Examples:**
- Skill doc shows `gate` field, actual schema requires `gateName`
- Skill doc omits required fields like `taskId`
- Skill doc includes fields (`prNumbers`, `maxIterations`) that aren't in the schema

**Diagnosis:** Compare the example payloads in skill docs against the Zod schemas in `servers/exarchos-mcp/src/event-store/schemas.ts`. The schema is the source of truth.

**Historical:** #964 (shepherd event payloads)

### Unknown Valid Values
**Symptom:** Agent guesses enum values and fails with `invalid_enum_value`.
**Examples:**
- Agent tries `wave.completed` when valid type is `workflow.transition`
- Agent doesn't know which event types exist

**Diagnosis:** Check if the skill docs list the valid enum values. If not, the agent has to guess — that's a documentation gap.

**Historical:** #741 (unknown event types)

### Path Resolution
**Symptom:** `ENOENT` errors when scripts are invoked via documented paths.
**Examples:**
- Skill references `scripts/check-tdd-compliance.sh` but script lives at `~/.claude/scripts/`
- MCP orchestrate `spawnSync` fails because CWD isn't the exarchos install dir

**Diagnosis:** Check if the script exists at the path referenced in the skill docs. Then check where the installer actually places it. Mismatch = path resolution bug.

**Historical:** #942 (scripts/ relative to CWD)

### Missing Workflow Instructions
**Symptom:** Orchestrator skips required tool calls or doesn't follow the expected workflow.
**Examples:**
- Delegation phase uses Claude Code Task/TaskUpdate but never calls `exarchos_workflow set`
- No events emitted during an entire workflow phase
- PR bodies don't follow the template

**Diagnosis:** Check if the skill docs explicitly instruct the agent to make these tool calls. If not, the agent has no reason to — the docs need to prescribe the correct workflow.

**Historical:** #739 (no exarchos tools during delegation), #740 (no events), #907 (PR template)

---

## User Error Patterns

### Sequence Violation
**Symptom:** Tool call fails because a prerequisite wasn't met.
**Examples:**
- Quality review dispatched before spec review passes
- Synthesis attempted before review phase completes
- Task completion attempted without required gate events

**Diagnosis:** Check if the skill docs describe the prerequisite. If they do and the agent skipped it, it's user error. If they don't, it's a documentation issue.

### Parameter Format Mismatch
**Symptom:** Tool call fails with wrong type or format, and the correct format is documented.
**Examples:**
- Passing a number where a string is expected
- Using camelCase when kebab-case is required
- Missing required field that the skill docs explicitly list

**Diagnosis:** If the skill docs clearly show the correct format and the agent didn't follow them, it's user error. If the docs are ambiguous or show the wrong format, it's a documentation issue.

### Context Loss After Compaction
**Symptom:** Agent loses track of state, teammates, or in-progress work after context compaction.
**Examples:**
- Orchestrator re-dispatches already-completed tasks
- Agent doesn't check workflow state after resume
- Agent creates duplicate branches

**Diagnosis:** Check if the skill docs include post-compaction recovery instructions. If they do, this is user error. If not, the skill needs compaction-resilience instructions (likely a documentation issue).

**Historical:** #738 (lost teammates after compaction)

---

## Severity Guide

| Severity | Definition | Filing Priority |
|----------|-----------|----------------|
| **HIGH** | Blocks workflow progression, no workaround, or causes data loss | File immediately |
| **MEDIUM** | Degraded experience, workaround exists (e.g., change field value, use different path) | File in batch |
| **LOW** | Minor friction, single retry resolves it | Track for patterns, file if recurrent |
