---
name: discovery
description: "Research and discovery workflow for document deliverables — competitive analyses, architecture comparisons, ADR scaffolding, literature reviews, vendor evaluations. No TDD requirement. Phases: gathering → synthesizing → completed. Triggers: 'discover', 'research', 'explore topic', or /exarchos:discover."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: gathering
---

# Discovery Workflow Skill

A workflow type for tasks whose deliverable is a **document, not code**. Explicitly
exempt from the Iron Law (no failing test requirement) because there is nothing to test.

## When to Use

- Competitive analyses and market research
- Architecture comparisons and ADR scaffolding
- Literature reviews and vendor evaluations
- Design research that does NOT feed into implementation planning

## When NOT to Use

- If the deliverable includes code changes → use `/exarchos:oneshot` or `/exarchos:ideate`
- If you need TDD enforcement → use any other workflow type
- If the research feeds directly into implementation → use `/exarchos:ideate` (which includes a design phase)

## Phases

### Phase 1: Gathering (initial)

Collect sources, references, and raw material for the deliverable.

1. Define the research question or deliverable scope
2. Identify and collect sources (URLs, documents, code references)
3. Record sources in workflow state:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "set", featureId: "<id>",
  updates: { "artifacts.sources": ["<source1>", "<source2>", "..."] }
})
```

4. Create an outline of the deliverable

**Transition:** When `artifacts.sources` is a non-empty array → `synthesizing`

### Phase 2: Synthesizing

Draft the deliverable document from gathered sources.

1. Write the document based on gathered sources and outline
2. Commit the document to the repo (typically under `docs/research/` or `docs/designs/`)
3. Record the report path:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_workflow({
  action: "set", featureId: "<id>",
  updates: { "artifacts.report": "<path-to-document>" }
})
```

**Transition:** When `artifacts.report` is set → `completed`

### Optional: Escalation to Implementation

If discovery surfaces an implementation need:

1. Note the finding in the report
2. After completing the discovery workflow, start a new workflow:
   ```
   /exarchos:ideate <implementation-topic>
   ```
   Reference the discovery report as design input.

## Event Emissions

Emit events at key moments:

```typescript
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append", stream: "<featureId>",
  event: { type: "discovery.sources_collected", data: { sourceCount: N } }
})
```

```typescript
mcp__plugin_exarchos_exarchos__exarchos_event({
  action: "append", stream: "<featureId>",
  event: { type: "discovery.report_committed", data: { path: "<report-path>" } }
})
```
