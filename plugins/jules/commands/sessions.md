---
description: List connected repositories for Jules
---

# List Jules Sources

Use the `jules_list_sources` MCP tool to list all repositories connected to Jules.

## Workflow

1. **List sources**: Call `jules_list_sources`
2. **Display results**: Show available repositories with their details

## Information Displayed

For each connected repository:
- Repository name (owner/repo)
- Privacy status (public/private)
- Default branch
- Available branches

## Next Steps

Once you see your repositories:
- Use `/jules:delegate <task>` to assign a task
- Ensure your target repository is connected

## No Repositories?

If no repositories are connected:
1. Visit https://jules.google
2. Connect your GitHub account
3. Install the Jules GitHub App on your repositories

## Example Usage

```
/jules:sessions
```
