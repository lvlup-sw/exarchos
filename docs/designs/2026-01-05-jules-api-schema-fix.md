# Jules API Schema Fix + Source Validation

## Problem Statement

The `jules_create_task` MCP tool fails with:
```
Error: Invalid JSON payload received. Unknown name "branch" at 'session.source_context': Cannot find field
```

This occurs because our implementation uses an incorrect schema for the `sourceContext` field when creating Jules sessions.

## Root Cause Analysis

### Current Implementation (Incorrect)

**types.ts:47-50:**
```typescript
export interface SourceContext {
  source: string; // "sources/github-{owner}-{repo}"
  branch?: string; // default: "main"
}
```

**tools.ts:181-184:**
```typescript
sourceContext: {
  source: `sources/github-${validated.repo.replace('/', '-')}`,
  branch: validated.branch
}
```

### Correct API Schema (from Jules docs)

```json
{
  "sourceContext": {
    "source": "sources/github/owner/repo",
    "githubRepoContext": {
      "startingBranch": "main"
    }
  }
}
```

### Discrepancies

| Aspect | Current | Correct |
|--------|---------|---------|
| Branch location | `sourceContext.branch` | `sourceContext.githubRepoContext.startingBranch` |
| Branch field name | `branch` | `startingBranch` |
| Source format | `sources/github-{owner}-{repo}` | `sources/github/{owner}/{repo}` |

## Design: Approach B - Schema Fix + Source Validation

### Changes Required

#### 1. Update Type Definitions (`types.ts`)

```typescript
// Add new nested type
export interface GitHubRepoContext {
  startingBranch?: string;
}

// Update SourceContext
export interface SourceContext {
  source: string; // "sources/github/{owner}/{repo}"
  githubRepoContext?: GitHubRepoContext;
}
```

#### 2. Update Tool Implementation (`tools.ts`)

**2a. Fix source format and schema in `jules_create_task`:**

```typescript
sourceContext: {
  source: `sources/github/${validated.repo}`,  // Use slashes, not dashes
  githubRepoContext: validated.branch ? {
    startingBranch: validated.branch
  } : undefined
}
```

**2b. Add source validation before creating session:**

```typescript
async jules_create_task(input): Promise<ToolResult> {
  const validated = createTaskSchema.parse(input);

  // Validate repo is connected to Jules
  const sources = await client.listSources();
  const expectedSource = `sources/github/${validated.repo}`;
  const sourceExists = sources.some(s => s.name === expectedSource);

  if (!sourceExists) {
    const connectedRepos = sources.map(s =>
      `${s.githubRepo.owner}/${s.githubRepo.repo}`
    ).join(', ');
    return errorResult(
      `Repository "${validated.repo}" is not connected to Jules. ` +
      `Connected repos: ${connectedRepos || 'none'}. ` +
      `Connect at https://jules.google`
    );
  }

  // Proceed with session creation...
}
```

#### 3. Update Tests (`tools.test.ts`, `jules-client.test.ts`)

- Update mocks to use correct schema structure
- Add test for source validation error case
- Verify correct source format in API calls

### Files to Modify

| File | Change |
|------|--------|
| `plugins/jules/servers/jules-mcp/src/types.ts` | Add `GitHubRepoContext`, update `SourceContext` |
| `plugins/jules/servers/jules-mcp/src/tools.ts` | Fix schema, add source validation |
| `plugins/jules/servers/jules-mcp/src/tools.test.ts` | Update mocks, add validation test |
| `plugins/jules/servers/jules-mcp/src/jules-client.test.ts` | Update schema in mocks |

### Test Plan

1. **Unit Tests:**
   - Verify `sourceContext` schema matches API spec
   - Verify source validation returns helpful error for unconnected repos
   - Verify successful task creation with valid repo

2. **Integration Test (manual):**
   - Call `jules_create_task` with a connected repo
   - Verify session creates successfully
   - Verify branch parameter works correctly

### Success Criteria

- [ ] `jules_create_task` no longer throws "Unknown name 'branch'" error
- [ ] Attempting to use an unconnected repo returns helpful error message
- [ ] All existing tests pass with updated schema
- [ ] New validation test covers the error case
