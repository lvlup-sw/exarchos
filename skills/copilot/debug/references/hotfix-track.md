---
name: hotfix-track
---

# Hotfix Track

## Purpose

Fix production issues or critical regressions ASAP. Speed over ceremony.

## Phases

```
triage -> investigate -> hotfix-implement -> hotfix-validate -> completed
  |          |            |                   |                  |
  |          |            |                   |                  +- Human checkpoint: merge
  |          |            |                   +- Smoke tests only
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

```typescript
exarchos_orchestrate({
  action: "select_debug_track",
  urgency: "<critical|high|medium|low>",
  rootCauseKnown: "<yes|no>"
})
```

**On `passed: true`:** Hotfix track selected.
**On `passed: false`:** Thorough track selected.

**Save triage results and advance to investigate:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `triage → investigate` guard requirements, then `set` the required fields (triage, urgency, track) and phase.

### 2. Investigate Phase (15 min max)

Use `@skills/debug/references/investigation-checklist.md`.

Run the investigation timer to enforce the 15-minute time-box:

```typescript
exarchos_orchestrate({
  action: "investigation_timer",
  stateFile: "<state-file>"
})
```

**On `passed: true`:** Within budget -- continue investigation.
**On `passed: false`:** Budget exceeded -- escalate to thorough track.

**Record findings and advance when root cause found:**

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `investigate → hotfix-implement` guard requirements and the expected field shapes for investigation findings, then `set` accordingly.

### 3. Implement Phase

Apply minimal fix directly (no worktree):
- Change only what's necessary
- No new features or refactoring
- Record fix approach in state

Call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `hotfix-implement → hotfix-validate` guard requirements, then `set` the required fields (artifacts) and phase.

### 4. Validate Phase

Run affected tests only:
```bash
npm run test:run -- <affected-test-files>
```

If tests pass, call `exarchos_workflow({ action: "describe", playbook: "debug" })` for the `hotfix-validate → completed` guard requirements, then `set` the required fields (followUp) and phase.

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
