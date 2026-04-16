/**
 * Platform-agnostic skills renderer + build CLI.
 *
 * Consumes `RuntimeMap.placeholders` (see `src/runtimes/types.ts`) to turn a
 * single skill source into one rendered variant per target runtime.
 *
 * Public surface grows task-by-task:
 *   - Task 003: `render(body, placeholders)` — placeholder substitution core.
 *   - Task 004: error handling + `assertNoUnresolvedPlaceholders`.
 *   - Task 005 (original): `parseTokenArgs` + argument-aware substitution.
 *   - Task 005 (dual-facade): `parseCallMacro` + `CALL_MACRO_REGEX` — CALL
 *     macro parser for `{{CALL tool action {json}}}` tokens.
 *   - Task 006: `copyReferences`.
 *   - Task 007: `buildAllSkills` orchestrator.
 *   - Task 008: `main()` CLI entry.
 *   - Task 009: Wire `renderCallMacros` into `buildAllSkills`, CLI facade
 *     rendering (`renderCliCall`), render-time fail-fast validation.
 *
 * Implements: DR-2, DR-3.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadAllRuntimes } from './runtimes/load.js';
import type { RuntimeMap } from './runtimes/types.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';
import { lintPlaceholders } from './placeholder-lint.js';

/**
 * Matches `{{TOKEN}}` and `{{TOKEN arg1="..." arg2="..."}}` placeholder
 * tokens. Capture groups:
 *   1. token name (identifier)
 *   2. raw arg string (optional, may be undefined)
 *
 * The token identifier is `\w+` so `{{FOO_BAR}}`, `{{CHAIN}}`, `{{abc123}}`
 * all match. The arg body is `[^}]*` — it intentionally forbids `}` so that
 * a stray `}}` cannot land inside an arg string and confuse the matcher.
 *
 * Exported so `src/placeholder-lint.ts` can use the exact same pattern
 * the renderer uses — the lint must see precisely the tokens the
 * renderer would otherwise substitute, and duplicating the regex in
 * two files would let them drift.
 *
 * WARNING: this is a stateful `/g` instance. Callers MUST either use a
 * local `.matchAll()` iterator or reset `lastIndex = 0` before and
 * after an `.exec()` loop so state does not leak into later call
 * sites.
 */
export const PLACEHOLDER_REGEX = /\{\{(\w+)(?:\s+([^}]*))?\}\}/g;

/**
 * Matches `{{CALL tool action {json}}}` macro tokens in skill source bodies.
 *
 * Capture group 1: full content after `CALL ` — i.e. `tool action {json}`.
 * The captured string is what `parseCallMacro()` expects as its `raw` input.
 *
 * The inner `.+` is greedy (not `.+?`) so that JSON args containing `}`
 * are captured correctly. E.g. `{{CALL tool act {"k":"v"}}}` — with a
 * non-greedy match the first `}}` inside the JSON would terminate the
 * capture prematurely. The greedy variant backtracks to let `\}\}` anchor
 * at the true closing delimiter. One CALL macro per line is the expected
 * usage; multiple CALL macros on the same line should be placed on
 * separate lines instead.
 *
 * Exported so:
 *   - The placeholder lint (task 010) can detect CALL macros without
 *     duplicating the pattern.
 *   - The render pipeline (tasks 007/008) can locate macros for expansion.
 *
 * WARNING: this is a stateful `/g` instance — same caveats as
 * `PLACEHOLDER_REGEX`. Use `.matchAll()` or reset `lastIndex` manually.
 */
export const CALL_MACRO_REGEX = /\{\{CALL\s+(.+)\}\}/g;

// ---------------------------------------------------------------------------
// CALL macro parser (task 005)
// ---------------------------------------------------------------------------

/**
 * The four composite MCP tools known to Exarchos. Hardcoded here for now;
 * task 006 will wire up the full registry validation.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'exarchos_workflow',
  'exarchos_event',
  'exarchos_orchestrate',
  'exarchos_view',
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
  if (parts.length < 2) {
    throw new Error(
      `parseCallMacro: expected "tool action {json}" but got "${trimmed}" — ` +
        `found ${parts.length} token(s) before the JSON body`,
    );
  }

  const tool = parts[0];
  const action = parts[1];
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
      return renderCliCall(ast);
    }

    // Unknown facade — leave macro as-is.
    return match;
  });
}

/**
 * Render a single parsed CALL macro as an MCP tool_use invocation.
 *
 * Output format:
 *   `{mcpPrefix}{toolName}({ "action": "{actionName}", ...args })`
 *
 * The `action` field is injected as the first key in the args object because
 * MCP composite tools use an `action` discriminator to route to the correct
 * handler.
 *
 * @param ast - Parsed CALL macro AST from `parseCallMacro()`.
 * @param runtime - Runtime providing the MCP prefix.
 * @returns The rendered MCP tool_use string.
 */
function renderMcpCall(ast: CallMacroAst, runtime: RuntimeMap): string {
  const prefix = runtime.capabilities.mcpPrefix;
  const fullArgs: Record<string, unknown> = { action: ast.action, ...ast.args };
  return `${prefix}${ast.tool}(${JSON.stringify(fullArgs, null, 2)})`;
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
 * Output format:
 *   `Bash(exarchos {tool-suffix} {action} --{kebab-key} {value} ... --json)`
 *
 * The tool name is mapped from its MCP `exarchos_{suffix}` form to the
 * CLI `exarchos {suffix}` subcommand. Args keys are camelCase-to-kebab
 * converted into `--flag value` pairs. A trailing `--json` flag is always
 * appended.
 *
 * @param ast - Parsed CALL macro AST from `parseCallMacro()`.
 * @returns The rendered Bash CLI string.
 */
function renderCliCall(ast: CallMacroAst): string {
  // Convert tool name: exarchos_workflow → exarchos workflow
  const toolCmd = ast.tool.replace(/_/g, ' ');
  const flags = Object.entries(ast.args)
    .map(([key, value]) => `--${camelToKebab(key)} ${String(value)}`)
    .join(' ');
  const flagsPart = flags.length > 0 ? ` ${flags}` : '';
  return `Bash(${toolCmd} ${ast.action}${flagsPart} --json)`;
}

/**
 * Diagnostic context for `render()` / `assertNoUnresolvedPlaceholders()`.
 * Both are optional so callers that don't care about nice error messages
 * (e.g. unit tests exercising the happy path) don't need to plumb anything.
 */
export interface RenderContext {
  sourcePath?: string;
  runtimeName?: string;
  /** When provided, run `renderCallMacros(body, runtime)` as a
   *  pre-processing step before placeholder substitution. */
  runtime?: RuntimeMap;
}

/**
 * Substitute `{{TOKEN}}` placeholders in `body` with values from
 * `placeholders`. Multi-line substitution values have their subsequent
 * lines prefixed with the column of the opening `{{` so the rendered
 * output preserves visual indentation.
 *
 * Tokens may carry arguments: `{{CHAIN next="plan" args="$PLAN"}}`. The
 * renderer parses the args, looks up the placeholder value for `CHAIN`,
 * and then performs a nested substitution of `{{next}}` / `{{args}}`
 * inside that value using the parsed arg map. Nested substitution does
 * NOT throw on unknown keys — only the outer pass validates against the
 * main placeholder map.
 *
 * Throws on unknown placeholder tokens — pass a populated `context` so the
 * error message can point at the offending source file and line.
 *
 * Idempotent: running `render` on output that has no remaining tokens
 * returns that output byte-identically.
 *
 * @param body - Raw skill source body (or any placeholder-bearing string).
 * @param placeholders - Map of token name → substitution value.
 * @param context - Optional diagnostic context (source path, runtime name).
 * @returns The rendered string with tokens substituted.
 */
export function render(
  body: string,
  placeholders: Record<string, string>,
  context: RenderContext = {},
): string {
  // When a runtime is provided, pre-process CALL macros before
  // placeholder substitution so `{{CALL ...}}` tokens are expanded
  // to facade-appropriate output first.
  const preprocessed = context.runtime
    ? renderCallMacros(body, context.runtime)
    : body;

  return substitute(preprocessed, placeholders, {
    sourcePath: context.sourcePath ?? '<unknown>',
    runtimeName: context.runtimeName ?? '<unknown>',
    throwOnUnknown: true,
  });
}

/**
 * Core token-substitution engine shared by the top-level `render()` pass
 * and the nested arg-value interpolation pass. The `throwOnUnknown` flag
 * is the only semantic difference between the two modes: the outer pass
 * validates tokens against the full placeholder map and raises on a miss,
 * while the nested pass leaves unknown `{{key}}` references untouched so
 * that arg interpolation never bleeds into a false-positive error.
 */
function substitute(
  body: string,
  values: Record<string, string>,
  opts: { sourcePath: string; runtimeName: string; throwOnUnknown: boolean },
): string {
  return body.replace(PLACEHOLDER_REGEX, (match, tokenName: string, argString: string | undefined, offset: number) => {
    if (!Object.prototype.hasOwnProperty.call(values, tokenName)) {
      if (!opts.throwOnUnknown) {
        return match;
      }
      const line = lineOf(body, offset);
      throw placeholderError(tokenName, opts.sourcePath, opts.runtimeName, line, Object.keys(values));
    }

    let value = values[tokenName];

    // If the token carries arguments, parse them and run a nested pass
    // that substitutes `{{key}}` tokens inside the placeholder value with
    // the parsed arg map. Nested pass does not throw on unknown — an
    // arg-less placeholder value containing `{{foo}}` is allowed.
    if (argString !== undefined && argString.trim().length > 0) {
      const args = parseTokenArgs(argString);
      value = substitute(value, args, {
        sourcePath: opts.sourcePath,
        runtimeName: opts.runtimeName,
        throwOnUnknown: false,
      });
    }

    if (!value.includes('\n')) {
      return value;
    }

    // Multi-line value: compute the column of the opening `{{` and indent
    // every subsequent line by that many spaces so the visual block stays
    // aligned with the opening token.
    const column = columnOf(body, offset);
    const indent = ' '.repeat(column);
    const lines = value.split('\n');
    return lines.map((line, i) => (i === 0 ? line : indent + line)).join('\n');
  });
}

/**
 * Parse a `key="value" key2="value2"` argument string into a map.
 * Values must be double-quoted; whitespace between pairs is ignored.
 * Unquoted values, unterminated quotes, or trailing garbage cause a
 * `malformed token args` error.
 *
 * @param argString - Raw capture group from a `{{TOKEN ...}}` match.
 * @returns The parsed key/value map (empty for an empty/whitespace input).
 */
export function parseTokenArgs(argString: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = argString.trim();
  if (trimmed.length === 0) return out;

  // Step through the string collecting `key="value"` pairs. We deliberately
  // hand-roll this rather than using a single regex so we can give a useful
  // diagnostic at the exact position of a malformed token.
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    // Skip whitespace between pairs.
    while (i < len && /\s/.test(trimmed[i])) i++;
    if (i >= len) break;

    // Read key identifier.
    const keyStart = i;
    while (i < len && /[\w-]/.test(trimmed[i])) i++;
    if (i === keyStart) {
      throw new Error(
        `malformed token args: expected identifier at position ${i} in "${argString}"`,
      );
    }
    const key = trimmed.slice(keyStart, i);

    // Expect `=`.
    if (i >= len || trimmed[i] !== '=') {
      throw new Error(
        `malformed token args: expected "=" after "${key}" at position ${i} in "${argString}"`,
      );
    }
    i++; // consume `=`

    // Expect opening quote.
    if (i >= len || trimmed[i] !== '"') {
      throw new Error(
        `malformed token args: expected opening quote for "${key}" at position ${i} in "${argString}"`,
      );
    }
    i++; // consume opening `"`

    // Read value until closing quote. Backslash escapes are not supported
    // (keep the vocabulary simple); a literal `"` inside a value is not
    // allowed.
    const valStart = i;
    while (i < len && trimmed[i] !== '"') i++;
    if (i >= len) {
      throw new Error(
        `malformed token args: unterminated quoted value for "${key}" in "${argString}"`,
      );
    }
    const value = trimmed.slice(valStart, i);
    i++; // consume closing `"`

    out[key] = value;
  }

  return out;
}

/**
 * Scan a rendered string for any residual `{{...}}` tokens and throw with
 * the same diagnostic format as `render()` if any are found. Intended as
 * a post-render sanity check in `buildAllSkills` so broken variants never
 * reach disk.
 *
 * @param rendered - Output of `render()`.
 * @param sourcePath - Origin file of the rendered content (for diagnostics).
 * @param runtimeName - Runtime whose placeholder map was used.
 */
export function assertNoUnresolvedPlaceholders(
  rendered: string,
  sourcePath: string,
  runtimeName: string,
): void {
  PLACEHOLDER_REGEX.lastIndex = 0;
  const match = PLACEHOLDER_REGEX.exec(rendered);
  if (match) {
    const tokenName = match[1];
    const line = lineOf(rendered, match.index);
    // Reset the regex state so the stateful /g instance doesn't leak into
    // later calls (matters because PLACEHOLDER_REGEX is module-scoped).
    PLACEHOLDER_REGEX.lastIndex = 0;
    throw placeholderError(tokenName, sourcePath, runtimeName, line, []);
  }
  PLACEHOLDER_REGEX.lastIndex = 0;
}

/**
 * Build a uniform `unknown placeholder` error. Known tokens are sorted so
 * the error message is deterministic regardless of map iteration order.
 */
function placeholderError(
  tokenName: string,
  sourcePath: string,
  runtimeName: string,
  line: number,
  knownTokens: string[],
): Error {
  const sorted = [...knownTokens].sort();
  const knownList = sorted.length > 0 ? sorted.join(', ') : '(none)';
  return new Error(
    `unknown placeholder {{${tokenName}}} in ${sourcePath}:${line}. ` +
      `Known placeholders: [${knownList}]. ` +
      `Add it to runtimes/${runtimeName}.yaml or remove it from source.`,
  );
}

/**
 * Return the 0-indexed column of `offset` within `source`. The column is
 * defined as the number of characters since the most recent newline
 * (exclusive) — i.e. the visible indentation of the opening `{{`.
 */
function columnOf(source: string, offset: number): number {
  const lastNewline = source.lastIndexOf('\n', offset - 1);
  return offset - (lastNewline + 1);
}

/**
 * Return the 1-indexed line number of `offset` within `source`. Used for
 * diagnostic error messages pointing at the offending token.
 */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Recursively copy the `references/` subdirectory from `srcDir` to
 * `destDir`. No-op if the source has no such subdirectory.
 *
 * Files are copied byte-for-byte (so binary blobs survive), and mtime is
 * pinned via `utimesSync` so re-running the build does not perturb
 * downstream consumers that key off of timestamps.
 *
 * Contract:
 *   - `srcDir/references/` absent → no-op (do not create a `references/`
 *     directory under `destDir`).
 *   - `srcDir/references/` present → mirrored under `destDir/references/`
 *     with full nested structure preserved.
 *   - Idempotent: running twice in a row is equivalent to running once,
 *     and produces byte- and mtime-identical files the second time.
 *
 * @param srcDir - Directory containing an optional `references/` subtree.
 * @param destDir - Directory under which a mirror `references/` will be
 *   written. Must already exist (caller's responsibility).
 */
export function copyReferences(srcDir: string, destDir: string): void {
  const srcRefs = join(srcDir, 'references');
  if (!existsSync(srcRefs)) return;
  const srcStat = statSync(srcRefs);
  if (!srcStat.isDirectory()) return;

  const destRefs = join(destDir, 'references');
  copyTreePreservingMtime(srcRefs, destRefs);
}

/**
 * Recursively copy `src` to `dest`, creating directories as needed and
 * pinning each file's mtime to the source's mtime so idempotence holds
 * at the filesystem level.
 *
 * Does not follow symlinks (via `statSync` + file/dir branching). Hidden
 * dotfiles are included — unlike `operations/copy.ts::smartCopyDirectory`
 * which skips them — because references can legitimately include
 * `.gitkeep` or similar markers. `writtenPaths` is an optional out-param
 * that `buildAllSkills` uses to track every file it produced so the
 * stale-cleanup pass can avoid deleting fresh output.
 */
function copyTreePreservingMtime(
  src: string,
  dest: string,
  writtenPaths?: Set<string>,
): void {
  const srcStat = statSync(src);
  if (srcStat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    const entries = readdirSync(src);
    for (const entry of entries) {
      copyTreePreservingMtime(join(src, entry), join(dest, entry), writtenPaths);
    }
    return;
  }
  if (srcStat.isFile()) {
    // Ensure parent exists (handles top-level files when `dest` is new).
    // Read + write so binary bytes round-trip exactly.
    const contents = readFileSync(src);
    writeFileSync(dest, contents);
    utimesSync(dest, srcStat.atime, srcStat.mtime);
    if (writtenPaths) writtenPaths.add(resolve(dest));
  }
}

// -----------------------------------------------------------------------------
// Task 007: buildAllSkills orchestrator
// -----------------------------------------------------------------------------

/**
 * Summary returned by `buildAllSkills` so callers (the CLI, tests) can
 * report on what happened without re-scanning the output tree.
 */
export interface BuildReport {
  variantsWritten: number;
  referencesCopied: number;
  overridesUsed: string[];
  warnings: string[];
}

/**
 * Orchestrator: render every source skill once per loaded runtime into
 * a per-runtime output tree.
 *
 * For each `srcDir/**\/SKILL.md` source:
 *   - If a runtime-specific override `SKILL.<runtime>.md` exists in the
 *     same skill directory, that override is written verbatim to the
 *     runtime's output (no rendering, no placeholder validation). The
 *     override path is recorded in `BuildReport.overridesUsed`.
 *   - Otherwise the source body is rendered with the runtime's
 *     `placeholders` map and the result is validated with
 *     `assertNoUnresolvedPlaceholders` before being written.
 *   - Any `references/` subdirectory next to the source `SKILL.md` is
 *     mirrored under each runtime's output variant.
 *
 * After writing all variants, any file under `outDir/<runtime>/` that
 * was not produced by this run is removed. Files outside
 * `outDir/<runtime>/` are never touched.
 *
 * Throws if `srcDir` contains no `SKILL.md` files.
 *
 * @param opts.srcDir - Source root (e.g. `skills-src/`).
 * @param opts.outDir - Per-runtime output root (e.g. `skills/`). Each
 *   runtime gets a subdirectory named after its `RuntimeMap.name`.
 * @param opts.runtimesDir - Directory containing runtime YAML files
 *   consumed by `loadAllRuntimes`.
 * @returns Populated `BuildReport`.
 */
export function buildAllSkills(opts: {
  srcDir: string;
  outDir: string;
  runtimesDir: string;
}): BuildReport {
  const runtimes: RuntimeMap[] = loadAllRuntimes(opts.runtimesDir);
  const skillDirs = walkSkillSourceDirs(opts.srcDir);

  if (skillDirs.length === 0) {
    throw new Error(
      `buildAllSkills: no SKILL.md files found under ${opts.srcDir} — refusing to produce an empty build.`,
    );
  }

  // Pre-flight: enforce the placeholder vocabulary. Running this
  // *before* the renderer means a stray `{{NOT_A_REAL_TOKEN}}`
  // surfaces as a single aggregated error naming every offender,
  // rather than throwing at the first `render()` call for whichever
  // runtime happens to iterate first. Implements DR-3 (lint path).
  //
  // Vocabulary is derived from the union of placeholder keys across
  // every loaded runtime map. In production the union collapses to
  // the canonical five tokens defined in `runtimes/*.yaml`
  // (MCP_PREFIX, COMMAND_PREFIX, TASK_TOOL, CHAIN, SPAWN_AGENT_CALL);
  // in tests that use synthetic fixtures the union is whatever the
  // fixtures declare — the lint self-adjusts so tests never need to
  // carry a duplicate "allowed tokens" list.
  const vocabulary = unionPlaceholderKeys(runtimes);
  const lintResult = lintPlaceholders({ sourcesDir: opts.srcDir, vocabulary });
  if (!lintResult.passed) {
    throw new Error(lintResult.message);
  }

  // Per-runtime set of file paths we produced this run. Used by the
  // stale-cleanup pass at the end so we only delete orphans, never
  // files that the current run legitimately wrote.
  const writtenByRuntime = new Map<string, Set<string>>();
  for (const rt of runtimes) writtenByRuntime.set(rt.name, new Set());

  const overridesUsed: string[] = [];
  const warnings: string[] = [];
  let variantsWritten = 0;
  let referencesCopied = 0;

  for (const skillDir of skillDirs) {
    const skillRel = relative(opts.srcDir, skillDir);
    const sourcePath = join(skillDir, 'SKILL.md');
    const body = readFileSync(sourcePath, 'utf8');

    for (const rt of runtimes) {
      const written = writtenByRuntime.get(rt.name)!;
      const outSkillDir = join(opts.outDir, rt.name, skillRel);
      const outSkillFile = join(outSkillDir, 'SKILL.md');
      mkdirSync(outSkillDir, { recursive: true });

      // Escape hatch: runtime-specific override file wins for this
      // runtime only, and is written verbatim with no rendering.
      const overridePath = join(skillDir, `SKILL.${rt.name}.md`);
      if (existsSync(overridePath)) {
        const overrideBody = readFileSync(overridePath, 'utf8');
        writeFileSync(outSkillFile, overrideBody);
        written.add(resolve(outSkillFile));
        overridesUsed.push(overridePath);
        variantsWritten++;
      } else {
        try {
          const macroExpanded = renderCallMacros(body, rt);
          const rendered = render(macroExpanded, rt.placeholders, {
            sourcePath,
            runtimeName: rt.name,
          });
          assertNoUnresolvedPlaceholders(rendered, sourcePath, rt.name);
          writeFileSync(outSkillFile, rendered);
          written.add(resolve(outSkillFile));
          variantsWritten++;
        } catch (err) {
          // Re-throw macro validation errors with source file context
          // so the developer knows which skill triggered the failure.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes(sourcePath)) {
            throw err;
          }
          throw new Error(`CALL macro error in ${sourcePath}: ${msg}`);
        }
      }

      // References: mirror next to the variant under each runtime.
      if (existsSync(join(skillDir, 'references'))) {
        const before = written.size;
        copyTreePreservingMtime(
          join(skillDir, 'references'),
          join(outSkillDir, 'references'),
          written,
        );
        referencesCopied += written.size - before;
      }
    }
  }

  // Stale cleanup: any file under `outDir/<runtime>/` not written this
  // run is deleted. We intentionally scope this to the per-runtime
  // subtree so we can never touch unrelated files that happen to sit
  // under `outDir` for other reasons.
  for (const rt of runtimes) {
    const runtimeRoot = join(opts.outDir, rt.name);
    if (!existsSync(runtimeRoot)) continue;
    const written = writtenByRuntime.get(rt.name)!;
    cleanStaleFiles(runtimeRoot, written);
  }

  return { variantsWritten, referencesCopied, overridesUsed, warnings };
}

/**
 * Collect every placeholder identifier defined by any loaded runtime
 * map into a sorted, de-duplicated list. The `buildAllSkills` lint
 * preflight uses this as its vocabulary so a skill source is allowed
 * to reference any token that at least one runtime knows how to
 * render. Sorted for determinism in diagnostic messages.
 */
function unionPlaceholderKeys(runtimes: RuntimeMap[]): string[] {
  const set = new Set<string>();
  for (const rt of runtimes) {
    for (const key of Object.keys(rt.placeholders)) set.add(key);
  }
  return [...set].sort();
}

/**
 * Walk `srcDir` recursively and return the absolute path of every
 * directory that contains a `SKILL.md` file. We return directories (not
 * the `SKILL.md` files themselves) so downstream code can locate the
 * adjacent `references/` and `SKILL.<runtime>.md` override files.
 */
function walkSkillSourceDirs(srcDir: string): string[] {
  const results: string[] = [];
  if (!existsSync(srcDir)) return results;

  const stack: string[] = [srcDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }

    // If this directory contains a SKILL.md, record it.
    if (entries.includes('SKILL.md')) {
      results.push(current);
    }

    // Recurse into subdirectories regardless — skill trees may nest.
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory() && entry !== 'references') {
        stack.push(full);
      }
    }
  }
  return results.sort();
}

// -----------------------------------------------------------------------------
// Task 008: CLI entry (`npm run build:skills`)
// -----------------------------------------------------------------------------

/**
 * Re-export of the shared `MainDeps` shape so existing callers that
 * imported it from this module continue to work. The canonical
 * definition lives in `cli-helpers.ts`.
 */
export type { MainDeps } from './cli-helpers.js';

/**
 * `npm run build:skills` entry point. Resolves default paths relative
 * to `deps.cwd()`, runs `buildAllSkills`, prints a one-line summary on
 * success, and exits with code 1 on any error (printed to stderr).
 *
 * Exported so the CLI test harness can invoke it with mocked deps. The
 * self-invocation guard at the bottom of this file only triggers when
 * the file is executed directly (e.g. via `node dist/build-skills.js`).
 *
 * @param _argv - Currently unused; reserved for future flag parsing
 *   (e.g. `--srcDir`, `--outDir`). Named with a leading underscore to
 *   silence the no-unused-vars lint while preserving the public shape.
 * @param deps - Optional injected side-effecting collaborators.
 */
export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);

  const root = cwd();
  const srcDir = join(root, 'skills-src');
  const outDir = join(root, 'skills');
  const runtimesDir = join(root, 'runtimes');

  let report: BuildReport;
  try {
    report = buildAllSkills({ srcDir, outDir, runtimesDir });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errLog(`[build:skills] error: ${msg}`);
    exit(1);
    return; // unreachable in production; in tests exit throws
  }

  // Count distinct runtime names in the output path set so the summary
  // does not need `buildAllSkills` to carry a separate runtime counter.
  const runtimeCount = countRuntimesFromOutDir(outDir);
  log(
    `[build:skills] wrote ${report.variantsWritten} variants across ${runtimeCount} runtimes`,
  );
  if (report.overridesUsed.length > 0) {
    log(`[build:skills] used ${report.overridesUsed.length} runtime override(s)`);
  }
  for (const warning of report.warnings) {
    errLog(`[build:skills] warning: ${warning}`);
  }
}

/**
 * Count how many direct subdirectories of `outDir` exist. Each subdir
 * corresponds to one rendered runtime. Returns 0 if `outDir` is absent.
 */
function countRuntimesFromOutDir(outDir: string): number {
  if (!existsSync(outDir)) return 0;
  try {
    return readdirSync(outDir).filter((entry) => {
      try {
        return statSync(join(outDir, entry)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

// Self-invocation guard: only run `main()` when this file is executed
// directly (e.g. `node dist/build-skills.js`). Importing it from a test
// must NOT trigger a build.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

/**
 * Recursively walk `root` and remove any file that is not present in
 * `keep`. After file removal, empty directories are pruned bottom-up so
 * the tree stays tidy.
 *
 * Safety: callers must scope `root` to a per-runtime subtree under
 * `outDir` so we never touch unrelated files.
 */
function cleanStaleFiles(root: string, keep: Set<string>): void {
  if (!existsSync(root)) return;

  const walk = (dir: string): boolean => {
    // Returns `true` if the directory still contains any surviving entries
    // after the recursive cleanup pass — caller uses that to decide
    // whether to rmdir this directory too.
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }

    let survivorCount = 0;
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const hadSurvivors = walk(full);
        if (hadSurvivors) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        }
      } else if (st.isFile()) {
        if (keep.has(resolve(full))) {
          survivorCount++;
        } else {
          try {
            rmSync(full, { force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    }
    return survivorCount > 0;
  };

  walk(root);
}
