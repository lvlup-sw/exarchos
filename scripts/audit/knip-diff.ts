/**
 * knip-diff.ts — the DR-6/DR-8 dead-code gate.
 *
 * Runs `knip` (files + dependencies + exports + types) and diffs its findings
 * against `knip-allowlist.json`. The gate FAILS CLOSED — it exits non-zero, and
 * never silently passes — on any of:
 *
 *   (a) an unallowlisted violation  → fix (delete the dead code) or allowlist it
 *   (b) an expired allowlist entry  → the review deadline passed; delete or renew
 *   (DR-8) the knip binary is missing → cannot verify the surface (tool-missing)
 *   (DR-8) knip emitted unparseable output → cannot trust the surface
 *   a malformed knip-allowlist.json → the exemption ledger itself is untrusted
 *
 * (a)/(b) exit 1 (a real dead-code finding); the DR-8 "can't verify" causes exit
 * 2, so CI can tell "there is dead code" from "the gate itself broke". Both are
 * blocking. The pure functions (`parseKnipOutput`, `loadAllowlist`,
 * `diffAgainstAllowlist`) and the injectable `runKnipDiff(deps)` are exported so
 * the fail-closed paths are unit-testable without spawning knip.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isEntryExpired, makeRegisterSchema } from './register-entry-schema.js';

/**
 * Per-register schema. The knip allowlist keys each exemption on `{ symbol, file }`;
 * the shared `{ owner, rationale, expires XOR permanent }` contract comes from
 * {@link makeRegisterSchema}. Task 010's edge register will call the same seam
 * with its own key fields.
 */
export const allowlistEntrySchema = makeRegisterSchema({
  symbol: z.string().min(1, '`symbol` is required'),
  file: z.string().min(1, '`file` is required'),
});
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;

export interface KnipViolation {
  readonly kind: 'file' | 'dependency' | 'export' | 'type';
  /** For `kind === 'file'` this is the file path; otherwise the symbol / dep name. */
  readonly symbol: string;
  readonly file: string;
  readonly line?: number;
}

/** Thrown when knip output cannot be parsed into the expected shape (DR-8). */
export class KnipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnipParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readName(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (isRecord(item) && typeof item.name === 'string') return item.name;
  return undefined;
}

function readLine(item: unknown): number | undefined {
  return isRecord(item) && typeof item.line === 'number' ? item.line : undefined;
}

/**
 * Parse knip's `--reporter json` stdout into a flat violation list. Throws
 * {@link KnipParseError} on anything that is not the expected `{ issues: [...] }`
 * shape so the caller can fail closed instead of treating garbage as "clean".
 */
export function parseKnipOutput(raw: string): KnipViolation[] {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new KnipParseError('knip produced empty output (expected a JSON report)');
  }
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    throw new KnipParseError(`knip did not emit valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(json) || !Array.isArray(json.issues)) {
    throw new KnipParseError('knip JSON is missing the expected top-level `issues[]` array');
  }

  const violations: KnipViolation[] = [];
  const collect = (raw_arr: unknown, kind: KnipViolation['kind'], file: string): void => {
    if (!Array.isArray(raw_arr)) return;
    for (const item of raw_arr) {
      const symbol = readName(item);
      if (symbol === undefined) {
        throw new KnipParseError(`a knip \`${kind}\` finding in ${file} is missing its \`name\``);
      }
      violations.push({ kind, symbol, file, line: readLine(item) });
    }
  };

  for (const issue of json.issues) {
    if (!isRecord(issue) || typeof issue.file !== 'string') {
      throw new KnipParseError('a knip issue is missing its `file`');
    }
    const file = issue.file;
    // Whole-file-unused: knip reports a non-empty `files` array on that file's issue.
    if (Array.isArray(issue.files) && issue.files.length > 0) {
      violations.push({ kind: 'file', symbol: file, file });
    }
    collect(issue.dependencies, 'dependency', file);
    collect(issue.devDependencies, 'dependency', file);
    collect(issue.exports, 'export', file);
    collect(issue.types, 'type', file);
  }
  return violations;
}

/** Validate the raw allowlist JSON against the shared register contract. */
export function loadAllowlist(raw: unknown): AllowlistEntry[] {
  const result = z.array(allowlistEntrySchema).safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - [${issue.path.join('.') || '(root)'}] ${issue.message}`)
      .join('\n');
    throw new Error(`knip-allowlist.json failed schema validation:\n${detail}`);
  }
  return result.data;
}

export interface DiffResult {
  /** knip findings with no matching allowlist entry — these FAIL the gate. */
  readonly unallowlisted: readonly KnipViolation[];
  /** allowlist entries past their review deadline — these FAIL the gate. */
  readonly expired: readonly AllowlistEntry[];
  /** allowlist entries knip no longer flags — a non-failing hygiene warning. */
  readonly stale: readonly AllowlistEntry[];
}

const entryKey = (file: string, symbol: string): string => `${file} ${symbol}`;

export function diffAgainstAllowlist(
  violations: readonly KnipViolation[],
  allowlist: readonly AllowlistEntry[],
  now: Date,
): DiffResult {
  const index = new Map<string, AllowlistEntry>();
  for (const entry of allowlist) index.set(entryKey(entry.file, entry.symbol), entry);

  const matched = new Set<string>();
  const unallowlisted: KnipViolation[] = [];
  for (const violation of violations) {
    const key = entryKey(violation.file, violation.symbol);
    if (index.has(key)) matched.add(key);
    else unallowlisted.push(violation);
  }

  const expired = allowlist.filter((entry) => isEntryExpired(entry, now));
  const stale = allowlist.filter((entry) => !matched.has(entryKey(entry.file, entry.symbol)));
  return { unallowlisted, expired, stale };
}

export const EXIT_OK = 0;
/** A real dead-code finding: an unallowlisted or expired exemption. */
export const EXIT_VIOLATIONS = 1;
/** Fail-closed: the gate itself could not verify the surface (DR-8). */
export const EXIT_GATE_ERROR = 2;

export interface KnipRun {
  /** Was the knip binary resolvable and spawnable? `false` ⇒ tool-missing. */
  readonly found: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly binPath: string;
}

export interface KnipDiffDeps {
  readonly runKnip: () => KnipRun;
  readonly readAllowlist: () => unknown;
  readonly now: Date;
  readonly log: (message: string) => void;
  readonly errlog: (message: string) => void;
}

/** Injectable gate body — no process/FS/child_process access of its own. */
export function runKnipDiff(deps: KnipDiffDeps): number {
  const run = deps.runKnip();
  if (!run.found) {
    deps.errlog(
      `[knip-diff] FAIL (tool-missing): knip binary not found at ${run.binPath}. ` +
        'Cannot verify the dead-code surface — failing closed. ' +
        'Run `npm ci` at the repo root to install devDependencies.',
    );
    return EXIT_GATE_ERROR;
  }

  let violations: KnipViolation[];
  try {
    violations = parseKnipOutput(run.stdout);
  } catch (err) {
    const detail = err instanceof KnipParseError ? err.message : (err as Error).message;
    deps.errlog(
      `[knip-diff] FAIL (unparseable-output): ${detail}. ` +
        `knip exited ${run.code}; stdout head=${JSON.stringify(run.stdout.slice(0, 160))}; ` +
        `stderr head=${JSON.stringify(run.stderr.slice(0, 160))}. Failing closed.`,
    );
    return EXIT_GATE_ERROR;
  }

  let allowlist: AllowlistEntry[];
  try {
    allowlist = loadAllowlist(deps.readAllowlist());
  } catch (err) {
    deps.errlog(`[knip-diff] FAIL (bad-allowlist): ${(err as Error).message}`);
    return EXIT_GATE_ERROR;
  }

  const { unallowlisted, expired, stale } = diffAgainstAllowlist(violations, allowlist, deps.now);

  for (const entry of stale) {
    deps.errlog(
      `[knip-diff] WARN (stale-entry): ${entry.file} :: ${entry.symbol} is no longer flagged by ` +
        'knip — delete it from knip-allowlist.json.',
    );
  }

  let failed = false;
  if (unallowlisted.length > 0) {
    failed = true;
    deps.errlog(
      `[knip-diff] FAIL (unallowlisted): ${unallowlisted.length} dead-code finding(s) absent from ` +
        'knip-allowlist.json — fix (delete the dead code) or add an entry with owner/expiry/rationale:',
    );
    for (const v of unallowlisted) {
      deps.errlog(`    ${v.kind}  ${v.file} :: ${v.symbol}${v.line ? `:${v.line}` : ''}`);
    }
  }
  if (expired.length > 0) {
    failed = true;
    deps.errlog(
      `[knip-diff] FAIL (expired): ${expired.length} allowlist exemption(s) past their review ` +
        'deadline — delete the dead code or renew `expires`:',
    );
    for (const e of expired) {
      deps.errlog(`    ${e.file} :: ${e.symbol} (owner ${e.owner}, expired ${e.expires ?? '?'})`);
    }
  }
  if (failed) return EXIT_VIOLATIONS;

  deps.log(
    `[knip-diff] OK: ${violations.length} knip finding(s), all allowlisted and unexpired ` +
      `(${allowlist.length} entr${allowlist.length === 1 ? 'y' : 'ies'} in knip-allowlist.json).`,
  );
  return EXIT_OK;
}

// ─── production wiring (only runs when invoked as a CLI) ────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const ALLOWLIST_PATH = path.join(HERE, 'knip-allowlist.json');
const DEFAULT_INCLUDE = 'files,dependencies,exports,types';

function parseIncludeArg(argv: readonly string[]): string {
  const i = argv.indexOf('--include');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : DEFAULT_INCLUDE;
}

function defaultRunKnip(include: string): KnipRun {
  const binPath = path.join(REPO_ROOT, 'node_modules', '.bin', 'knip');
  const res = spawnSync(
    binPath,
    ['--no-progress', '--reporter', 'json', '--include', include],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    return { found: false, code: -1, stdout: res.stdout ?? '', stderr: res.error.message, binPath };
  }
  return {
    found: true,
    code: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    binPath,
  };
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  const include = parseIncludeArg(process.argv.slice(2));
  const exitCode = runKnipDiff({
    runKnip: () => defaultRunKnip(include),
    readAllowlist: () => JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')),
    now: new Date(),
    log: (message) => process.stdout.write(`${message}\n`),
    errlog: (message) => process.stderr.write(`${message}\n`),
  });
  process.exit(exitCode);
}
