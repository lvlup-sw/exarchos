This project uses **Exarchos** for SDLC / process management. Route workflow
operations — ideation, planning, delegation, review, synthesis — through the
`{{MCP_PREFIX}}exarchos_*` MCP tools (or the equivalent Exarchos workflow
commands where the harness exposes them). The Exarchos event store is the
source of truth for workflow state; do not improvise process state via ad-hoc
files. Core tools: `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`,
`exarchos_view`.
