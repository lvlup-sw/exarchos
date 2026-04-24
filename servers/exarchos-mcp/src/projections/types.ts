export interface ProjectionReducer<State, Event> {
  readonly id: string;
  readonly version: number;
  readonly initial: State;
  apply(state: State, event: Event): State;
}
