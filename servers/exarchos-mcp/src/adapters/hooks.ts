/**
 * Hook routing adapter — dispatches Claude Code hook CLI commands
 * (session-start, pre-compact, guard, etc.) to their lightweight handlers.
 *
 * Extracted from index.ts to create a clean three-way dispatcher:
 * hooks → CLI → MCP.
 */

// Hook CLI commands invoked by Claude Code hooks (hooks.json).
// These are detected early in main() and routed through a lightweight path
// that avoids the expensive backend initialization and heavy eval deps.
export const HOOK_COMMANDS = new Set([
  'pre-compact', 'session-start', 'guard', 'task-gate', 'teammate-gate',
  'subagent-context', 'session-end',
]);

/**
 * Check whether a command string is a known hook command.
 */
export function isHookCommand(command: string | undefined): boolean {
  return !!command && HOOK_COMMANDS.has(command);
}

export type HookResult =
  | { handled: true; exitCode?: number }
  | { handled: false };

/**
 * Handle a hook command by dispatching to the appropriate cli-commands handler.
 *
 * @param command     - The hook command name (e.g. 'pre-compact', 'guard')
 * @param argv        - Full process.argv array
 * @param readStdin   - Async function that reads raw stdin
 * @param parseStdin  - Function that parses raw stdin string into a JSON object
 * @param outputJson  - Function that writes a JSON result to stdout
 */
export async function handleHookCommand(
  command: string,
  argv: string[],
  readStdin: () => Promise<string>,
  parseStdin: (raw: string) => Record<string, unknown>,
  outputJson: (result: unknown) => void,
): Promise<HookResult> {
  // Parse --plugin-root from argv if present (used by SessionStart hook)
  const pluginRootIdx = argv.indexOf('--plugin-root');
  if (pluginRootIdx !== -1 && argv[pluginRootIdx + 1]) {
    process.env.EXARCHOS_PLUGIN_ROOT = argv[pluginRootIdx + 1];
  }

  // Lightweight hook router — avoids importing cli.ts which transitively
  // pulls in promptfoo/playwright via eval handlers.
  const { resolveStateDir } = await import('../workflow/state-store.js');
  const { resolveTeamsDir } = await import('../utils/paths.js');

  let stdinData: Record<string, unknown>;
  try {
    const rawInput = await readStdin();
    stdinData = parseStdin(rawInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputJson({ error: { code: 'STDIN_PARSE_ERROR', message } });
    return { handled: true, exitCode: 1 };
  }

  type HandlerResult = { error?: { code: string; message: string }; [key: string]: unknown };

  const handlers: Record<string, () => Promise<HandlerResult>> = {
    'pre-compact': async () => {
      const { handlePreCompact } = await import('../cli-commands/pre-compact.js');
      return handlePreCompact(stdinData, resolveStateDir());
    },
    'session-start': async () => {
      const { handleSessionStart } = await import('../cli-commands/session-start.js');
      return handleSessionStart(stdinData, resolveStateDir(), resolveTeamsDir());
    },
    'guard': async () => {
      const { handleGuard } = await import('../cli-commands/guard.js');
      return handleGuard(stdinData);
    },
    'task-gate': async () => {
      const { handleTaskGate } = await import('../cli-commands/gates.js');
      return handleTaskGate(stdinData);
    },
    'teammate-gate': async () => {
      const { handleTeammateGate } = await import('../cli-commands/gates.js');
      return handleTeammateGate(stdinData);
    },
    'subagent-context': async () => {
      const { handleSubagentContext } = await import('../cli-commands/subagent-context.js');
      return handleSubagentContext(stdinData);
    },
    'session-end': async () => {
      const { handleSessionEnd } = await import('../cli-commands/session-end.js');
      return handleSessionEnd(stdinData, resolveStateDir());
    },
  };

  const handler = handlers[command];
  if (!handler) {
    return { handled: false };
  }

  let result: HandlerResult;
  try {
    result = await handler();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputJson({ error: { code: 'HOOK_HANDLER_ERROR', message } });
    return { handled: true, exitCode: 1 };
  }
  outputJson(result);

  if (result.error) {
    const isGateCommand = command === 'task-gate' || command === 'teammate-gate';
    const exitCode = isGateCommand && result.error.code === 'GATE_FAILED' ? 2 : 1;
    return { handled: true, exitCode };
  }

  return { handled: true };
}
