/**
 * Hook routing adapter — dispatches Claude Code hook CLI commands to their
 * lightweight handlers.
 *
 * #1476 + #1485: the hook layer is observe-only (see
 * docs/adrs/2026-05-24-hook-layer-observe-only.md). The former enforcement /
 * control hooks were retired; enforcement lives entirely inside the MCP tools.
 * Three lifecycle observers remain: `session-start` (binding), `session-end`
 * (provenance), and `subagent-stop` (per-subagent token telemetry, restored in
 * #1525 W2 Half 1 — still observe-only; it appends a `subagent.tokens_used`
 * atom and never blocks the subagent).
 *
 * Extracted from index.ts to create a clean three-way dispatcher:
 * hooks → CLI → MCP.
 */

// Hook CLI commands invoked by Claude Code hooks (hooks.json).
// These are detected early in main() and routed through a lightweight path
// that avoids the expensive backend initialization and heavy eval deps.
//
// Observe-only set (#1476 + #1485 + #1525): all three entries are lifecycle
// observers. They report on harness lifecycle events and never block tool
// execution. `subagent-stop` opens the event store to append its atom (it must,
// to record the token fact) but is otherwise observe-only — it drives no state
// transition and fails open on any error.
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
 * Handle a hook command by dispatching to the appropriate lifecycle handler.
 *
 * @param command     - The hook command name (e.g. 'session-start', 'session-end')
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
  // Parse --plugin-root from argv if present (passed by hooks that need
  // to resolve plugin-relative paths before backend initialization).
  const pluginRootIdx = argv.indexOf('--plugin-root');
  if (pluginRootIdx !== -1 && argv[pluginRootIdx + 1]) {
    process.env.EXARCHOS_PLUGIN_ROOT = argv[pluginRootIdx + 1];
  }

  // #1485: the SessionStart binding directive is baked into the rendered
  // per-runtime hook command (prefix already substituted at build time) and
  // passed as `--directive <text>`. The handler echoes it as additionalContext
  // for injection-capable hosts.
  const directiveIdx = argv.indexOf('--directive');
  const directive =
    directiveIdx !== -1 && argv[directiveIdx + 1] ? argv[directiveIdx + 1] : undefined;

  // Lightweight hook router — avoids importing cli.ts which transitively
  // pulls in promptfoo/playwright via eval handlers.
  const { resolveStateDir } = await import('../workflow/state-store.js');

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
      const { handleSessionStart } = await import('../lifecycle/session-start.js');
      return handleSessionStart(stdinData, resolveStateDir(), { directive });
    },
    'session-end': async () => {
      const { handleSessionEnd } = await import('../lifecycle/session-end.js');
      return handleSessionEnd(stdinData, resolveStateDir());
    },
    'subagent-stop': async () => {
      const { handleSubagentStop } = await import('../lifecycle/subagent-stop.js');
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
    // Write error details to stderr so the agent (and hook runner) can see them.
    // Observers never set a policy `error`, so any error here is an
    // operational failure (e.g. STDIN parse, IO) — surface it and exit 1.
    process.stderr.write(`[${result.error.code}] ${result.error.message}\n`);
    return { handled: true, exitCode: 1 };
  }

  return { handled: true };
}
