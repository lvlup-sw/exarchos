/**
 * Dead-code gate. It runs `knip` (files, dependencies, exports, types) and diffs the findings
 * against `knip-allowlist.json`. An unallowlisted finding or an expired allowlist entry exits 1.
 * A missing binary, unparseable output, a bad config or allowlist, or a vacuous exemption exits 2.
 * CI can then tell dead code from a broken gate.
 *
 * `knip-allowlist.json` exempts one finding by `{file, symbol}`, with an owner and an expiry.
 * The `tags: ["-proof"]` rule in `knip.json` exempts a convention: exported `Expect<…>` proof
 * aliases, which exist only so that `tsc` checks an invariant.
 *
 * For each exclusion tag, the gate takes a second knip reading with `--tags +<name>`. This
 * denominator lists the unreferenced exports that carry the tag. An empty denominator exits 2,
 * because a renamed tag or a run that resolves no files also reports zero findings.
 * The gate exempts a symbol only by its tag, never by a `_` name prefix.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isEntryExpired, makeRegisterSchema } from './register-entry-schema.js';

/**
 * Per-register schema. The knip allowlist keys each exemption on `{ symbol, file }`.
 * The shared `{ owner, rationale, expires XOR permanent }` contract comes from
 * {@link makeRegisterSchema}.
 */
export const allowlistEntrySchema = makeRegisterSchema({
  symbol: z.string().min(1, '`symbol` is required'),
  file: z.string().min(1, '`file` is required'),
});
export type AllowlistEntry = z.infer<typeof allowlistEntrySchema>;

export interface KnipViolation {
  readonly kind: 'file' | 'dependency' | 'export' | 'type';
  /** The file path for `kind === 'file'`. For the other kinds, the symbol or dependency name. */
  readonly symbol: string;
  readonly file: string;
  /**
   * `| undefined` on purpose: {@link parseKnipOutput} sets it from `readLine`, which returns
   * `undefined` for a finding with no line. Under `exactOptionalPropertyTypes`, an explicit
   * `undefined` is not the same as an absent key.
   */
  readonly line?: number | undefined;
}

/** Thrown when knip output cannot be parsed into the expected shape. */
export class KnipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnipParseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrow a caught `unknown` without spending from the repo's type-assertion budget. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * A non-empty `files` array on an issue marks the whole file as unused.
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

/**
 * A knip exclusion tag, in the two forms the gate needs.
 * knip splits a raw config entry on `,`, takes the first `[a-zA-Z]+` run, and prefixes `@`.
 * So `"-proof"` and `"-proof-alias"` both name `@proof`. An entry with no leading `-` is an
 * include filter, not an exemption. {@link readExclusionTags} mirrors that rule, so the
 * denominator measures the tag that knip applies.
 */
export interface ExclusionTag {
  /** Bare name, as passed back to knip's `--tags +<name>` (`proof`). */
  readonly name: string;
  /** JSDoc form, as knip matches it against a declaration's tags (`@proof`). */
  readonly jsDocTag: string;
}

/**
 * Read the exclusion tags declared by `knip.json`. The gate reads the policy from the same
 * file as knip and hard-codes no tag name.
 */
export function readExclusionTags(knipConfig: unknown): ExclusionTag[] {
  if (!isRecord(knipConfig)) return [];
  const raw = knipConfig.tags;
  const entries: string[] = typeof raw === 'string' ? [raw] : [];
  if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === 'string') entries.push(item);
  }

  const tags: ExclusionTag[] = [];
  const seen = new Set<string>();
  for (const entry of entries.flatMap((t) => t.split(','))) {
    if (!entry.trim().startsWith('-')) continue;
    const match = /[a-zA-Z]+/.exec(entry);
    if (match === null) continue;
    const name = match[0];
    if (seen.has(name)) continue;
    seen.add(name);
    tags.push({ name, jsDocTag: `@${name}` });
  }
  return tags;
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
  /** allowlist entries that knip does not flag — a non-failing hygiene warning. */
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
/** Fail-closed: the gate itself cannot verify the surface. */
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
  /**
   * The INVERTED reading: knip run with `--tags +<name>`, which reports only the
   * unreferenced exports/types that carry that tag. This is the exemption's
   * denominator — see the module header.
   */
  readonly runTagCensus: (tagName: string) => KnipRun;
  /** Raw parsed `knip.json`, so the gate reads the live policy rather than a copy. */
  readonly readKnipConfig: () => unknown;
  readonly readAllowlist: () => unknown;
  readonly now: Date;
  readonly log: (message: string) => void;
  readonly errlog: (message: string) => void;
}

/** The evidence that one exclusion tag still exempts something real. */
export interface TagDenominator {
  readonly tag: ExclusionTag;
  /** Unreferenced exports/types carrying the tag — the symbols the rule exempts. */
  readonly exempted: readonly KnipViolation[];
}

/**
 * Take the inverted reading for every exclusion tag `knip.json` declares.
 * Returns a diagnostic string on any fail-closed condition, or the per-tag
 * evidence when every rule is non-vacuous.
 */
function measureDenominators(
  tags: readonly ExclusionTag[],
  runTagCensus: (tagName: string) => KnipRun,
): { readonly denominators: TagDenominator[] } | { readonly failure: string } {
  const denominators: TagDenominator[] = [];
  for (const tag of tags) {
    const run = runTagCensus(tag.name);
    if (!run.found) {
      return {
        failure:
          `[knip-diff] FAIL (tool-missing): knip binary not found at ${run.binPath} while ` +
          `measuring the denominator for \`${tag.jsDocTag}\`. Cannot show the exemption still ` +
          'matches anything — failing closed.',
      };
    }
    let exempted: KnipViolation[];
    try {
      exempted = parseKnipOutput(run.stdout).filter(
        (v) => v.kind === 'export' || v.kind === 'type',
      );
    } catch (err) {
      const detail = messageOf(err);
      return {
        failure:
          `[knip-diff] FAIL (unparseable-output): ${detail}, while measuring the denominator ` +
          `for \`${tag.jsDocTag}\`. knip exited ${run.code}; ` +
          `stderr head=${JSON.stringify(run.stderr.slice(0, 160))}. Failing closed.`,
      };
    }
    if (exempted.length === 0) {
      return {
        failure:
          `[knip-diff] FAIL (vacuous-exemption): knip.json exempts every export tagged ` +
          `\`${tag.jsDocTag}\`, but the inverted reading (\`knip --tags +${tag.name}\`) finds ` +
          'ZERO such symbols. An exemption that matches nothing is not exempting anything — ' +
          'either the tag was renamed or removed from the sources that carried it, or knip ' +
          'resolved no files at all (check `project` / `entry` in knip.json). Both make this ' +
          'sweep vacuous, so it fails closed rather than reporting a clean surface. Remove the ' +
          `\`-${tag.name}\` entry from knip.json if the convention is genuinely gone.`,
      };
    }
    denominators.push({ tag, exempted });
  }
  return { denominators };
}

/**
 * Injectable gate body — no process/FS/child_process access of its own.
 * The remedies for an unallowlisted finding print in the failure output, where an author reads them.
 * A green run also logs each denominator, so a reviewer can see the count move.
 */
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
    deps.errlog(
      `[knip-diff] FAIL (unparseable-output): ${messageOf(err)}. ` +
        `knip exited ${run.code}; stdout head=${JSON.stringify(run.stdout.slice(0, 160))}; ` +
        `stderr head=${JSON.stringify(run.stderr.slice(0, 160))}. Failing closed.`,
    );
    return EXIT_GATE_ERROR;
  }

  let exclusionTags: ExclusionTag[];
  try {
    exclusionTags = readExclusionTags(deps.readKnipConfig());
  } catch (err) {
    deps.errlog(
      `[knip-diff] FAIL (bad-knip-config): could not read knip.json to learn which exemption ` +
        `rules are live: ${messageOf(err)}. Failing closed.`,
    );
    return EXIT_GATE_ERROR;
  }
  if (exclusionTags.length === 0) {
    deps.errlog(
      '[knip-diff] FAIL (no-denominator): knip.json declares no exclusion tags, so this sweep ' +
        'has nothing it can prove it is still measuring. A run that resolves zero files reports ' +
        'zero findings and would otherwise pass clean — the vacuous-gate failure DR-24 exists to ' +
        'prevent. Restore the `tags` entry (e.g. `"tags": ["-proof"]`) in knip.json.',
    );
    return EXIT_GATE_ERROR;
  }
  const measured = measureDenominators(exclusionTags, deps.runTagCensus);
  if ('failure' in measured) {
    deps.errlog(measured.failure);
    return EXIT_GATE_ERROR;
  }

  let allowlist: AllowlistEntry[];
  try {
    allowlist = loadAllowlist(deps.readAllowlist());
  } catch (err) {
    deps.errlog(`[knip-diff] FAIL (bad-allowlist): ${messageOf(err)}`);
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
        'knip-allowlist.json:',
    );
    for (const v of unallowlisted) {
      deps.errlog(`    ${v.kind}  ${v.file} :: ${v.symbol}${v.line ? `:${v.line}` : ''}`);
    }
    deps.errlog('  Three remedies, in order of preference:');
    deps.errlog(
      '    1. DELETE it. An exported symbol nothing references is dead code until shown ' +
        'otherwise — that is the whole claim this gate makes.',
    );
    for (const { tag } of measured.denominators) {
      deps.errlog(
        `    2. If it is a COMPILE-TIME PROOF — an exported \`Expect<…>\` type alias that exists ` +
          `so \`tsc\` checks an invariant the co-located test cannot (\`tsconfig.json\` excludes ` +
          `\`*.test.ts\`, which is what makes the compiler the prover) — add \`${tag.jsDocTag}\` ` +
          `to its JSDoc. knip.json's \`tags: ["-${tag.name}"]\` then exempts it BY RULE, and no ` +
          'allowlist row is needed for it, now or ever.',
      );
    }
    deps.errlog(
      '    3. Otherwise add an entry to tools/audit/knip-allowlist.json with owner, expiry ' +
        'and rationale. Use this for a one-off invisible consumer (a CLI reached by subprocess, ' +
        'a corpus fixture read by path) — never for a recurring convention, which belongs in 2.',
    );
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

  for (const { tag, exempted } of measured.denominators) {
    deps.log(
      `[knip-diff] denominator: \`${tag.jsDocTag}\` exempts ${exempted.length} unreferenced ` +
        `export(s)/type(s) — measured by \`knip --tags +${tag.name}\`, not asserted.`,
    );
  }
  deps.log(
    `[knip-diff] OK: ${violations.length} knip finding(s), all allowlisted and unexpired ` +
      `(${allowlist.length} entr${allowlist.length === 1 ? 'y' : 'ies'} in knip-allowlist.json).`,
  );
  return EXIT_OK;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const ALLOWLIST_PATH = path.join(HERE, 'knip-allowlist.json');
const KNIP_CONFIG_PATH = path.join(REPO_ROOT, 'knip.json');
const DEFAULT_INCLUDE = 'files,dependencies,exports,types';
/**
 * The denominator reading concerns only tagged exports and types. The tag filter of knip
 * does not apply to `files` or `dependencies` findings.
 */
const CENSUS_INCLUDE = 'exports,types';

/** The `--include` value, or the default when the value is missing or empty. */
function parseIncludeArg(argv: readonly string[]): string {
  const i = argv.indexOf('--include');
  if (i < 0) return DEFAULT_INCLUDE;
  const value = argv[i + 1];
  return value !== undefined && value !== '' ? value : DEFAULT_INCLUDE;
}

/**
 * Spawns knip. `EXARCHOS_KNIP_BIN` overrides the binary path, so the self-test can reach the
 * tool-missing, unparseable-output and vacuous-exemption paths without uninstalling knip.
 */
function spawnKnip(args: readonly string[]): KnipRun {
  const binPath = process.env.EXARCHOS_KNIP_BIN ?? path.join(REPO_ROOT, 'node_modules', '.bin', 'knip');
  const res = spawnSync(binPath, [...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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

function defaultRunKnip(include: string): KnipRun {
  return spawnKnip(['--no-progress', '--reporter', 'json', '--include', include]);
}

/**
 * The inverted reading. `--tags +<name>` overrides the `tags` of knip.json and makes knip report
 * only the unreferenced exports that carry the tag. That is the population that the `-<name>`
 * rule exempts.
 */
function defaultRunTagCensus(tagName: string): KnipRun {
  return spawnKnip([
    '--no-progress',
    '--reporter',
    'json',
    '--include',
    CENSUS_INCLUDE,
    '--tags',
    `+${tagName}`,
  ]);
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  const include = parseIncludeArg(process.argv.slice(2));
  const exitCode = runKnipDiff({
    runKnip: () => defaultRunKnip(include),
    runTagCensus: defaultRunTagCensus,
    readKnipConfig: () => JSON.parse(readFileSync(KNIP_CONFIG_PATH, 'utf8')),
    readAllowlist: () => JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')),
    now: new Date(),
    log: (message) => process.stdout.write(`${message}\n`),
    errlog: (message) => process.stderr.write(`${message}\n`),
  });
  process.exit(exitCode);
}
