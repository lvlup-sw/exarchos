---
outline: deep
---

# Token Efficiency

## The problem

LLM context windows are finite. Every token spent on infrastructure is a token not available for actual coding work. Exarchos is infrastructure: it adds workflow state, event history, guard descriptions, and tool schemas to the agent's context. If this overhead is large, the agent has less room to think about your code.

This isn't a theoretical concern. A single full workflow state object can easily reach 2,000-3,000 tokens. Eagerly registering all tool schemas at MCP startup could cost thousands more. Multiply by the number of tool calls in a workflow, and infrastructure can consume a meaningful fraction of the context window.

Every design choice in Exarchos accounts for this cost.

## Lazy schema registration

At MCP startup, each tool registers with a slim one-line description and an enum of action names. No parameter schemas, no examples, no detailed descriptions. Here is what `exarchos_workflow` looks like at registration:

```
Workflow lifecycle management. Use describe(actions) for schemas.

Actions: init, get, set, cancel, cleanup, reconcile
```

Total startup cost: under 500 tokens for all four visible tools combined.

When the agent needs to call a specific action for the first time, it calls `describe`:

```json
{ "action": "describe", "actions": ["set"] }
```

This returns the full parameter schema, description, phase restrictions, and gate metadata for just that action. The agent pays for schema tokens only when it actually needs them.

Compare this to eager registration, where every tool would dump its complete schema into the system prompt at session start. The `exarchos_orchestrate` tool alone has 23 actions; eagerly registering all of them would cost thousands of tokens that most sessions would never use.

## Field projection

State queries accept a `fields` parameter that returns only the requested fields:

```json
{
  "action": "get",
  "featureId": "my-feature",
  "fields": ["phase", "tasks"]
}
```

This returns a response containing just `phase` and `tasks`, omitting the event log, artifacts map, review results, synthesis metadata, and everything else. Typical reduction: roughly 90% fewer tokens than returning the full state object.

Agents learn to request only what they need for the current operation. A guard check might request `["phase", "artifacts"]`. A delegation step might request `["tasks", "worktrees"]`. A reconciliation might request nothing (the server handles it internally).

## Artifact references

Design docs, implementation plans, review findings, and PR links are stored as file paths in state, not inlined as content:

```json
{
  "artifacts": {
    "design": "docs/designs/my-feature.md",
    "plan": "docs/plans/my-feature-plan.md"
  }
}
```

When the agent needs the design doc, it reads the file directly using its built-in file tools. The MCP server never loads artifact content into state objects.

This prevents state from growing unbounded as artifacts accumulate. A design doc might be 3,000 tokens. A plan might be 2,000 tokens. Inlining both into every state response would add 5,000 tokens to every `get` call. Storing paths instead costs a few dozen tokens.

## Diff-based review

Code review operates on git diffs, not full file contents. The review scripts use `git diff` to extract only the changed lines, then analyze those changes.

For a typical feature touching 10 files with 200 lines changed across 5,000 total lines, diff-based review processes roughly 200 lines instead of 5,000. That is a 96% reduction in the tokens the reviewer agent needs to consume.

Review findings reference file paths and line numbers rather than quoting code blocks. The agent can read the relevant file section if it needs more context, but the review itself stays compact.

## Slim responses

Beyond field projection, several other techniques keep responses small:

- Materialized views (`exarchos_view`) pre-aggregate data. The `pipeline` view returns a summary of all active workflows with phase, task counts, and stack positions, not the full state of every workflow.
- Event log cap. The in-memory event log is capped at 100 entries. Older events are still in the JSONL file but don't inflate state responses.
- Compact telemetry. The telemetry view supports a `compact` mode that returns only the top-level metrics, omitting per-tool breakdowns unless requested.

## Quantified impact

| Technique | Token reduction | Where it applies |
|-----------|----------------|------------------|
| Lazy schemas | ~80% vs. eager registration | MCP startup |
| Field projection | ~90% on state queries | Every `get` call |
| Artifact references | Unbounded savings | State objects with design docs, plans |
| Diff-based review | ~97% vs. full file content | Code review phase |
| Materialized views | ~70% vs. raw event queries | Pipeline and status views |

These savings compound. A workflow that makes 50 state queries over its lifetime saves tens of thousands of tokens through field projection alone. Combined with lazy schemas and artifact references, Exarchos typically consumes less than 5% of the context window budget for its infrastructure overhead.
