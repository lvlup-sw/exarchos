import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const STACK_VIEW = 'stack';

// ─── Stack Position ────────────────────────────────────────────────────────

export interface StackPosition {
  position: number;
  taskId: string;
  branch?: string;
  prUrl?: string;
}

// ─── View State ────────────────────────────────────────────────────────────

export interface StackViewState {
  positions: StackPosition[];
}

// ─── Projection ────────────────────────────────────────────────────────────

export const stackViewProjection: ViewProjection<StackViewState> = {
  init: () => ({ positions: [] }),

  apply: (view, event) => {
    if (event.type !== 'stack.position-filled') return view;

    const data = event.data as
      | { position?: number; taskId?: string; branch?: string; prUrl?: string }
      | undefined;

    if (data?.position === undefined || !data?.taskId) return view;

    const pos: StackPosition = {
      position: data.position,
      taskId: data.taskId,
    };

    if (data.branch !== undefined) pos.branch = data.branch;
    if (data.prUrl !== undefined) pos.prUrl = data.prUrl;

    return { positions: [...view.positions, pos] };
  },
};
