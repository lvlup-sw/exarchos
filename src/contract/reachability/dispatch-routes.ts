/**
 * The shipped dispatch-route authority: the `(tool, action)` pairs that the composite routers
 * route. It reads the dispatch code that runs, not the contract compile that supplies the
 * closure denominator. Thus the `route` hop can fail when a router and the registry disagree.
 *
 * The routing table is code, not data. The routers use `switch (action)` arms, `action === '…'`
 * branches, and an `ACTION_HANDLERS` table. No runtime value lists all of them without the
 * import of each handler, so this module scans the router source. A test compares the scan
 * with the runtime handler keys and the live registry.
 *
 * Each structural surprise throws a named error instead of an empty route set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOSITE_HANDLER_LOADERS } from '../../dispatch/core/dispatch.js';
import { EFFECT_PROVIDERS, type EffectProvider } from './providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The `src/` root. Router module paths resolve relative to it. */
export const SOURCE_ROOT = path.resolve(HERE, '../..');

/** The routing construct a route was extracted from. */
export const ROUTE_FORMS = ['switch-case', 'equality-branch', 'handler-table'] as const;
export type RouteForm = (typeof ROUTE_FORMS)[number];

/** One `(tool, action)` pair the shipped router actually routes. */
export interface DispatchRoute {
  readonly tool: string;
  readonly action: string;
  /** The ActionId of the route: `${tool}.${action}`. */
  readonly actionId: string;
  /** Which routing construct in the router source produced this route. */
  readonly form: RouteForm;
}

/** A composite tool and the router module file dispatch loads for it. */
export interface RouterSource {
  readonly tool: string;
  /** Absolute path to the composite router module the dispatch loader imports. */
  readonly file: string;
}

/** Thrown when the shipped routing wiring cannot be read as an authority. */
export class DispatchRouteScanError extends Error {
  override readonly name = 'DispatchRouteScanError';
}

/**
 * Resolves each dispatchable tool to its composite router file. Dispatch keeps the tool-to-directory
 * map inside loader closures, which code cannot read. The `area` field of {@link EFFECT_PROVIDERS}
 * holds the same map, so this function reads it there.
 *
 * The provider tool set and the dispatch loader tool set must be identical. Otherwise this
 * function throws, and no routes of a tool get lost.
 */
export function resolveRouterSources(
  providers: readonly EffectProvider[] = EFFECT_PROVIDERS,
  loaders: Readonly<Record<string, unknown>> = COMPOSITE_HANDLER_LOADERS,
  sourceRoot: string = SOURCE_ROOT,
): readonly RouterSource[] {
  const loaderTools = new Set(Object.keys(loaders));
  const providerTools = new Set(providers.map((p) => p.tool));

  const missingProvider = [...loaderTools].filter((t) => !providerTools.has(t)).sort();
  const missingLoader = [...providerTools].filter((t) => !loaderTools.has(t)).sort();
  if (missingProvider.length > 0 || missingLoader.length > 0) {
    throw new DispatchRouteScanError(
      'the dispatch loader map and the effect-provider map disagree about the composite tool set — ' +
        `tools with a dispatch loader but no provider: [${missingProvider.join(', ')}]; ` +
        `tools with a provider but no dispatch loader: [${missingLoader.join(', ')}]. ` +
        'Reconcile core/dispatch.ts::COMPOSITE_HANDLER_LOADERS with reachability/providers.ts.',
    );
  }

  return providers
    .map((p): RouterSource => ({ tool: p.tool, file: path.join(sourceRoot, p.area, 'composite.ts') }))
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * The comment and string mask of a source file. The scanner reads route literals by position, so
 * a `case 'x':` inside a comment or a string must not count as a route.
 */
interface SourceMask {
  /** `true` at every index that lies inside a comment or a string literal. */
  readonly masked: readonly boolean[];
}

/**
 * Marks each index of `source` inside a comment or a string literal. It knows line comments,
 * block comments, and the three string forms. The opening quote stays unmasked, so a
 * `case '…'` pattern still matches.
 */
export function maskCommentsAndStrings(source: string): SourceMask {
  const masked = new Array<boolean>(source.length).fill(false);
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') masked[i++] = true;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (i < stop) masked[i++] = true;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          masked[i] = true;
          if (i + 1 < source.length) masked[i + 1] = true;
          i += 2;
          continue;
        }
        const done = source[i] === quote;
        masked[i] = true;
        i += 1;
        if (done) break;
      }
      continue;
    }
    i += 1;
  }
  return { masked };
}

/**
 * Index of the `}` that closes the `{` at `openIndex`, ignoring braces inside
 * comments and strings. Throws when the block is unterminated.
 */
export function matchingBrace(source: string, openIndex: number, mask: SourceMask): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (mask.masked[i]) continue;
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new DispatchRouteScanError(`unterminated block starting at offset ${openIndex}`);
}

/** Each unmasked match of `re` in `source`. */
function unmaskedMatches(
  source: string,
  re: RegExp,
  mask: SourceMask,
): readonly RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const scoped = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null = scoped.exec(source);
  while (m !== null) {
    if (!mask.masked[m.index]) out.push(m);
    m = scoped.exec(source);
  }
  return out;
}

const SWITCH_HEADER = /switch\s*\(\s*action\b[^)]*\)\s*\{/;
const CASE_LABEL = /case\s+'([^'\\]*)'\s*:/;
const EQUALITY_BRANCH = /(typeof\s+)?(?<![.\w$])action\s*===\s*'([^'\\]*)'/;
const HANDLER_TABLE =
  /const\s+[A-Za-z_$][\w$]*\s*:\s*Readonly<\s*Record<\s*string\s*,\s*([A-Za-z_$][\w$]*)\s*>\s*>\s*=\s*\{/;
const TABLE_KEY_AT =
  /^(?:'([^'\\]*)'|"([^"\\]*)"|([A-Za-z_$][\w$]*)|\[\s*([A-Za-z_$][\w$]*)\s*\])\s*:/;

/** The `case '<action>':` arms of each `switch (action…)` block in the router. */
export function extractSwitchCaseActions(source: string, mask: SourceMask): readonly string[] {
  const actions: string[] = [];
  for (const header of unmaskedMatches(source, SWITCH_HEADER, mask)) {
    const open = header.index + header[0].length - 1;
    const close = matchingBrace(source, open, mask);
    const body = source.slice(open, close);
    const bodyMask: SourceMask = { masked: mask.masked.slice(open, close) };
    for (const label of unmaskedMatches(body, CASE_LABEL, bodyMask)) {
      const value = label[1];
      if (value !== undefined) actions.push(value);
    }
  }
  return actions;
}

/**
 * The explicit `action === '<action>'` branch arms of the router. These are the special branches
 * outside the generic table. A `typeof action === '…'` guard is not a route, so it is skipped.
 */
export function extractEqualityBranchActions(source: string, mask: SourceMask): readonly string[] {
  const actions: string[] = [];
  for (const m of unmaskedMatches(source, EQUALITY_BRANCH, mask)) {
    if (m[1] !== undefined) continue;
    const value = m[2];
    if (value !== undefined) actions.push(value);
  }
  return actions;
}

/**
 * Resolves a computed dispatch key such as `[MUTATION_GATE_NAME]` to its string literal. It
 * follows the import of the router and reads `export const NAME = '<literal>'` there. It throws
 * when the key does not resolve, because a lost key drops a real route.
 */
export function resolveImportedConst(routerFile: string, identifier: string): string {
  const source = fs.readFileSync(routerFile, 'utf8');
  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\b${identifier}\\b[^}]*\\}\\s*from\\s*'([^']+)'`,
  );
  const importMatch = importRe.exec(source);
  const spec = importMatch?.[1];
  if (spec === undefined) {
    throw new DispatchRouteScanError(
      `computed dispatch key '[${identifier}]' in ${routerFile} has no matching import — ` +
        'the shipped route set cannot be read without it',
    );
  }
  const resolved = path.resolve(path.dirname(routerFile), spec.replace(/\.js$/, '.ts'));
  if (!fs.existsSync(resolved)) {
    throw new DispatchRouteScanError(
      `computed dispatch key '[${identifier}]' resolves to '${resolved}', which does not exist`,
    );
  }
  const declRe = new RegExp(`export\\s+const\\s+${identifier}\\b[^=]*=\\s*'([^'\\\\]*)'`);
  const value = declRe.exec(fs.readFileSync(resolved, 'utf8'))?.[1];
  if (value === undefined) {
    throw new DispatchRouteScanError(
      `computed dispatch key '[${identifier}]' is imported from '${resolved}' but is not a ` +
        "string-literal `export const` there — the shipped route set cannot be read from it",
    );
  }
  return value;
}

/**
 * The keys of the `Readonly<Record<string, …Handler>>` dispatch table of the router. It reads
 * quoted, bare, and computed keys. A key starts only at depth 1 after `{` or `,`. Thus a nested
 * option bag or a call argument adds no false route.
 */
export function extractHandlerTableActions(
  source: string,
  mask: SourceMask,
  routerFile: string,
): readonly string[] {
  const actions: string[] = [];
  for (const header of unmaskedMatches(source, HANDLER_TABLE, mask)) {
    if (!/Handler$/.test(header[1] ?? '')) continue;
    const open = header.index + header[0].length - 1;
    const close = matchingBrace(source, open, mask);
    const body = source.slice(open, close);
    const bodyMask = mask.masked.slice(open, close);

    let depth = 0;
    let expectKey = false;
    let i = 0;
    while (i < body.length) {
      if (bodyMask[i]) {
        i += 1;
        continue;
      }
      const ch = body[i] ?? '';
      if (expectKey && depth === 1 && !/\s/.test(ch)) {
        const m = TABLE_KEY_AT.exec(body.slice(i, i + 256));
        expectKey = false;
        if (m !== null) {
          const quoted = m[1] ?? m[2];
          const bare = m[3];
          const computed = m[4];
          if (quoted !== undefined) actions.push(quoted);
          else if (bare !== undefined) actions.push(bare);
          else if (computed !== undefined) actions.push(resolveImportedConst(routerFile, computed));
          i += m[0].length;
          continue;
        }
      }
      if (ch === '{' || ch === '(' || ch === '[') {
        depth += 1;
        expectKey = ch === '{' && depth === 1;
      } else if (ch === '}' || ch === ')' || ch === ']') {
        depth -= 1;
        expectKey = false;
      } else if (ch === ',' && depth === 1) {
        expectKey = true;
      }
      i += 1;
    }
  }
  return actions;
}

/** Reads the shipped routes of one router. It throws when the file has none. */
export function readRouterRoutes(source: RouterSource): readonly DispatchRoute[] {
  if (!fs.existsSync(source.file)) {
    throw new DispatchRouteScanError(
      `composite router for tool '${source.tool}' not found at '${source.file}' — ` +
        'dispatch loads this module, so its routes cannot be read',
    );
  }
  const text = fs.readFileSync(source.file, 'utf8');
  const mask = maskCommentsAndStrings(text);

  const routes: DispatchRoute[] = [];
  const push = (action: string, form: RouteForm): void => {
    routes.push({ tool: source.tool, action, actionId: `${source.tool}.${action}`, form });
  };
  for (const a of extractSwitchCaseActions(text, mask)) push(a, 'switch-case');
  for (const a of extractEqualityBranchActions(text, mask)) push(a, 'equality-branch');
  for (const a of extractHandlerTableActions(text, mask, source.file)) push(a, 'handler-table');

  if (routes.length === 0) {
    throw new DispatchRouteScanError(
      `composite router '${source.file}' (tool '${source.tool}') has no recognizable routing ` +
        'construct — no `switch (action)`, no `action === \'…\'` branch, and no ' +
        '`Readonly<Record<string, …Handler>>` table. The route scanner is out of date with the router.',
    );
  }
  return routes;
}

/**
 * The sorted shipped dispatch route table, read from the router modules that dispatch imports.
 * A route is here because the router code routes it, not because a descriptor declares it.
 */
export function collectDispatchRoutes(
  sources: readonly RouterSource[] = resolveRouterSources(),
): readonly DispatchRoute[] {
  const routes = sources.flatMap((s) => readRouterRoutes(s));
  return [...routes].sort((a, b) =>
    a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : a.form < b.form ? -1 : a.form > b.form ? 1 : 0,
  );
}
