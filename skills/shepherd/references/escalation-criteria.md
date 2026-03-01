# Escalation Criteria

When to stop the shepherd loop and escalate to the user.

## Automatic Escalation Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| Iteration limit | `currentIteration >= maxIterations` (default 5) | Pause and report summary |
| Persistent CI failure | Same check fails across 3+ consecutive iterations | Report as likely flaky or systemic |
| Review loop | Same reviewer requests changes 2+ times after fixes | Escalate — may need design discussion |
| Conflicting feedback | Two reviewers give contradictory guidance | Escalate — human decision needed |
| Access failure | GitHub MCP or Graphite CLI returns auth errors | Report — credentials may need refresh |
| `assess_stack` returns `escalate` | Composite action determined escalation needed | Report action items to user |

## Escalation Report Format

When escalating, provide:

```markdown
## Shepherd Escalation — Iteration <N>/<max>

**Reason:** <trigger from table above>

### Persistent Issues
- <Issue 1>: failed in iterations <list>, last fix attempted: <description>
- <Issue 2>: ...

### Actions Taken
- Iteration 1: <summary>
- Iteration 2: <summary>
- ...

### Recommendation
<Suggest next steps — e.g., "re-run with higher limit", "needs human review of X", "flaky test should be skipped">
```

## User Override

The user can override iteration limits: `/shepherd --max-iterations 10`

After escalation, the user may:
1. Ask to continue with a higher limit
2. Manually resolve the blocking issue, then re-run `/shepherd`
3. Accept the current state and proceed to `/cleanup`

## Non-Escalation Cases

These situations should NOT trigger escalation:
- CI checks still pending (wait and re-assess)
- Minor CodeRabbit suggestions (acknowledge and move on)
- Informational `github-actions[bot]` comments (safe to skip)
- Stack needs routine restack (fix automatically)
