# Token Attribution for Subagent Telemetry (#1525) — Approach Selection

> **Type:** Discovery / decision-oriented research
> **Date:** 2026-06-19
> **Workflow:** `token-attribution-discovery-1525` (discovery)
> **Question:** In an event-sourced, single-machine, multi-agent system, what is the SoTA / best-practice way to attribute LLM token usage to individual subagents so it's queryable per-teammate — and which of A/B/C fits Exarchos? Feeds the W2/#1525 plan; not a standalone epic.
> **Decision:** **Option A** (correlate the existing per-turn token atom; derive attribution in a projection — no new aggregate event), with **Option C** as the documented fallback. **Reject B.**

---

## TL;DR

Across every authoritative source — OpenTelemetry's GenAI semantic conventions, LangSmith, Langfuse, and the event-sourcing canon — the pattern is identical and unambiguous:

> **Token usage is a per-call *atom*, recorded once at the operation where it is known. Attribution to any higher unit (agent, subagent, thread, session) is *derived by correlation* (parent-span / run-tree / propagated id), never re-recorded as an aggregate fact.**

Exarchos already has both halves of that pattern: the atom (`turn.completed.outputTokens`) and the correlation primitive (`operationId`/`correlationId`/`causationId` on every event envelope, #1291). So **Option A is the SoTA-aligned and INV-1-pure choice**: make `team-performance` / `delegation-timeline` left-folds that group the per-turn token atom by the dispatch correlation. A new `subagent.tokens_used` aggregate event (Option B) is the *state-focused* anti-pattern the event-sourcing literature explicitly warns against.

---

## 1. What the sources actually say

### OpenTelemetry GenAI semantic conventions (the standard)
- Token usage is modeled **on the operation** — `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` as **span attributes**, plus an aggregatable **metric** `gen_ai.client.token.usage`. ([semconv/gen-ai](https://opentelemetry.io/docs/specs/semconv/gen-ai/openai/), [spans.yaml](https://github.com/open-telemetry/semantic-conventions/blob/main/model/gen-ai/spans.yaml))
- The three-signal split is explicit: **spans** = a unit of work (one model call / tool / **agent step**); **metrics** = the aggregatable numbers (token counts); **events/logs** = high-cardinality content (prompts/completions). Token *counts* belong on the operation; aggregation is derived. ([Sentry field guide](https://sentryml.com/posts/opentelemetry-genai-semantic-conventions-instrumenting-llm-apps/))
- There are distinct **agent spans** (`invoke_agent`) and **model spans**; per-call token usage rolls up to the agent via the **trace tree (parent-span causation)** — i.e. attribution-by-correlation, not a re-recorded total.

### LangSmith (run-tree)
- Each `run` carries `total_tokens`/`prompt_tokens`/`completion_tokens`, `parent_run_id`, `trace_id`, and a sortable `dotted_order`. Token usage is captured **per LLM run**. ([run-data-format](http://docs.langchain.com/langsmith/run-data-format))
- Per-thread / per-agent token totals are obtained by **grouping runs on a propagated correlation key** (`thread_id`) and summing — and the docs warn: *"If child runs don't have the `thread_id` metadata, they won't be included when calculating token usage for a thread."* Attribution is correlation, full stop. ([multi-turn observability](https://vectoringai.com/posts/llm/Observability-for-Multi-Turn-LLM-Conversations.html))
- **Subagents render inline as nested runs**; their tokens aggregate up the tree via `parent_run_id`. ([view-traces](https://docs.langchain.com/langsmith/view-traces))

### Langfuse (traces → observations)
- Token/cost are tracked on **`generation` observations** (`usageDetails: {input, output}`); trace attributes (`session_id`, `user_id`) **propagate to observations**, and totals are aggregated up the trace. ([data-model](https://langfuse.com/docs/observability/data-model), [token-and-cost-tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking))
- Same shape: atom = the generation; attribution = derived by the trace/observation hierarchy + propagated ids.

### Event-sourcing canon (how to record it)
- A read model is a **left-fold over events, derived not duplicated**; one stream yields many specialized read models. ([event-driven.io](https://event-driven.io/en/projections_and_read_models_in_event_driven_architecture/), [EventSourcingDB "Your Aggregate is Not a Table"](https://docs.eventsourcingdb.io/blog/2026/01/26/your-aggregate-is-not-a-table/), [domaincentric](https://domaincentric.net/blog/event-sourcing-projections))
- **Intent-focused events beat state-focused events** (Azure Event Sourcing pattern): *"an event that records 'two seats were reserved' is more valuable than 'remaining seats changed to 42' … State-focused events reduce the event store to a change log with no business meaning."* A `subagent.tokens_used: {total: N}` event is exactly the "= 42" aggregate — a derived total masquerading as a fact. ([Azure Event Sourcing](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing))

---

## 2. The three options, mapped

| | A — correlate per-turn atom (no new event) | B — new `subagent.tokens_used` aggregate | C — new event, correlation-sourced |
|---|---|---|---|
| Atom of truth | `turn.completed.outputTokens` (already emitted) | re-recorded total | per-turn atom, re-stamped |
| Attribution | **derived** in a projection, grouping turns by the dispatch correlation (`operationId`/`causationId`, #1291) | re-recorded at completion | derived once, then frozen as an event |
| SoTA fit | **matches OTel / LangSmith / Langfuse exactly** | the "remaining seats = 42" anti-pattern | acceptable compromise |
| New event type | none | yes (+ schema, registry, EVENT_DATA_SCHEMAS) | yes |
| Coupling | none beyond correlation stamping | transcript-parse / session-end seam (most platform-coupled) | dispatch-boundary derivation |

## 3. Invariant scorecard

| Invariant | A | B | C |
|---|---|---|---|
| **INV-1** (read-model = left-fold; derive, don't duplicate) | ✅ pure projection | ❌ re-records a derived aggregate | ⚠️ records a derived value, but sourced correctly |
| **INV-4** (platform-agnostic; degrade gracefully) | ✅ folds whatever turn atoms exist; runtimes without `turn.completed` → empty view, no new seam | ❌ needs a per-runtime transcript/session emission seam | ⚠️ one emission seam, but correlation-sourced |
| **INV-10** (liveness as events) | ✅ neutral (atom already an event) | ✅ | ✅ |
| **INV-15** (single-machine; no distributed machinery) | ✅ local correlation ids, not network trace propagation | ✅ | ✅ |

**A dominates on INV-1 and INV-4.** Notably A is *more* platform-agnostic than B: token data is inherently runtime-dependent (`turn.completed.outputTokens` is a session-layer concept some of the 6 runtimes won't emit), and A degrades to an empty view with **no** new platform-coupled emission path, whereas B must grow one.

## 4. Recommendation

**Adopt Option A.** Make `team-performance` and `delegation-timeline` left-folds that attribute the existing `turn.completed.outputTokens` atom to a teammate by the dispatch correlation already on the event envelope (#1291 `operationId`/`causationId`). No new event type; token metrics become just another projection over the same stream — the canonical CQRS move ("one stream, many read models").

**The one precondition (the real W2 work):** verify the per-turn token atom is *correlatable to a teammate dispatch* — i.e. `turn.completed` events carry the dispatching operation's `operationId`/`causationId` (or a `teammateName`/`taskId` derivable from it). The atom (`outputTokens`) and the envelope fields both exist; what must be confirmed/added is that turns emitted *inside a teammate dispatch* are stamped with that dispatch's correlation. If they already are, A is a pure projection addition. If the stamping is missing, **add the stamping** (still A) — do not substitute a re-recorded aggregate.

**Fallback — Option C —** only if per-turn atoms are structurally non-correlatable at read time (e.g. emitted on a disjoint session stream the feature projection cannot see). Then emit a minimal `subagent.tokens_used` at the dispatch-completion boundary **sourced by correlating the per-turn atoms** (never by re-parsing a transcript). C is "A's derivation, materialized as an event because read-time correlation isn't feasible."

**Reject Option B** (transcript-parse aggregate at session-end): it is the state-focused anti-pattern, the most platform-coupled, and it duplicates a value the per-turn atoms already hold.

## 5. Handoff to the #1525 plan

- W2 Half 1 (token telemetry) → **Option A**: a projection-side change (extend `team-performance`/`delegation-timeline` to fold `turn.completed` grouped by dispatch correlation) + verify/ add correlation stamping on `turn.completed`. Gate the plan on the precondition check above.
- W2 Half 2 (mutation-score trend) is the *same principle* applied to a different atom: fold the existing `gate.executed` / `mutation.executed` events into `code-quality` / `eval-results` as a per-skill trend (a left-fold), **not** a new "mutation summary" event.
- Both halves are therefore **projection-first, derive-don't-duplicate** — coherent with INV-1 and the #1525 acceptance ("token telemetry populated; mutation-score trend queryable per skill").

## Sources

- OpenTelemetry GenAI semantic conventions — [gen-ai registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/), [openai spans/metrics](https://opentelemetry.io/docs/specs/semconv/gen-ai/openai/), [model/gen-ai/spans.yaml](https://github.com/open-telemetry/semantic-conventions/blob/main/model/gen-ai/spans.yaml)
- [A Field Guide to the OpenTelemetry GenAI Semantic Conventions](https://sentryml.com/posts/opentelemetry-genai-semantic-conventions-instrumenting-llm-apps/) (spans/metrics/events split)
- LangSmith — [run-data-format](http://docs.langchain.com/langsmith/run-data-format), [observability-concepts](https://docs.langchain.com/langsmith/observability-concepts), [view-traces (subagents inline)](https://docs.langchain.com/langsmith/view-traces), [multi-turn token aggregation](https://vectoringai.com/posts/llm/Observability-for-Multi-Turn-LLM-Conversations.html)
- Langfuse — [data-model](https://langfuse.com/docs/observability/data-model), [token-and-cost-tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking), [trace-ids & distributed tracing](https://langfuse.com/docs/observability/features/trace-ids-and-distributed-tracing)
- Event sourcing — [Azure Event Sourcing pattern (intent vs state events)](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing), [event-driven.io projections/read-models](https://event-driven.io/en/projections_and_read_models_in_event_driven_architecture/), [EventSourcingDB — Your Aggregate is Not a Table](https://docs.eventsourcingdb.io/blog/2026/01/26/your-aggregate-is-not-a-table/), [domaincentric — projections as left-fold](https://domaincentric.net/blog/event-sourcing-projections)
- Internal: `telemetry/telemetry-projection.ts` (`turn.completed` atom), `event-store/schemas.ts` (#1291 envelope correlation), `views/team-performance-view.ts`, `views/delegation-timeline-view.ts`
