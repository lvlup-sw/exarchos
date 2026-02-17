---
name: skill-path-resolution
description: "Resolve @skills/<name>/SKILL.md paths to ~/.claude/skills/<name>/SKILL.md."
---

# Skill Path Resolution

`@skills/<name>/SKILL.md` resolves to `~/.claude/skills/<name>/SKILL.md`.

When encountered: read the skill file, follow its instructions, use templates from its directory. If not found, report to user and fall back to inline instructions.
