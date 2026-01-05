---
description: Check the status of a Jules session
---

# Check Jules Session Status

Use the `jules_check_status` MCP tool to check the status of session "$ARGUMENTS".

## Workflow

1. **Get session ID**: Parse the session ID from arguments
2. **Check status**: Call `jules_check_status` with the session ID
3. **Report status**: Display the current state and any relevant information

## Session States

- **QUEUED**: Task is waiting to be processed
- **PLANNING**: Jules is creating an execution plan
- **AWAITING_PLAN_APPROVAL**: Plan ready for your review
- **IN_PROGRESS**: Jules is implementing the task
- **COMPLETED**: Task done, PR created
- **FAILED**: Task failed (check activities for details)

## Next Steps by State

- **AWAITING_PLAN_APPROVAL**: Review the plan and use `/jules:approve` to continue
- **COMPLETED**: Review the pull request URL provided
- **FAILED**: Check the error and consider creating a new task

## Example Usage

```
/jules:status abc123
/jules:status sessions/xyz789
```
