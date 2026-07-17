# Implementation Plan: Jules API Schema Fix

## Overview

Fix the `sourceContext` schema to match the actual Jules API and add source validation.

**Design:** `docs/designs/2026-01-05-jules-api-schema-fix.md`

## Task Summary

| ID | Task | Phase | Parallelizable |
|----|------|-------|----------------|
| 001 | Add GitHubRepoContext type and update SourceContext | RED→GREEN | No (foundation) |
| 002 | Fix source format in fixtures | GREEN | Yes (after 001) |
| 003 | Update tools.ts to use correct schema | RED→GREEN | Yes (after 001) |
| 004 | Add source validation to jules_create_task | RED→GREEN | Yes (after 003) |
| 005 | Update existing tests for new schema | GREEN | Yes (after 003) |

---

## Task 001: Add GitHubRepoContext type and update SourceContext

**Phase:** RED → GREEN
**Dependencies:** None
**Parallelizable:** No (foundation for other tasks)

### [RED] Write failing test

**File:** `plugins/jules/servers/jules-mcp/src/types.test.ts` (new file)

```typescript
describe('SourceContext type', () => {
  it('should have githubRepoContext with startingBranch', () => {
    const context: SourceContext = {
      source: 'sources/github/owner/repo',
      githubRepoContext: {
        startingBranch: 'main'
      }
    };
    expect(context.githubRepoContext?.startingBranch).toBe('main');
  });

  it('should not have branch property at top level', () => {
    const context: SourceContext = {
      source: 'sources/github/owner/repo'
    };
    // TypeScript should error if 'branch' exists on SourceContext
    expect((context as any).branch).toBeUndefined();
  });
});
```

**Expected failure:** TypeScript error - `githubRepoContext` doesn't exist on `SourceContext`

### [GREEN] Implement minimum code

**File:** `plugins/jules/servers/jules-mcp/src/types.ts`

1. Add `GitHubRepoContext` interface after line 50:
```typescript
export interface GitHubRepoContext {
  startingBranch?: string;
}
```

2. Update `SourceContext` interface (lines 47-50):
```typescript
export interface SourceContext {
  source: string; // "sources/github/{owner}/{repo}"
  githubRepoContext?: GitHubRepoContext;
}
```

---

## Task 002: Fix source format in fixtures

**Phase:** GREEN
**Dependencies:** Task 001
**Parallelizable:** Yes

### [GREEN] Update fixtures

**File:** `plugins/jules/servers/jules-mcp/src/test/fixtures.ts`

Update source names from dash format to slash format:

```typescript
// Line 8: Change from
name: 'sources/github-lvlup-sw-test-repo',
// To
name: 'sources/github/lvlup-sw/test-repo',

// Line 9: Change from
id: 'github-lvlup-sw-test-repo',
// To
id: 'github/lvlup-sw/test-repo',

// Line 23: Change from
name: 'sources/github-lvlup-sw-private-repo',
// To
name: 'sources/github/lvlup-sw/private-repo',

// Line 24: Change from
id: 'github-lvlup-sw-private-repo',
// To
id: 'github/lvlup-sw/private-repo',
```

---

## Task 003: Update tools.ts to use correct schema

**Phase:** RED → GREEN
**Dependencies:** Task 001
**Parallelizable:** Yes

### [RED] Write failing test

**File:** `plugins/jules/servers/jules-mcp/src/tools.test.ts`

Add test in `jules_create_task` describe block:

```typescript
it('should use githubRepoContext.startingBranch for branch parameter', async () => {
  // Arrange
  vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
  vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

  // Act
  await tools.jules_create_task({
    repo: 'lvlup-sw/test-repo',
    prompt: 'Test task',
    branch: 'develop'
  });

  // Assert
  expect(mockClient.createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceContext: {
        source: 'sources/github/lvlup-sw/test-repo',
        githubRepoContext: {
          startingBranch: 'develop'
        }
      }
    })
  );
});

it('should use correct source format with slashes', async () => {
  // Arrange
  vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
  vi.mocked(mockClient.createSession).mockResolvedValue(mockSession);

  // Act
  await tools.jules_create_task({
    repo: 'lvlup-sw/test-repo',
    prompt: 'Test task'
  });

  // Assert
  expect(mockClient.createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceContext: expect.objectContaining({
        source: 'sources/github/lvlup-sw/test-repo'
      })
    })
  );
});
```

**Expected failure:** sourceContext uses old schema with `branch` instead of `githubRepoContext.startingBranch`

### [GREEN] Implement minimum code

**File:** `plugins/jules/servers/jules-mcp/src/tools.ts`

Update `jules_create_task` function (around lines 179-188):

```typescript
const session = await client.createSession({
  prompt: enhancedPrompt,
  sourceContext: {
    source: `sources/github/${validated.repo}`,
    githubRepoContext: validated.branch ? {
      startingBranch: validated.branch
    } : undefined
  },
  title: validated.title,
  requirePlanApproval: true,
  automationMode: 'AUTO_CREATE_PR'
});
```

---

## Task 004: Add source validation to jules_create_task

**Phase:** RED → GREEN
**Dependencies:** Task 003
**Parallelizable:** Yes

### [RED] Write failing test

**File:** `plugins/jules/servers/jules-mcp/src/tools.test.ts`

Add tests in `jules_create_task` describe block:

```typescript
it('should return error when repo is not connected to Jules', async () => {
  // Arrange
  vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);

  // Act
  const result = await tools.jules_create_task({
    repo: 'other-org/other-repo',
    prompt: 'Test task'
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('not connected to Jules');
  expect(result.content[0].text).toContain('lvlup-sw/test-repo');
  expect(mockClient.createSession).not.toHaveBeenCalled();
});

it('should return error with empty connected repos message when none connected', async () => {
  // Arrange
  vi.mocked(mockClient.listSources).mockResolvedValue([]);

  // Act
  const result = await tools.jules_create_task({
    repo: 'any/repo',
    prompt: 'Test task'
  });

  // Assert
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('not connected to Jules');
  expect(result.content[0].text).toContain('none');
});
```

**Expected failure:** No source validation exists, `createSession` is called without checking sources

### [GREEN] Implement minimum code

**File:** `plugins/jules/servers/jules-mcp/src/tools.ts`

Add source validation in `jules_create_task` before `createSession` call:

```typescript
async jules_create_task(
  input: z.infer<typeof createTaskSchema>
): Promise<ToolResult> {
  try {
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

    // ... rest of existing code
  }
}
```

---

## Task 005: Update existing tests for new schema

**Phase:** GREEN
**Dependencies:** Task 003
**Parallelizable:** Yes

### [GREEN] Update tests

**File:** `plugins/jules/servers/jules-mcp/src/tools.test.ts`

1. Add `listSources` mock to `jules_create_task` tests that need it:

```typescript
// In each test that calls jules_create_task successfully:
vi.mocked(mockClient.listSources).mockResolvedValue([mockSource]);
```

2. Update branch parameter test expectations (lines 116-122, 136-142):

```typescript
// Change from:
sourceContext: expect.objectContaining({
  branch: 'develop'
})
// To:
sourceContext: {
  source: 'sources/github/lvlup-sw/test-repo',
  githubRepoContext: {
    startingBranch: 'develop'
  }
}
```

3. Update default branch test (lines 125-143):

```typescript
// Test should verify githubRepoContext is undefined when branch not specified
// or has startingBranch: 'main'
```

**File:** `plugins/jules/servers/jules-mcp/src/jules-client.test.ts`

Update source context expectations in `createSession` tests (lines 100-150):

```typescript
// Update test at line 131-132:
sourceContext: {
  source: 'sources/github/lvlup-sw/test-repo',
  githubRepoContext: { startingBranch: 'develop' }
}
```

---

## Execution Order

```
Task 001 (types.ts)
       │
       ├──────────┬──────────┐
       ▼          ▼          ▼
Task 002     Task 003    Task 005
(fixtures)   (tools.ts)  (update tests)
                  │
                  ▼
             Task 004
         (source validation)
```

**Parallel groups:**
- Group A: Task 002, Task 003, Task 005 (can run after Task 001)
- Group B: Task 004 (runs after Task 003)

---

## Verification

After all tasks complete:

```bash
cd plugins/jules/servers/jules-mcp
npm test
```

All tests should pass with:
- Correct `sourceContext` schema using `githubRepoContext.startingBranch`
- Source format using slashes: `sources/github/{owner}/{repo}`
- Source validation returning helpful error for unconnected repos
