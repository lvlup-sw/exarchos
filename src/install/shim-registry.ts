/**
 * Inventory and ratchet for thin shims. A thin shim is a per-runtime adapter
 * that exists only because a target runtime lacks a capability that the
 * canonical surface assumes. When the runtime gains the capability, the shim
 * must go away.
 *
 * {@link discoverRenderers} finds each per-harness renderer by its shape, so a
 * renderer needs no marker comment. {@link discoverShims} finds the marker
 * comments. {@link verifyShimRatchet} fails when a renderer or a marker has no
 * row in {@link SHIM_REGISTRY}. It also fails when a row is malformed, expired,
 * or covers nothing on disk. The ratchet rules are pure over their inputs.
 *
 * Marker grammar: a one-line comment
 * `SHIM(runtimes: <r1>[+<r2>...], capability: <capability-id>)`. The parser
 * ignores the note after the closing parenthesis. The issue, owner and expiry
 * are only in the registry, so the marker and the row cannot drift.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** One approved thin shim, keyed by (file, runtime). */
export interface ShimEntry {
  /** Stable human id, such as `cursor-command-shim`. Unique across the registry. */
  readonly id: string;
  /** POSIX repo-relative path to the shim source file. */
  readonly file: string;
  /** The target runtime that this shim adapts, such as `cursor`. */
  readonly runtime: string;
  /** The missing-capability id that necessitates the shim (the REASON). */
  readonly capability: string;
  /** Approval issue ref: `#<number>`. */
  readonly issue: string;
  /** Owning team / person — must be non-empty. */
  readonly owner: string;
  /** Expiry date `YYYY-MM-DD`. A past expiry fails the ratchet. */
  readonly expires: string;
}

/** A `SHIM(...)` marker parsed out of a source file. */
export interface DiscoveredShim {
  /** POSIX repo-relative path to the file carrying the marker. */
  readonly file: string;
  /** Runtimes the marker declares coverage for. */
  readonly runtimes: readonly string[];
  /** The missing-capability id the marker declares. */
  readonly capability: string;
  /** The raw field text inside the marker parens (for diagnostics). */
  readonly raw: string;
}

/**
 * A per-harness renderer discovered STRUCTURALLY — no marker required, and no
 * marker able to suppress it. See {@link detectRenderer} for the shape rule.
 */
export interface DiscoveredRenderer {
  /** POSIX repo-relative path to the renderer module. */
  readonly file: string;
  /**
   * The runtime id the renderer declares (`runtime: 'cursor'` /
   * `readonly runtime = 'copilot'`). Empty when the module declares
   * none, or declares more than one — either way the ratchet fails loudly
   * rather than guessing.
   */
  readonly runtime: string;
  /** Local name the port type is bound to in this file (alias-aware). */
  readonly port: string;
  /** Name of the exported declaration that implements the port. */
  readonly exportName: string;
  /** The matched declaration text, for diagnostics. */
  readonly evidence: string;
}

/** A single ratchet failure. */
export interface ShimViolation {
  readonly kind:
    | 'unregistered'
    | 'expired'
    | 'malformed'
    | 'missing-on-disk'
    | 'capability-mismatch'
    | 'undeclared-runtime'
    | 'duplicate-id';
  readonly id?: string;
  readonly file?: string;
  readonly runtime?: string;
  readonly detail: string;
}

/** Result of a ratchet run — discriminated on `ok`. */
export interface ShimRatchetResult {
  readonly ok: boolean;
  readonly violations: readonly ShimViolation[];
}

/**
 * The closed list of approved capability reasons. A registry row with an empty
 * or unknown reason fails, so the field cannot become free text.
 * - `slash-command-native`: the runtime cannot autoload canonical
 *   `commands/*.md`, so a shim lowers the verbs into its instruction file.
 * - `agent-definition-native`: the runtime cannot read the canonical
 *   `AgentSpec`, so a renderer writes its own agent-definition format.
 */
export const APPROVED_CAPABILITY_REASONS: readonly string[] = [
  'slash-command-native',
  'agent-definition-native',
];

/**
 * The approved thin shims and per-harness renderers. A marker or a discovered
 * renderer without a matching row fails {@link verifyShimRatchet}. Each row
 * names the missing capability, an approval issue, an owner and an expiry. By
 * the expiry, the adapter must be adopted, replaced by native support, or
 * deleted.
 * - `command-shim-emitter.ts` has a row for Cursor and a row for Copilot. The
 *   module is a reserved stub, and both rows use the issue and expiry of its
 *   reservation marker.
 * - Each `agents/adapters/*.ts` renderer has one row. The renderers carry no
 *   marker, so the shape scan finds them.
 */
export const SHIM_REGISTRY: readonly ShimEntry[] = [
  {
    id: 'copilot-command-shim',
    file: 'src/runtime/command-shim-emitter.ts',
    runtime: 'copilot',
    capability: 'slash-command-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-01-31',
  },
  {
    id: 'cursor-command-shim',
    file: 'src/runtime/command-shim-emitter.ts',
    runtime: 'cursor',
    capability: 'slash-command-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-01-31',
  },
  {
    id: 'claude-agent-renderer',
    file: 'src/runtime/agents/adapters/claude.ts',
    runtime: 'claude',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'codex-agent-renderer',
    file: 'src/runtime/agents/adapters/codex.ts',
    runtime: 'codex',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'copilot-agent-renderer',
    file: 'src/runtime/agents/adapters/copilot.ts',
    runtime: 'copilot',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'cursor-agent-renderer',
    file: 'src/runtime/agents/adapters/cursor.ts',
    runtime: 'cursor',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'opencode-agent-renderer',
    file: 'src/runtime/agents/adapters/opencode.ts',
    runtime: 'opencode',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
];

/**
 * Source roots that {@link discoverShims} scans in the real-repo check. The
 * list is explicit, so the places where a shim can live are reviewable. A
 * marker outside these roots is out of scope.
 */
export const SHIM_SCAN_ROOTS: readonly string[] = [
  'src/install',
  'src/runtime',
];

/**
 * Source roots that {@link discoverRenderers} scans: the whole product source
 * tree. The list is broader than {@link SHIM_SCAN_ROOTS}, because an author
 * writes a marker on purpose, but a renderer can appear in any directory.
 */
export const RENDERER_SCAN_ROOTS: readonly string[] = ['src'];

/**
 * The repo-relative path of this module, which both scans skip. A real-tree
 * test checks that the path still exists, because a move makes it stale with
 * no other error.
 */
export const SELF_PATH = 'src/install/shim-registry.ts';

/**
 * Matches a `SHIM(<fields>)` marker. The regex source is a spliced string, so the
 * regex line holds no marker token. The comments of this module do, so both scans
 * skip {@link SELF_PATH}.
 */
const SHIM_MARKER_RE = new RegExp('SHIM' + '\\(([^)]*)\\)', 'g');

/** Parse `key: value` field pairs from a marker's inner text. */
function parseFields(inner: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of inner.split(',')) {
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (kv && kv[1] !== undefined && kv[2] !== undefined) {
      fields[kv[1].toLowerCase()] = kv[2];
    }
  }
  return fields;
}

/**
 * Extract every `SHIM(...)` marker from a file's source. Pure — no I/O.
 * `file` is echoed onto each result as the POSIX repo-relative path so callers
 * can key violations to a location.
 */
export function parseShimMarkers(source: string, file: string): DiscoveredShim[] {
  const out: DiscoveredShim[] = [];
  for (const m of source.matchAll(SHIM_MARKER_RE)) {
    const inner = m[1] ?? '';
    const fields = parseFields(inner);
    const runtimes = (fields.runtimes ?? '')
      .split('+')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    out.push({
      file,
      runtimes,
      capability: fields.capability ?? '',
      raw: inner.trim(),
    });
  }
  return out;
}

/** Narrow, injectable filesystem surface so discovery is testable. */
export interface ShimDiscoveryFs {
  readFile(abs: string): string;
  listTsFiles(absRoot: string): string[];
}

/** Options for {@link discoverShims}. */
export interface DiscoverShimsOptions {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /** Repo-relative directories to scan. Defaults to {@link SHIM_SCAN_ROOTS}. */
  readonly roots?: readonly string[];
  /** Override the filesystem surface (tests). */
  readonly fs?: ShimDiscoveryFs;
}

const DEFAULT_FS: ShimDiscoveryFs = {
  readFile: (abs) => readFileSync(abs, 'utf8'),
  listTsFiles: (absRoot) => listTsFilesReal(absRoot),
};

/** True for paths/dirs that must never be scanned for shim markers. */
function isExcludedSegment(segment: string): boolean {
  return (
    segment === 'node_modules' ||
    segment === 'dist' ||
    segment === '__fixtures__' ||
    segment === '__tests__' ||
    segment === '__shims__'
  );
}

/** True for a filename that is a test/fixture rather than production source. */
function isExcludedFile(name: string): boolean {
  return (
    name.endsWith('.test.ts') ||
    name.endsWith('.type-test.ts') ||
    name.endsWith('.d.ts') ||
    name.endsWith('.bench.ts')
  );
}

/** Recursively collect production `.ts` files under `absRoot`. */
function listTsFilesReal(absRoot: string): string[] {
  const results: string[] = [];
  if (!existsSync(absRoot)) return results;
  const stack: string[] = [absRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isExcludedSegment(entry)) continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (entry.endsWith('.ts') && !isExcludedFile(entry)) {
        results.push(full);
      }
    }
  }
  return results;
}

/** Normalize an OS path to POSIX separators. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Walk the configured roots and return every `SHIM(...)` marker found in
 * production source, as POSIX-repo-relative {@link DiscoveredShim}s. This
 * module's own file is excluded so its documentation/regex can never be
 * mistaken for a live shim.
 *
 * Each file is visited once even when the roots nest, matching
 * {@link discoverRenderers}. Without that, a root listed under another silently
 * doubles every marker it contains, and the duplicate reads as a second shim.
 */
export function discoverShims(opts: DiscoverShimsOptions): DiscoveredShim[] {
  const fs = opts.fs ?? DEFAULT_FS;
  const roots = opts.roots ?? SHIM_SCAN_ROOTS;
  const found: DiscoveredShim[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const absRoot = join(opts.repoRoot, root);
    for (const abs of fs.listTsFiles(absRoot)) {
      const rel = toPosix(relative(opts.repoRoot, abs));
      if (rel === SELF_PATH || seen.has(rel)) continue;
      seen.add(rel);
      const source = fs.readFile(abs);
      if (!source.includes('SHIM' + '(')) continue;
      found.push(...parseShimMarkers(source, rel));
    }
  }
  return found;
}

/**
 * The port type a per-harness renderer implements (`agents/adapters/types.ts`).
 * This is the SUBJECT of the shape rule, not a filename or directory list.
 */
export const RENDERER_PORT_TYPE = 'RuntimeAdapter';

/**
 * The RENDER member every per-harness renderer must declare — the function that
 * lowers a canonical `AgentSpec` into runtime-specific file contents. Requiring
 * it is what separates a renderer from a module that merely *holds* the port
 * type in a generic.
 */
export const RENDERER_RENDER_MEMBER = 'lowerSpec';

/** `import [type] { … } from '…'` — the named-binding block plus specifier. */
const IMPORT_BLOCK_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;

/** A single named import binding, with an optional `type` qualifier and an optional alias. */
const IMPORT_BINDING_RE = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/;

/** `runtime: 'cursor'` / `readonly runtime = 'copilot'` (const-asserted). */
const RUNTIME_ID_RE = /\bruntime\s*[:=]\s*['"]([A-Za-z0-9][\w.-]*)['"]/g;

/** The render member in a DECLARING position (method, property, or shorthand). */
const RENDER_MEMBER_RE = new RegExp(`\\b${RENDERER_RENDER_MEMBER}\\b\\s*[(,:}]`);

/**
 * Return each local name of the port type in this file, aliases included. A
 * file that does not import the port returns `[]`. Thus the port module, which
 * declares the interface, stays out of the result.
 */
function portLocalNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(IMPORT_BLOCK_RE)) {
    for (const spec of (m[1] ?? '').split(',')) {
      const binding = IMPORT_BINDING_RE.exec(spec);
      if (!binding || binding[1] !== RENDERER_PORT_TYPE) continue;
      names.add(binding[2] ?? binding[1]);
    }
  }
  return [...names];
}

/**
 * Return the exported declaration that implements `port`, or `null`. The
 * implementing positions are `export const X: Port` (also with `&`),
 * `export class X implements Port`, and `satisfies Port`. For `satisfies`, the
 * name comes from the nearest earlier exported variable.
 */
function implementingExport(
  source: string,
  port: string,
): { exportName: string; evidence: string } | null {
  const asConst = new RegExp(
    `export\\s+(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*:\\s*${port}\\s*(?:&|=)`,
  ).exec(source);
  if (asConst) return { exportName: asConst[1] ?? '', evidence: asConst[0].trim() };

  const asClass = new RegExp(
    `export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)[^{]*?\\bimplements\\b[^{]*?\\b${port}\\b`,
  ).exec(source);
  if (asClass) return { exportName: asClass[1] ?? '', evidence: asClass[0].trim() };

  const asSatisfies = new RegExp(`\\bsatisfies\\s+${port}\\b`).exec(source);
  if (asSatisfies) {
    const before = [
      ...source.slice(0, asSatisfies.index).matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g),
    ];
    return {
      exportName: before.at(-1)?.[1] ?? '(satisfies-expression)',
      evidence: asSatisfies[0].trim(),
    };
  }

  return null;
}

/**
 * Return the renderer that `source` is, or `null`. Three facts must hold: the
 * file imports the port, an export implements the port, and the file declares
 * the render member. One fact alone is common, so it gives false positives.
 * The runtime id comes from the `runtime` member of the module. With no id or
 * several ids, `runtime` is `''`, and the ratchet reports `undeclared-runtime`.
 */
export function detectRenderer(source: string, file: string): DiscoveredRenderer | null {
  if (!RENDER_MEMBER_RE.test(source)) return null;
  for (const port of portLocalNames(source)) {
    const impl = implementingExport(source, port);
    if (!impl) continue;
    const ids = new Set<string>();
    for (const m of source.matchAll(RUNTIME_ID_RE)) if (m[1] !== undefined) ids.add(m[1]);
    const runtime = ids.size === 1 ? ([...ids][0] ?? '') : '';
    return { file, runtime, port, exportName: impl.exportName, evidence: impl.evidence };
  }
  return null;
}

/** Options for {@link discoverRenderers}. */
export interface DiscoverRenderersOptions {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /** Repo-relative directories to scan. Defaults to {@link RENDERER_SCAN_ROOTS}. */
  readonly roots?: readonly string[];
  /** Override the filesystem surface (tests). */
  readonly fs?: ShimDiscoveryFs;
}

/**
 * Return each per-harness renderer in production source under the configured
 * roots, sorted by path. A marker does not change the result. The result holds
 * each renderer once, even when roots nest. A file that does not name the port
 * type is skipped before the regex checks.
 */
export function discoverRenderers(opts: DiscoverRenderersOptions): DiscoveredRenderer[] {
  const fs = opts.fs ?? DEFAULT_FS;
  const roots = opts.roots ?? RENDERER_SCAN_ROOTS;
  const found = new Map<string, DiscoveredRenderer>();
  for (const root of roots) {
    const absRoot = join(opts.repoRoot, root);
    for (const abs of fs.listTsFiles(absRoot)) {
      const rel = toPosix(relative(opts.repoRoot, abs));
      if (rel === SELF_PATH || found.has(rel)) continue;
      const source = fs.readFile(abs);
      if (!source.includes(RENDERER_PORT_TYPE)) continue;
      const renderer = detectRenderer(source, rel);
      if (renderer) found.set(rel, renderer);
    }
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** UTC midnight of a date, for a whole-day expiry comparison. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

interface GovernanceProblem {
  readonly kind: 'malformed' | 'expired';
  readonly detail: string;
}

/**
 * Return the governance problems of a registry entry at `now`. An empty list
 * means the entry is valid. The id, file, runtime and owner must be non-empty.
 * The capability reason must be approved, and the issue ref must be `#<number>`.
 * The expiry must be a real `YYYY-MM-DD` date that is not past. These run-time checks also catch a row
 * that comes in through a cast or from JSON.
 */
export function validateEntryGovernance(
  entry: ShimEntry,
  now: Date,
): GovernanceProblem[] {
  const problems: GovernanceProblem[] = [];

  if (!/\S/.test(entry.id)) {
    problems.push({ kind: 'malformed', detail: 'id is required and must be non-empty' });
  }

  if (!/\S/.test(entry.file)) {
    problems.push({ kind: 'malformed', detail: 'file is required and must be non-empty' });
  }

  if (!/\S/.test(entry.runtime)) {
    problems.push({ kind: 'malformed', detail: 'runtime is required and must be non-empty' });
  }

  if (!/\S/.test(entry.capability)) {
    problems.push({
      kind: 'malformed',
      detail:
        'capability reason is required — name the missing runtime capability ' +
        `that justifies this adapter (one of: ${APPROVED_CAPABILITY_REASONS.join(', ')})`,
    });
  } else if (!APPROVED_CAPABILITY_REASONS.includes(entry.capability)) {
    problems.push({
      kind: 'malformed',
      detail:
        `capability reason ${JSON.stringify(entry.capability)} is not approved — ` +
        `add it to APPROVED_CAPABILITY_REASONS with a justification, or use one ` +
        `of: ${APPROVED_CAPABILITY_REASONS.join(', ')}`,
    });
  }

  if (!/^#\d+$/.test(entry.issue)) {
    problems.push({
      kind: 'malformed',
      detail: `issue ref must be "#<number>" (got ${JSON.stringify(entry.issue)})`,
    });
  }

  if (!/\S/.test(entry.owner)) {
    problems.push({ kind: 'malformed', detail: 'owner is required and must be non-empty' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
    problems.push({
      kind: 'malformed',
      detail: `expires must be a clean YYYY-MM-DD date (got ${JSON.stringify(entry.expires)})`,
    });
  } else {
    const parsed = new Date(`${entry.expires}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== entry.expires) {
      problems.push({
        kind: 'malformed',
        detail: `expires is not a real calendar date (got ${JSON.stringify(entry.expires)})`,
      });
    } else if (parsed.getTime() < startOfUtcDay(now)) {
      problems.push({
        kind: 'expired',
        detail:
          `shim expired on ${entry.expires} — an expired shim must be deleted ` +
          `(ratchet down) or re-approved with a future expiry`,
      });
    }
  }

  return problems;
}

const PAIR_SEP = '\u0000';
const pairKey = (file: string, runtime: string): string => `${file}${PAIR_SEP}${runtime}`;

/** Inputs to {@link verifyShimRatchet}. */
export interface ShimRatchetInputs {
  readonly registry: readonly ShimEntry[];
  readonly discovered: readonly DiscoveredShim[];
  /**
   * Per-harness renderers from the shape scan. When this field is omitted, a
   * row that only a renderer backs fails `missing-on-disk`.
   */
  readonly renderers?: readonly DiscoveredRenderer[];
  readonly now: Date;
}

/**
 * Compare the registry with the discovered markers and renderers, and validate
 * each entry. One pass reports every violation:
 * - `duplicate-id`: two entries share an id.
 * - `malformed` or `expired`: the governance of an entry is not valid.
 * - `unregistered`: a renderer or a (file, runtime) marker pair has no entry.
 * - `undeclared-runtime`: a renderer does not declare exactly one runtime id.
 * - `capability-mismatch`: the capability of a marker differs from its entry.
 * - `missing-on-disk`: an entry has no marker and no renderer on disk.
 */
export function verifyShimRatchet(inputs: ShimRatchetInputs): ShimRatchetResult {
  const { registry, discovered, now } = inputs;
  const renderers = inputs.renderers ?? [];
  const violations: ShimViolation[] = [];

  const seenIds = new Set<string>();
  for (const e of registry) {
    if (seenIds.has(e.id)) {
      violations.push({
        kind: 'duplicate-id',
        id: e.id,
        detail: `registry id '${e.id}' is declared more than once`,
      });
    }
    seenIds.add(e.id);
  }

  for (const e of registry) {
    for (const p of validateEntryGovernance(e, now)) {
      violations.push({
        kind: p.kind,
        id: e.id,
        file: e.file,
        runtime: e.runtime,
        detail: `registry entry '${e.id}': ${p.detail}`,
      });
    }
  }

  const regByPair = new Map<string, ShimEntry>();
  for (const e of registry) regByPair.set(pairKey(e.file, e.runtime), e);

  const rendererKeys = new Set<string>();
  for (const r of renderers) {
    if (r.runtime === '') {
      violations.push({
        kind: 'undeclared-runtime',
        file: r.file,
        detail:
          `per-harness renderer ${r.file} (export '${r.exportName}') declares no single ` +
          `runtime id — governance is keyed on (file, runtime), so add exactly one ` +
          `\`runtime: '<id>'\` member`,
      });
      continue;
    }
    const key = pairKey(r.file, r.runtime);
    rendererKeys.add(key);
    if (regByPair.has(key)) continue;
    violations.push({
      kind: 'unregistered',
      file: r.file,
      runtime: r.runtime,
      detail:
        `per-harness renderer ${r.file} (runtime ${r.runtime}, export ` +
        `'${r.exportName}' — ${r.evidence}) is not registered — add a ` +
        `SHIM_REGISTRY entry with an approved capability reason (issue + owner) ` +
        `and a future expiry, or delete the renderer`,
    });
  }

  const discoveredKeys = new Set<string>();
  for (const d of discovered) {
    for (const runtime of d.runtimes) {
      const key = pairKey(d.file, runtime);
      discoveredKeys.add(key);
      const entry = regByPair.get(key);
      if (!entry) {
        violations.push({
          kind: 'unregistered',
          file: d.file,
          runtime,
          detail:
            `shim ${d.file} (runtime ${runtime}) is not registered — add a ` +
            `SHIM_REGISTRY entry with an approved capability reason (issue + ` +
            `owner) and a future expiry, or remove the shim marker`,
        });
      } else if (entry.capability !== d.capability) {
        violations.push({
          kind: 'capability-mismatch',
          id: entry.id,
          file: d.file,
          runtime,
          detail:
            `marker capability '${d.capability}' disagrees with registered ` +
            `capability '${entry.capability}' for '${entry.id}'`,
        });
      }
    }
  }

  for (const e of registry) {
    const key = pairKey(e.file, e.runtime);
    if (discoveredKeys.has(key) || rendererKeys.has(key)) continue;
    violations.push({
      kind: 'missing-on-disk',
      id: e.id,
      file: e.file,
      runtime: e.runtime,
      detail:
        `registered shim '${e.id}' (${e.file}, runtime ${e.runtime}) has neither a ` +
        `SHIM marker nor a per-harness renderer on disk — remove the stale registry ` +
        `entry or restore the artefact`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/** Thrown by {@link assertShimRatchet} when the ratchet fails. */
export class ShimRatchetError extends Error {
  override readonly name = 'ShimRatchetError';
  readonly code = 'SHIM_RATCHET_VIOLATION';
  constructor(public readonly violations: readonly ShimViolation[]) {
    super(
      `Shim ratchet failed — ${violations.length} violation(s):\n` +
        violations
          .map((v) => `  • [${v.kind}] ${v.id ?? v.file ?? ''} — ${v.detail}`)
          .join('\n'),
    );
  }
}

/** Verify the ratchet and THROW {@link ShimRatchetError} on any violation. */
export function assertShimRatchet(inputs: ShimRatchetInputs): void {
  const result = verifyShimRatchet(inputs);
  if (!result.ok) throw new ShimRatchetError(result.violations);
}
