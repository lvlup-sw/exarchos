# Dogfood Report Template

```markdown
## Dogfood Report

**Session:** [workflow name or description]
**Date:** [ISO 8601]
**Workflow type:** [feature | debug | refactor | ad-hoc]

### Summary

| Metric | Value |
|--------|-------|
| Total Exarchos tool calls | X |
| Failed tool calls | Y |
| Failure rate | Z% |
| Code bugs found | A |
| Documentation issues found | B |
| User errors found | C |

### Debug Trace Summary

| Metric | Value |
|--------|-------|
| Workflows inspected | X |
| Events reviewed | Y |
| Describe queries issued | Z |
| Views consulted | [pipeline, convergence, telemetry, ...] |
| Trace-only findings | W |

### Playbook Adherence

| Phase | Tools | Events | Transition Criteria | Guards | Verdict |
|-------|-------|--------|-------------------|--------|---------|
| [phase] | [match/mismatch] | [match/mismatch] | [match/mismatch] | [match/mismatch] | [OK/VIOLATION] |

**Violations:**
- [phase]: [playbook says X, agent did Y — bucket: documentation_issue/user_error]

### Runbook Conformance

| Runbook | Steps Executed | Deviations | Verdict |
|---------|---------------|------------|---------|
| [id] | X/Y | [list] | [OK/DEVIATED] |

### Code Bugs

#### [CB-1] [Title]
- **Tool:** `exarchos_workflow` action `set`
- **Error:** `INVALID_INPUT: ...`
- **Root cause:** [diagnosis]
- **Trace evidence:** [what describe/view/event query revealed]
- **Authoritative ref:** [e.g., `describe(actions: ['set']) → TaskSchema`]
- **Impact:** [blocked workflow / degraded experience / minor friction]
- **Suggested fix:** [specific code change]
- **Files:** [file:line references]

### Documentation Issues

#### [DOC-1] [Title]
- **Tool:** `exarchos_event` action `append`
- **Error:** `VALIDATION_ERROR: invalid_enum_value`
- **Root cause:** [diagnosis — what the docs say vs what describe output shows]
- **Trace evidence:** [describe output vs skill doc content]
- **Authoritative ref:** [e.g., `describe(eventTypes: ['team.spawned']) → JSON Schema`]
- **Skill/Reference:** [skills/X/SKILL.md:line or references/Y.md:line]
- **Source of truth:** [describe action + servers/exarchos-mcp/src/file.ts:line]
- **Suggested fix:** [update docs to match describe output]

### User Errors

#### [UE-1] [Title]
- **Tool:** `exarchos_orchestrate` action `check_tdd_compliance`
- **Error:** [error message]
- **What happened:** [agent did X]
- **What should have happened:** [both docs and describe agree on Y]
- **Authoritative ref:** [confirm docs match describe/topology/playbook]
- **Skill improvement:** [if the error is common, suggest making the skill clearer]

### Trace-Only Findings

Issues discovered solely through debug trace (not visible in conversation errors):

#### [T-1] [Title]
- **Discovery method:** [describe comparison / event log analysis / view query / playbook check]
- **Evidence:** [what the trace revealed]
- **Authoritative ref:** [which self-service query provided the ground truth]
- **Bucket:** [code_bug / documentation_issue]
- **Impact:** [silent data loss / state drift / stale guidance / playbook-skill divergence]
- **Suggested fix:** [specific change]

### Issue Drafts

Ready-to-file issue bodies for Code Bugs and Documentation Issues:

#### Issue: [CB-1 title]
```typescript
exarchos_orchestrate({ action: "create_issue", title: "bug: [summary]", body: "...", labels: ["bug"] })
```

#### Issue: [DOC-1 title]
```typescript
exarchos_orchestrate({ action: "create_issue", title: "docs: [summary]", body: "...", labels: ["bug"] })
```

### Patterns & Trends

[Observations about recurring failure modes, systemic issues, or improvements to the dogfood process itself]
```
