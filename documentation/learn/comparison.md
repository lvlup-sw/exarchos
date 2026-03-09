# Comparison

## Feature comparison

| Feature | Exarchos | Obra Superpowers | Claude Task Master | Manual (plan.md) |
|---------|----------|-----------------|-------------------|-----------------|
| State persistence across sessions | Event-sourced, survives compaction | Session-based | Task file on disk | None |
| Phase-gated workflows | State machine with guards | No | No | Manual discipline |
| Quality verification | Automated convergence gates | No | No | Manual review |
| Agent team coordination | Typed agents in worktrees | Mode switching | No | No |
| Token efficiency | Lazy schemas, field projection | N/A | Full context load | Full context load |
| Audit trail | Append-only event log | No | No | Git history only |
| Learning curve | Moderate | Low | Low | None |
| Platform support | Claude Code | VS Code | Claude Code | Any |

## Where Exarchos fits well

Durability. If your sessions regularly hit context compaction, or you work across multiple days on a single feature, Exarchos solves the "re-explain everything" problem. The event log persists state independently of the LLM context window. Checkpoint before compaction, rehydrate after. Your workflow picks up where it left off.

Verification. If you've been burned by an agent that says "done" when it isn't, convergence gates give you automated checks instead of trust. Specification fidelity, type checking, test coverage, error handling, test determinism. These run as scripts, not as prompts the agent can ignore.

Coordination. If your features involve multiple files or modules that could be worked on in parallel, agent teams let you dispatch tasks to separate worktrees. Each agent has scoped tools and responsibilities. The implementer writes code. The reviewer checks it. Neither can do the other's job.

## Trade-offs

Higher learning curve. Raw Claude Code with a plan file has zero setup cost. Exarchos has concepts to learn: workflows, phases, convergence gates, agent roles. The structured approach pays off on longer tasks, but adds overhead to quick one-off changes. If you just need to rename a variable, you don't need a workflow.

Claude Code only. Exarchos integrates deeply with Claude Code's plugin system, lifecycle hooks, and agent framework. This is a deliberate choice: deep integration over portability. It won't work with other AI coding tools.

MCP server overhead. The MCP server adds a process and file I/O to your development setup. Lazy schema registration and field projection minimize the token cost, but there's still overhead compared to stateless operation. The trade-off is durability: you pay a small cost per operation to get crash recovery and a complete audit trail.

## Complementary tools

Exarchos manages workflow state and coordination. It doesn't do code analysis or fetch documentation. The dev companion (`npx @lvlup-sw/exarchos-dev`) optionally installs three MCP servers that fill those gaps:

- Serena provides semantic code analysis: symbol resolution, reference finding, and structural understanding of your codebase.
- Context7 provides up-to-date library documentation, so the agent works with current APIs instead of stale training data.
- Microsoft Learn provides Azure and .NET documentation for projects in that ecosystem.

These are independent tools. You can use Exarchos without them, or use them without Exarchos. The dev companion just makes it easy to install them together.
