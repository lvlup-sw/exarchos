## Summary

<!-- 2-3 sentences: What changed, why it matters, what problem it solves -->

## Changes

<!-- Scannable list. Use **Bold** for component names and — (em-dash) as separator -->
- **Component** — Brief description of what changed

## Test Plan

<!-- 1-2 sentences: Testing approach and coverage summary -->

---

**Results:** Tests X · Build 0 errors
**Design:** <!-- link to design doc if applicable -->
**Related:** <!-- #issue, Continues #PR -->

## Cross-cutting (#1109) verification

This PR has been verified against the four invariants from #1109. Tick each
applicable box; explain N/A cases.

- [ ] **Event-sourcing integrity:** all new state-affecting commands either
      emit events, read projections, or both. Output is reconstructable from
      the event log alone. List events emitted: ...
- [ ] **MCP parity:** any new command surface routes through the shared
      dispatch core; verified identical output from CLI and MCP facades.
      Command(s) verified: ...
- [ ] **Basileus-forward:** no hard-coded assumption that MCP is local-only;
      no separate config file added (per ADR §2.7, configuration consolidates
      in `.exarchos.yml`).
- [ ] **Capability resolution:** no reads of yaml capability fields at runtime
      (or N/A — explain).

## Backend-quality dimensions

<!-- Optional: list any axiom dimensions this PR remediates or impacts.
     DIM-1 Topology, DIM-2 Observability, DIM-3 Contracts, DIM-4 Test Fidelity,
     DIM-5 Hygiene, DIM-6 Architecture, DIM-7 Resilience, DIM-8 Prose Quality.  -->

## Test plan

- [ ] `npm run typecheck` clean
- [ ] `npm run test:run` (root) — pass count: ...
- [ ] `cd servers/exarchos-mcp && npm run test:run` — pass count: ...
- [ ] `npm run skills:guard` clean (if skills/ touched)
- [ ] Manual verification: ...

## Related

<!-- Issue refs (Closes #N, Refs #M), prior PRs in stack, RCA docs. -->
