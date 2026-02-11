# Debug Workflow State Schema

Extended schema for debug workflow state files.

## Base Schema

Debug workflows extend the standard workflow state with additional fields.

```json
{
  "version": "1.1",
  "featureId": "debug-<issue-slug>",
  "workflowType": "debug",
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "track": "hotfix | thorough",
  "phase": "triage | investigate | rca | design | debug-implement | debug-validate | debug-review | hotfix-implement | hotfix-validate | synthesize | completed | cancelled | blocked",

  "urgency": {
    "level": "P0 | P1 | P2",
    "justification": "string"
  },

  "triage": {
    "symptom": "string",
    "reproduction": "string | null",
    "affectedArea": "string",
    "impact": "string"
  },

  "investigation": {
    "startedAt": "ISO8601 | null",
    "completedAt": "ISO8601 | null",
    "rootCause": "string | null",
    "findings": ["string"]
  },

  "artifacts": {
    "rca": "string | null",
    "fixDesign": "string | null",
    "pr": "string | null"
  },

  "followUp": {
    "rcaRequired": "boolean",
    "issueUrl": "string | null"
  },

  "tasks": [],
  "worktrees": {},
  "reviews": {},
  "synthesis": {
    "integrationBranch": "string | null",
    "mergeOrder": [],
    "mergedBranches": [],
    "prUrl": "string | null",
    "prFeedback": []
  }
}
```

## Field Definitions

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Schema version, currently "1.1" |
| `featureId` | string | Unique identifier, format: `debug-<issue-slug>` |
| `workflowType` | string | Always "debug" for debug workflows |
| `createdAt` | ISO8601 | When workflow was created |
| `updatedAt` | ISO8601 | Last modification timestamp |
| `track` | enum | "hotfix" or "thorough" |
| `phase` | enum | Current workflow phase |

### Phase Values

| Track    | Valid Phases                                                                          |
|----------|-----------------------------------------------------------------------------------------|
| Hotfix   | triage → investigate → hotfix-implement → hotfix-validate → completed                                 |
| Thorough | triage → investigate → rca → design → debug-implement → debug-validate → debug-review → synthesize → completed |

Note: Thorough track may skip `rca` and `design` phases if root cause is straightforward.

### Urgency Object

```json
{
  "urgency": {
    "level": "P0",
    "justification": "Production login broken, 100% of users affected"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `level` | enum | P0 (critical), P1 (high), P2 (normal) |
| `justification` | string | Why this urgency level was selected |

### Triage Object

```json
{
  "triage": {
    "symptom": "Login returns 500 error",
    "reproduction": "Click login button with valid credentials",
    "affectedArea": "src/auth/login.ts",
    "impact": "All users cannot log in"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `symptom` | string | Observable problem description |
| `reproduction` | string\|null | Steps to reproduce, null if unknown |
| `affectedArea` | string | Suspected code area or component |
| `impact` | string | Business/user impact description |

### Investigation Object

```json
{
  "investigation": {
    "startedAt": "2026-01-27T10:00:00Z",
    "completedAt": "2026-01-27T10:15:00Z",
    "rootCause": "Session cookie SameSite attribute mismatch",
    "findings": [
      "Error occurs in handleLogin function",
      "Session object is null when it shouldn't be",
      "Cookie not being set due to browser security policy"
    ]
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `startedAt` | ISO8601\|null | When investigation began |
| `completedAt` | ISO8601\|null | When root cause was found |
| `rootCause` | string\|null | Final root cause determination |
| `findings` | string[] | Progressive findings during investigation |

### Artifacts Object

```json
{
  "artifacts": {
    "rca": "docs/rca/2026-01-27-login-500-error.md",
    "fixDesign": "Set SameSite=None on session cookie, add Secure flag",
    "pr": "https://github.com/org/repo/pull/123"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `rca` | string\|null | Path to RCA document (thorough track only) |
| `fixDesign` | string\|null | Brief fix description (in state, not separate doc) |
| `pr` | string\|null | Pull request URL |

### Follow-Up Object

```json
{
  "followUp": {
    "rcaRequired": true,
    "issueUrl": "https://github.com/org/repo/issues/456"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `rcaRequired` | boolean | True if hotfix shipped without full RCA |
| `issueUrl` | string\|null | Link to follow-up issue for RCA |

## State Transitions

### Hotfix Track

```text
triage → investigate → hotfix-implement → hotfix-validate → completed
   │          │               │                 │                │
   │          │               │                 │                └─ Human checkpoint: merge
   │          │               │                 └─ Run smoke tests
   │          │               └─ Apply minimal fix
   │          └─ Find root cause (15 min max)
   └─ Gather context, select track
```

### Thorough Track

```text
triage → investigate → rca → design → debug-implement → debug-review → synthesize → completed
   │          │         │       │            │                │              │          │
   │          │         │       │            │                │              │          └─ Merge
   │          │         │       │            │                │              └─ Create PR
   │          │         │       │            │                └─ Spec review
   │          │         │       │            └─ TDD implementation
   │          │         │       └─ Brief fix approach
   │          │         └─ Full RCA document
   │          └─ Systematic investigation
   └─ Gather context, select track
```

## Example State Files

### Hotfix In Progress

```json
{
  "version": "1.1",
  "featureId": "debug-login-500",
  "workflowType": "debug",
  "createdAt": "2026-01-27T10:00:00Z",
  "updatedAt": "2026-01-27T10:12:00Z",
  "track": "hotfix",
  "phase": "hotfix-implement",
  "urgency": {
    "level": "P0",
    "justification": "Production login broken"
  },
  "triage": {
    "symptom": "Login returns 500",
    "reproduction": "Click login with valid creds",
    "affectedArea": "src/auth/login.ts",
    "impact": "All users blocked"
  },
  "investigation": {
    "startedAt": "2026-01-27T10:02:00Z",
    "completedAt": "2026-01-27T10:10:00Z",
    "rootCause": "Missing null check on session",
    "findings": [
      "Error in handleLogin line 42",
      "Session is null when user has no prior session"
    ]
  },
  "artifacts": {
    "rca": null,
    "fixDesign": "Add null check before accessing session properties",
    "pr": null
  },
  "followUp": {
    "rcaRequired": true,
    "issueUrl": null
  }
}
```

### Thorough Completed

```json
{
  "version": "1.1",
  "featureId": "debug-cart-total-wrong",
  "workflowType": "debug",
  "createdAt": "2026-01-26T14:00:00Z",
  "updatedAt": "2026-01-27T09:00:00Z",
  "track": "thorough",
  "phase": "completed",
  "urgency": {
    "level": "P2",
    "justification": "Cart shows wrong total, workaround is refresh"
  },
  "triage": {
    "symptom": "Cart total doesn't update after removing item",
    "reproduction": "Add 2 items, remove 1, total shows both",
    "affectedArea": "src/cart/CartTotal.tsx",
    "impact": "Users confused, may abandon checkout"
  },
  "investigation": {
    "startedAt": "2026-01-26T14:05:00Z",
    "completedAt": "2026-01-26T15:30:00Z",
    "rootCause": "React state not updating due to stale closure in useEffect",
    "findings": [
      "Total computed in useEffect",
      "Effect has stale items reference",
      "Missing items in dependency array"
    ]
  },
  "artifacts": {
    "rca": "docs/rca/2026-01-26-cart-total-wrong.md",
    "fixDesign": "Add items to useEffect deps, use useMemo for total",
    "pr": "https://github.com/org/repo/pull/789"
  },
  "followUp": {
    "rcaRequired": false,
    "issueUrl": null
  }
}
```
