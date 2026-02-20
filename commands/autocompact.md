---
description: Toggle autocompact on/off or set threshold percentage
---

# Autocompact Toggle

Manage the `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` setting in `~/.claude/settings.json`.

## Arguments

- No arguments or `status`: Show current autocompact state
- `on`: Enable autocompact at 95%
- `off`: Disable autocompact (remove the env var)
- A number (1-100): Set autocompact to that percentage

**Input:** "$ARGUMENTS"

## Process

1. Read `~/.claude/settings.json`
2. Check `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`:
   - If present: autocompact is **on** at that percentage
   - If absent: autocompact is **off** (uses Claude Code default behavior)
3. Apply the requested action:
   - **`on`**: Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `"95"` in the `env` object
   - **`off`**: Remove `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` from the `env` object
   - **Number**: Set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to that number as a string
   - **`status` or empty**: Just report current state
4. Write updated JSON back (preserve all other settings)
5. Report the change — note it takes effect on the **next session**

## Output Format

```
Autocompact: ON (95%) → OFF
Changes take effect on next session.
```
