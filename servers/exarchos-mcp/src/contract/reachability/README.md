# Generated reachability graph — the closure capstone (P05-05)

**The program's closure capstone (CTR-013).** This module proves the
structural-closure objective end to end:

> Every public action reaches **one implementation, one owned effect path where
> applicable, one output contract, and one packaged proof.**

It does not invent a new authority. It **assembles a reachability graph** from
the authorities the earlier packages already froze, and **gates on closure**:
every public action must have exactly **one complete path** from its authored
ActionId all the way to its packaged proof fixture. A break — or an ambiguity —
at any hop is a closure failure that names the action and the broken hop.

## The node chain (one path per public action)

```
ActionId → schema → route → handler → [owner] → output → artifact → fixture
(authored) (P03-03) (P03-04) (P03-04)  (P04-01)  (P03-02) (P03-03)   (packaged)
```

| Hop | Authority consumed | A break means |
| --- | --- | --- |
| **schema** | P03-03 `compile(deriveMetaModel())` — descriptor + I/O schema | the action has no compiled contract entry |
| **route** | P03-04 `generateRegistration` — the dispatch route (ActionId→tool) | the ActionId is not routed to a tool |
| **handler** | P03-04 `BINDING_TABLE` — one non-serializable handler per tool | the tool has no (or two) handler bindings |
| **owner** *(conditional)* | P04-01 `EFFECT_OWNERSHIP` via the [provider map](./providers.ts) | a **mutating** action's effect path has no (or two) effect owners |
| **output** | P03-02 output kinds + error families (on the descriptor) | the action binds no output-kind / error-family contract |
| **artifact** | P03-03 `compile().proofFixtures` — the in-memory proof fixture | the compiler emitted no fixture for the action |
| **fixture** | the checked-in `generated/proof-fixtures.json` baseline | the packaged proof baseline omits the action |

The **owner hop is conditional** — "one owned effect path *where applicable*". A
pure (read-only) action legitimately skips it (`status: not-applicable`); only a
mutating action is required to resolve exactly one effect owner. This is modeled
explicitly (`ActionNode.mutates`), not special-cased.

**Ambiguity is a closure failure too.** Two handler bindings for a tool, or two
effect owners for a tool, resolve a hop to `ambiguous` (count > 1) — exactly one
complete path is required, so "which of the two?" fails closed just like absence.

## Layout

| File | Role |
| --- | --- |
| `graph.ts` | The **pure** model: `ReachabilityInputs`, `resolveHops`, `evaluateClosure`, `buildReachabilityGraph`, `serializeReachabilityGraph`, and explicit `reachabilityNodes` / `reachabilityEdges` expansion. No I/O — every seeded break is unit-testable. |
| `providers.ts` | The governed `EFFECT_PROVIDERS` connective map (tool → effect area + owner), **validated** against the live `EFFECT_OWNERSHIP` ledger (two-way ratchet: unbacked / duplicate providers are flagged). |
| `collect.ts` | The **impure** adapter: `collectReachabilityInputs()` materializes the inputs from the live authorities; `LIVE_CLOSURE_EXCEPTIONS` is the governed known-unclosed list (empty). |
| `generate.ts` | The generator + drift baseline (`buildLiveReachabilityGraph`, `serializedGraphBaseline`, `generateReachabilityArtifact`). |
| `generated/reachability-graph.json` | The **checked-in** reviewable closure artifact, drift-guarded by `generated.test.ts`. |
| `regenerate.mjs` | The Node regeneration runner (see below). |

## The effect-owner seam (dispatch → ledger)

The `owner` hop bridges two authorities that do not name each other: dispatch
(`COMPOSITE_HANDLER_LOADERS`, tool → handler **module**) and the effect ledger
(`EFFECT_OWNERSHIP`, module-**prefix** → owner). [`providers.ts`](./providers.ts)
is the small governed map between them; every entry is validated against the live
ledger, so a renamed/moved/removed owner trips validation rather than silently
mis-reporting a `missing owner` break.

## The authored-workflow seam (P07-02)

The chain's origin is the **authored ActionId** (authored in the tool registry).
Binding each ActionId to a specific shared-IR built-in workflow definition is the
**P07-02** surface, authored in parallel. That refinement is a *pluggable origin
attribute*, not a required hop here — the graph does not block on it.

## Closure finding (the honest number)

The live tree achieves **complete closure: 120 of 120 public actions are fully
closed** — every applicable hop resolves to exactly one. `LIVE_CLOSURE_EXCEPTIONS`
is therefore **empty**; no action is excepted. If the tree ever regresses, the
gate reports precisely which action breaks at which hop, and a genuinely-unclosed
action must be recorded in the governed exceptions list with a reason (a stale
exception — one that is actually closed — is itself flagged).

### Verified vs. simulated

- **Verified** (real, in-tree): schema, route, handler, owner, output, and
  artifact hops run over the live authorities; the **fixture** hop is proven
  against the checked-in `proof-fixtures.json` baseline (present, per action).
- **Simulated / not exercised here**: `dist/` is not built in this workspace, so
  the *binary* packaging of the fixture (bundling `proof-fixtures.json` into the
  shipped artifact) is not exercised. The packaged-proof hop is verified at the
  checked-in-baseline boundary; downstream release packaging (P05-01/-02/-03)
  owns the binary inclusion.

## Regenerating the checked-in graph

`generated.test.ts` fails when the checked-in artifact drifts from a fresh build.
To re-approve after an intentional change (a registry edit, a new binding, an
effect-ledger change):

```sh
# from the repo root (or servers/exarchos-mcp)
node servers/exarchos-mcp/src/contract/reachability/regenerate.mjs
```

`regenerate.mjs` reproduces vitest's `bun:sqlite` → node-shim alias (the
generator pulls `bun:sqlite` in transitively via the binding table → dispatch),
then runs the TS generator via tsx. Commit the updated
`generated/reachability-graph.json`.
