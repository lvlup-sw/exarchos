# Runtime Notes

Per-runtime quirks and decisions captured during implementation. This file
is the narrative companion to the structured `runtimes/<name>.yaml` files —
if a value in one of those YAML files needs explanation, the rationale
belongs here.

Each section is filled in by the owner of the corresponding task in the
platform-agnostic skills initiative (Lane B). Sections without detail are
placeholders until their owner synthesizes recon findings.

## Claude Code

(placeholder — Lane B task-010 owner: fill in during synthesis)

Points to capture: composite plugin MCP prefix, Task tool shape for
sub-agent spawning, how hooks are declared, slash-command namespacing.

## Codex

(placeholder — Lane B task-011 recon findings go here)

Points to capture: binary name on PATH, session env-var signal, skills
directory layout, any lack of sub-agent support.

## OpenCode

(placeholder — Lane B task-012)

## Copilot CLI

(placeholder — Lane B task-013)

## Cursor

(placeholder — Lane B task-014)

## Generic

(placeholder — Lane B task-009)

The generic runtime is the fallback used when no agent is detected on
the host. It must render coherently without assuming any agent-specific
feature: no sub-agents, no hooks, no slash commands, no skill chaining.
All placeholder substitutions for generic should read naturally as prose.
