---
name: pr-descriptions
description: "PR title and body format guidelines for Graphite stacked PRs."
---

# PR Descriptions

**Title:** `<type>: <what>` (max 72 chars)

**Body:** Summary (2-3 sentences) → Changes (bulleted, `**Component** — description`) → Test Plan → Footer (`---` + results, design doc, related PRs). Aim for 120-200 words.

See `skills/synthesis/references/pr-descriptions.md` for template and examples.

**Enforcement:** CI runs `scripts/validate-pr-body.sh` on every PR. Bodies missing `## Summary`, `## Changes`, or `## Test Plan` will fail the check. After `gt submit`, update each PR body via `gh pr edit <number> --body "..."`.

**Custom templates:** Projects can override the default required sections by placing a `.exarchos/pr-template.md` file in the repo root. Any `## Section` headers in the template define the required sections for validation.
