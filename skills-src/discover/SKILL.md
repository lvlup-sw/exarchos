---
name: discover
description: "Research and discovery workflow for document deliverables — competitive analyses, architecture comparisons, ADR scaffolding, literature reviews, vendor evaluations. No TDD requirement. Phases: gathering → synthesizing → completed. Triggers: 'discover', 'research', 'explore topic', or {{COMMAND_PREFIX}}discover."
metadata:
  author: exarchos
  version: 1.0.0
  mcp-server: exarchos
  category: workflow
  phase-affinity: gathering
---

# Discovery Workflow Skill

A workflow type for tasks whose deliverable is a **document, not code**. It carries
no verification gates (nothing to test), so the verification ladder does not apply.

## When to Use

- Competitive analyses and market research
- Architecture comparisons and ADR scaffolding
- Literature reviews and vendor evaluations
- Design research that does NOT feed into implementation planning

## When NOT to Use

- If the deliverable includes code changes → use `/exarchos:oneshot` or `/exarchos:ideate`
- If you need TDD enforcement → use any other workflow type
- If the research feeds directly into implementation → use `/exarchos:ideate` (which authors the Design & Rationale section of the unified `docs/specs/` artifact)

## Discover bridge (the deep-rung escalation)

At the `deep` planning rung, `/exarchos:ideate` can escalate to this workflow as a **first-class, event-linked research pre-pass** instead of a manual "go start a new workflow" handoff. The bridge is **opt-in** (author-confirmed, never auto-run): the affordance is surfaced on `next_actions`, and the `discover_bridge` orchestrate action — invoked with `confirm: true` — stitches this discovery run to the originating spec by a deterministic `correlationId` (recorded as a `state.patched` link event on the feature stream). When you run a discovery escalated this way, cite the report path in the spec's `## Design & Rationale` → Exploration section, and `init` this workflow with the bridge's `correlationId` so provenance spans both documents.

## Phases

### Phase 1: Gathering (initial)

Collect sources, references, and raw material for the deliverable.

1. Define the research question or deliverable scope
2. Identify and collect sources (URLs, documents, code references)
3. Record sources in workflow state:

```typescript
{{MCP_PREFIX}}exarchos_workflow({
  action: "update", featureId: "<id>",
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
{{MCP_PREFIX}}exarchos_workflow({
  action: "update", featureId: "<id>",
  updates: { "artifacts.report": "<path-to-document>" }
})
```

**Transition:** When `artifacts.report` is set → `completed`

### Optional: Escalation to Implementation

If discovery surfaces an implementation need:

1. Note the finding in the report
2. After completing the discovery workflow, start a new workflow:
   ```bash
   {{COMMAND_PREFIX}}ideate <implementation-topic>
   ```
   Reference the discovery report as design input.

## Event Emissions

Optionally emit events at key moments for observability:

```typescript
{{MCP_PREFIX}}exarchos_event({
  action: "append", stream: "<featureId>",
  event: { type: "discovery.sources_collected", data: { sourceCount: N } }
})
```

```typescript
{{MCP_PREFIX}}exarchos_event({
  action: "append", stream: "<featureId>",
  event: { type: "discovery.report_committed", data: { path: "<report-path>" } }
})
```
