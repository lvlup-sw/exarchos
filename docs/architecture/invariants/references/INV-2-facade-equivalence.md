# INV-2: Contract-Client Equivalence (the CLI is a client of the compiled contract)

> **Filename note:** this reference file keeps its historical name
> (`INV-2-facade-equivalence.md`) because `.exarchos/invariants.md` is a
> FROZEN, digest-pinned catalog (DR-26) and its `references:` list points at
> this literal path. Renaming the file would break that pinned link. The
> dimension itself was renamed `contract-client-equivalence` — read the title
> above, not the filename, as the governing framing.

The MCP wire projection of the compiled contract is the invocation surface. The CLI is a **client of that same contract**, equal to the wire BY CONSTRUCTION — not a peer facade kept in step by hand-coordination or by a passing fixture. Behavior lives in the shared dispatch core (`servers/exarchos-mcp/src/dispatch/core/dispatch.ts`); a client carries **presentation only** (argv parsing, exit codes, stdio framing, error rendering, carrier translation).

Byte- and schema-equivalence across carriers — the parity harnesses plus each action's registered Zod `outputSchema` — are the **WITNESS** of that construction, never the invariant itself. A suite of green parity fixtures does not make two hand-written surfaces equal; the mechanical backstop is the dispatch-seam containment census in `servers/exarchos-mcp/src/contract/cli/cli-contract-seam.ts`, not the parity tests.

## The current gap, and how it is governed

The shipped `adapters/cli.ts` does **NOT yet** meet this framing: it is a hand-written Commander tree that imports the runtime `dispatch` value and hand-assembles `(tool, args)` at each call site, so `generated/cli-surface.json` only *describes* the surface rather than generating it. Under the governing framing that is a deviation, not compliance — and it is recorded, not hidden:

- `CLI_CONTRACT_DEVIATIONS` in `cli-contract-seam.ts` carries exactly **one** row, `cli-direct-dispatch`, covering `adapters/cli.ts`.
- The row is governed: it has an owner (`exarchos`, resolved through CODEOWNERS), a rationale, a retirement condition (the `deriveCliSurface` projection becomes generative and `adapters/cli.ts` stops importing `dispatch`), and an expiry (`2027-02-28`).
- Every OTHER module that imports the runtime `dispatch` value and is not in `CONTRACT_PROJECTIONS` (currently only `adapters/mcp.ts`) fails the census closed — there is no second, undocumented direct-dispatch path.
- Past its expiry, the row goes RED as `STALE_DEVIATION` and must be deleted, not re-dated quietly.

The deviation is an acknowledged, expiring debt AGAINST this invariant, never a weakening OF it. Do not read the deviation ledger as "two peer facades, equal by fixture" — that is exactly the retired framing this invariant replaces.

## Acceptance questions

1. Does the new verb route through `dispatch/core/dispatch.ts` as a typed handler, with `adapters/mcp.ts` as the thin generated-equivalent wrapper?
2. If a new module needs the shared handler but cannot yet route through the compiled contract, does it carry a governed row in `CLI_CONTRACT_DEVIATIONS` (owner, rationale, retirement condition, expiry) rather than a silent import?
3. Is there zero behavior in `adapters/mcp.ts` beyond format conversion? (No MCP-only side effects, no adapter-local mutable state.)
4. Does the parity harness in `__tests__/parity-harness.ts` cover the new verb, and does the verb's `ToolResult` shape match the canonical envelope (`success` / `data` / `error` / `_meta` / `_perf` / `next_actions` — see [INV-5b](INV-5b-output-contract.md))?
5. Does every action register a Zod `outputSchema`, so schema-equivalence is checked, not merely asserted?

## Cross-invariant note: TaskStore-as-projection

The `TaskStore-as-projection` decision in milestone-16 §2.1 is an example of [INV-1](INV-1-event-sourcing.md) *driving* an INV-2 implementation choice. The SDK ships an `InMemoryTaskStore` that would let the MCP adapter "just work" — but using it would create a second source of truth invisible to the CLI, breaking contract-client equivalence in a way the parity tests would not catch (state, not output).

Flag any "convenient adapter-local state" as a candidate for this anti-pattern. The skill should examine: does the adapter hold a `Map`, `Set`, `Cache`, or any field that survives across calls? If yes, is the state a projection over events, reachable identically from either carrier? If no, you have a hidden equivalence violation.

## External grounding

- Alistair Cockburn, [*Hexagonal Architecture (Ports & Adapters)*](https://alistair.cockburn.us/hexagonal-architecture/) (2005) — the contract is the port; CLI and MCP are adapters over it, not co-equal ports.
- Martin Fowler, [*PresentationDomainDataLayering*](https://martinfowler.com/bliki/PresentationDomainDataLayering.html) (2015) — presentation carries no domain behavior.
- Anthropic, [*Model Context Protocol — Tools*](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (2024) — the wire projection this invariant treats as the reference surface.
- `docs/designs/archive/2026-05-07-milestone-16-mcp-alignment.md` §2.2 — the shared-dispatch-core architecture that the contract-client framing sits on top of.

## Severity guide

- **HIGH:** a new direct-dispatch path with no ledger row; behavior added to `adapters/cli.ts` or `adapters/mcp.ts` beyond presentation; adapter-local mutable state that would not survive a swap; a verb lacking a registered `outputSchema`.
- **MEDIUM:** a governed ledger row whose retirement condition or expiry has gone stale; missing parity-harness fixture for a new verb; a passing parity fixture cited as if it were the proof of equivalence rather than its witness.
- **LOW:** cosmetic differences (whitespace, key order); per-adapter performance optimization that doesn't change observable output.

## Worked example

**Violation (HIGH):** A new verb is added with a CLI-only print:

```ts
// adapters/cli.ts — DON'T
export async function runWorkflowGet(featureId: string) {
  const result = await dispatch({ verb: 'workflow.get', args: { featureId } });
  console.log(`Loaded workflow ${featureId}`); // ← CLI-only side effect
  return result;
}
```

The `console.log` doesn't affect `ToolResult` (so byte-equivalence holds), but it changes observable behavior. An agent using the CLI sees the banner; an agent using MCP doesn't — and neither one is the client of a shared contract if presentation code has silently grown behavior.

**Fix:** Move the message into `_meta.notes` or remove it. Agent-facing surfaces are JSON-only; human-facing display is the CLI's job at the renderer boundary, not inside dispatch.

**Violation (HIGH):** A new module imports `dispatch` directly with no ledger row:

```ts
// orchestrate/some-new-thing.ts — DON'T
import { dispatch } from '../core/dispatch.js';

export async function doSomething() {
  return dispatch({ verb: 'workflow.get', args: {} }, ctx);
}
```

Neither `CONTRACT_PROJECTIONS` nor `CLI_CONTRACT_DEVIATIONS` covers this module, so `runDeviationLedgerCensus` fails it as an ungoverned direct-dispatch path.

**Fix:** Route through a projection module, or add a governed row to `CLI_CONTRACT_DEVIATIONS` with a real owner, rationale, retirement condition and expiry — never a silent import.

## See also

- Deterministic checks for INV-2 → [deterministic-checks.md](deterministic-checks.md#inv-2-facade-equivalence)
- `servers/exarchos-mcp/src/contract/cli/cli-contract-seam.ts` — the deviation ledger and the census that enforces it
- [INV-1](INV-1-event-sourcing.md) — stores-as-projections rule (cross-invariant constraint)
- [INV-5b](INV-5b-output-contract.md) — the canonical `ToolResult` envelope shape
