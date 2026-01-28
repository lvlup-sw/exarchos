# Triage Questions

Use these questions during the triage phase to gather context and select the appropriate track.

## Core Questions

### 1. What is the symptom?

Capture the observable problem:
- Error messages (exact text)
- Unexpected behavior
- Performance degradation
- Data corruption/loss

**Prompts:**
- "What error message do you see?"
- "What behavior are you observing?"
- "What did you expect to happen instead?"

### 2. Can it be reproduced?

Determine reproducibility:
- **Always** - Happens every time
- **Sometimes** - Intermittent, conditions unclear
- **Rarely** - Happened once, hard to trigger
- **Unknown** - Haven't tried yet

**Prompts:**
- "Can you trigger this consistently?"
- "What steps reproduce the issue?"
- "Does it happen in all environments?"

### 3. What is the impact/urgency?

Assess business impact to determine urgency level:

| Level | Criteria | Examples |
|-------|----------|----------|
| **P0** | Production down, revenue impact, data loss | Site unreachable, payments failing, user data corrupted |
| **P1** | Major feature broken, significant user impact | Login fails for subset, core workflow blocked |
| **P2** | Minor issue, workaround exists, cosmetic | UI glitch, slow performance, edge case failure |

**Prompts:**
- "How many users are affected?"
- "Is there a workaround?"
- "Is this blocking production use?"

### 4. What area of code is likely affected?

Narrow down the investigation scope:
- Component/module name
- File paths if known
- Recent changes that might relate
- Related features

**Prompts:**
- "Which feature/page does this affect?"
- "Were there recent deployments?"
- "Has this worked before? When did it break?"

## Track Selection Logic

Based on answers, select the appropriate track:

```
                    ┌─────────────┐
                    │   P0 / P1   │
                    │  severity?  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
           P0 + Known   P0 + Unknown   P1 or P2
           Root Cause   Root Cause
              │            │            │
              ▼            ▼            ▼
         ┌─────────┐  ┌─────────┐  ┌─────────┐
         │ HOTFIX  │  │ Attempt │  │THOROUGH │
         │  TRACK  │  │ Hotfix  │  │  TRACK  │
         └─────────┘  │ 15 min  │  └─────────┘
                      └────┬────┘
                           │
                      ┌────┴────┐
                      │  Found  │
                      │ in 15m? │
                      └────┬────┘
                      Yes  │  No
                       ┌───┴───┐
                       ▼       ▼
                   HOTFIX   THOROUGH
                    TRACK    TRACK
```

### Hotfix Track Criteria

Select hotfix when ALL of these apply:
- [ ] P0 urgency (production down or revenue impact)
- [ ] Root cause is known OR likely findable in 15 minutes
- [ ] Fix is straightforward (code change, config fix, rollback)
- [ ] User accepts reduced ceremony for speed

### Thorough Track Criteria

Select thorough when ANY of these apply:
- [ ] P1/P2 urgency (not production-critical)
- [ ] Root cause is unknown and complex
- [ ] Fix requires design decisions
- [ ] Issue is recurring or indicates systemic problem
- [ ] User wants full documentation for learning

### Escalation Criteria

Escalate to `/ideate` when:
- [ ] Fix requires architectural changes
- [ ] Multiple systems/teams need coordination
- [ ] Issue exposes design flaw requiring redesign
- [ ] Scope exceeds bug fix (becomes feature work)

## Triage Output Format

After gathering answers, record in state file:

```json
{
  "triage": {
    "symptom": "Login button returns 500 error on click",
    "reproduction": "Always reproducible: Click login with valid credentials",
    "affectedArea": "Authentication service, src/auth/login.ts",
    "impact": "All users cannot log in"
  },
  "urgency": {
    "level": "P0",
    "justification": "Production login completely broken, 100% of users affected"
  },
  "track": "hotfix"
}
```

## Quick Triage Script

For fast P0 situations, use this abbreviated flow:

1. **Symptom?** [one sentence]
2. **Repro?** [yes/no/unknown]
3. **P0?** [yes → hotfix, no → thorough]
4. **Affected file?** [path or "unknown"]

Example:
```
Symptom: Login 500 error
Repro: Yes
P0: Yes
File: src/auth/login.ts
→ HOTFIX TRACK
```
