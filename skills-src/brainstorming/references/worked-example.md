# Worked Example: Brainstorming — Event Deduplication

## Context

Feature: event store deduplication for the Exarchos MCP server. The user runs `/exarchos:ideate` to explore approaches.

## Phase 1: Understanding

**Agent:** "What problem are we solving?"
**User:** "Duplicate events in the JSONL store when agents retry after timeouts."

**Agent:** "What constraints exist?"
**User:** "Must not break existing event streams. Append-only store, no rewriting."

**Agent:** "What patterns already exist in the codebase?"
**User:** "Events have timestamps and stream IDs but no unique event IDs."

## Phase 2: Exploration

**Agent presents three approaches:**

### Option 1: Idempotency Keys
Add a unique `eventId` field. Writers generate UUIDs; readers skip duplicates.
- **Pros:** Simple, no schema migration needed.
- **Cons:** Requires all callers to generate IDs.

### Option 2: Content Hashing
Hash `stream + type + timestamp + payload` to detect duplicates at write time.
- **Pros:** No caller changes. Automatic.
- **Cons:** Hash collisions possible. Slightly slower writes.

### Option 3: Write-Ahead Log
Buffer events in a WAL, flush deduplicated batches.
- **Pros:** Strongest guarantees. Enables batching.
- **Cons:** Significant complexity. Overkill for append-only JSONL.

**Agent recommends Option 1** — simplest, aligns with event-sourcing conventions.

## Pivot: User Rejects All Approaches

**User:** "These all add complexity. Can we just make the timeout longer?"

**Agent:** "Longer timeouts reduce retries but don't eliminate duplicates from network issues or process restarts. However, we can combine your instinct with a minimal approach: add idempotency keys (Option 1) but make them optional — readers tolerate duplicates, and the key is only used when callers choose to deduplicate. This keeps the default path unchanged."

**User:** "That works. Proceed with optional idempotency keys."

## Phase 3: Design Presentation

Agent writes design document to `docs/designs/2026-02-28-event-deduplication.md` covering: problem statement, chosen approach (optional idempotency keys), technical design (UUID generation, reader-side dedup), integration points (event append tool, view tool), testing strategy (duplicate detection tests, backward compatibility).

**State update:** `artifacts.design` set to design path, phase transitions to `plan`.

**Agent:** "Design saved. Auto-continuing to implementation planning..."
