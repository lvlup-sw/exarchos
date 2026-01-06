# Integrator Prompt Template

Use this template when dispatching integration tasks via the Task tool.

## Template

```markdown
# Integration Task: [Feature Name]

## Working Directory
[Main project root - NOT a worktree]

## Integration Branch
feature/integration-[feature-name]

## Branches to Merge (in dependency order)
1. feature/001-[name] (.worktrees/001-[name])
2. feature/002-[name] (.worktrees/002-[name])
3. feature/003-[name] (.worktrees/003-[name])

## Steps

### Step 1: Prepare Integration Branch
```bash
git checkout main
git pull origin main
git checkout -b feature/integration-[feature-name]
```

### Step 2: Merge Branches
For each branch in order:
```bash
git merge --no-ff feature/[branch-name] -m "Merge feature/[branch-name]"
npm run test:run  # Stop if fails, report which merge broke
```

### Step 3: Full Verification
```bash
npm run test:run
npm run typecheck
npm run lint
npm run build
```

## Success Criteria

- All branches merged without conflict
- All tests pass after each merge
- Final test suite passes
- Type check passes
- Lint passes
- Build succeeds

## On Failure

If any step fails, report:
1. Which step failed (merge, test, typecheck, lint, build)
2. Which branch caused the failure (if merge-related)
3. Error output
4. Files involved
5. Suggested fix

Do NOT attempt to fix issues - report them for the orchestrator to create fix tasks.

## Completion

Report final status:
- PASS: All verifications passed, integration branch ready for review
- FAIL: [Step] failed with [error], branch [name] responsible
```

## Usage Example

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Integrate: user-auth feature",
  prompt: `
# Integration Task: User Authentication

## Working Directory
/home/user/project

## Integration Branch
feature/integration-user-auth

## Branches to Merge (in dependency order)
1. feature/001-types (.worktrees/001-types)
2. feature/002-models (.worktrees/002-models)
3. feature/003-api (.worktrees/003-api)
4. feature/004-tests (.worktrees/004-tests)

## Steps

### Step 1: Prepare Integration Branch
\`\`\`bash
git checkout main
git pull origin main
git checkout -b feature/integration-user-auth
\`\`\`

### Step 2: Merge Branches
For each branch in order:
\`\`\`bash
git merge --no-ff feature/[branch-name] -m "Merge feature/[branch-name]"
npm run test:run
\`\`\`

### Step 3: Full Verification
\`\`\`bash
npm run test:run
npm run typecheck
npm run lint
npm run build
\`\`\`

## Success Criteria

- All branches merged without conflict
- All tests pass
- Type check passes
- Lint passes
- Build succeeds

## On Failure

Report: step, branch, error output, files, suggested fix.
Do NOT attempt fixes.
`
})
```

## Key Principles

1. **Main project root** - Integration runs in main, not worktree
2. **Dependency order** - Merge branches in correct sequence
3. **Incremental verification** - Test after each merge
4. **Report, don't fix** - Integrator reports issues, doesn't fix them
5. **Clear failure details** - Include all context for fix tasks
