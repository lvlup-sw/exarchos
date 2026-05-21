# Runtime Invariants Gap Analysis

> **Workflow:** `workload-agnostic-runtime-invariants` (discovery, Phase B per charter)
> **Date:** 2026-05-20
> **Status:** Research deliverable D2 of 5
> **Parent:** epic #1441 (v2.10.0-preview.4 polish + post-bundle follow-ups)
> **Charter:** issue #1370 comment 4464273740 — "Primary audit should be against workload-agnosticism"

## 1. Method

Walk `docs/architecture/runtime.md` §2–§8 against the current 18-entry catalog at `docs/architecture/invariants.md` (post-#1455 audit). For every numbered runtime guarantee, every layer (L1–L9), every concurrency-substrate mechanism, every recovery primitive, every cooperation primitive, and every deliberately rejected pattern: does it map to a current catalog entry?

Three verdicts per row:

- **HIT** — covered by an existing entry with congruent framing.
- **PARTIAL** — covered, but the catalog's wording omits a load-bearing facet that should be sharpened or split.
- **GAP** — no catalog entry corresponds; propose a new ID.

GAPs are then characterized as **candidate new invariants** for the v2 catalog (D5).

## 2. Walk — §2 runtime guarantees (RT-1..RT-6)

| runtime.md claim | Catalog entry | Verdict | Notes |
|---|---|---|---|
| RT-1 — Event log is the source of truth (discipline + reconcile path) | INV-1 event-sourcing-integrity | HIT | INV-1's summary captures "append-only log is source of truth" + "reducers must be pure" cleanly |
| RT-2 — Total order within a stream (composite PK + OCC retry) | INV-1 | PARTIAL | INV-1 covers "events are authority" but not the *substrate mechanism* (composite PK `(streamId, sequence)`). The mechanism is INV-1's load-bearing dependency and deserves its own entry. **Candidate INV-7 (substrate-serialization).** |
| RT-3 — Atomic append (`BEGIN IMMEDIATE` wrapping idempotency + sequence + INSERT + outbox INSERT) | INV-1 | PARTIAL | Same as RT-2 — INV-1 names the *invariant* but not the *substrate primitive*. Candidate INV-7. |
| RT-4 — Single writer per stream (PK rejects duplicate sequences; OCC retry on conflict) | INV-1 | PARTIAL | Candidate INV-7. |
| RT-5 — Idempotent at-least-once delivery (`UNIQUE INDEX (idempotency_key)`) | (none) | GAP | Idempotency at the storage layer is load-bearing for INV-1 *and* for the process-manager pattern (§4 below). **Candidate INV-8 (idempotency-at-the-boundary).** |
| RT-6 — Operations atomic against the log (event-first commit point; handlers retry-safe; reducers replay-safe) | INV-1 | HIT | INV-1's "reducers must be deterministic" covers replay-safety; "events are authority" covers event-first commit point |

**§2 takeaway:** INV-1 conflates *event-sourcing-as-design-principle* with *the SQLite/WAL/OCC substrate that enforces it*. Splitting these is the largest catalog-shape change the cross-walk surfaces. RT-2 + RT-3 + RT-4 want a `substrate-serialization` invariant (proposed **INV-7**); RT-5 wants an `idempotency-at-the-boundary` invariant (proposed **INV-8**).

## 3. Walk — §3 layered architecture (L1..L9)

| Layer | runtime.md claim | Catalog entry | Verdict | Notes |
|---|---|---|---|---|
| L1 Storage | `bun:sqlite` (WAL); schema tables; storage handle injected via `DispatchContext`; CI gate enforces `Database` import boundary | (none direct) | PARTIAL | INV-1 implicit; the "import-boundary CI gate" facet is uncovered. Probably not catalog-worthy — operational, not architectural. |
| L2 Event store | `AtomicAppender` interface; cross-stream queries via `eventStore.queryByType`; streams namespaced `<feature-id>/<subagent-id>` | INV-1 | HIT | Namespacing is the load-bearing primitive that lets sub-agents not collide — worth naming explicitly in INV-1 sharpen pass, but not a new entry. |
| L3 Projections | Reducers over event stream; pure; deterministic; three test types per reducer; snapshots are an optimization | INV-1 | HIT | Solid coverage |
| L4 Workflow primitives | HSM, capability resolver, phase contract loader, pruner — four pure modules | INV-3 + INV-4 partial | PARTIAL | HSM and pruner are uncovered. **Candidate INV-9 (HSM-as-state-machine).** Phase contract loader → covered by INV-3 (basileus-forward) tangentially. |
| L5 Dispatch core | Single function: `dispatch(verb, args, ctx) → ToolResult`; parity tests assert byte-equal across CLI/MCP | INV-2 | HIT | Direct |
| L6 Composite tools | 4 visible; action discriminator; per-action outputSchema + annotations; describe entry returns schema and emission catalog | INV-5d + INV-5a | HIT | Direct |
| L7 Process lifecycle verbs (v2.12) | `ps`, `describe`, `wait`, `export`; every long-running op emits `<surface>.executing_started` | INV-5c partial | PARTIAL | INV-5c covers Aspire-verb *spirit* but not the *liveness-event protocol* the v2.12 verbs depend on. **Candidate INV-10 (liveness-event-protocol).** |
| L8 Adapters | Zero behavior; format only; `cli.ts` parses argv + maps exit codes; `mcp.ts` uses `structuredContent`; parity harness verifies | INV-2 | HIT | Direct |
| L9 Cooperative agents | Declared posture; consume `next_actions`; do not poll; progressive `describe`; self-correct from `_meta.deprecation` + `error.suggestedFix` | INV-5a + INV-5b partial | PARTIAL | Posture and consumption-of-next_actions facets uncovered. **Candidates INV-11 (posture-declared-capabilities), INV-12 (next-actions-as-affordance).** |

**§3 takeaway:** Five new candidates surface. The pattern: existing INV-* entries cover what Exarchos *exposes* to designers, but undercover the substrate *primitives* the runtime is built on — HSM, liveness events, posture, next-actions consumption.

## 4. Walk — §4 concurrency model

| runtime.md claim | Catalog entry | Verdict | Notes |
|---|---|---|---|
| Tier 1 — In-process: `AtomicAppender` owns `StreamLockManager` (per-stream Promise-chain mutex) | (none) | GAP | This is the in-process half of substrate-serialization. Folds into **candidate INV-7**. |
| Tier 2 — Cross-process: `BEGIN IMMEDIATE` + `PRIMARY KEY (streamId, sequence)` | (none) | GAP | Folds into **candidate INV-7**. |
| OCC retry on PK conflict; `{ ok: false, reason: 'sequence-conflict' }` translation | (none) | GAP | Folds into INV-7. The {ok: false, reason} carrier shape is INV-5b-adjacent but the specific 'sequence-conflict' contract is INV-7. |
| PID lock removed (#1343 / Wave A) — `initialize()` is idempotent no-op marker | (none) | N/A | Anti-pattern explicitly rejected; not catalog-worthy as a positive invariant. |
| Process-manager handlers — two-event split `*.requested` / `*.executed`; idempotent precheck on recovery | (none) | GAP | This is the canonical process-manager pattern (Akka *Effect.thenRun*, Wolverine *AggregateHandler*, Greg Young). Zero catalog presence. **Candidate INV-13 (process-manager-two-event-split).** |
| CI grep gate `scripts/check-withsession-idempotency.sh` enforces contract markers | (none) | N/A | Operational mechanism, not invariant content |

**§4 takeaway:** Two GAPs (INV-7 substrate-serialization, INV-13 process-manager-two-event-split) consume most of §4's content. INV-13 is the single most under-represented invariant — the two-event split is documented in the canonical event-sourcing literature (corpus has 6+ external sources) but appears nowhere in the catalog.

## 5. Walk — §5 recovery model

| runtime.md claim | Catalog entry | Verdict | Notes |
|---|---|---|---|
| Crash atomicity (L1) — SQLite txn fully committed or rolled back | INV-1 | HIT (implicit) | Substrate primitive; INV-1's "events are authority" implies the all-or-nothing property |
| Replay from event log (L3) — `reconcile` rebuilds from event 0; `replay` from snapshot; state files never authoritative | INV-1 | HIT | Direct |
| Local recovery (L4 handlers) — native primitive first (`git X --abort`); `git reset --keep` second; never `--hard`; `recoveryError` discriminator | (none) | GAP | This is a workload-runtime invariant — applies to every external-mutator handler. **Candidate INV-14 (native-primitive-first-recovery).** |
| `resume: true` flag + idempotency keys collapsing re-runs | INV-1 partial | PARTIAL | Idempotency facet folds into candidate INV-8 |

**§5 takeaway:** One new candidate (INV-14). The "native primitive first, then `--keep`, never `--hard`" rule is a specific recovery posture that holds across all workloads using external-mutator handlers — git operations today, but conceivable for any tool with a built-in undo (kubectl, terraform, etc.).

## 6. Walk — §6 observability model

| runtime.md claim | Catalog entry | Verdict | Notes |
|---|---|---|---|
| Events are the only source of truth | INV-1 | HIT | Direct |
| Lifecycle events (`workflow.transition`, `task.assigned`, `gate.executed`, `merge.*`) | (none direct) | PARTIAL | Catalog doesn't name the lifecycle-event surface as a contract. Could fold into candidate INV-10 (liveness-event-protocol). |
| Liveness signals (`<surface>.executing_started`) | (none) | GAP | Folds into candidate INV-10. |
| Telemetry events (`dispatch.preflight`, deprecation invocations) | DIM-2 (axiom-owned) | HIT | DIM-2 observability covers the silent-catch and degradation-path concerns |
| Three-way inspection: `exarchos_event query` / `next_actions` envelope / CLI `ps describe wait` | INV-5b + candidate INV-12 | PARTIAL | The "three views over the same event stream" architectural claim is implicit in INV-5b but not stated as an invariant. |

**§6 takeaway:** §6 mostly folds into candidates INV-10 (liveness) and INV-12 (next-actions affordance). No new candidates beyond those.

## 7. Walk — §7 agent cooperation model

| runtime.md claim | Catalog entry | Verdict | Notes |
|---|---|---|---|
| Posture declaration — every agent declares `read-only \| task-isolated \| shared-mutating`; unrepresentable-by-construction | (none) | GAP | **Candidate INV-11 (posture-declared-capabilities).** Mark Miller *Robust Composition* (Agoric 2006) + Paradigm Lost (SRL 2003) ground this directly — capability-based security with POLA. |
| Handshake-authoritative capabilities — MCP `initialize` handshake declares runtime half; mismatches resolve to handshake; `runtimes/<name>.yaml` capability fields not read at runtime | INV-3 partial | PARTIAL | INV-3 (basileus-forward) covers "handshake-authoritative" for the remote-MCP angle but not for the local cooperation primitive. Folds into **candidate INV-11**. |
| Next-actions consumption — agents read `next_actions` from envelopes; do not poll; autonomy is property of state + topology | INV-5b partial | PARTIAL | INV-5b covers `next_actions` as carrier; this covers `next_actions` as autonomy driver. **Candidate INV-12 (next-actions-as-affordance).** Norman/Gibson affordance theory grounds this. |

**§7 takeaway:** Two strong candidates with external research backing — INV-11 (posture, capability-security literature) and INV-12 (next-actions, affordance theory).

## 8. Walk — §8 deliberate non-patterns

Each rejected pattern is itself an invariant ("Exarchos does not do X"). The catalog has zero entries for any of these — but the rejections are load-bearing for designers who might otherwise import the rejected pattern.

| Rejected pattern | runtime.md rationale | Catalog entry | Candidate? |
|---|---|---|---|
| Saga (multi-step distributed transaction + cross-service compensation) | One repo, one event store, one state dir. Compensation is local rewind, not remote commands. | (none) | YES — fold into **candidate INV-15 (single-machine-frame)** |
| Scheduler-Agent-Supervisor (Microsoft) | Supervisor role addresses distributed liveness. v2.12 lifecycle verbs handle this generically. | (none) | YES — fold into INV-15 |
| 2PC / leader election / vector clocks / BFT consensus | Single machine. None of the problems these solve exist. | (none) | YES — fold into INV-15 |
| Active polling / heartbeat infrastructure | Agents consume `next_actions`; runtime doesn't poll agents. Liveness is event-emitted. | (none) | YES — fold into candidate INV-12 (next-actions-as-affordance) |
| Workflow engine in agent runtime (Temporal-style worker loops) | Exarchos delegates execution to host runtime (Claude Code, Codex). Basileus is autonomous tier. | INV-3 partial | PARTIAL — covered by INV-3 framing but not stated as a non-pattern |
| Distributed locks / mutex services | OCC + SQLite WAL lock cover all serialization needs. | (none) | YES — fold into candidate INV-7 (substrate-serialization) |

**§8 takeaway:** One new umbrella candidate — **INV-15 (single-machine-frame)** — captures the "this is a concurrent system, not a distributed one" framing that runtime.md §1 leads with. Three rejections fold into it (saga, SAS, 2PC). The other three fold into existing candidates (INV-7, INV-12) or existing entries (INV-3).

## 9. Existing catalog entries — verdict per entry

For completeness: every current entry's status after the cross-walk.

| ID | Verdict | Action in v2 |
|---|---|---|
| INV-1 event-sourcing-integrity | HIT but overloaded | **Split:** sharpen INV-1 to "events as design authority + reducer purity"; split off INV-7 (substrate-serialization), INV-8 (idempotency-at-the-boundary) |
| INV-2 facade-equivalence | HIT | Keep |
| INV-3 basileus-forward | HIT | Keep |
| INV-4 platform-agnosticity | HIT | Keep. Sharpen scope to "platform" axis only; let INV-6 own "workload" axis |
| INV-5a input-ergonomics | HIT | Keep |
| INV-5b output-contract | HIT | Keep. Split off INV-12 (next-actions-as-affordance) since 5b is about carrier shape and 12 is about consumption semantics |
| INV-5c aspire-verbs | HIT | Keep |
| INV-5d action-discriminator | HIT | Keep |
| INV-6 workflow-agnosticism | PARTIAL — currently scoped to skill-body grep | **Sharpen:** elevate to the primary workload-agnosticism statement. The grep-test stays as the operational projection; the *invariant* is broader — "the runtime makes no assumption about which workload is executing." |
| DIM-1..DIM-7 | HIT (axiom-owned, cross-link entries) | Keep. Tag with `axis: substrate`. |
| DIM-8 prose-quality | HIT (archivable) | Keep. Tag with `axis: authoring`. Only authoring-tagged entry. |
| basileus-boundary | HIT (forward-looking) | Keep |

## 10. Candidate new invariants — summary list

Nine candidates surface (INV-7 through INV-15). IDs are provisional pending D5 (v2 catalog spec):

| Provisional ID | Name | Source §§ | Research backing |
|---|---|---|---|
| INV-7 | substrate-serialization | §2 (RT-2/3/4), §4 Tier 1/2, §8 distributed-locks rejection | Mohan ARIES 1992 (WAL); Bernstein & Goodman 1981 (OCC); SQLite WAL docs |
| INV-8 | idempotency-at-the-boundary | §2 (RT-5), §4 process-manager idempotent precheck, §5 resume + collapse | Wolverine PR #1858 (idempotency); Akka persistence (at-least-once); Greg Young versioning |
| INV-9 | HSM-as-state-machine | §3 L4 | (light — mostly internal; HSM literature: Harel statecharts 1987 if needed) |
| INV-10 | liveness-event-protocol | §3 L7, §6 liveness signals | Conductor durable-execution; AWP runtime liveness |
| INV-11 | posture-declared-capabilities | §3 L9, §7 posture + handshake | **Strong:** Miller *Robust Composition* 2006; Paradigm Lost SRL 2003; POLA; anip-protocol SPEC posture/handshake convergence |
| INV-12 | next-actions-as-affordance | §3 L9, §7 next-actions consumption, §8 polling rejection | Norman 1999; Gibson 1979; HCI affordance literature |
| INV-13 | process-manager-two-event-split | §4 process-manager handlers | **Strong:** Akka *Effect.thenRun*; Wolverine *AggregateHandler*; Greg Young; Vaughn Vernon DDD |
| INV-14 | native-primitive-first-recovery | §5 local recovery (L4 handlers) | (light external — mostly Exarchos-specific; `git --abort` semantics; ARIES CLR concept tangentially) |
| INV-15 | single-machine-frame | §1 framing, §8 rejections (saga, SAS, 2PC) | **Strong:** Microsoft SAS pattern doc (negative reference); Saga pattern doc; ARIES single-machine WAL |

That's nine, not eight — INV-7 and INV-15 are siblings but distinct (substrate primitive vs framing statement). The final v2 entry list (D5) may merge some after the workload-agnosticism stress test (D3).

## 11. Coverage check

Per charter acceptance criterion: "≥3 external citations per candidate invariant."

| Candidate | Citation count | Pass? |
|---|---|---|
| INV-7 substrate-serialization | ARIES (3 URLs), Bernstein/Goodman (4 URLs), SQLite docs | ≥7 — PASS |
| INV-8 idempotency-at-the-boundary | Wolverine PR #1858, Akka persistence, Greg Young versioning | 3 — PASS |
| INV-9 HSM-as-state-machine | Light — internal only | **FAIL — need backfill** |
| INV-10 liveness-event-protocol | Conductor, AWP, internal RT-2.12 | 3 — PASS (thin) |
| INV-11 posture-declared-capabilities | Miller 2006, Paradigm Lost 2003, POLA wiki, erights.org, anip-protocol | ≥5 — PASS |
| INV-12 next-actions-as-affordance | Norman 1999, jnd.org, ACM Interactions, HCI glossary, Graphics Interface 2000 | ≥5 — PASS |
| INV-13 process-manager-two-event-split | Akka (2 URLs), Wolverine (3 URLs), Greg Young (2 URLs) | ≥7 — PASS |
| INV-14 native-primitive-first-recovery | Light — git docs only | **FAIL — need backfill or drop** |
| INV-15 single-machine-frame | Microsoft SAS, Saga doc, Clemens Vasters origin blog, Azure saga alternatives | 4 — PASS |

**Two failures to address in D1 (survey):** INV-9 and INV-14 are under-cited. Either backfill external literature or downgrade to operational-pattern (catalog-internal only) status. Likely action: INV-9 backfills with Harel statecharts; INV-14 either drops to operational-pattern or gets the "ARIES Compensation Log Records semantics as the abstract analog" treatment.

## 12. Workload-agnosticism preview

Anticipating D3 (stress test): the cross-walk surfaces a strong-and-quiet pattern — every candidate (INV-7 through INV-15) is workload-agnostic by construction because none of them name `feature` / `oneshot` / `debug` / `refactor` / `discovery` or any SDLC-specific term. They name runtime primitives (events, streams, sequences, postures, locks, recovery). This is the *positive case* for workload-agnosticism: if the candidate list survives unchanged through D3, it confirms the catalog's framing is workload-correct.

The *risk*: existing INV-6 is currently scoped to "skill-body grep" as the operational projection. If D3 promotes INV-6 to the primary workload-agnosticism statement, the operational grep becomes one of several enforcement tools, not the rule itself. D3 will rule on this.

## 13. References

- Primary: [`docs/architecture/runtime.md`](../architecture/runtime.md)
- Source-of-truth catalog (v1): [`docs/architecture/invariants.md`](../architecture/invariants.md)
- Charter trigger: issue [#1370](https://github.com/lvlup-sw/exarchos/issues/1370) comment [4464273740](https://github.com/lvlup-sw/exarchos/issues/1370#issuecomment-4464273740)
- Audit predecessor: [`docs/research/2026-05-18-invariant-content-audit.md`](2026-05-18-invariant-content-audit.md)
- External-corpus details: [`docs/research/2026-05-20-runtime-invariants-research-survey.md`](2026-05-20-runtime-invariants-research-survey.md) (D1, next)
