/**
 * Routes the Claude Code hook CLI commands to their lifecycle handlers.
 * The hook layer only observes. The MCP tools hold all enforcement.
 */

/**
 * Hook commands that `main()` detects early. They skip backend initialization and the heavy eval dependencies.
 * Each one is a lifecycle observer and never blocks tool execution.
 * `subagent-stop` opens the event store to append a `subagent.tokens_used` event. It changes no workflow state and fails open on an error.
 */
export const HOOK_COMMANDS = new Set([
  'session-start', 'session-end', 'subagent-stop',
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
 * Sends a hook command to its lifecycle handler, with `--plugin-root` and `--directive` read from argv.
 * The build puts the SessionStart binding directive into the rendered hook command. The handler returns it as `additionalContext`.
 *
 * The router imports the handlers lazily. It does not import `cli.ts`, which pulls in promptfoo and playwright through the eval handlers.
 * A handler `error` is an operational failure, not a policy decision. The router writes it to stderr and returns exit code 1.
 *
 * @param command     - The hook command name, for example 'session-start'
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
  const pluginRootIdx = argv.indexOf('--plugin-root');
  if (pluginRootIdx !== -1 && argv[pluginRootIdx + 1]) {
    process.env.EXARCHOS_PLUGIN_ROOT = argv[pluginRootIdx + 1];
  }

  const directiveIdx = argv.indexOf('--directive');
  const directive =
    directiveIdx !== -1 && argv[directiveIdx + 1] ? argv[directiveIdx + 1] : undefined;

  const { resolveStateDir } = await import('../../workflow/state-store.js');

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
    'session-start': async () => {
      const { handleSessionStart } = await import('../../lifecycle/session-start.js');
      return handleSessionStart(stdinData, resolveStateDir(), { directive });
    },
    'session-end': async () => {
      const { handleSessionEnd } = await import('../../lifecycle/session-end.js');
      return handleSessionEnd(stdinData, resolveStateDir());
    },
    'subagent-stop': async () => {
      const { handleSubagentStop } = await import('../../lifecycle/subagent-stop.js');
      return handleSubagentStop(stdinData, resolveStateDir());
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
    process.stderr.write(`[${result.error.code}] ${result.error.message}\n`);
    return { handled: true, exitCode: 1 };
  }

  return { handled: true };
}
