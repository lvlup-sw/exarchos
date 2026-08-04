// ─── The SHIPPED action-level dispatch-route authority (P05-05) ──────────────
//
// PROGRAM-05, the closure capstone (CTR-013). This module answers ONE question
// about the real tree: **which `(tool, action)` pairs does the shipped composite
// router actually route?**
//
// ── Why this module exists (the tautology it removes) ────────────────────────
// The `route` hop used to be materialized by re-running `generateRegistration()`
// over the SAME `compile()` descriptors that also supply the closure
// DENOMINATOR. `generateRegistration` emits exactly one entry per descriptor and
// ActionIds are unique (the compiler rejects duplicates), so that hop resolved
// to exactly 1 for every action BY CONSTRUCTION — it could not fail, and it was
// blind to the drift it claimed to catch (an ActionId that no router serves).
//
// The authority read here is INDEPENDENT of the contract compiler: it is the
// dispatch code that actually runs. `core/dispatch.ts::COMPOSITE_HANDLER_LOADERS`
// resolves a TOOL to its composite module; that module's router then performs the
// action-level routing. Those routing constructs are the last mile of the wire
// path, and they are the thing that silently drifts when an action is renamed in
// the registry but not in its router (or vice versa).
//
// ── Why a source scan ────────────────────────────────────────────────────────
// The action-level routing table is CODE, not data: four composites route with
// `switch (action) { case '…': }` and orchestrate routes through an
// `ACTION_HANDLERS` object literal plus a handful of explicit `action === '…'`
// branch arms. There is no runtime value that enumerates all of it without
// importing (and thereby executing the module init of) every handler in the
// tree. So the router SOURCE — the file dispatch dynamically imports — is read
// and its routing constructs are extracted.
//
// Fidelity is not assumed: the co-located test pins the scanner's orchestrate
// result against the RUNTIME `ACTION_HANDLER_KEYS` value exported by the real
// composite, and against the live registry for every tool.
//
// ── Fail LOUD, never fail quiet ──────────────────────────────────────────────
// Every structural surprise throws: a router file that is missing, a router with
// no recognizable routing construct, a computed dispatch key that cannot be
// resolved to a string literal, or a tool set that disagrees with dispatch. A
// silently-empty route set would understate closure loudly (the census drops),
// but a named error is a better diagnosis.
// ────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPOSITE_HANDLER_LOADERS } from '../../core/dispatch.js';
import { EFFECT_PROVIDERS, type EffectProvider } from './providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The `src/` root — router modules are resolved relative to this. */
export const SOURCE_ROOT = path.resolve(HERE, '../..');

/** The routing construct a route was extracted from. */
export const ROUTE_FORMS = ['switch-case', 'equality-branch', 'handler-table'] as const;
export type RouteForm = (typeof ROUTE_FORMS)[number];

/** One `(tool, action)` pair the shipped router actually routes. */
export interface DispatchRoute {
  readonly tool: string;
  readonly action: string;
  /** `${tool}.${action}` — the ActionId the route resolves. */
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

// ─── Router-source resolution (tool → the module dispatch imports) ───────────

/**
 * Resolve each dispatchable tool to its composite router file.
 *
 * The tool → module-directory correspondence is the one fact dispatch encodes
 * only inside its loader closures (`() => import('../workflow/composite.js')`),
 * which cannot be read as data. It is already transcribed — and ledger-validated
 * — as the `area` field of the governed {@link EFFECT_PROVIDERS} map, so it is
 * reused here rather than transcribed a second time.
 *
 * Two-way ratchet: the provider tool set and the live dispatch loader tool set
 * must be IDENTICAL. A tool that gains a dispatch loader without a provider (or
 * loses one) throws here instead of quietly dropping that tool's routes.
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

// ─── A comment/string-aware cursor over TypeScript source ────────────────────
//
// Route literals are extracted positionally, so the scanner must not mistake a
// `case 'x':` inside a comment or a string for a real routing arm. This is a
// deliberately small lexer: it recognizes line comments, block comments, and the
// three string forms, and reports whether a given index is inside one.

interface SourceMask {
  /** `true` at every index that lies inside a comment or a string literal. */
  readonly masked: readonly boolean[];
}

/** Mark every index of `source` that lies inside a comment or string literal. */
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
      // The opening quote itself stays UNMASKED so `case '…'` can be matched;
      // only the literal body (and closing quote) is masked.
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

/** Every unmasked match of `re` in `source`, as `[index, groups]`. */
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

// ─── The three routing constructs ────────────────────────────────────────────

const SWITCH_HEADER = /switch\s*\(\s*action\b[^)]*\)\s*\{/;
const CASE_LABEL = /case\s+'([^'\\]*)'\s*:/;
const EQUALITY_BRANCH = /(typeof\s+)?(?<![.\w$])action\s*===\s*'([^'\\]*)'/;
const HANDLER_TABLE =
  /const\s+[A-Za-z_$][\w$]*\s*:\s*Readonly<\s*Record<\s*string\s*,\s*([A-Za-z_$][\w$]*)\s*>\s*>\s*=\s*\{/;
const TABLE_KEY_AT =
  /^(?:'([^'\\]*)'|"([^"\\]*)"|([A-Za-z_$][\w$]*)|\[\s*([A-Za-z_$][\w$]*)\s*\])\s*:/;

/** `case '<action>':` arms of every `switch (action…)` block in the router. */
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
 * Explicit `action === '<action>'` branch arms — the composite router's special
 * dispatch branches (the arms that need something the generic table cannot give
 * them). `typeof action === 'string'` is a type guard, not a route, and is
 * excluded.
 */
export function extractEqualityBranchActions(source: string, mask: SourceMask): readonly string[] {
  const actions: string[] = [];
  for (const m of unmaskedMatches(source, EQUALITY_BRANCH, mask)) {
    if (m[1] !== undefined) continue; // `typeof action === '…'`
    const value = m[2];
    if (value !== undefined) actions.push(value);
  }
  return actions;
}

/**
 * Resolve a COMPUTED dispatch key (`[MUTATION_GATE_NAME]: …`) to its string
 * literal by following the router's own import of that binding and reading the
 * `export const NAME = '<literal>'` there. Throws when it cannot be resolved —
 * an unresolvable key would silently drop a real route.
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
 * Keys of the router's `Readonly<Record<string, …Handler>>` dispatch table — the
 * map the router indexes with the incoming action (`ACTION_HANDLERS[action]`).
 * Quoted, bare-identifier and computed keys are all read.
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

    // Walk the table body tracking bracket depth. A key can only start at depth
    // 1 immediately after the opening `{` or a `,` — so a nested option bag or
    // an adapter call argument can never contribute a phantom route.
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

// ─── The collector ───────────────────────────────────────────────────────────

/** Read one router's shipped routes. Throws when the file carries none. */
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
 * The SHIPPED dispatch route table: every `(tool, action)` pair the real
 * composite routers route, read from the modules dispatch actually imports.
 *
 * Deterministic (sorted) and independent of the contract compiler — a route
 * here exists because the router code routes it, not because a descriptor
 * declared it.
 */
export function collectDispatchRoutes(
  sources: readonly RouterSource[] = resolveRouterSources(),
): readonly DispatchRoute[] {
  const routes = sources.flatMap((s) => readRouterRoutes(s));
  return [...routes].sort((a, b) =>
    a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : a.form < b.form ? -1 : a.form > b.form ? 1 : 0,
  );
}
