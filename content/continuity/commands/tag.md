---
description: "Retroactively attribute the current session to a feature, project, or concern."
---

# Tag Session

Attribute this session to **$ARGUMENTS**.

## When to Use

- Working outside a structured workflow (`/exarchos:ideate`, `/exarchos:debug`, `/exarchos:refactor`)
- Quick fixes, explorations, or ad-hoc changes you want linked to a feature
- Retroactively connecting work to a project after the fact

## Process

### Step 1: Resolve Session Context

Determine the current session ID and branch. These are available from the session environment.

### Step 2: Emit Tag Event

```
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append",
  stream: "tags",
  event: {
    type: "session.tagged",
    data: {
      tag: "$ARGUMENTS",
      sessionId: "<current session ID>",
      branch: "<current branch, if available>"
    },
    correlationId: "$ARGUMENTS",
    source: "user"
  }
})
```

### Step 3: Confirm

Output a brief confirmation:

```
Tagged this session as **$ARGUMENTS**.
```

## Notes

- Tags are lightweight annotations — no workflow state is created
- Multiple tags per session are allowed (run `/tag` again with a different label)
- Tags emit to a shared `tags` stream for cross-session queries via `exarchos_view`
- See `docs/guides/opt-in-tracking.md` for the philosophy behind opt-in tracking
