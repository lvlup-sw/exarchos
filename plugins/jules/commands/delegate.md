---
description: Delegate a coding task to Jules (junior engineer)
---

# Delegate Task to Jules

Use the `jules_create_task` MCP tool to delegate "$ARGUMENTS" to Jules.

## Workflow

1. **Parse the task**: Understand what the user wants to delegate
2. **Identify the repository**: Use `jules_list_sources` if not specified
3. **Create the task**: Call `jules_create_task` with:
   - `repo`: The target repository (owner/repo format)
   - `prompt`: The detailed task description
   - `branch`: Target branch (default: main)
4. **Report**: Return the session ID and URL for monitoring

## Guidelines

Remember that Jules is a junior engineer:
- Provide clear, detailed requirements
- Include test requirements (TDD: tests first)
- Specify the target branch
- The user will review the plan before Jules proceeds

## Example Usage

```
/jules:delegate Add user profile feature with TDD
/jules:delegate Fix the authentication bug in issue #123
/jules:delegate Refactor the payment module to use the new API
```
