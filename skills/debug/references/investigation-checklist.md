# Investigation Checklist

Systematic approach to finding root cause during the investigate phase.

## Investigation Process

### Step 1: Reproduce the Issue

Before investigating, ensure you can trigger the bug:

```bash
# Run the reproduction steps
# Observe the failure
# Capture any error output (redact secrets/PII before sharing)
```

**If cannot reproduce:**
- Check environment differences (local vs prod)
- Check data differences (test vs real data)
- Check timing/race conditions
- Ask for more context from reporter

### Step 2: Identify Entry Point

Find where the problem manifests:

| Entry Point Type | How to Find |
|-----------------|-------------|
| Error message | Search codebase for exact text |
| Failing test | Read test output for assertion location |
| User report | Trace from UI component to backend |
| Log entry | Search logs for timestamp, correlate with code |

**Tools:**
```bash
# Search for error message
Grep({ pattern: "exact error text", output_mode: "content" })

# Find related files
Glob({ pattern: "**/auth/**/*.ts" })

# Read suspicious file
Read({ file_path: "/path/to/file.ts" })
```

### Step 3: Trace Execution Path

Follow the code from entry point to failure:

1. **Identify the call stack** - What functions are called?
2. **Check input values** - Are parameters valid?
3. **Trace data flow** - Where does data transform?
4. **Find the divergence** - Where does actual != expected?

**Tracing Pattern:**
```text
Entry Point → Function A → Function B → [FAILURE POINT] → Function C (never reached)
```

### Step 4: Narrow Down Location

Use binary search to isolate the problem:

1. Add logging/breakpoints at midpoint
2. Determine which half contains bug
3. Repeat until isolated to specific lines

**Quick Logging:**
```typescript
console.log('[DEBUG] checkpoint 1:', { value });
console.log('[DEBUG] checkpoint 2:', { transformed });
console.log('[DEBUG] checkpoint 3:', { result });
```

### Step 5: Understand the Why

Once located, understand the mechanism:

- **What condition fails?** (if/else, validation, null check)
- **Why is that condition triggered?** (bad input, state corruption, race)
- **When was this introduced?** (recent change, always broken, regression)

## Hotfix Time-Boxing (15 Minutes)

For hotfix track, investigation is time-boxed:

```text
0:00  - Start investigation
0:05  - Should have identified entry point
0:10  - Should have narrowed to general area
0:15  - DECISION POINT
       │
       ├─ Root cause found → Continue to fix phase
       │
       └─ Root cause NOT found → Switch to thorough track
```

### 15-Minute Checkpoint Questions

At 15 minutes, ask:
1. Do I know the exact cause?
2. Do I know exactly what code to change?
3. Am I confident the fix won't break other things?

If any answer is "no" -> switch to thorough track.

### Switching to Thorough Track

Use `mcp__workflow-state__workflow_set` to update state:

```text
# Update track
Use mcp__workflow-state__workflow_set with featureId:
  updates: { "track": "thorough" }

# Record investigation findings so far
Use mcp__workflow-state__workflow_set with featureId:
  updates: {
    "investigation.findings": ["Investigated for 15 min, narrowed to auth module but root cause unclear"]
  }
```

## Investigation Tools

### For Code Search

```typescript
// Find error message source
Grep({ pattern: "Error: something failed", output_mode: "content" })

// Find function definition
Grep({ pattern: "function handleLogin", output_mode: "content" })

// Find all usages
Grep({ pattern: "handleLogin\\(", output_mode: "files_with_matches" })
```

### For Codebase Exploration

```typescript
// Use Explore agent for complex investigation
Task({
  subagent_type: "Explore",
  description: "Find auth error handling",
  prompt: "Find where authentication errors are handled and what could cause a 500 response"
})
```

### For Test Execution

```bash
# Run specific test to see failure
npm run test:run -- --grep "login"

# Run tests with verbose output
npm run test:run -- --reporter=verbose

# Run tests in specific file
npm run test:run -- src/auth/login.test.ts
```

### For Git History

```bash
# Find when file was last changed
git log --oneline -10 -- src/auth/login.ts

# Find what changed recently
git diff HEAD~5 -- src/auth/

# Blame specific lines
git blame -L 50,60 src/auth/login.ts
```

## Recording Findings

Update state with investigation progress using `mcp__workflow-state__workflow_set`:

```text
# Add finding
Use mcp__workflow-state__workflow_set with featureId:
  updates: {
    "investigation.findings": ["Error occurs in handleLogin when session is null"]
  }

# Record root cause when found
Use mcp__workflow-state__workflow_set with featureId:
  updates: {
    "investigation.rootCause": "Session cookie not being set due to SameSite attribute mismatch"
  }

# Mark investigation complete
Use mcp__workflow-state__workflow_set with featureId:
  updates: {
    "investigation.completedAt": "2026-01-27T10:30:00Z"
  }
```

## Common Bug Patterns

Quick reference for common root causes:

| Symptom | Common Causes |
|---------|---------------|
| Null/undefined error | Missing null check, async race, optional field |
| Type error | Wrong cast, schema mismatch, serialization issue |
| Timeout | N+1 query, missing index, external service slow |
| 500 error | Unhandled exception, missing env var, DB connection |
| Wrong data | Cache stale, transaction isolation, merge conflict |
| UI not updating | State not propagated, missing re-render, stale closure |

## Escalation Triggers

During investigation, escalate to `/ideate` if you discover:

- [ ] Fundamental design flaw requiring architectural change
- [ ] Multiple interconnected bugs requiring coordinated fix
- [ ] Security vulnerability requiring careful handling
- [ ] Data corruption requiring recovery strategy
- [ ] Issue affecting multiple teams/services
