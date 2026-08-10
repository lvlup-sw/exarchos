# Migration: one authority for event names

**Applies to:** custom event types registered at runtime — the `events:` block of
`exarchos.config.ts` / `.exarchos.yml`, and any direct `registerEventType(...)` call.
**Does not apply to:** events already written to an event store. Nothing on disk changes and
nothing on disk stops replaying. See [Already-persisted streams](#already-persisted-streams).

## What changed

Exarchos shipped **two** rules for what an event name may be, and they disagreed.

`EVENT_NAME_PATTERN` in `servers/exarchos-mcp/src/event-store/schemas.ts` was
`/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/`. It had no `_` in either character class, so it rejected
**25 of the 171 built-in event names in its own file** — `workflow.checkpoint_requested`,
`merge.retry_attempt`, `subagent.tokens_used`, and 22 others. It never failed, because
`registerEventType` pointed it only at *custom* registrations while the built-ins are a `readonly`
literal array that was never fed through it. A validator its own authoritative corpus fails,
invisible because it was never pointed at that corpus.

The other rule is the DR-3 event-name grammar in
`servers/exarchos-mcp/src/event-store/event-name.ts`, derived from all 171 live names and accepting
every one — but narrower in the other direction: no digits, single-word namespaces, 2 or 3
dot-segments.

There is now one authority. `registerEventType` calls the grammar's `assertWellFormedEventName`;
`EVENT_NAME_PATTERN` is still exported, but it is now *built from* the grammar's own alphabet and
separator set rather than written by hand, so it is a form of the rule instead of a rival to it.

## The rule, in full

```
EventName   := Namespace "." Segment ( "." Segment )?
Namespace   := Word                                   -- a bare word, no "-" and no "_"
Segment     := Word | Word ("-" Word)+ | Word ("_" Word)+   -- one style per segment, never both
Word        := [a-z]+                                 -- no digits, no uppercase
```

Accepted: `merge.executed`, `workflow.plan-review-dispatched`,
`migration.correlation_backfill_progress`, `team.task.assigned`.

## What starts working

Names using `snake_case` in a segment. These were refused by `EVENT_NAME_PATTERN` and are now
accepted, which is what makes the built-in catalog and the custom-registration seam agree for the
first time:

| name | before | after |
|---|---|---|
| `deploy.rollback_started` | rejected | **registers** |
| `billing.invoice_reissued` | rejected | **registers** |

## What breaks

Four shapes registered before and no longer do. Each was legal under the old regex and is refused
by the grammar:

| shape | example | clause |
|---|---|---|
| a digit anywhere | `deploy.rollout2` | `NON_LOWERCASE_ALPHA` |
| a multi-word namespace | `my-app.started` | `NAMESPACE_NOT_SINGLE_WORD` |
| four or more segments | `a.b.c.d` | `TOO_MANY_SEGMENTS` |
| both separators in one segment | `deploy.blue-green_started` | `MIXED_WORD_SEPARATORS` |

The failure is loud and immediate: `registerEventType` throws a `MalformedEventNameError` naming
the broken clause and linking back to this note. Because `registerCustomWorkflows` rolls back the
whole config on any failure, a single affected name means **none** of that config's custom
workflows or events register — the server does not boot half-configured.

### Measured blast radius

Re-derived on the landing branch rather than estimated:

- **171** registered names on a cold boot — **0** carry a digit, a multi-word namespace, or a
  fourth segment. No built-in is affected.
- **79** distinct event names across **12,890** rows in two real on-disk stores
  (`~/.claude/workflow-state/exarchos.db`, `~/.exarchos/state/exarchos.db`) — **0** are refused by
  the grammar.
- Every custom event name this repo registers or documents (`deploy.started`, `deploy.finished`,
  `custom.hello`, `vcs.requested`, `vcs.executed`, `vcs.compensated`) — **0** affected.

So the known population of affected names is empty. That is a reason to state the break precisely,
not a reason to assume nobody has one.

## What to do if you have an affected name

1. **Rename it, if it has never been emitted.** Change the key in your `events:` block and every
   emit site. Nothing is on disk, so nothing is lost.

   ```diff
   -  'my-app.deploy2': { source: 'auto' }
   +  'myapp.deploy': { source: 'auto' }
   ```

   Digits usually carry a version (`deploy2` → `deploy.v.two` reads badly; prefer a new verb or a
   third segment: `deploy.rollout.second`). A multi-word namespace is usually two things — pick the
   partition (`my-app.started` → `myapp.started`), because a hyphenated namespace is how one
   partition silently becomes two.

2. **If it HAS been emitted, read the next section first.** A rename is a log-compatibility break
   under INV-1, and the safe sequence is different.

3. **If neither works — if the digit or the multi-word namespace is load-bearing for you** — the
   grammar is meant to be widened against real evidence rather than worked around. The no-digits
   clause in particular was adopted with zero measured counterexamples, which is exactly the
   condition under which one real counterexample should move it. Open an issue with the name and
   what it means; the clause lives in one place (`LOWER_ALPHA` / `MALFORMED_EVENT_NAMES` in
   `event-name.ts`) and widening it is a visible edit to a fixture table, not a character-class
   tweak.

Do **not** reach for `EVENT_NAME_PATTERN` as an escape hatch. It no longer decides anything, and
re-authoring it by hand re-creates the exact defect this change removed — the census's ratchet will
catch that and fail CI.

## Already-persisted streams

**No persisted event is rewritten, re-validated, or orphaned.** INV-1 holds by construction, not by
promise:

- The read path never consults the grammar. `EventStore.query` reads rows through the backend's
  `rowToEvent` (which returns the stored JSON payload) and folds them through `migrateEvents`.
  Neither step looks at the event *name*. A stream containing `my-app.deploy2` replays byte-for-byte
  after this change, exactly as before.
- This is already load-bearing today and not a new claim: the measured stores hold `init.executed`,
  a name the current catalog no longer declares at all, and those rows read back fine.
- The **write** path is where the change bites. An event can only be appended if its type is in the
  live registry (`WorkflowEventBase.type` checks membership in `getValidEventTypes()`). If your
  config's registration now fails, the name is no longer in the registry, so *new* events of that
  type are rejected while the *old* ones remain readable.

That is the shape to plan around: **history is safe, the future is not.** If you have persisted
events under an affected name, the sequence is

1. register a new, well-formed name alongside the old one and start emitting that;
2. teach the consuming projection to fold **both** names (the old one for history, the new one going
   forward);
3. leave the old events exactly where they are. Do not rewrite them — under INV-1 the store is
   authoritative and rewriting history to make a validator happy is the failure this rule exists to
   prevent.

Step 2 is the one people skip. A projection that only knows the new name will silently produce a
shorter fold over old streams, which reads as data loss and is not.

## Where this is pinned

- `servers/exarchos-mcp/src/event-store/event-name.ts` — the grammar, its compile-time proofs, and
  the derived `EVENT_NAME_PATTERN`.
- `servers/exarchos-mcp/src/event-store/event-name.test.ts` — the both-ways kill fixtures
  (a name the retired regex admitted that now fails; a `snake_case` name it refused that now
  registers) and the agreement sweep over the live catalog.
- `servers/exarchos-mcp/src/event-store/event-name-persisted-replay.test.ts` — the persisted corpus
  measured from the two real stores, replayed through the surviving authority.
- `servers/exarchos-mcp/src/architecture/event-grammar-census.ts` — the two-way ratchet that
  measures the two forms against each other and fails if they drift apart again.
