---
name: hotfix-track
---

# Hotfix Track

## Purpose

Fix production issues or critical regressions ASAP. Speed over ceremony.

## Phases

```
Triage -> Investigate -> Implement -> Validate -> Completed
  |          |            |           |           |
  |          |            |           |           +- Human checkpoint: merge
  |          |            |           +- Smoke tests only
  |          |            +- Minimal fix, no worktree
  |          +- 15 min max, focused on root cause
  +- Capture symptom, select track
```

## Phase Details

### 1. Triage Phase

Use `@skills/debug/references/triage-questions.md` to gather:
- Symptom description
- Reproduction steps
- Urgency justification
- Affected area

Run deterministic track selection:

```bash
scripts/select-debug-track.sh --urgency <critical|high|medium|low> --root-cause-known <yes|no>
```

**On exit 0:** Hotfix track selected.
**On exit 1:** Thorough track selected.

Update state using `mcp__exarchos__exarchos_workflow` with `action: "set"`:

```text
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: {
    "triage": {
      "symptom": "<symptom>",
      "reproduction": "<steps>",
      "affectedArea": "<area>",
      "impact": "<impact>"
    },
    "urgency": {
      "level": "<level>",
      "justification": "<justification>"
    },
    "track": "<hotfix|thorough>"
  }
  phase: "investigate"
```

### 2. Investigate Phase (15 min max)

Use `@skills/debug/references/investigation-checklist.md`.

Run the investigation timer to enforce the 15-minute time-box:

```bash
scripts/investigation-timer.sh --state-file <state-file>
```

**On exit 0:** Within budget -- continue investigation.
**On exit 1:** Budget exceeded -- escalate to thorough track.

Record findings using `mcp__exarchos__exarchos_workflow` with `action: "set"`:

```text
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "investigation.findings": ["<finding>"] }
```

When root cause found:

```text
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: {
    "investigation.rootCause": "<root cause>",
    "investigation.completedAt": "<ISO8601>"
  }
  phase: "implement"
```

### 3. Implement Phase

Apply minimal fix directly (no worktree):
- Change only what's necessary
- No new features or refactoring
- Record fix approach in state

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "artifacts.fixDesign": "<brief fix description>" }
  phase: "validate"
```

### 4. Validate Phase

Run affected tests only:
```bash
npm run test:run -- <affected-test-files>
```

If tests pass:

```
Use mcp__exarchos__exarchos_workflow with action: "set", featureId:
  updates: { "followUp.rcaRequired": true }
  phase: "completed"
```

Create follow-up task for proper RCA:
```bash
cat > docs/follow-ups/$(date +%Y-%m-%d)-<issue-slug>.json << EOF
{
  "type": "follow-up",
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source": "hotfix:<state-file>",
  "task": "Create proper RCA for hotfix: <issue-slug>",
  "context": {
    "symptom": "<symptom>",
    "quickFix": "<fix description>",
    "affectedFiles": ["<files>"]
  }
}
EOF
```

**Human checkpoint:** Confirm merge.
