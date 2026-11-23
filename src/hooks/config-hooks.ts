import { spawnCommand } from '../utils/process.js';
import type { BoundProjectHooks } from './hook-trust.js';

export interface WorkflowEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly featureId: string;
  readonly timestamp: string;
}

export type ConfigHookRunner = (event: WorkflowEvent) => Promise<void>;

/**
 * Creates a fire-and-forget hook runner for the project hooks that the user trusts.
 * Only `bindProjectHooks` makes the bound hooks, and an untrusted project binds an empty table.
 * For each hook in `hooks.on[event.type]`, the runner starts the bound program with its arguments through `spawnCommand`.
 * On POSIX it uses no shell. On win32 only a bare package-manager shim name goes through `cmd.exe`.
 * It writes the event JSON to stdin and ignores every hook error, so that a hook cannot block a workflow operation.
 *
 * Each hook gets `EXARCHOS_FEATURE_ID`, `EXARCHOS_PHASE`, `EXARCHOS_EVENT_TYPE`
 * and `EXARCHOS_WORKFLOW_TYPE`. `EXARCHOS_SKIP_HOOKS=true` turns off all hooks.
 * The event tool calls the runner after a successful append. Hooks are external,
 * so `EventStore.append()` must not call the runner.
 */
export function createConfigHookRunner(
  hooks: BoundProjectHooks,
): ConfigHookRunner {
  return async (event: WorkflowEvent): Promise<void> => {
    if (process.env.EXARCHOS_SKIP_HOOKS === 'true') return;

    if (!Object.hasOwn(hooks.on, event.type)) return;
    const handlers = hooks.on[event.type];
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
        const [program, ...args] = handler.argv;
        const proc = spawnCommand(program, args, {
          cwd: hooks.projectRoot,
          env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: handler.timeout,
        });

        proc.stdin?.on('error', () => {
        });
        proc.stdin?.write(JSON.stringify(event));
        proc.stdin?.end();

        proc.on('error', () => {
        });
      } catch {
      }
    }
  };
}
