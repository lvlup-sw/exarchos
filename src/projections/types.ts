/**
 * The reducer contract for every projection over the Exarchos event store.
 */

/**
 * Aggregate boundary of a {@link ProjectionReducer}. It is one literal on purpose.
 * {@link ProjectionReducer.scope} tells why `'global'` must not be a member.
 */
export type ProjectionScope = 'stream';

/**
 * A deterministic reducer that folds an event stream into a derived state. Each projection
 * gives one to the projection registry. The registry and the runner decide when to replay it.
 *
 * `apply` must be pure. The same inputs give an equal output, with no I/O, no ambient state,
 * and no change to `state`. A rebuild from the stored log must then reproduce the state
 * that the live system saw.
 *
 * @typeParam State - The projected state type this reducer produces.
 * @typeParam Event - The event type this reducer consumes.
 */
export interface ProjectionReducer<State, Event> {
  /** Unique id in the projection registry, for example `"rehydration@v1"`. The registry rejects a duplicate. */
  readonly id: string;

  /**
   * Integer schema version of `State`. Increase it when a change to `State` or `apply`
   * makes stored snapshots invalid. A snapshot read matches on this version, so a
   * snapshot of another version is not used.
   */
  readonly version: number;

  /**
   * Aggregate boundary. `'stream'` folds one feature workflow for `decide`, `withSession` and
   * `aggregateStream`. This is the one statement of the rule. Other sites link here.
   *
   * A cross-stream fold merges the tasks of different features. `task-store@v1` keys tasks by a
   * per-feature ordinal, and `TaskRecord` has no `featureId`. The one-literal type makes
   * `scope: 'global'` a compile error in typechecked code.
   *
   * The primitives have no runtime scope check. Three facts make that safe. Each production
   * `register` call is in a typechecked barrel. A reducer is code and is never deserialized. A wrong scope still
   * folds one stream, because `decide` and `aggregateStream` read `backend.queryEvents(streamId)`.
   *
   * `tsconfig.json` excludes test files, so a test can still author `'global'`. A wider
   * `ProjectionScope` must add a runtime guard and a state keyed by stream.
   */
  readonly scope: ProjectionScope;

  /**
   * The initial `State` value used as the seed for replay.
   *
   * Folding over an empty event stream MUST yield `initial`.
   */
  readonly initial: State;

  /**
   * Pure fold step: `(state, event) => nextState`. The interface description gives the
   * purity rules. An impure `apply` makes a replay differ from the live state.
   *
   * @param state - The current projected state (MUST NOT be mutated).
   * @param event - The next event to fold into the state.
   * @returns The next projected state.
   */
  apply(state: State, event: Event): State;
}
