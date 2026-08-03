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
 * ## The ratchet
 *
 * Shims RATCHET DOWN, never silently up. Every shim must be:
 *   1. ENUMERATED in {@link SHIM_REGISTRY} with a capability REASON — the
 *      missing-capability id plus a well-formed approval issue ref and a
 *      non-empty owner — and an EXPIRY (`YYYY-MM-DD`).
 *   2. Self-declared in-source with a `SHIM(...)` marker comment so the tree
 *      can be scanned independently of the registry.
 *
 * {@link verifyShimRatchet} cross-checks the two:
 *   - a discovered marker with no matching registry entry FAILS (a shim was
 *     added without an approved capability reason + expiry — the count grew);
 *   - a registry entry whose `expires` is in the past FAILS (deletion is due at
 *     expiry — the same enforcement philosophy as the `RESERVED(...)`
 *     module-intent gate in `scripts/check-module-intent.mjs`);
 *   - a registry entry with no marker on disk FAILS (a stale/dangling entry).
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
 * registry, the discovered set, and `now` explicitly — so the ratchet rules are
 * unit-testable without a filesystem. {@link discoverShims} is the thin,
 * injectable I/O adapter that produces the discovered set from the real tree.
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

/** A single ratchet failure. */
export interface ShimViolation {
  readonly kind:
    | 'unregistered'
    | 'expired'
    | 'malformed'
    | 'missing-on-disk'
    | 'capability-mismatch'
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
 * The single authored list of approved capability-required thin shims.
 *
 * Adding a shim to the tree WITHOUT a matching entry here fails
 * {@link verifyShimRatchet}. Each entry pins the missing capability that
 * justifies the adapter, an approval issue, an owner, and an expiry by which
 * the shim must be adopted, replaced by native support, or deleted.
 *
 * Current inventory — the command-discovery shim (`command-shim-emitter.ts`)
 * lowers the canonical slash-command verbs into the instruction-file mechanism
 * of two runtimes that cannot autoload native `commands/*.md`:
 *   - Cursor  — `hasSlashCommands:false`; emits `.cursor/rules/exarchos-commands.md`.
 *   - Copilot — routes commands through `.github/copilot-instructions.md`.
 * Both share the file and the `#1590` reservation/expiry (the module is a
 * reserved-but-unadopted stub; the shim ratchet tracks it so it is deleted at
 * expiry if it stays unadopted — mirroring its `RESERVED(...)` marker).
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
    const current = stack.pop()!;
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
 * of problems (empty ⇒ valid): a well-formed issue ref (`#<number>`), a
 * non-empty owner, and a CLEAN `YYYY-MM-DD` expiry that is a real calendar date
 * and not in the past.
 */
export function validateEntryGovernance(
  entry: ShimEntry,
  now: Date,
): GovernanceProblem[] {
  const problems: GovernanceProblem[] = [];

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
  readonly now: Date;
}

/**
 * The ratchet. Compares the enumerated registry against the shims discovered on
 * disk and validates each registry entry's governance. Never short-circuits —
 * a caller sees every violation in one pass.
 *
 * Violation classes:
 *   - `duplicate-id`        — two registry entries share an id.
 *   - `malformed`/`expired` — a registry entry's governance is invalid / past.
 *   - `unregistered`        — a discovered (file, runtime) shim has no entry
 *                             (the count grew without an approved reason+expiry).
 *   - `capability-mismatch` — the marker's capability disagrees with the entry.
 *   - `missing-on-disk`     — a registry entry has no marker on disk (stale).
 */
export function verifyShimRatchet(inputs: ShimRatchetInputs): ShimRatchetResult {
  const { registry, discovered, now } = inputs;
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

  // 2. Every discovered (file, runtime) pair must be registered, with a
  //    matching capability. An unregistered pair is the "count grew" failure.
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

  // 3. Every registry entry must be backed by a marker on disk.
  for (const e of registry) {
    if (!discoveredKeys.has(pairKey(e.file, e.runtime))) {
      violations.push({
        kind: 'missing-on-disk',
        id: e.id,
        file: e.file,
        runtime: e.runtime,
        detail:
          `registered shim '${e.id}' (${e.file}, runtime ${e.runtime}) has no ` +
          `SHIM marker on disk — remove the stale registry entry or restore the marker`,
      });
    }
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
