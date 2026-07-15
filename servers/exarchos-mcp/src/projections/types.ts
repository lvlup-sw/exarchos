/**
 * A deterministic reducer that projects an event stream into a derived state.
 *
 * `ProjectionReducer<State, Event>` is the canonical pattern for every
 * projection over the Exarchos event store (DR-1). Concrete projections —
 * hot-file manifest, time-travel, cross-workflow memory, cost telemetry,
 * rehydration — each provide a reducer and register it with the projection
 * registry. The reducer defines **what** the projection is; the registry and
 * runner handle **when** and **how** it is replayed.
 *
 * ## Purity contract
 *
 * `apply` MUST be a pure function:
 *
 * - **Deterministic**: for the same `(state, event)` inputs, it MUST return an
 *   equal output. No dependence on wall-clock time, random sources, the
 *   filesystem, network, environment variables, or any other ambient state.
 * - **No I/O**: `apply` MUST NOT perform side effects (file writes, logging,
 *   network calls, mutation of module-level variables, etc.).
 * - **No mutation of `state`**: `apply` MUST return a new `State` value and
 *   MUST NOT mutate the `state` argument in place. Downstream consumers rely
 *   on structural sharing across calls, and a property test in a sibling task
 *   (T003) enforces this invariant.
 *
 * Purity is what makes replay safe: rebuilding a projection by folding
 * `apply` over a persisted event log must reproduce the same `State` the
 * live system observed, byte-for-byte.
 *
 * ## Identity and versioning
 *
 * - {@link ProjectionReducer.id} is a human-readable, globally unique
 *   identifier (e.g. `"rehydration@v1"`). Uniqueness is enforced by the
 *   projection registry; duplicate registration raises an error (T002).
 * - {@link ProjectionReducer.version} is an integer schema version. It is
 *   used to detect schema skew between a reducer and a cached snapshot: if
 *   the cached snapshot's version does not match the current reducer's
 *   version, the cache is discarded and the projection is re-folded from the
 *   event log.
 *
 * @typeParam State - The projected state type this reducer produces.
 * @typeParam Event - The event type this reducer consumes.
 */
/**
 * Aggregate boundary a {@link ProjectionReducer} folds over.
 *
 * Deliberately a single literal. See {@link ProjectionReducer.scope} for why a
 * cross-stream (`'global'`) member is not — and must not be — representable.
 * This alias is the one place to change if that decision is ever revisited.
 */
export type ProjectionScope = 'stream';

export interface ProjectionReducer<State, Event> {
  /**
   * Globally unique identifier for this reducer (e.g. `"rehydration@v1"`).
   *
   * Must be unique across the projection registry. Duplicate registration is
   * rejected by the registry (see T002).
   */
  readonly id: string;

  /**
   * Integer schema version for this reducer's `State` shape.
   *
   * Bumped whenever the `State` type or the meaning of `apply` changes in a
   * way that invalidates previously cached snapshots. The projection runner
   * compares this against the version recorded on a cached snapshot and
   * re-folds from scratch on mismatch.
   */
  readonly version: number;

  /**
   * Aggregate boundary for this reducer.
   *
   * - `'stream'` — folds over events on one stream (one feature workflow).
   *   Consumed by the `decide` / `withSession` / `aggregateStream` primitives.
   *
   * {@link ProjectionScope} is `'stream'` and nothing else. A cross-stream
   * (`'global'`) fold was removed because no reducer in this codebase has a
   * state shape that survives one: `task-store@v1` keys `TaskStoreState.tasks`
   * by a bare per-feature ordinal (`'001'`) and `TaskRecord` carries no
   * `featureId`, so folding two streams together silently merges feature-A's
   * task `001` into feature-B's. Collapsing the union makes that corrupting
   * state **unauthorable in typechecked code** — a compile error at the
   * keyboard rather than a runtime rejection. Note the precise wording: not
   * "unrepresentable", which would overstate it. See the limit below.
   *
   * Consequently the per-stream primitives carry no runtime scope check. Three
   * things make that safe, and the type alone is NOT one of them:
   *
   * 1. Every production `defaultRegistry.register` call site is a module-load
   *    side-effect import from a typechecked barrel, so `scope: 'global'` is a
   *    compile error at every real authoring site.
   * 2. Reducers are code, never deserialized — snapshots carry state, not
   *    reducers — so no reducer crosses a trust boundary into the registry.
   * 3. Even a wrongly-scoped reducer reaching `decide` / `aggregateStream`
   *    would fold ONE stream: those read `backend.queryEvents(streamId)`. The
   *    cross-stream fold died with `readProjection`, not with this stamp.
   *
   * The limit worth knowing: `tsconfig.json` excludes test files from the
   * program, so the compiler does NOT enforce this in a `.test.ts`. A fixture
   * can still author `scope: 'global'` there. That is a gap in coverage, not in
   * safety — see (3).
   *
   * Re-widening {@link ProjectionScope} re-arms the collision above and MUST
   * re-introduce a runtime guard alongside a state shape actually keyed by
   * stream.
   *
   * THIS COMMENT AND `docs/architecture/projections.md` ("Reducer scope
   * discipline") ARE THE ONLY TWO PLACES THIS GUARANTEE IS STATED. Every other
   * site — reducers, the primitives, the tests — points here and asserts
   * nothing. That is deliberate: #1342 was caused by a claim about this
   * subsystem being restated in ~8 places until the restatements outlived the
   * code and contradicted each other. Prose has no compiler, so the only
   * defence is to have one copy. If you find yourself explaining the scope rule
   * somewhere else, link instead.
   */
  readonly scope: ProjectionScope;

  /**
   * The initial `State` value used as the seed for replay.
   *
   * Folding over an empty event stream MUST yield `initial`.
   */
  readonly initial: State;

  /**
   * Pure folding function: `(state, event) => nextState`.
   *
   * MUST be deterministic, side-effect-free, and MUST NOT mutate the `state`
   * argument. See the interface-level "Purity contract" section for the full
   * set of invariants. Violations are caught by property tests (T003) and
   * will cause replay divergence in production.
   *
   * @param state - The current projected state (MUST NOT be mutated).
   * @param event - The next event to fold into the state.
   * @returns The next projected state.
   */
  apply(state: State, event: Event): State;
}
