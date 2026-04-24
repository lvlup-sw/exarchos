/**
 * Rehydration projection reducer — skeleton (T022, DR-3).
 *
 * Folds the canonical event stream (`WorkflowEvent`) into a
 * {@link RehydrationDocument} suitable for emission by the rehydration MCP
 * envelope (DR-3). This task intentionally lands only the skeleton:
 *
 *   - `id` / `version` / `initial`
 *   - `apply()` that returns `state` unchanged for **every** event
 *
 * Event-specific folding is layered on in the immediately following tasks:
 *   - T023 — `task.*` events project into `taskProgress`
 *   - T024 — `workflow.*` events populate `workflowState`
 *   - T025 — artifacts, blockers, and decisions
 *
 * The reducer is **not** registered with the projection registry here; that
 * wiring is T026.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { RehydrationDocumentSchema, type RehydrationDocument } from './schema.js';

/**
 * Minimal initial rehydration document — satisfies {@link RehydrationDocumentSchema}
 * with empty volatile sections and stable-section string defaults. Folding over
 * an empty event stream MUST yield this value (see `ProjectionReducer.initial`).
 *
 * Validated at module load (below) via `.parse(...)` so that any schema drift
 * is caught the moment this module is imported, rather than at first use.
 */
const initialRehydrationDocument: RehydrationDocument = RehydrationDocumentSchema.parse({
  v: 1,
  projectionSequence: 0,
  behavioralGuidance: {
    skill: '',
    skillRef: '',
  },
  workflowState: {
    featureId: '',
    phase: '',
    workflowType: '',
  },
  taskProgress: [],
  decisions: [],
  artifacts: {},
  blockers: [],
});

export const rehydrationReducer: ProjectionReducer<RehydrationDocument, WorkflowEvent> = {
  id: 'rehydration@v1',
  version: 1,
  initial: initialRehydrationDocument,
  apply(state: RehydrationDocument, _event: WorkflowEvent): RehydrationDocument {
    // Skeleton: the initial reducer does not interpret any event types.
    // T023–T025 replace this body with per-event-type folds.
    return state;
  },
};

export type { RehydrationDocument } from './schema.js';
