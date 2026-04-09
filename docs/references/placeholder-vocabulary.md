# Placeholder Vocabulary

Canonical placeholder tokens consumed by the skills build renderer.

The renderer reads a source skill, looks up the active runtime map
(`runtimes/<name>.yaml`), and substitutes each token below with the
runtime-specific value. Unknown tokens are a build error so typos are
surfaced early.

| Token | Purpose | Example (claude) | Example (generic) |
|---|---|---|---|
| `{{MCP_PREFIX}}` | Prefix prepended to every MCP tool name. Runtimes that expose plugin-provided tools under a composite namespace use a longer prefix. | `mcp__plugin_exarchos_exarchos__` | `mcp__exarchos__` |
| `{{COMMAND_PREFIX}}` | Slash-command prefix. Runtimes without slash-command support collapse this to an empty string so the rendered text reads naturally. | `/exarchos:` | `` |
| `{{TASK_TOOL}}` | How the runtime spawns a parallel sub-task. Runtimes with true sub-agents name their task tool; runtimes without them fall back to a textual directive. | `Task` | `[sequential execution]` |
| `{{CHAIN next="..." args="..."}}` | How one skill hands off to the next. Runtimes with skill chaining emit a structured invocation; runtimes without it emit prose. | `Skill({...})` | `[Invoke...]` |
| `{{SPAWN_AGENT_CALL}}` | Full multi-line spawn block (when the runtime supports it) or a prose-style directive for runtimes that do not. | multi-line `Task({...})` | prose directive |

See `runtimes/<name>.yaml` for canonical substitution values — those files
are the source of truth, this table is a quick-reference overview.

## Adding a new placeholder

1. Add an entry to the `placeholders` map in every `runtimes/*.yaml` file
   (the YAML loader validates the presence of required fields but the
   placeholder map itself is open-ended).
2. Add a row to the table above with a short explanation and a
   contrasting example (a high-capability runtime vs. the `generic`
   fallback).
3. Reference the token in the skill source that needs it.

## Adding a new runtime

1. Add `runtimes/<name>.yaml` with values for every existing placeholder.
2. Add the runtime's name to `REQUIRED_RUNTIME_NAMES` in
   `src/runtimes/load.ts` so the loader enforces its presence.
3. Add a row to `docs/references/runtime-notes.md` with any quirks you
   discovered while authoring the map.
