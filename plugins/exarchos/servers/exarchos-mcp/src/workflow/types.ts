import { z } from 'zod';
import type {
  EventTypeSchema,
  EventSchema,
  CheckpointStateSchema,
  CheckpointMetaSchema,
  FeaturePhaseSchema,
  DebugPhaseSchema,
  RefactorPhaseSchema,
  TaskStatusSchema,
  TaskSchema,
  WorktreeStatusSchema,
  WorktreeSchema,
  SynthesisSchema,
  ArtifactsSchema,
  FeatureIdSchema,
  WorkflowTypeSchema,
  FeatureWorkflowStateSchema,
  DebugWorkflowStateSchema,
  RefactorWorkflowStateSchema,
  WorkflowStateSchema,
  InitInputSchema,
  ListInputSchema,
  GetInputSchema,
  SetInputSchema,
  SummaryInputSchema,
  ReconcileInputSchema,
  NextActionInputSchema,
  TransitionsInputSchema,
  CancelInputSchema,
  CheckpointInputSchema,
  ErrorCode,
} from './schemas.js';

// ─── Domain Types (derived from Zod schemas) ────────────────────────────────

export type EventType = z.infer<typeof EventTypeSchema>;
export type Event = z.infer<typeof EventSchema>;
export type CheckpointState = z.infer<typeof CheckpointStateSchema>;
export type CheckpointMeta = z.infer<typeof CheckpointMetaSchema>;

export type FeaturePhase = z.infer<typeof FeaturePhaseSchema>;
export type DebugPhase = z.infer<typeof DebugPhaseSchema>;
export type RefactorPhase = z.infer<typeof RefactorPhaseSchema>;

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;

export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;

export type Synthesis = z.infer<typeof SynthesisSchema>;
export type Artifacts = z.infer<typeof ArtifactsSchema>;

export type FeatureId = z.infer<typeof FeatureIdSchema>;
export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

// ─── Workflow State Types ───────────────────────────────────────────────────

export type FeatureWorkflowState = z.infer<typeof FeatureWorkflowStateSchema>;
export type DebugWorkflowState = z.infer<typeof DebugWorkflowStateSchema>;
export type RefactorWorkflowState = z.infer<typeof RefactorWorkflowStateSchema>;
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

// ─── Tool Input Types ───────────────────────────────────────────────────────

export type InitInput = z.infer<typeof InitInputSchema>;
export type ListInput = z.infer<typeof ListInputSchema>;
export type GetInput = z.infer<typeof GetInputSchema>;
export type SetInput = z.infer<typeof SetInputSchema>;
export type SummaryInput = z.infer<typeof SummaryInputSchema>;
export type ReconcileInput = z.infer<typeof ReconcileInputSchema>;
export type NextActionInput = z.infer<typeof NextActionInputSchema>;
export type TransitionsInput = z.infer<typeof TransitionsInputSchema>;
export type CancelInput = z.infer<typeof CancelInputSchema>;
export type CheckpointInput = z.infer<typeof CheckpointInputSchema>;

// ─── Error Code Type ────────────────────────────────────────────────────────

export type ErrorCodeValue = typeof ErrorCode[keyof typeof ErrorCode];
