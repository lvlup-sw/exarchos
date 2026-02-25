/** Manifest entry written by SessionStart hook */
export interface SessionManifestEntry {
  readonly sessionId: string;
  readonly workflowId?: string;
  readonly transcriptPath: string;
  readonly startedAt: string;
  readonly cwd: string;
  readonly branch?: string;
}

/** Completion metadata appended by SessionEnd hook */
export interface SessionManifestCompletion {
  readonly sessionId: string;
  readonly extractedAt: string;
  readonly endReason?: string;
  readonly toolCalls: number;
  readonly turns: number;
  readonly totalTokens: number;
}

/** Compact event: one per tool call */
export interface SessionToolEvent {
  readonly t: 'tool';
  readonly ts: string;
  readonly tool: string;
  readonly cat: 'native' | 'mcp_exarchos' | 'mcp_other';
  readonly inB: number;
  readonly outB: number;
  readonly files?: readonly string[];
  readonly dur?: number;
  readonly sid: string;
  readonly wid?: string;
}

/** Compact event: one per model turn */
export interface SessionTurnEvent {
  readonly t: 'turn';
  readonly ts: string;
  readonly model: string;
  readonly tokIn: number;
  readonly tokOut: number;
  readonly tokCacheR: number;
  readonly tokCacheW: number;
  readonly dur?: number;
  readonly sid: string;
  readonly wid?: string;
}

/** Compact event: one per session (aggregate) */
export interface SessionSummaryEvent {
  readonly t: 'summary';
  readonly ts: string;
  readonly sid: string;
  readonly wid?: string;
  readonly tools: Record<string, number>;
  readonly tokTotal: {
    readonly in: number;
    readonly out: number;
    readonly cacheR: number;
    readonly cacheW: number;
  };
  readonly files: readonly string[];
  readonly dur: number;
  readonly turns: number;
}

export type SessionEvent = SessionToolEvent | SessionTurnEvent | SessionSummaryEvent;

/** Metadata passed to the parser */
export interface SessionMetadata {
  readonly sessionId: string;
  readonly workflowId?: string;
}
