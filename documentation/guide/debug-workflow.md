---
outline: deep
---

# Debug Workflow

The debug workflow handles bug investigation and fixes. It provides two tracks: hotfix for production fires where the cause is obvious, and thorough for cases that need proper root cause analysis.

## Phase chains

Thorough track:
```
triage → investigate → rca → design → debug-implement → debug-validate → debug-review → synthesize → completed
```

Hotfix track:
```
triage → investigate → hotfix-implement → hotfix-validate → synthesize → completed
```

Both tracks have one human checkpoint: merge confirmation at the end.

## Starting a debug workflow

```
/exarchos:debug users are getting 500 errors on the /api/payments endpoint
```

You can force a track at start:

```
# Skip triage, go straight to hotfix
/exarchos:debug --hotfix production is down, login returns 500

# Skip triage, escalate to a feature workflow
/exarchos:debug --escalate this needs architectural changes
```

## Triage phase

Triage classifies the issue and selects a track. Exarchos collects:

- Symptom description: what is broken, what error messages appear
- Reproduction steps: how to trigger the bug consistently
- Impact assessment: who is affected, how urgently does this need a fix
- Affected area: which files, modules, or services are involved

Based on urgency and whether the root cause is known, a deterministic script selects the track:

| Criteria | Hotfix | Thorough |
|----------|--------|----------|
| Root cause known? | Yes | No |
| Urgency | Critical / P0 | Normal / P1-P2 |
| Fix scope | Small, obvious | Unclear or broad |
| Investigation needed | Minimal | Full |

After triage, the workflow auto-continues to investigation.

## Investigation phase

Both tracks start with investigation, but they differ in depth.

Hotfix investigation is time-boxed to 15 minutes. The goal is to confirm the root cause you already suspect and locate the exact code to change. If 15 minutes pass without finding the cause, Exarchos prompts you to switch to the thorough track. All findings transfer; nothing is lost.

Thorough investigation has no time limit. Exarchos works through a systematic checklist: reproduce the bug, read error logs, trace the call path, check recent changes, test hypotheses. The goal is to fully understand the problem before proposing any fix.

## Hotfix track

The hotfix track prioritizes speed. No worktree isolation, no separate design phase, no full review.

Implement. Write a test that reproduces the bug. Fix it with minimum changes. No new features, no refactoring, only fix the bug. Changes happen directly on a branch from the current working tree.

Validate. Run the affected tests. Verify the fix and check for regressions in related test suites. Convergence gates run automatically.

After validation, synthesis creates a PR and shepherd monitors CI. You confirm the merge.

Hotfix creates a follow-up task for a proper root cause analysis. The follow-up is saved to `docs/follow-ups/` so it does not get forgotten.

## Thorough track

The thorough track invests time upfront to prevent the bug from recurring.

### Root cause analysis

After investigation, Exarchos documents the root cause with evidence. The RCA captures:

- What happened (the symptom)
- Why it happened (the root cause with evidence)
- All affected code paths
- Whether the fix needs a design change

The RCA document is saved to `docs/rca/YYYY-MM-DD-<issue-slug>.md`. This becomes institutional knowledge. The next developer who encounters something similar can find it.

### Design

If the fix requires more than a one-line change, a brief fix design is written. This is not a full design document like the feature workflow produces. It is 2-3 paragraphs in the workflow state: what will change, why this approach, what is explicitly out of scope.

If the fix requires architectural changes that exceed bug-fix scope, the workflow escalates. Exarchos recommends running `/ideate` to design the solution properly, and preserves all investigation context for that handoff.

### Implementation

An implementer agent works in a worktree following TDD:

1. Write a test that proves the bug exists (it should fail)
2. Apply the fix (the test should now pass)
3. Clean up without changing behavior

This ordering matters. The test documents what was broken and proves the fix actually addresses it.

### Validation

Convergence gates run against the fix:
- Tests pass (including the new regression test)
- Static analysis clean
- No regressions in related test suites

### Review

The thorough track runs a spec review (not the full two-stage review that features get). The reviewer verifies:
- The fix matches the root cause from the RCA
- The fix matches the brief design
- Tests cover the bug and its fix
- No unrelated changes snuck in

If review finds issues, fixer agents address them.

### After review

Synthesis creates the PR. The PR description links to the RCA document. Shepherd monitors CI. You confirm the merge.

## Switching tracks

You can switch between tracks mid-workflow:

Hotfix to thorough. Happens automatically when the 15-minute investigation timer expires. Also available manually:
```
/exarchos:debug --switch-thorough
```

Thorough to escalation. When investigation reveals the fix needs architectural changes:
```
/exarchos:debug --escalate reason for escalation
```

This transitions the workflow to blocked and recommends `/ideate` for a proper design.

## Session recovery

Debug workflows rehydrate the same way as feature workflows:

```
/exarchos:rehydrate
```

The workflow picks up from whatever phase it was in. Investigation findings, triage results, and RCA documents are all preserved in the workflow state.
