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

### Code Bugs

#### [CB-1] [Title]
- **Tool:** `exarchos_workflow` action `set`
- **Error:** `INVALID_INPUT: ...`
- **Root cause:** [diagnosis]
- **Impact:** [blocked workflow / degraded experience / minor friction]
- **Suggested fix:** [specific code change]
- **Files:** [file:line references]

### Documentation Issues

#### [DOC-1] [Title]
- **Tool:** `exarchos_event` action `append`
- **Error:** `VALIDATION_ERROR: invalid_enum_value`
- **Root cause:** [diagnosis — what the docs say vs what the code expects]
- **Skill/Reference:** [skills/X/SKILL.md:line or references/Y.md:line]
- **Source of truth:** [servers/exarchos-mcp/src/file.ts:line]
- **Suggested fix:** [update docs to match schema]

### User Errors

#### [UE-1] [Title]
- **Tool:** `exarchos_orchestrate` action `check_tdd_compliance`
- **Error:** [error message]
- **What happened:** [agent did X]
- **What should have happened:** [docs say to do Y]
- **Skill improvement:** [if the error is common, suggest making the skill clearer]

### Issue Drafts

Ready-to-file issue bodies for Code Bugs and Documentation Issues:

#### Issue: [CB-1 title]
```
gh issue create --title "bug: [summary]" --label "bug" --body "..."
```

#### Issue: [DOC-1 title]
```
gh issue create --title "docs: [summary]" --label "bug" --body "..."
```

### Patterns & Trends

[Observations about recurring failure modes, systemic issues, or improvements to the dogfood process itself]
```
