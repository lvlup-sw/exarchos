import { spawn } from 'child_process';
import type { ResolvedProjectConfig } from '../config/resolve.js';

export interface WorkflowEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly featureId: string;
  readonly timestamp: string;
}

export type ConfigHookRunner = (event: WorkflowEvent) => Promise<void>;

/**
 * Creates a fire-and-forget hook runner for the resolved project config. For
 * each hook in `config.hooks.on[event.type]`, it runs the command with `sh -c`
 * and writes the event JSON to stdin. It ignores every hook error, so that a
 * hook cannot block a workflow operation.
 *
 * Each hook gets `EXARCHOS_FEATURE_ID`, `EXARCHOS_PHASE`, `EXARCHOS_EVENT_TYPE`
 * and `EXARCHOS_WORKFLOW_TYPE`. `EXARCHOS_SKIP_HOOKS=true` turns off all hooks.
 */
export function createConfigHookRunner(
  config: ResolvedProjectConfig,
): ConfigHookRunner {
  return async (event: WorkflowEvent): Promise<void> => {
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
        });
        proc.stdin.write(JSON.stringify(event));
        proc.stdin.end();

        proc.on('error', () => {
        });
      } catch {
      }
    }
  };
}
