# Azure DevOps CLI Reference

This document provides `az devops` CLI commands as fallbacks for MCP tools. Use these when:
- MCP server is unavailable
- Debugging authentication issues
- Running bulk operations
- Scripting outside of Copilot sessions

## Prerequisites

### Installation

```powershell
# Install Azure CLI
winget install Microsoft.AzureCLI

# Add DevOps extension
az extension add --name azure-devops
```

### Authentication

**Option 1: Azure AD (Recommended for SSO environments)**
```powershell
az login
az devops configure --defaults organization=https://dev.azure.com/your-org
```

**Option 2: Personal Access Token**
```powershell
$env:AZURE_DEVOPS_EXT_PAT = "your-pat-here"
az devops configure --defaults organization=https://dev.azure.com/your-org
```

## Command Reference

### Pull Request Operations

| MCP Tool | CLI Equivalent |
|----------|---------------|
| `mcp_ado_repo_create_pull_request` | `az repos pr create` |
| `mcp_ado_repo_update_pull_request` | `az repos pr update` |
| `mcp_ado_repo_get_pull_request_by_id` | `az repos pr show` |
| `mcp_ado_repo_list_pull_requests_by_repo_or_project` | `az repos pr list` |

#### Create Pull Request

```powershell
az repos pr create `
  --title "Feature: My Feature" `
  --description "PR description here" `
  --source-branch "feature/my-feature" `
  --target-branch "main" `
  --repository "my-repo" `
  --project "my-project"
```

#### Update Pull Request

```powershell
# Complete (merge) a PR
az repos pr update --id 42 --status completed

# Set to draft
az repos pr update --id 42 --draft true

# Add reviewers
az repos pr update --id 42 --reviewers "user@example.com"
```

#### List Pull Requests

```powershell
# List open PRs
az repos pr list --status active --project "my-project"

# List PRs by creator
az repos pr list --creator "user@example.com"
```

### PR Comments & Threads

| MCP Tool | CLI Equivalent |
|----------|---------------|
| `mcp_ado_repo_list_pull_request_threads` | `az repos pr list-threads` |
| `mcp_ado_repo_create_pull_request_thread` | (API only) |
| `mcp_ado_repo_reply_to_comment` | (API only) |

#### List PR Threads

```powershell
# Get all threads on a PR
az repos pr list-threads --id 42
```

#### View Specific Thread (API)

```powershell
# For operations not in CLI, use REST API
az rest --method GET `
  --uri "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}/threads?api-version=7.0"
```

### Work Item Operations

| MCP Tool | CLI Equivalent |
|----------|---------------|
| `mcp_ado_wit_link_work_item_to_pull_request` | `az boards work-item relation add` |

#### Link Work Item to PR

```powershell
# Get PR artifact link URL first
$prUrl = "vstfs:///Git/PullRequestId/{project-id}%2F{repo-id}%2F{pr-id}"

az boards work-item relation add `
  --id 1234 `
  --relation-type "ArtifactLink" `
  --target-url $prUrl
```

### Branch Operations

| MCP Tool | CLI Equivalent |
|----------|---------------|
| `mcp_ado_repo_create_branch` | `az repos ref create` |
| `mcp_ado_repo_list_branches_by_repo` | `az repos ref list` |

#### Create Branch

```powershell
# Get the commit ID of main branch
$mainCommit = az repos ref list --repository "my-repo" --filter "heads/main" --query "[0].objectId" -o tsv

# Create new branch
az repos ref create `
  --name "refs/heads/feature/new-branch" `
  --object-id $mainCommit `
  --repository "my-repo"
```

#### List Branches

```powershell
az repos ref list --repository "my-repo" --filter "heads/"
```

## Troubleshooting

### Common Issues

#### "TF401019: The Git repository does not exist"
- Verify repository name is correct
- Check you have access to the project
- Ensure organization URL is set: `az devops configure --defaults organization=URL`

#### "TF400813: The user is not authorized"
- Re-authenticate: `az login`
- Check PAT has required scopes (Code: Read & Write, Work Items: Read & Write)
- Verify PAT hasn't expired

#### "Could not find any pipelines..."
- The CLI looks for repo by name, not ID
- Use `--repository "repo-name"` not the GUID

### Debug Mode

Enable verbose output:
```powershell
az repos pr create --debug ...
```

### Check Current Configuration

```powershell
# View defaults
az devops configure --list

# Check login status
az account show
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `AZURE_DEVOPS_EXT_PAT` | Personal access token for auth |
| `AZURE_DEVOPS_ORG_URL` | Default organization URL |

## See Also

- [Azure DevOps CLI Documentation](https://docs.microsoft.com/en-us/azure/devops/cli/)
- [REST API Reference](https://docs.microsoft.com/en-us/rest/api/azure/devops/)
