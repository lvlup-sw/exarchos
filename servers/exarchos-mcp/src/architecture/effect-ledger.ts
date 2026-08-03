import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { maskLiteralsAndComments } from './delivery-safety.js';

/**
 * P04-01 — effect ownership ledger (structural census).
 *
 * The unified remediation plan (PROGRAM-04) mandates that **every effect has one
 * typed owner, idempotency boundary, and repair or compensation contract**. This
 * module is the structural-conformance harness for that mandate: a string-aware
 * static scan of the shipped source that enumerates every *effect occurrence*
 * and maps it to a declared typed owner via {@link EFFECT_OWNERSHIP}. Any
 * occurrence that no ownership rule claims is an `INDETERMINATE_OWNER` and fails
 * the census; any ownership rule that claims no live occurrence is a
 * `STALE_OWNERSHIP` phantom and also fails (no stale cover — the same "no-mask"
 * ratchet as `architecture/import-cycles.ts`).
 *
 * It follows the established `orchestrate/gate-ownership-census.ts` pattern: a
 * string-aware source scan producing a typed verdict over the *real* tree, so a
 * regression (a new unowned effect site) trips it rather than a hand-maintained
 * mirror.
 *
 * ── Effect classes ──────────────────────────────────────────────────────────
 * The scan classifies the three effect *primitives* that are statically
 * detectable from a module's import surface: `filesystem` (`node:fs`), `process`
 * (`node:child_process`), and `network` (`node:http|https|net|tls|dgram`,
 * `undici`, or a global `fetch`). The plan's other named effects — `vcs` and
 * `install` — are process *owners*, not separate primitives: a `process`
 * occurrence under `vcs/**` is owned by the VCS effect owner, one under an
 * install module by the install owner. Ownership is therefore where `vcs` /
 * `install` are named (see {@link EFFECT_OWNERSHIP}).
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * "Shipped source" excludes test, fixture, benchmark and evaluation harnesses
 * (see {@link EXCLUDED_DIRS} / {@link isScannableFile}); those are not shipped
 * and carry their own effect surface. Filesystem persistence is pervasive, so
 * its ownership is declared at layer granularity; process and network are
 * declared at the crisp module/owner granularity their "one typed owner" mandate
 * warrants.
 */

/** The three statically-detectable effect primitives. */
export type EffectClass = 'filesystem' | 'process' | 'network';

/** A single effect occurrence: module M performs effect class C, per `evidence`. */
export interface EffectOccurrence {
  /** Repo-relative to the scan root, forward-slashed. */
  readonly module: string;
  readonly effectClass: EffectClass;
  /** The import specifier or token that evidences the effect. */
  readonly evidence: string;
}

/**
 * A declared ownership rule. `match` is either an exact module path or a
 * directory prefix ending in `/`. A rule claims every occurrence of its
 * `effectClass` whose module the `match` covers. `owner` is the single typed
 * owner; `idempotency` and `compensation` record the two remaining contracts the
 * plan requires of every effect.
 */
export interface EffectOwnershipRule {
  readonly effectClass: EffectClass;
  readonly match: string;
  readonly owner: string;
  readonly idempotency: string;
  readonly compensation: string;
}

export type EffectLedgerDiagnostic =
  | {
      readonly code: 'INDETERMINATE_OWNER';
      readonly module: string;
      readonly effectClass: EffectClass;
      readonly evidence: string;
      readonly message: string;
    }
  | {
      readonly code: 'STALE_OWNERSHIP';
      readonly effectClass: EffectClass;
      readonly match: string;
      readonly owner: string;
      readonly message: string;
    };

export interface EffectLedgerResult {
  readonly ok: boolean;
  readonly occurrenceCount: number;
  readonly diagnostics: readonly EffectLedgerDiagnostic[];
}

// ─── Detection ──────────────────────────────────────────────────────────────

/** Directories whose contents are not shipped source (test/bench/eval harnesses). */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'test-helpers',
  'bench',
  'benchmarks',
  'evals',
]);

/** True for a shipped-source TypeScript module (not a test/decl/bench file). */
export function isScannableFile(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.d.ts') &&
    !name.endsWith('.bench.ts')
  );
}

const FS_SPEC = /^(?:node:)?fs(?:\/promises)?$/;
const PROCESS_SPEC = /^(?:node:)?child_process$/;
const NETWORK_SPEC = /^(?:node:)?(?:http|https|net|tls|dgram)$|^undici$/;

/** Classify an import specifier to an effect class, or undefined if inert. */
function classifySpecifier(spec: string): EffectClass | undefined {
  if (FS_SPEC.test(spec)) return 'filesystem';
  if (PROCESS_SPEC.test(spec)) return 'process';
  if (NETWORK_SPEC.test(spec)) return 'network';
  return undefined;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const isIdentChar = (c: string | undefined): boolean => c !== undefined && IDENT_CHAR.test(c);
const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/**
 * Extract every module specifier introduced by `from '…'`, `import '…'`,
 * `import('…')` or `require('…')` at CODE position. A comment/string aware walk
 * so a `from 'node:fs'` that appears *inside* a string literal or comment (e.g.
 * a lint pattern or doc example) is not mistaken for a real import.
 */
export function extractImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const n = source.length;
  let i = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;

  const readStringAt = (start: number): { value: string; end: number } | undefined => {
    const q = source[start];
    if (q !== '"' && q !== "'" && q !== '`') return undefined;
    let j = start + 1;
    let val = '';
    while (j < n) {
      const c = source[j] ?? '';
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === q) return { value: val, end: j };
      val += c;
      j += 1;
    }
    return undefined;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      i += 1;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }

    // Code position: a keyword that introduces a specifier, at a word boundary.
    if (!isIdentChar(source[i - 1])) {
      let kw: 'from' | 'import' | 'require' | null = null;
      if (source.startsWith('from', i) && !isIdentChar(source[i + 4])) kw = 'from';
      else if (source.startsWith('import', i) && !isIdentChar(source[i + 6])) kw = 'import';
      else if (source.startsWith('require', i) && !isIdentChar(source[i + 7])) kw = 'require';

      if (kw !== null) {
        let j = i + kw.length;
        while (isSpace(source[j])) j += 1;
        if ((kw === 'import' || kw === 'require') && source[j] === '(') {
          j += 1;
          while (isSpace(source[j])) j += 1;
        }
        const str = readStringAt(j);
        if (str !== undefined) {
          specs.push(str.value);
          i = str.end + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return specs;
}

const FETCH_RE = /\bfetch\s*\(/;

/**
 * Enumerate the distinct effect classes a single module performs. Deduped to one
 * occurrence per (module, class): ownership is per module, so a module that reads
 * fs twice is one filesystem occurrence.
 */
export function detectModuleEffects(module: string, source: string): EffectOccurrence[] {
  const found = new Map<EffectClass, string>();

  for (const spec of extractImportSpecifiers(source)) {
    const klass = classifySpecifier(spec);
    if (klass !== undefined && !found.has(klass)) found.set(klass, spec);
  }

  // A global `fetch(` (no import) is a network effect too — judged on fully
  // masked source so a `fetch(` in a string/comment is not counted.
  if (!found.has('network') && FETCH_RE.test(maskLiteralsAndComments(source))) {
    found.set('network', 'fetch');
  }

  return [...found.entries()]
    .map(([effectClass, evidence]) => ({ module, effectClass, evidence }))
    .sort((a, b) => (a.effectClass < b.effectClass ? -1 : 1));
}

async function collectScannableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile() && isScannableFile(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** Scan the shipped source under `sourceRoot` and enumerate every effect occurrence. */
export async function scanEffectOccurrences(
  sourceRoot: string,
): Promise<readonly EffectOccurrence[]> {
  const files = await collectScannableFiles(sourceRoot);
  const perFile = await Promise.all(
    files.map(async (file) => {
      const module = relative(sourceRoot, file).replaceAll('\\', '/');
      return detectModuleEffects(module, await readFile(file, 'utf8'));
    }),
  );
  return Object.freeze(
    perFile.flat().sort((a, b) =>
      a.module === b.module
        ? a.effectClass < b.effectClass
          ? -1
          : 1
        : a.module < b.module
          ? -1
          : 1,
    ),
  );
}

// ─── Ownership model ────────────────────────────────────────────────────────

/** Does `rule` claim `occurrence`? */
export function ruleClaims(rule: EffectOwnershipRule, occurrence: EffectOccurrence): boolean {
  if (rule.effectClass !== occurrence.effectClass) return false;
  if (rule.match.endsWith('/')) return occurrence.module.startsWith(rule.match);
  return occurrence.module === rule.match;
}

/**
 * Pure census verdict over an already-collected occurrence set and rule set.
 *
 * Two independent, complementary checks, each with its own diagnostic:
 *   - INDETERMINATE_OWNER — an occurrence no rule claims;
 *   - STALE_OWNERSHIP     — a rule that claims no occurrence (phantom cover).
 */
export function runEffectLedgerCensus(
  occurrences: readonly EffectOccurrence[],
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): EffectLedgerResult {
  const diagnostics: EffectLedgerDiagnostic[] = [];

  for (const occurrence of occurrences) {
    const owned = rules.some((rule) => ruleClaims(rule, occurrence));
    if (!owned) {
      diagnostics.push({
        code: 'INDETERMINATE_OWNER',
        module: occurrence.module,
        effectClass: occurrence.effectClass,
        evidence: occurrence.evidence,
        message:
          `Module "${occurrence.module}" performs a ${occurrence.effectClass} effect ` +
          `(via "${occurrence.evidence}") that no ownership rule claims. Every effect ` +
          `must have one typed owner — declare it in EFFECT_OWNERSHIP.`,
      });
    }
  }

  for (const rule of rules) {
    const claimsSomething = occurrences.some((occurrence) => ruleClaims(rule, occurrence));
    if (!claimsSomething) {
      diagnostics.push({
        code: 'STALE_OWNERSHIP',
        effectClass: rule.effectClass,
        match: rule.match,
        owner: rule.owner,
        message:
          `Ownership rule for ${rule.effectClass} "${rule.match}" (owner "${rule.owner}") ` +
          `claims no live effect occurrence — stale cover. Remove it or restore the effect.`,
      });
    }
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    occurrenceCount: occurrences.length,
    diagnostics,
  });
}

/** Collect the live occurrences and return the census verdict over the real tree. */
export async function auditEffectOwnership(
  sourceRoot: string,
  rules: readonly EffectOwnershipRule[] = EFFECT_OWNERSHIP,
): Promise<EffectLedgerResult> {
  const occurrences = await scanEffectOccurrences(sourceRoot);
  return runEffectLedgerCensus(occurrences, rules);
}

// ─── The declared effect ledger ─────────────────────────────────────────────
//
// One entry per (effectClass, module-or-layer). Process and network are declared
// at owner granularity (the crisp "one typed owner" surface); filesystem
// persistence is declared at layer granularity. Adding a new effect site to a
// layer with no rule fails the census until an owner is consciously declared.

const rule = (
  effectClass: EffectClass,
  match: string,
  owner: string,
  idempotency: string,
  compensation: string,
): EffectOwnershipRule => ({ effectClass, match, owner, idempotency, compensation });

/**
 * The effect ownership ledger — the census's single source of truth for who owns
 * each effect. Populated in {@link registerLedger} against the live tree.
 */
export const EFFECT_OWNERSHIP: readonly EffectOwnershipRule[] = registerLedger();

function registerLedger(): readonly EffectOwnershipRule[] {
  return Object.freeze([
    // ── network (crisp: exact modules) ──────────────────────────────────────
    rule(
      'network',
      'workflow/feedback.ts',
      'workflow-feedback-network',
      'idempotent: feedback read/post keyed by operation marker',
      'marker-scan reconciliation dedupes a retried post',
    ),

    // ── process (owner granularity) ─────────────────────────────────────────
    rule(
      'process',
      'utils/process.ts',
      'process-spawn-primitive',
      'boundary: the single cross-OS spawn primitive; callers own idempotency',
      'supervised child exposes kill() for teardown',
    ),
    rule(
      'process',
      'vcs/',
      'vcs-process-owner',
      'idempotent: git/gh reads; writes guarded by the VCS provider',
      'VCS provider surfaces failures; no partial local state',
    ),
    rule(
      'process',
      'workflow/compensation.ts',
      'compensation-process-owner',
      'idempotent: teardown re-run is a no-op when already absent',
      'this IS the compensation effect (saga repair)',
    ),
    rule(
      'process',
      'orchestrate/',
      'orchestrate-process-owner',
      'per-call: orchestrate probes/gates own their re-run semantics',
      'orchestrate saga steps carry their own compensation',
    ),
    rule(
      'process',
      'config/',
      'config-probe-owner',
      'idempotent: config toolchain probes are read-only',
      'none: probes mutate no state',
    ),
    rule(
      'process',
      'hooks/',
      'hook-process-owner',
      'best-effort: hook subprocesses are side-channel',
      'none: hooks are advisory, not on the compensation path',
    ),
    rule(
      'process',
      'launcher/',
      'launcher-process-owner',
      'idempotent: teardown/liveness probes tolerate re-run',
      'launcher lifecycle owns child kill/teardown',
    ),
    rule(
      'process',
      'cli-commands/',
      'cli-process-owner',
      'per-command: CLI verification runners own re-run semantics',
      'none: verification is read-only over the worktree',
    ),

    // ── filesystem (layer granularity) ──────────────────────────────────────
    rule('filesystem', 'index.ts', 'server-entry-fs', 'startup read-only', 'none'),
    rule(
      'filesystem',
      'artifacts/',
      'artifact-store-fs',
      'content-addressed: idempotent by digest',
      'orphan artifacts are GC-swept; no compensation needed',
    ),
    rule(
      'filesystem',
      'storage/',
      'storage-layer-fs',
      'atomic writes; idempotent by key',
      'atomic rename leaves no partial state',
    ),
    rule(
      'filesystem',
      'event-store/',
      'event-store-fs',
      'append-only; sequence-guarded idempotency',
      'atomic append; a failed append leaves the log unchanged',
    ),
    rule(
      'filesystem',
      'config/',
      'config-load-fs',
      'read-only config load; idempotent',
      'none: config reads mutate nothing',
    ),
    rule(
      'filesystem',
      'orchestrate/',
      'orchestrate-fs',
      'worktree/state writes carry saga idempotency',
      'orchestrate compensation reverses worktree/state writes',
    ),
    rule(
      'filesystem',
      'workflow/',
      'workflow-fs',
      'state writes guarded by state-retry',
      'workflow compensation reverses partial writes',
    ),
    rule(
      'filesystem',
      'architecture/',
      'architecture-scan-fs',
      'read-only static scans; idempotent',
      'none: scans mutate nothing',
    ),
    rule(
      'filesystem',
      'session/',
      'session-fs',
      'session state writes; idempotent by session id',
      'session teardown removes state',
    ),
    rule(
      'filesystem',
      'projections/',
      'projection-fs',
      'derived read-model writes; rebuildable from the log',
      'projection rebuild reconstructs state',
    ),
    rule(
      'filesystem',
      'views/',
      'view-fs',
      'read-only derived views; idempotent',
      'none: views are derived',
    ),
    rule('filesystem', 'core/', 'core-fs', 'read-only bootstrap/context', 'none'),
    rule('filesystem', 'utils/', 'utils-fs', 'pure fs helpers; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'lib/', 'lib-fs', 'pure fs helpers; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'launcher/', 'launcher-fs', 'startup/teardown fs; idempotent', 'launcher teardown'),
    rule('filesystem', 'agents/', 'agents-fs', 'agent definition reads; read-only', 'none'),
    rule('filesystem', 'sync/', 'sync-fs', 'outbox writes; idempotent by op id', 'outbox reconciliation'),
    rule('filesystem', 'runtime/', 'runtime-fs', 'runtime resource reads; read-only', 'none'),
    rule('filesystem', 'telemetry/', 'telemetry-fs', 'append-only telemetry; best-effort', 'none: telemetry is advisory'),
    rule('filesystem', 'topology/', 'topology-fs', 'topology reads; read-only', 'none'),
    rule('filesystem', 'cli-commands/', 'cli-fs', 'worktree reads/writes; per-command', 'none: read-mostly'),
    rule('filesystem', 'adapters/', 'adapters-fs', 'adapter io; caller owns idempotency', 'caller-owned'),
    rule('filesystem', 'onramp/', 'onramp-fs', 'onboarding scaffold writes; idempotent', 'scaffold is re-runnable'),
    rule('filesystem', 'workspace/', 'workspace-fs', 'workspace reads/writes; idempotent by path', 'caller-owned'),
  ]);
}
