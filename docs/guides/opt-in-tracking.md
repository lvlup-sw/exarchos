# Opt-In Tracking

Exarchos workflows are opt-in by design. This is a feature, not a gap.

## Philosophy

Structured workflows (`/ideate`, `/debug`, `/refactor`) provide full event-sourced tracking: phase transitions, task assignments, quality gates, team coordination, and audit trails. This tracking is valuable precisely because it is intentional — you choose to enter a workflow when the work warrants governance.

Not all work warrants governance. Quick fixes, explorations, experiments, and one-offs happen constantly. Requiring tracking for every interaction would create friction that degrades the developer experience without proportional value.

**The opt-in principle:** Tracking should be a tool you reach for, not a tax you pay.

## What's Already Tracked

Even outside structured workflows, Exarchos captures:

| Layer | What | How |
|-------|------|-----|
| **Session transcripts** | Every tool call, model turn, and token count | `SessionEnd` hook parses transcripts into `sessions/{sessionId}.events.jsonl` |
| **Session manifest** | Session start time, branch, working directory, transcript path | `SessionStart` hook writes to `sessions/.manifest.jsonl` |
| **Tool telemetry** | Every MCP tool invocation with duration, bytes, and token estimates | `withTelemetry` middleware writes to `telemetry.events.jsonl` |
| **Git history** | Every code change with author, timestamp, and diff | Git itself |

The raw data exists. What's missing for non-workflow sessions is *attribution* — linking a session to a feature, project, or concern.

## Bridging the Gap: `/tag`

For sessions where you want attribution without full workflow ceremony:

```
/tag feature-auth
```

This emits a lightweight `session.tagged` event to the shared `tags` stream, linking the current session to the given label. No workflow state is created. No phase machine is initialized. Just a metadata annotation on work you've already done.

- Zero friction for untagged sessions (the default)
- Opt-in attribution when you want it
- Multiple tags per session allowed
- Retroactive — tag after the work, not before

## When to Use Workflows vs. Tags

| Situation | Use |
|-----------|-----|
| New feature with design, implementation, review | `/ideate` (full workflow) |
| Bug with investigation, fix, validation | `/debug` (full workflow) |
| Code improvement with scope assessment | `/refactor` (full workflow) |
| Quick fix you want linked to a feature | `/tag feature-name` |
| Exploration or spike | Nothing, or `/tag` if you want to find it later |
| One-off change | Nothing |

## Design Rationale

The alternative — mandatory tracking for all changes — was considered and rejected for three reasons:

1. **Friction compounds.** Even a single question at session start ("what are you working on?") becomes irritating across hundreds of sessions. Skippable prompts get skipped, producing the same unattributed data with added annoyance.

2. **Value requires intent.** Auto-classified sessions (inferring "bugfix" vs "feature" from transcripts) produce noisy, unreliable metadata. Intentional attribution via `/tag` or workflows produces clean, trustworthy data.

3. **Git is the universal fallback.** Every code change is already tracked with full context in git history. The event store adds value through *structured workflow metadata* — phase transitions, quality gates, team coordination. For unstructured work, git is sufficient.
