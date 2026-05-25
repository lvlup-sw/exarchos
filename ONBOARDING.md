# Welcome to Exarchos

## How We Use Claude

Based on Reed's usage over the last 30 days:

Work Type Breakdown:
  Build Feature     ███████████████░░░░░  35%
  Plan Design       ████████████░░░░░░░░  29%
  Improve Quality   █████████░░░░░░░░░░░  21%
  Debug Fix         ██████░░░░░░░░░░░░░░  15%

Top Skills & Commands:
  /exarchos:rehydrate   ████████████████████  39x/month
  /exarchos:ideate      ███████████████░░░░░  29x/month
  /exarchos:shepherd    ██████████████░░░░░░  28x/month
  /exarchos:checkpoint  ██████████░░░░░░░░░░  20x/month
  /exarchos:discover    ████████░░░░░░░░░░░░  15x/month
  /goal                 ██████░░░░░░░░░░░░░░  11x/month

Top MCP Servers:
  exarchos         ████████████████████  1674 calls
  exa              █░░░░░░░░░░░░░░░░░░░░  64 calls
  microsoft-learn  ░░░░░░░░░░░░░░░░░░░░  11 calls
  context7         ░░░░░░░░░░░░░░░░░░░░  8 calls
  serena           ░░░░░░░░░░░░░░░░░░░░  1 call

## Your Setup Checklist

### Codebases
- [ ] exarchos — https://github.com/lvlup-sw/exarchos

### MCP Servers to Activate
- [ ] exarchos — The core workflow engine: event-sourced SDLC workflows, agent orchestration, state views. Ships with the Exarchos Claude Code plugin via the lvlup-sw marketplace (`/plugin`).
- [ ] exa — Web search and page fetch for research. Add via the Exa MCP server (needs an Exa API key).
- [ ] microsoft-learn — Official Microsoft/Azure docs lookup. Public hosted MCP server, no key required.
- [ ] context7 — Up-to-date library/framework docs. Ships as a Claude Code plugin (`/plugin`).
- [ ] serena — Semantic code navigation (symbol search, references). Plugin-based; remember to run `activate_project` before other Serena tools.

### Skills to Know About
- [ ] /exarchos:rehydrate — Re-injects workflow state and behavioral guidance into context. The team's most-used command — run it after `/clear` or when resuming a workflow.
- [ ] /exarchos:ideate — Starts collaborative design exploration for a feature or problem. Where most new work begins.
- [ ] /exarchos:shepherd — Drives PRs through CI and reviews to merge readiness.
- [ ] /exarchos:checkpoint — Saves workflow state and prepares for session handoff (use before context exhaustion).
- [ ] /exarchos:discover — Starts a research/investigation workflow producing document deliverables.
- [ ] /goal — Sets the working goal for the session.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
