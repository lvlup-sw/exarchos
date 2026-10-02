import type { RuntimeMap } from '../runtimes/types.js';
import { CALL_MACRO_REGEX } from '../skill-vocabulary.js';

/**
 * The five composite MCP tools of Exarchos: four visible and the hidden sync tool.
 * `parseCallMacro` uses this set as a coarse pre-check against typos.
 * The registry check in `validateCallMacro` is authoritative.
 * When you add a composite tool, update this set and register the tool in `src/registry/tools.ts`.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'exarchos_workflow',
  'exarchos_event',
  'exarchos_orchestrate',
  'exarchos_view',
  'exarchos_sync',
]);

/**
 * Typed representation of a parsed `{{CALL tool action {json}}}` macro.
 */
export interface CallMacroAst {
  tool: string;
  action: string;
  args: Record<string, unknown>;
}

/**
 * Parse the raw content of a `{{CALL ...}}` macro into a typed AST.
 * The format is `tool_name action_name {json_args}`. The JSON body starts at the first `{`.
 *
 * @param raw - The raw content after stripping `{{CALL` and `}}` delimiters.
 * @returns A typed `CallMacroAst` with tool, action, and parsed args.
 * @throws On malformed input: missing parts, invalid JSON, or unknown tool.
 */
export function parseCallMacro(raw: string): CallMacroAst {
  const trimmed = raw.trim();

  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(
      `parseCallMacro: expected JSON args object in "${trimmed}" — format is "tool action {json}"`,
    );
  }

  const prefix = trimmed.slice(0, jsonStart).trim();
  const parts = prefix.split(/\s+/);
  const tool = parts[0];
  const action = parts[1];
  if (tool === undefined || action === undefined) {
    throw new Error(
      `parseCallMacro: expected "tool action {json}" but got "${trimmed}" — ` +
        `found ${parts.length} token(s) before the JSON body`,
    );
  }

  const jsonStr = trimmed.slice(jsonStart);

  if (!KNOWN_TOOLS.has(tool)) {
    throw new Error(
      `parseCallMacro: "${tool}" is not a known tool. ` +
        `Known tools: [${[...KNOWN_TOOLS].sort().join(', ')}]`,
    );
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `parseCallMacro: malformed JSON args in "${trimmed}" — ${detail}`,
    );
  }

  return { tool, action, args };
}

/**
 * Minimal schema interface that matches the `.safeParse()` contract of a Zod schema,
 * so this module does not import zod.
 */
interface SafeParseable {
  safeParse(data: unknown): { success: true } | { success: false; error: { message: string } };
}

/** A registry action from the lookup function, with the schema that validates its args. */
export interface RegistryAction {
  readonly name: string;
  readonly schema: SafeParseable;
}

/**
 * Signature for the registry lookup function injected via
 * `setRegistryLookup()`. Given a tool name and action name, returns the
 * matching `RegistryAction` or `undefined` if the pair is unknown.
 */
export type RegistryLookup = (
  toolName: string,
  actionName: string,
) => RegistryAction | undefined;

/** Module-level registry lookup, configured via `setRegistryLookup()`. */
let _registryLookup: RegistryLookup | undefined;

/**
 * Configure the registry lookup for `validateCallMacro()`. The caller injects it,
 * so this module has no static import of the registry.
 *
 * @param fn - The lookup function, normally `findActionInRegistry` from `src/registry.ts`.
 */
export function setRegistryLookup(fn: RegistryLookup): void {
  _registryLookup = fn;
}

/**
 * Clear the registry lookup, so `renderCallMacros` skips validation.
 * Tests use it, so the lookup of one test block does not leak into later blocks.
 */
export function clearRegistryLookup(): void {
  _registryLookup = undefined;
}

/**
 * Validate a parsed CALL macro AST against the tool registry.
 * The per-action schemas hold only the action parameters, not the `action` discriminator.
 * `buildCompositeSchema` adds the discriminator for MCP registration.
 *
 * @param ast - The parsed CALL macro AST from `parseCallMacro()`.
 * @throws If registry is not configured, action is unknown, or args fail
 *   schema validation.
 */
export function validateCallMacro(ast: CallMacroAst): void {
  if (!_registryLookup) {
    throw new Error(
      'validateCallMacro: registry not configured — call setRegistryLookup() first',
    );
  }

  const action = _registryLookup(ast.tool, ast.action);
  if (!action) {
    throw new Error(
      `validateCallMacro: unknown action "${ast.action}" on tool "${ast.tool}"`,
    );
  }

  const result = action.schema.safeParse(ast.args);
  if (!result.success) {
    throw new Error(
      `validateCallMacro: args for ${ast.tool}.${ast.action} failed schema validation: ${result.error.message}`,
    );
  }
}

/**
 * Expand each `{{CALL tool action {json}}}` macro in `body` for the `preferredFacade`
 * of the runtime: `mcp` or `cli`. An unknown facade leaves the macro as it is.
 * When a registry lookup is configured, the function validates each macro at build time.
 * This pass runs before placeholder substitution. The order is safe, because
 * `CALL_MACRO_REGEX` and `PLACEHOLDER_REGEX` match disjoint text.
 * The function uses a fresh RegExp, because the module-scoped regex has the global flag and keeps `lastIndex` state.
 *
 * @param body - Raw skill source body containing `{{CALL ...}}` macros.
 * @param runtime - The target runtime whose facade preference sets the output format.
 * @returns The body with the CALL macros expanded.
 */
export function renderCallMacros(body: string, runtime: RuntimeMap): string {
  const localRegex = new RegExp(CALL_MACRO_REGEX.source, 'g');
  return body.replace(localRegex, (match, content: string) => {
    const ast = parseCallMacro(content);

    if (_registryLookup) {
      validateCallMacro(ast);
    }

    if (runtime.preferredFacade === 'mcp') {
      return renderMcpCall(ast, runtime);
    }

    if (runtime.preferredFacade === 'cli') {
      return renderCliCall(ast, runtime);
    }

    return match;
  });
}

/**
 * Normalize a path to forward slashes. Diagnostics embed `sourcePath` as it is,
 * and `path.join` on win32 gives backslashes. Node fs APIs accept forward slashes on
 * each platform, so the normalized path is valid for I/O and for diagnostics.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Render a parsed CALL macro as an MCP tool call, then an HTML comment with the CLI fallback.
 * The `action` field is the first key, because composite tools route on it.
 * If the MCP transport is unavailable, the agent can read the comment and run the CLI form.
 */
function renderMcpCall(ast: CallMacroAst, runtime: RuntimeMap): string {
  const prefix = runtime.capabilities.mcpPrefix;
  const fullArgs: Record<string, unknown> = { action: ast.action, ...ast.args };
  const primary = `${prefix}${ast.tool}(${JSON.stringify(fullArgs, null, 2)})`;
  const fallback = renderFallbackComment('mcp', ast, runtime);
  return `${primary}\n${fallback}`;
}

/**
 * Convert a camelCase string to kebab-case.
 *
 * Examples: `featureId` → `feature-id`, `myPropName` → `my-prop-name`.
 */
function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * Render a parsed CALL macro as a Bash CLI call, then an HTML comment with the MCP fallback.
 * If the Bash transport is unavailable, the agent can read the comment and use the MCP form.
 *
 * @param runtime - Runtime with the MCP prefix for the fallback.
 */
function renderCliCall(ast: CallMacroAst, runtime: RuntimeMap): string {
  const primary = renderCliPrimary(ast);
  const fallback = renderFallbackComment('cli', ast, runtime);
  return `${primary}\n${fallback}`;
}

/**
 * Build the Bash CLI form of a CALL macro: `exarchos_workflow` becomes `exarchos workflow`,
 * each arg key becomes a kebab-case flag, and `--json` comes last.
 * `true` gives a bare flag, `false` gives `--no-<flag>`, and an object or array gives JSON.
 * `renderFallbackComment` uses the same function, so the fallback matches the primary form.
 */
function renderCliPrimary(ast: CallMacroAst): string {
  const toolCmd = ast.tool.replace(/_/g, ' ');
  const flagParts: string[] = [];
  for (const [key, value] of Object.entries(ast.args)) {
    const kebab = camelToKebab(key);
    if (value === true) {
      flagParts.push(`--${kebab}`);
    } else if (value === false) {
      flagParts.push(`--no-${kebab}`);
    } else if (value !== null && typeof value === 'object') {
      flagParts.push(`--${kebab}`, JSON.stringify(value));
    } else {
      flagParts.push(`--${kebab}`, String(value));
    }
  }
  const flags = flagParts.join(' ');
  const flagsPart = flags.length > 0 ? ` ${flags}` : '';
  return `Bash(${toolCmd} ${ast.action}${flagsPart} --json)`;
}

/**
 * Build the MCP tool call of a CALL macro as compact single-line JSON,
 * so the fallback HTML comment stays on one line.
 */
function renderMcpPrimaryCompact(ast: CallMacroAst, runtime: RuntimeMap): string {
  const prefix = runtime.capabilities.mcpPrefix;
  const fullArgs: Record<string, unknown> = { action: ast.action, ...ast.args };
  return `${prefix}${ast.tool}(${JSON.stringify(fullArgs)})`;
}

/**
 * Build the single-line HTML comment that points an agent at the other facade,
 * for when the primary facade is unavailable.
 *
 * @param primary - The facade of the primary call. The fallback is the other facade.
 * @returns An HTML comment line with no trailing newline.
 */
function renderFallbackComment(
  primary: 'mcp' | 'cli',
  ast: CallMacroAst,
  runtime: RuntimeMap,
): string {
  if (primary === 'mcp') {
    return `<!-- If MCP is unavailable, fall back to: ${renderCliPrimary(ast)} -->`;
  }
  return `<!-- If Bash is unavailable, fall back to: ${renderMcpPrimaryCompact(ast, runtime)} -->`;
}
