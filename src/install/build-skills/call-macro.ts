import type { RuntimeMap } from '../runtimes/types.js';
import { CALL_MACRO_REGEX } from '../skill-vocabulary.js';

// ---------------------------------------------------------------------------

/**
 * The five composite MCP tools known to Exarchos (4 visible + 1 hidden sync).
 *
 * Used for fail-fast validation in `parseCallMacro` when the registry
 * lookup is not wired (e.g. test isolation). The authoritative source is
 * the TOOL_REGISTRY consulted via `validateCallMacro`; this set is a
 * coarse pre-check that only rejects obvious typos. When adding a new
 * composite tool, update this set *and* register it in
 * `src/registry.ts`.
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
 * Parse the raw content inside a `{{CALL ...}}` macro into a typed AST.
 *
 * Expected format: `tool_name action_name {json_args}`
 *
 * Steps:
 *   1. Split into tool, action, and remaining JSON string
 *   2. Parse the JSON args
 *   3. Validate tool name against `KNOWN_TOOLS`
 *   4. Return the typed AST
 *
 * @param raw - The raw content after stripping `{{CALL` and `}}` delimiters.
 * @returns A typed `CallMacroAst` with tool, action, and parsed args.
 * @throws On malformed input: missing parts, invalid JSON, or unknown tool.
 */
export function parseCallMacro(raw: string): CallMacroAst {
  const trimmed = raw.trim();

  // Find the first JSON object boundary — the first `{` character.
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(
      `parseCallMacro: expected JSON args object in "${trimmed}" — format is "tool action {json}"`,
    );
  }

  // Everything before the `{` must be "tool action ".
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

  // Validate the tool name against the known registry.
  if (!KNOWN_TOOLS.has(tool)) {
    throw new Error(
      `parseCallMacro: "${tool}" is not a known tool. ` +
        `Known tools: [${[...KNOWN_TOOLS].sort().join(', ')}]`,
    );
  }

  // Parse JSON args.
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

// ---------------------------------------------------------------------------
// CALL macro registry validation (task 006)
// ---------------------------------------------------------------------------

/**
 * Minimal schema interface — matches the `.safeParse()` contract on a Zod
 * schema without importing zod directly. This keeps the root package free of
 * a hard dependency on zod at compile time (the MCP server owns the full
 * schemas; we only need to call `safeParse` on them).
 */
interface SafeParseable {
  safeParse(data: unknown): { success: true } | { success: false; error: { message: string } };
}

/**
 * A registry action returned by the lookup function. Contains at minimum
 * the action's Zod schema (which we use for arg validation).
 */
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
 * Configure the registry lookup function used by `validateCallMacro()`.
 *
 * The root package (`src/`) cannot import directly from the MCP server
 * package due to tsconfig `rootDir` boundaries. This setter allows the
 * caller (CLI entry point, test harness, or future build pipeline) to
 * wire the real `findActionInRegistry` from `servers/exarchos-mcp/` at
 * runtime without a compile-time cross-package import.
 *
 * @param fn - The lookup function (typically `findActionInRegistry` from
 *   the MCP server's `registry.ts`).
 */
export function setRegistryLookup(fn: RegistryLookup): void {
  _registryLookup = fn;
}

/**
 * Clear the registry lookup so `renderCallMacros` skips validation.
 * Primarily for test isolation — prevents one test block's `beforeAll`
 * from leaking state into later blocks.
 */
export function clearRegistryLookup(): void {
  _registryLookup = undefined;
}

/**
 * Validate a parsed CALL macro AST against the live tool registry.
 *
 * Steps:
 *   1. Look up the `(tool, action)` pair via the configured registry lookup.
 *   2. If unknown, throw with a descriptive error naming the tool and action.
 *   3. Validate `ast.args` against the action's Zod schema via `safeParse`.
 *   4. If validation fails, throw with the Zod error details.
 *
 * Requires `setRegistryLookup()` to have been called first — throws if the
 * registry is not configured.
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

  // Validate args against the action's schema. The per-action schemas in the
  // registry do NOT include the `action` discriminator field — they contain
  // only the action-specific parameters (e.g. featureId, phase, updates).
  // `buildCompositeSchema` adds the discriminator later for MCP registration.
  const result = action.schema.safeParse(ast.args);
  if (!result.success) {
    throw new Error(
      `validateCallMacro: args for ${ast.tool}.${ast.action} failed schema validation: ${result.error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// CALL macro rendering (task 007)
// ---------------------------------------------------------------------------

/**
 * Pre-process all `{{CALL tool action {json}}}` macros in `body`, replacing
 * each with the facade-appropriate output determined by the runtime's
 * `preferredFacade` setting.
 *
 * Currently supported facades:
 *   - `mcp` — emits `{mcpPrefix}{tool}({ "action": "{action}", ...args })`
 *   - `cli` — emits `Bash(exarchos {suffix} {action} --{flag} {val} --json)`
 *
 * This function is designed to run as a pre-processing pass *before*
 * `render()` handles `{{TOKEN}}` placeholder substitution. The two regex
 * patterns (`CALL_MACRO_REGEX` and `PLACEHOLDER_REGEX`) are disjoint, so
 * ordering is safe.
 *
 * Uses a fresh RegExp instance to avoid stateful `/g` issues with the
 * module-scoped `CALL_MACRO_REGEX`.
 *
 * @param body - Raw skill source body containing `{{CALL ...}}` macros.
 * @param runtime - The target runtime whose facade preference determines
 *   the output format.
 * @returns The body with all CALL macros expanded (or left intact for
 *   unsupported facades).
 */
export function renderCallMacros(body: string, runtime: RuntimeMap): string {
  // Create a fresh regex instance to avoid stateful /g issues with the
  // module-scoped CALL_MACRO_REGEX.
  const localRegex = new RegExp(CALL_MACRO_REGEX.source, 'g');
  return body.replace(localRegex, (match, content: string) => {
    const ast = parseCallMacro(content);

    // Validate against the live tool registry (if configured).
    // This catches unknown actions and invalid args at build time.
    if (_registryLookup) {
      validateCallMacro(ast);
    }

    if (runtime.preferredFacade === 'mcp') {
      return renderMcpCall(ast, runtime);
    }

    if (runtime.preferredFacade === 'cli') {
      return renderCliCall(ast, runtime);
    }

    // Unknown facade — leave macro as-is.
    return match;
  });
}

/**
 * Render a single parsed CALL macro as an MCP tool_use invocation.
 *
 * Output format (primary + remediation):
 *   `{mcpPrefix}{toolName}({ "action": "{actionName}", ...args })
 *   <!-- If MCP is unavailable, fall back to: Bash(...) -->`
 *
 * The `action` field is injected as the first key in the args object because
 * MCP composite tools use an `action` discriminator to route to the correct
 * handler. The trailing HTML comment is a DR-5 resilience hint: if the host's
 * MCP transport is unavailable at runtime, the agent can read the fallback
 * and execute the CLI form directly. HTML comments are invisible in rendered
 * Markdown but available to an agent reading the source.
 *
 * @param ast - Parsed CALL macro AST from `parseCallMacro()`.
 * @param runtime - Runtime providing the MCP prefix.
 * @returns The rendered MCP tool_use string with remediation comment.
 */
/**
 * Normalize a path to forward slashes. Diagnostic messages built from
 * `sourcePath` (vocabulary-lint, chain-target, placeholder errors) embed it
 * verbatim; a native `path.join` on win32 produces backslashes, which then
 * fail cross-platform test assertions that match a `/`-separated fragment.
 * Node's fs APIs accept forward-slash paths on every platform, so applying
 * this at construction keeps `sourcePath` valid for both I/O and diagnostics.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

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
 * Render a single parsed CALL macro as a Bash CLI invocation.
 *
 * Output format (primary + remediation):
 *   `Bash(exarchos {tool-suffix} {action} --{kebab-key} {value} ... --json)
 *   <!-- If Bash is unavailable, fall back to: mcp__...__tool({...}) -->`
 *
 * The tool name is mapped from its MCP `exarchos_{suffix}` form to the
 * CLI `exarchos {suffix}` subcommand. Args keys are camelCase-to-kebab
 * converted into `--flag value` pairs. A trailing `--json` flag is always
 * appended. The trailing HTML comment is a DR-5 resilience hint: if the
 * host's Bash transport is unavailable, the agent can read the fallback
 * and execute the MCP tool_use form directly.
 *
 * @param ast - Parsed CALL macro AST from `parseCallMacro()`.
 * @param runtime - Runtime providing the MCP prefix (used for the fallback
 *   pointer, not the primary form).
 * @returns The rendered Bash CLI string with remediation comment.
 */
function renderCliCall(ast: CallMacroAst, runtime: RuntimeMap): string {
  const primary = renderCliPrimary(ast);
  const fallback = renderFallbackComment('cli', ast, runtime);
  return `${primary}\n${fallback}`;
}

/**
 * Build the Bash CLI form of a CALL macro without any remediation comment.
 * Extracted so `renderFallbackComment` can emit the same string when the
 * primary facade is MCP, guaranteeing the primary and fallback forms stay
 * byte-identical to each runtime's standalone rendering.
 */
function renderCliPrimary(ast: CallMacroAst): string {
  // Convert tool name: exarchos_workflow → exarchos workflow
  const toolCmd = ast.tool.replace(/_/g, ' ');
  const flagParts: string[] = [];
  for (const [key, value] of Object.entries(ast.args)) {
    const kebab = camelToKebab(key);
    if (value === true) {
      // Boolean true → bare flag (no value)
      flagParts.push(`--${kebab}`);
    } else if (value === false) {
      // Boolean false → negated flag
      flagParts.push(`--no-${kebab}`);
    } else if (value !== null && typeof value === 'object') {
      // Object / array → JSON-serialize so we don't emit `[object Object]`
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
 * Build the MCP tool_use form of a CALL macro without any remediation
 * comment or pretty-printed indentation. Single-line JSON keeps the
 * fallback pointer to a single scannable line per DR-5. The compact
 * form omits whitespace inside the JSON body so the entire HTML
 * comment fits on one line regardless of how many args the call carries.
 */
function renderMcpPrimaryCompact(ast: CallMacroAst, runtime: RuntimeMap): string {
  const prefix = runtime.capabilities.mcpPrefix;
  const fullArgs: Record<string, unknown> = { action: ast.action, ...ast.args };
  return `${prefix}${ast.tool}(${JSON.stringify(fullArgs)})`;
}

/**
 * Build the HTML-comment remediation line that points an agent at the
 * opposite facade when the primary facade is unavailable at runtime
 * (DR-5). The comment is always a single line so it's easy to scan in the
 * rendered source.
 *
 * @param primary - Which facade was rendered as the primary invocation;
 *   the fallback points to the opposite one.
 * @param ast - Parsed CALL macro AST.
 * @param runtime - Runtime providing the MCP prefix (needed whether or
 *   not MCP is the primary form, because the fallback may point at MCP).
 * @returns An HTML comment line (no trailing newline).
 */
function renderFallbackComment(
  primary: 'mcp' | 'cli',
  ast: CallMacroAst,
  runtime: RuntimeMap,
): string {
  if (primary === 'mcp') {
    // MCP is primary → fallback is the CLI form.
    return `<!-- If MCP is unavailable, fall back to: ${renderCliPrimary(ast)} -->`;
  }
  // CLI is primary → fallback is the MCP tool_use form (single-line/compact).
  return `<!-- If Bash is unavailable, fall back to: ${renderMcpPrimaryCompact(ast, runtime)} -->`;
}

/**
 * Diagnostic context for `render()` / `assertNoUnresolvedPlaceholders()`.
 * Both are optional so callers that don't care about nice error messages
 * (e.g. unit tests exercising the happy path) don't need to plumb anything.
 */
