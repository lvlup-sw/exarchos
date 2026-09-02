import { spawn } from 'child_process';
import type { ResolvedProjectConfig } from '../config/resolve.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkflowEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly featureId: string;
  readonly timestamp: string;
}

export type ConfigHookRunner = (event: WorkflowEvent) => Promise<void>;

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a fire-and-forget hook runner bound to the resolved project config.
 *
 * When an event is fired, the runner looks up matching hooks in
 * `config.hooks.on[event.type]` and spawns each configured command via
 * `sh -c`. The event JSON is written to each process's stdin. Hook
 * failures are silently swallowed so they never block workflow operations.
 *
 * Environment variables injected into each hook process:
 * - EXARCHOS_FEATURE_ID  — the feature stream being operated on
 * - EXARCHOS_PHASE       — current workflow phase (from event.data.phase)
 * - EXARCHOS_EVENT_TYPE  — the event type string
 * - EXARCHOS_WORKFLOW_TYPE — workflow type (from event.data.workflowType)
 *
 * Set EXARCHOS_SKIP_HOOKS=true to disable all hook execution (useful in tests).
 *
 * Integration point: call the returned runner after EventStore.append() in
 * orchestrate handlers to fire hooks on workflow events. Do NOT modify
 * EventStore.append() itself — hooks are an external concern.
 */
export function createConfigHookRunner(
  config: ResolvedProjectConfig,
): ConfigHookRunner {
  return async (event: WorkflowEvent): Promise<void> => {
    // Skip hooks when env var is set (test/CI environments)
    if (process.env.EXARCHOS_SKIP_HOOKS === 'true') return;

    const handlers = config.hooks.on[event.type];
    if (!handlers?.length) return;

    const env = {
      ...process.env,
      EXARCHOS_FEATURE_ID: event.featureId,
      EXARCHOS_PHASE: String(event.data?.phase ?? ''),
      EXARCHOS_EVENT_TYPE: event.type,
      EXARCHOS_WORKFLOW_TYPE: String(event.data?.workflowType ?? ''),
    };

    for (const handler of handlers) {
      try {
        const proc = spawn('sh', ['-c', handler.command], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: handler.timeout,
        });

        proc.stdin.on('error', () => {
          // Prevent unhandled error events on stdin
        });
        proc.stdin.write(JSON.stringify(event));
        proc.stdin.end();

        // Fire-and-forget — attach error handler to prevent unhandled exceptions
        proc.on('error', () => {
          // Silently ignore hook errors — hooks must never block workflow
        });
      } catch {
        // Silently ignore spawn errors — hooks must never block workflow
      }
    }
  };
}
