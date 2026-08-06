/**
 * shim-registry — enumerated inventory + ratchet for capability-required
 * "thin shims" (P03-07; API-008, CTR-011).
 *
 * A THIN SHIM is a per-runtime / per-host adapter artifact that exists ONLY
 * because a target runtime lacks a capability the canonical surface assumes.
 * Example: Cursor has no native slash-command loader (`hasSlashCommands:false`),
 * so a command shim translates the canonical verbs into its instruction-file
 * mechanism. When the runtime gains the capability (or the adapter is adopted /
 * retired), the shim must go away — it is not a permanent surface.
 *
 * ## Discovery is STRUCTURAL, not opt-in (DR-14)
 *
 * The original discovery scanned for a hand-written `SHIM(...)` marker comment
 * and nothing else. That mechanism can only see adapters whose author
 * volunteered to declare one — the governed count and the REAL count were
 * decoupled by construction. Concretely: the whole inventory was two rows for
 * one self-declared, reserved-but-unadopted stub
 * (`runtime/command-shim-emitter.ts`), while FIVE per-harness renderers
 * (`agents/adapters/{claude,codex,copilot,cursor,opencode}.ts`) shipped
 * ungoverned — not because they were exempt, but because none of them carries a
 * marker. A detector that cannot see the surface it claims to govern is the
 * DR-12/13/15 failure class.
 *
 * {@link discoverRenderers} replaces that with EVIDENCE-BASED discovery that
 * hunts the artefact itself. A PER-HARNESS RENDERER is identified by its SHAPE,
 * not by its name, its directory, or a comment:
 *
 *   1. it IMPORTS the `RuntimeAdapter` port type (alias-aware — renaming the
 *      binding on import is still an import of the port); AND
 *   2. it EXPORTS a declaration in an IMPLEMENTING POSITION for that port —
 *      `export const X: <Port> = …` / `… & …`, `export class X implements
 *      <Port>`, or `export … = { … } satisfies <Port>`; AND
 *   3. it declares the RENDER member `lowerSpec` — the function that lowers a
 *      canonical `AgentSpec` into runtime-specific file contents.
 *
 * All three must hold. That conjunction is what keeps the scan false-positive
 * free on the live tree: the port module `adapters/types.ts` DECLARES
 * `RuntimeAdapter` but never imports it (fails 1); the fan-out consumer
 * `agents/generate-agents.ts` imports the port and calls `lowerSpec` but only
 * ever mentions it inside a generic (`Record<Runtime, RuntimeAdapter>`), never
 * in an implementing position (fails 2). Renaming a renderer, moving it, or
 * omitting its marker cannot hide it.
 *
 * The `SHIM(...)` marker survives — SUPPLEMENTARY and human-facing:
 * a stray marker with no registry row still FAILS, but a governed row is now
 * backed by a marker OR by a structurally discovered renderer — so omitting the
 * marker can no longer defeat the mechanism.
 *
 * ## The ratchet
 *
 * Shims and renderers RATCHET DOWN, never silently up. Every one must be
 * ENUMERATED in {@link SHIM_REGISTRY} with a capability REASON — an APPROVED
 * missing-capability id (closed world: see {@link APPROVED_CAPABILITY_REASONS})
 * plus a well-formed approval issue ref and a non-empty owner — and an EXPIRY
 * (`YYYY-MM-DD`).
 *
 * {@link verifyShimRatchet} cross-checks registry against tree:
 *   - a discovered RENDERER with no matching registry entry FAILS (the DR-14
 *     headline: a per-harness renderer added without an approved capability
 *     reason and an expiry cannot pass);
 *   - a discovered marker with no matching registry entry FAILS (a shim was
 *     added without an approved capability reason + expiry — the count grew);
 *   - a registry entry missing ANY governance field — id, file, runtime,
 *     capability reason, issue, owner, expiry — FAILS;
 *   - a registry entry whose `expires` is in the past FAILS (deletion is due at
 *     expiry — the same enforcement philosophy as the `RESERVED(...)`
 *     module-intent gate in `scripts/check-module-intent.mjs`);
 *   - a registry entry with neither a marker NOR a renderer on disk FAILS (a
 *     stale/dangling entry — the cover outlived the thing it covered).
 *
 * The marker declares only *existence + coverage* (which runtimes, which
 * capability); the governance metadata (issue / owner / expiry) lives ONLY in
 * the registry so the two cannot drift.
 *
 * ## Marker grammar
 *
 * A shim file carries a single-line comment:
 *
 *   `// ` + `SHIM(runtimes: <r1>[+<r2>...], capability: <capability-id>) — <free note>`
 *
 * Fields are `key: value` pairs separated by commas (the `runtimes` value is a
 * `+`-joined list). The trailing ` — note` after the close paren is not parsed.
 *
 * This module is pure over its inputs — {@link verifyShimRatchet} takes the
 * registry, the discovered sets, and `now` explicitly — so the ratchet rules are
 * unit-testable without a filesystem. {@link discoverShims} and
 * {@link discoverRenderers} are the thin, injectable I/O adapters that produce
 * the discovered sets from the real tree.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

/** One approved thin shim, keyed by (file, runtime). */
export interface ShimEntry {
  /** Stable human id, e.g. `cursor-command-shim`. Unique across the registry. */
  readonly id: string;
  /** POSIX repo-relative path to the shim source file. */
  readonly file: string;
  /** The target runtime this shim adapts (e.g. `cursor`, `copilot`). */
  readonly runtime: string;
  /** The missing-capability id that necessitates the shim (the REASON). */
  readonly capability: string;
  /** Approval issue ref: `#<number>`. */
  readonly issue: string;
  /** Owning team / person — must be non-empty. */
  readonly owner: string;
  /** Expiry date `YYYY-MM-DD`; a past expiry FAILS the ratchet. */
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

// ─── The enumerated inventory ────────────────────────────────────────────────

/**
 * The CLOSED WORLD of approved capability reasons (DR-14, mirroring the DR-13
 * allowlist inversion in `architecture/effect-ledger.ts`).
 *
 * A registry row's `capability` names the missing runtime capability that
 * justifies the adapter existing at all. Free text would make the field
 * decoration: any string, including `''`, would "have a reason". Instead the
 * field is validated against this explicit, justified list, so a row invented
 * with an unapproved (or empty) reason FAILS rather than passing silently.
 * Adding a reason here is a deliberate, reviewable act.
 *
 *   - `slash-command-native`     — the runtime cannot autoload canonical
 *     `commands/*.md`, so the verbs must be lowered into its instruction-file
 *     mechanism.
 *   - `agent-definition-native`  — the runtime has no native reader for the
 *     canonical `AgentSpec`, so a per-harness renderer must lower it into that
 *     runtime's proprietary agent-definition format (frontmatter shape, file
 *     path, tool vocabulary). If a runtime ever consumes `AgentSpec` directly,
 *     its renderer is deleted.
 */
export const APPROVED_CAPABILITY_REASONS: readonly string[] = [
  'slash-command-native',
  'agent-definition-native',
];

/**
 * The single authored list of approved capability-required thin shims and
 * per-harness renderers.
 *
 * Adding a shim marker OR a structurally discovered renderer to the tree
 * WITHOUT a matching entry here fails {@link verifyShimRatchet}. Each entry
 * pins the missing capability that justifies the adapter, an approval issue, an
 * owner, and an expiry by which it must be adopted, replaced by native support,
 * or deleted.
 *
 * ### Inventory notes (DR-14)
 *
 * Before DR-14 this inventory was TWO rows — both for the command-discovery
 * shim, a reserved-but-unadopted stub — because discovery required a
 * hand-written marker and only that one module carried one. The list below is
 * reconciled against {@link discoverRenderers}, which finds renderers by shape:
 *
 *   - `command-shim-emitter.ts` (2 rows) — lowers the canonical slash-command
 *     verbs into the instruction-file mechanism of two runtimes that cannot
 *     autoload native `commands/*.md`:
 *       * Cursor  — `hasSlashCommands:false`; emits `.cursor/rules/exarchos-commands.md`.
 *       * Copilot — routes commands through `.github/copilot-instructions.md`.
 *     Both share the file and the `#1590` reservation/expiry (the module is a
 *     reserved-but-unadopted stub; the shim ratchet tracks it so it is deleted
 *     at expiry if it stays unadopted — mirroring its `RESERVED(...)` marker).
 *
 *   - `agents/adapters/{claude,codex,opencode,cursor,copilot}.ts` (5 rows) —
 *     the per-harness renderers, NEWLY REGISTERED (DR-14). Each lowers a
 *     canonical `AgentSpec` into one runtime's proprietary agent-definition
 *     file. None carries a `SHIM(...)` marker, which is exactly why the
 *     marker-driven scan could not see any of them; they are discovered by the
 *     port-implementation shape instead.
 */
export const SHIM_REGISTRY: readonly ShimEntry[] = [
  {
    id: 'copilot-command-shim',
    file: 'servers/exarchos-mcp/src/runtime/command-shim-emitter.ts',
    runtime: 'copilot',
    capability: 'slash-command-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-01-31',
  },
  {
    id: 'cursor-command-shim',
    file: 'servers/exarchos-mcp/src/runtime/command-shim-emitter.ts',
    runtime: 'cursor',
    capability: 'slash-command-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-01-31',
  },
  {
    id: 'claude-agent-renderer',
    file: 'servers/exarchos-mcp/src/agents/adapters/claude.ts',
    runtime: 'claude',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'codex-agent-renderer',
    file: 'servers/exarchos-mcp/src/agents/adapters/codex.ts',
    runtime: 'codex',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'copilot-agent-renderer',
    file: 'servers/exarchos-mcp/src/agents/adapters/copilot.ts',
    runtime: 'copilot',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'cursor-agent-renderer',
    file: 'servers/exarchos-mcp/src/agents/adapters/cursor.ts',
    runtime: 'cursor',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
  {
    id: 'opencode-agent-renderer',
    file: 'servers/exarchos-mcp/src/agents/adapters/opencode.ts',
    runtime: 'opencode',
    capability: 'agent-definition-native',
    issue: '#1590',
    owner: 'exarchos',
    expires: '2027-06-30',
  },
];

/**
 * Source roots scanned by {@link discoverShims} in the real-repo ratchet check.
 * Shims live in per-runtime adapter / runtime directories by convention; the
 * scan is bounded to these so it stays fast and so "where shims may live" is an
 * explicit, reviewable list. A shim smuggled outside these roots is out of the
 * ratchet's scope by design (add the root here to bring it in).
 */
export const SHIM_SCAN_ROOTS: readonly string[] = [
  'src',
  'servers/exarchos-mcp/src/runtime',
  'servers/exarchos-mcp/src/agents/adapters',
];

/**
 * Source roots scanned by {@link discoverRenderers}. DELIBERATELY BROADER than
 * {@link SHIM_SCAN_ROOTS}: the marker scan can afford a narrow, per-directory
 * allowlist because a marker is a declaration you go out of your way to write,
 * but a per-harness renderer is discovered against the author's convenience.
 * Bounding renderer discovery to `agents/adapters/**` would re-introduce the
 * very hole DR-14 closes — a renderer one directory over would be invisible.
 * The whole product source tree is scanned instead.
 */
export const RENDERER_SCAN_ROOTS: readonly string[] = ['src', 'servers/exarchos-mcp/src'];

/** This module's own repo-relative path — excluded from its own marker scan. */
const SELF_PATH = 'src/shim-registry.ts';

// ─── Marker parsing ──────────────────────────────────────────────────────────

/**
 * Matches a `SHIM(<fields>)` marker. Built from a spliced string literal so the
 * regex source itself does NOT contain the literal marker token — that keeps
 * this module from matching itself if it is ever accidentally scanned.
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

// ─── Filesystem discovery (injectable I/O) ───────────────────────────────────

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
    if (current === undefined) break; // len>0 makes this unreachable; satisfies noUncheckedIndexedAccess without an assertion
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
 */
export function discoverShims(opts: DiscoverShimsOptions): DiscoveredShim[] {
  const fs = opts.fs ?? DEFAULT_FS;
  const roots = opts.roots ?? SHIM_SCAN_ROOTS;
  const found: DiscoveredShim[] = [];
  for (const root of roots) {
    const absRoot = join(opts.repoRoot, root);
    for (const abs of fs.listTsFiles(absRoot)) {
      const rel = toPosix(relative(opts.repoRoot, abs));
      if (rel === SELF_PATH) continue;
      const source = fs.readFile(abs);
      if (!source.includes('SHIM' + '(')) continue;
      found.push(...parseShimMarkers(source, rel));
    }
  }
  return found;
}

// ─── Structural renderer discovery (DR-14) ───────────────────────────────────

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

/** A single named import binding, optionally `type`-qualified and/or aliased. */
const IMPORT_BINDING_RE = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/;

/** `runtime: 'cursor'` / `readonly runtime = 'copilot'` (const-asserted). */
const RUNTIME_ID_RE = /\bruntime\s*[:=]\s*['"]([A-Za-z0-9][\w.-]*)['"]/g;

/** The render member in a DECLARING position (method, property, or shorthand). */
const RENDER_MEMBER_RE = new RegExp(`\\b${RENDERER_RENDER_MEMBER}\\b\\s*[(,:}]`);

/**
 * Every local name the port type is bound to in this file. Alias-aware, so an
 * aliased import of the port binding does not evade the shape rule. Returns
 * `[]` when the file does not import the port at all — which is how the port
 * module itself (`adapters/types.ts`, which DECLARES the interface) is kept out
 * of the result set.
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

/** An exported declaration in an implementing position for `port`. */
function implementingExport(
  source: string,
  port: string,
): { exportName: string; evidence: string } | null {
  // `export const X: Port = …` / `export const X: Port & { … } = …`
  const asConst = new RegExp(
    `export\\s+(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*:\\s*${port}\\s*(?:&|=)`,
  ).exec(source);
  if (asConst) return { exportName: asConst[1] ?? '', evidence: asConst[0].trim() };

  // `export [default] [abstract] class X … implements … Port`
  const asClass = new RegExp(
    `export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+([A-Za-z_$][\\w$]*)[^{]*?\\bimplements\\b[^{]*?\\b${port}\\b`,
  ).exec(source);
  if (asClass) return { exportName: asClass[1] ?? '', evidence: asClass[0].trim() };

  // `export const X = { … } satisfies Port` — no type annotation, but still an
  // implementing position, so it must not be an escape hatch.
  const asSatisfies = new RegExp(`\\bsatisfies\\s+${port}\\b`).exec(source);
  if (asSatisfies) {
    // Nearest PRECEDING export declaration, for a useful diagnostic name.
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
 * Decide whether `source` IS a per-harness renderer, purely from its shape.
 * Pure — no I/O. Returns `null` for anything that is not one.
 *
 * The rule is a CONJUNCTION of three independent structural facts (see the
 * module header): the port is imported, an export sits in an implementing
 * position for it, and the render member is declared. Any one of them alone is
 * common enough to be a false positive; together they are satisfied on the live
 * tree by exactly the five shipped renderers.
 *
 * The declared runtime id is extracted from the module's own
 * `runtime: '<id>'` / `runtime = '<id>'` member. If the module declares no id,
 * or declares several, `runtime` is `''` — the ratchet then reports
 * `undeclared-runtime` rather than guessing a binding that governance would be
 * keyed on.
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
 * Walk the configured roots and return every per-harness renderer found in
 * production source, keyed by POSIX repo-relative path. Marker-INDEPENDENT: a
 * renderer is reported whether or not anyone wrote a `SHIM(...)` marker in it,
 * and a marker cannot conjure one. Results are de-duplicated (roots may nest)
 * and sorted by path so output is stable.
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
      // Cheap prefilter: the port name must appear at all. Keeps the scan from
      // running three regexes over every file in the tree.
      if (!source.includes(RENDERER_PORT_TYPE)) continue;
      const renderer = detectRenderer(source, rel);
      if (renderer) found.set(rel, renderer);
    }
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
}

// ─── Governance validation ───────────────────────────────────────────────────

/** UTC midnight of a date, for a whole-day expiry comparison. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

interface GovernanceProblem {
  readonly kind: 'malformed' | 'expired';
  readonly detail: string;
}

/**
 * Validate a registry entry's governance fields against `now`. Returns the list
 * of problems (empty ⇒ valid).
 *
 * Every field a row is *supposed* to carry is checked HERE, not by convention:
 * a non-empty id / file / runtime, an APPROVED capability reason (closed world
 * — see {@link APPROVED_CAPABILITY_REASONS}), a well-formed issue ref
 * (`#<number>`), a non-empty owner, and a CLEAN `YYYY-MM-DD` expiry that is a
 * real calendar date and not in the past. The `ShimEntry` interface makes the
 * fields required at COMPILE time; these checks make them required at RUN time
 * too, so a row smuggled in through a cast or from JSON cannot ship blank.
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

  // The capability REASON. A blank or unrecognised reason is not a reason; the
  // closed world is what stops the field decaying into free-text decoration.
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

// ─── The ratchet ─────────────────────────────────────────────────────────────

const PAIR_SEP = '\u0000';
const pairKey = (file: string, runtime: string): string => `${file}${PAIR_SEP}${runtime}`;

/** Inputs to {@link verifyShimRatchet}. */
export interface ShimRatchetInputs {
  readonly registry: readonly ShimEntry[];
  readonly discovered: readonly DiscoveredShim[];
  /**
   * Per-harness renderers discovered structurally (DR-14). Optional so the pure
   * ratchet rules stay callable with a hand-built marker set — and omitting it
   * cannot pass silently: a registry row backed only by a renderer then has
   * NEITHER a marker nor a renderer on disk and fails `missing-on-disk`.
   */
  readonly renderers?: readonly DiscoveredRenderer[];
  readonly now: Date;
}

/**
 * The ratchet. Compares the enumerated registry against the shims AND
 * per-harness renderers discovered on disk, and validates each registry entry's
 * governance. Never short-circuits — a caller sees every violation in one pass.
 *
 * Violation classes:
 *   - `duplicate-id`        — two registry entries share an id.
 *   - `malformed`/`expired` — a registry entry's governance is invalid / past.
 *   - `unregistered`        — a discovered renderer or (file, runtime) marker
 *                             has no entry (the count grew without an approved
 *                             capability reason + expiry).
 *   - `undeclared-runtime`  — a discovered renderer declares no single runtime
 *                             id, so governance cannot be keyed to it.
 *   - `capability-mismatch` — the marker's capability disagrees with the entry.
 *   - `missing-on-disk`     — a registry entry has neither a marker nor a
 *                             renderer on disk (stale cover).
 */
export function verifyShimRatchet(inputs: ShimRatchetInputs): ShimRatchetResult {
  const { registry, discovered, now } = inputs;
  const renderers = inputs.renderers ?? [];
  const violations: ShimViolation[] = [];

  // 0. Registry ids must be unique — a duplicate id makes remediation ambiguous.
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

  // 1. Governance: every entry must be well-formed and unexpired.
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

  // 2. Every discovered RENDERER must be registered. This is the DR-14
  //    headline and it does NOT depend on anyone remembering to write a
  //    `SHIM(...)` marker: a per-harness renderer added anywhere under the
  //    scanned roots without an approved capability reason and an expiry fails
  //    here, on the strength of its own shape.
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

  // 3. Every discovered (file, runtime) MARKER pair must be registered, with a
  //    matching capability. The marker is supplementary after DR-14, but a
  //    stray one still fails: it documents a shim nobody governs.
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

  // 4. Every registry entry must be backed on disk by a marker OR a renderer.
  //    Marker-OR-renderer is the T-21 demotion: a governed row no longer
  //    *requires* a comment, so omitting one cannot defeat the mechanism —
  //    but a row covering nothing at all is still a stale cover and fails.
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
