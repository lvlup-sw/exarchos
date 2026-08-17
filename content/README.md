# `content/` — authored content

The source of truth for every skill, command and rule the product ships. These
are structured Markdown, not executable code: they instruct an agent, and the
renderer projects them per harness runtime into `rendered/`.

Content is grouped by DOMAIN rather than by artifact kind — `design/`,
`delivery/`, `review/`, `synthesis/`, `continuity/`, `governance/`,
`remediation/`, `harness/`, plus `_shared/`. A domain holds its own
`commands/`, `skills/` and their `references/` together, so everything one
workflow needs is in one place.

## What belongs here

- `SKILL.md` entry points, with `{{TOKEN}}` placeholders the renderer
  substitutes per runtime.
- `references/` beside a skill: the detail a skill points at rather than
  inlines.
- Commands and rules, authored the same way.
- A `SKILL.<runtime>.md` override where one runtime genuinely needs different
  prose.

## What does not

- **Anything rendered.** Editing `rendered/` directly fails `npm run
  render:guard`, which re-renders from here and diffs.
- **Executable code.** A skill describes what to do and names the tools that
  do it.

## Two rules the build enforces

**Frontmatter is for entry points only.** `SKILL.md`, `commands/*.md` and
`rules/*.md` carry it; a file under `references/` must not. A reference with
frontmatter is treated as an entry point by every runtime that scans this tree.

**A skill that calls Exarchos tools must declare it.** Set
`metadata.mcp-server: exarchos` in the frontmatter. Utility and standards
skills that invoke nothing are exempt.

After editing, run `npm run build:skills` and commit BOTH the source here and
the regenerated tree.
