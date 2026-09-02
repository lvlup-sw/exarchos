---
layout: home

hero:
  name: Exarchos
  text: Local agent governance for Claude Code
  tagline: Event-sourced SDLC workflows with agent-team coordination. Checkpoint any task, resume where you left off.
  image:
    src: /architecture.svg
    alt: Exarchos architecture
  actions:
    - theme: brand
      text: Install
      link: https://github.com/lvlup-sw/exarchos#installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/lvlup-sw/exarchos

features:
  - title: Durable workflows
    details: Every phase transition is an event. State is a projection of that log, so a workflow survives a lost session, a crashed agent, or a context window that filled up mid-task.
  - title: Agent teams
    details: Dispatch implementation tasks to subagents in isolated git worktrees, with verification depth scaled to each task's blast radius rather than a uniform ceremony.
  - title: Standalone CLI
    details: Ships as a single binary with an optional MCP subcommand. The workflow engine is the same either way — the facade is just how you reach it.
---

## The written guides are being rewritten

This site previously carried a set of hand-written pages describing a version of
Exarchos that several refactors had moved past. They were removed rather than
migrated: a stale page outranks the source in a search result, which makes it
worse than no page at all.

Until the rewrite lands, the accurate descriptions are the ones kept next to the
code:

- **[The repository README](https://github.com/lvlup-sw/exarchos#readme)** —
  installation, the command surface, and what Exarchos is for.
- **[CONTRIBUTING](https://github.com/lvlup-sw/exarchos/blob/main/CONTRIBUTING.md)**
  and **[ONBOARDING](https://github.com/lvlup-sw/exarchos/blob/main/ONBOARDING.md)** —
  working on Exarchos itself.
- **Directory READMEs** — each top-level directory states what belongs in it and
  what does not, and a test keeps that true.
