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
   * state **unrepresentable at compile time** rather than merely rejected at
   * runtime.
   *
   * Consequently the per-stream primitives need no runtime scope check — the
   * type is the guard. Re-widening {@link ProjectionScope} re-arms the
   * collision above and MUST re-introduce a runtime guard alongside a state
   * shape that is actually keyed by stream.
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
