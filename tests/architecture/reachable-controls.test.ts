/**
 * A control that gates production behavior must be reachable in production.
 *
 * A test can enable a control that nothing under `src/` enables. Then the
 * coverage looks complete, and the shipped path cannot run.
 *
 * The rule is data in `tools/audit/reachable-controls.json`. Thus an exemption
 * is an allowlist entry with an owner and an expiry, and not a code change.
 *
 * The guard reads names, because a dataflow answer needs the whole program. The
 * population is each exported `configureX`, `registerX`, `installX`, `enableX`
 * or `wireX`, and each one must have a use under `src/`. An allowlist entry
 * answers a false positive. A control with an unconventional name is a false
 * negative.
 *
 * A second rule holds the shipped defaults. A settle or acceptance test that turns
 * one off needs a twin case that keeps it, or a recorded reason.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lexModule } from '../../tools/test-helpers/module-lexer.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface Policy {
  readonly enablerNamePatterns: readonly { readonly pattern: string }[];
  readonly scannedRoots: readonly string[];
  readonly callerRoots: readonly string[];
  readonly allowlist: readonly {
    readonly symbol: string;
    readonly file: string;
    readonly why: string;
    readonly owner: string;
    readonly expiry: string;
  }[];
  readonly sourceExtensions: readonly string[];
  readonly killFixture: { readonly path: string; readonly expectedSymbol: string };
  readonly minimumScannedFiles: number;
  readonly minimumEnablersFound: number;
  readonly oracleRoster: {
    readonly entries: readonly {
      readonly symbol: string;
      readonly declaredIn: string;
      readonly chain: readonly { readonly file: string; readonly mustReference: string }[];
      readonly owner: string;
    }[];
    readonly killFixture: { readonly path: string; readonly standsInFor: string };
  };
  readonly shippedDefaultTwins: ShippedDefaultTwinsPolicy;
}

/** One shipped default that a test context can turn off, and the pattern that finds such a context. */
interface ShippedDefault {
  readonly id: string;
  readonly offPattern: string;
}

/** The record of one context that turns a default off: a twin that keeps the default, or a reason. */
interface DefaultContext {
  readonly file: string;
  readonly default: string;
  readonly twin?: { readonly file: string; readonly test: string; readonly keeps: string };
  readonly reason?: string;
  readonly owner?: string;
}

interface ShippedDefaultTwinsPolicy {
  readonly scannedRoots: readonly string[];
  readonly defaults: readonly ShippedDefault[];
  readonly contexts: readonly DefaultContext[];
  readonly minimumScannedFiles: number;
  readonly minimumContexts: number;
  readonly killFixture: { readonly drops: readonly { readonly file: string; readonly default: string }[] };
}

const POLICY: Policy = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'tools/audit/reachable-controls.json'), 'utf8'),
) as Policy;

const ENABLER_NAME = new RegExp(
  POLICY.enablerNamePatterns.map((entry) => `(?:${entry.pattern})`).join('|'),
);

interface Enabler {
  readonly symbol: string;
  readonly file: string;
}

/**
 * Each exported enabler that one file declares. The scan reads the lexed
 * source, so a name in a comment or a string is not a declaration.
 */
function findEnablers(relativePath: string, source: string): Enabler[] {
  const { maskedSource } = lexModule(source, path.basename(relativePath));
  const declarations = maskedSource.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g,
  );
  const found: Enabler[] = [];
  for (const match of declarations) {
    const symbol = match[1];
    if (symbol !== undefined && ENABLER_NAME.test(symbol)) {
      found.push({ symbol, file: relativePath });
    }
  }
  return found;
}

async function sourceFiles(roots: readonly string[]): Promise<string[]> {
  return listTrackedFiles(REPO_ROOT, {
    extensions: POLICY.sourceExtensions,
    exclude: (relative) =>
      !roots.some((root) => relative.startsWith(`${root}/`)) || relative.endsWith('.d.ts'),
  });
}

/**
 * The executable source of each file in the caller roots, read one time. The
 * reachability check runs for each symbol, and a new lex of the tree for each
 * symbol takes seconds.
 */
const CALLER_BODIES: ReadonlyMap<string, string> = new Map(
  (await sourceFiles(POLICY.callerRoots)).map((file) => [file, executableSource(file)]),
);

/**
 * The lexed source of one file without its import and re-export statements. A
 * file that names a symbol in `import { x } from` or `export { x } from` routes
 * the symbol and does not use it. Thus a barrel that re-exports a dead control
 * does not make it reachable.
 */
function executableSource(relativePath: string): string {
  return executableSourceOf(readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'), relativePath);
}

function executableSourceOf(source: string, relativePath: string): string {
  const { maskedSource } = lexModule(source, path.basename(relativePath));
  return maskedSource
    .replace(/import\s[\s\S]*?from\s*['"][^'"]*['"]\s*;?/g, '')
    .replace(/export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]*['"])?\s*;?/g, '');
}

/**
 * True when the shipped tree uses `symbol` outside its own declaration.
 *
 * The check is for a reference and not a call. Production wiring often passes
 * an enabler as a value: as a default, or in a probe array. The declaring file
 * also counts, because a control that its own file invokes is reachable. The
 * check removes only the declaration itself from that file.
 */
function hasProductionUse(symbol: string, declaredIn: string): boolean {
  const reference = new RegExp(`\\b${symbol}\\b`);
  const declaration = new RegExp(`export\\s+(?:async\\s+)?function\\s+${symbol}\\b`, 'g');
  for (const [file, source] of CALLER_BODIES) {
    const body = file === declaredIn ? source.replace(declaration, '') : source;
    if (reference.test(body)) return true;
  }
  return false;
}

function isAllowlisted(enabler: Enabler): boolean {
  return POLICY.allowlist.some(
    (entry) => entry.symbol === enabler.symbol && entry.file === enabler.file,
  );
}

describe('reachable controls', () => {
  /**
   * The first two assertions are denominators. An empty walk makes the last
   * assertion vacuously true, and a pattern set that matches nothing enforces
   * nothing.
   */
  it('ReachableControls_NoEnabler_IsCalledOnlyFromTests', async () => {
    const files = await sourceFiles(POLICY.scannedRoots);

    expect(
      files.length,
      'the guard scanned an implausibly small population — the walk is broken, not the code',
    ).toBeGreaterThanOrEqual(POLICY.minimumScannedFiles);

    const enablers = files.flatMap((file) =>
      findEnablers(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );

    expect(
      enablers.length,
      'no enabler matched any name pattern — the patterns are stale, not the tree',
    ).toBeGreaterThanOrEqual(POLICY.minimumEnablersFound);

    const dark = enablers
      .filter((enabler) => !isAllowlisted(enabler))
      .filter((enabler) => !hasProductionUse(enabler.symbol, enabler.file));

    expect(
      dark,
      'these controls gate production behaviour but nothing in the shipped composition ' +
        'enables them, so the paths they guard cannot run. Call them from the composition ' +
        'root, remove them, or add an allowlist entry with a reason, an owner and an expiry.',
    ).toEqual([]);
  });

  /**
   * The self-test. The function that scans the source tree must find the
   * fixture control. The control must also be dark: nothing in the shipped tree
   * uses it.
   */
  it('ReachableControls_KillFixture_IsReportedByTheSameScanner', () => {
    const fixture = readFileSync(path.join(REPO_ROOT, POLICY.killFixture.path), 'utf8');
    const reported = findEnablers(POLICY.killFixture.path, fixture);

    expect(
      reported.map((enabler) => enabler.symbol),
      'the kill fixture is the evidence that this guard detects the real defect shape',
    ).toContain(POLICY.killFixture.expectedSymbol);

    expect(
      hasProductionUse(POLICY.killFixture.expectedSymbol, POLICY.killFixture.path),
      'the fixture symbol is used in the shipped tree, so it no longer demonstrates the defect',
    ).toBe(false);
  });

  it('ReachableControls_AllowlistEntries_CarryAReasonOwnerAndUnexpiredDate', () => {
    for (const entry of POLICY.allowlist) {
      expect(entry.why, `${entry.symbol} records no reason`).toBeTruthy();
      expect(entry.owner, `${entry.symbol} has no owner`).toBeTruthy();
      expect(entry.expiry, `${entry.symbol} has no expiry`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        Date.parse(entry.expiry),
        `the allowlist entry for ${entry.symbol} expired on ${entry.expiry}`,
      ).toBeGreaterThan(Date.now());
    }
  });
});

/** True when the lexed source of the file declares a method `symbol(` in a class body. */
function declaresMethod(relativePath: string, symbol: string): boolean {
  const { maskedSource } = lexModule(
    readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    path.basename(relativePath),
  );
  return new RegExp(`(?:^|\\n)\\s+(?:async\\s+)?${symbol}\\s*(?:<[^>]*>)?\\s*\\(`).test(maskedSource);
}

/** The hops of a chain whose executable source does not reference the required symbol. */
function brokenHops(
  chain: readonly { readonly file: string; readonly mustReference: string }[],
  sourceOf: (file: string) => string,
): readonly { readonly file: string; readonly mustReference: string }[] {
  return chain.filter((hop) => {
    const escaped = hop.mustReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`\\b${escaped}\\b`).test(sourceOf(hop.file));
  });
}

/**
 * The enabler rule reads names, and an oracle has no enabler name. An oracle is
 * also often a class method, which the enabler extractor does not read. Thus a
 * method that returns a verdict can exist for its own tests only, and nothing
 * in the shipped composition enforces its property. For each oracle, the roster
 * in the policy file declares the call chain from the method to the roster that
 * the composition root iterates. The test checks each hop.
 */
describe('reachable oracles', () => {
  it('ReachableOracles_EveryRosteredOracle_IsCalledThroughItsDeclaredChain', () => {
    expect(POLICY.oracleRoster.entries.length, 'the roster is empty and enforces nothing').toBeGreaterThan(0);
    for (const entry of POLICY.oracleRoster.entries) {
      expect(
        declaresMethod(entry.declaredIn, entry.symbol),
        `${entry.symbol} is not declared as a method in ${entry.declaredIn} — the roster names something that does not exist`,
      ).toBe(true);
      expect(entry.chain.length, `${entry.symbol} declares no chain`).toBeGreaterThan(0);
      expect(entry.owner, `${entry.symbol} has no owner`).toBeTruthy();
      expect(
        brokenHops(entry.chain, executableSource),
        `${entry.symbol} is not reachable through its declared chain: the listed hop(s) do not ` +
          'reference what the previous hop provides, so the verdict is computed for nobody',
      ).toEqual([]);
    }
  });

  /**
   * The self-test. The fixture stands in for one hop of a rostered chain, and
   * the scanner must report the chain as broken at that hop only.
   */
  it('ReachableOracles_KillFixture_IsReportedAsABrokenChain', () => {
    const { killFixture, entries } = POLICY.oracleRoster;
    const fixture = readFileSync(path.join(REPO_ROOT, killFixture.path), 'utf8');
    const entry = entries.find((candidate) =>
      candidate.chain.some((hop) => hop.file === killFixture.standsInFor),
    );
    expect(entry, 'the kill fixture stands in for a file no rostered chain passes through').toBeDefined();
    if (entry === undefined) return;

    const sourceOf = (file: string): string =>
      file === killFixture.standsInFor ? executableSourceOf(fixture, file) : executableSource(file);
    expect(brokenHops(entry.chain, sourceOf).map((hop) => hop.file)).toEqual([killFixture.standsInFor]);
  });
});

/** The key of a context: the test file and the id of the default that it turns off. */
function contextKey(file: string, defaultId: string): string {
  return `${file} :: ${defaultId}`;
}

/** The source of a tracked file with its comments blanked, or undefined when the file does not exist. */
function commentlessSource(relativePath: string): string | undefined {
  const absolute = path.join(REPO_ROOT, relativePath);
  if (!existsSync(absolute)) return undefined;
  return lexModule(readFileSync(absolute, 'utf8'), path.basename(relativePath)).commentMaskedSource;
}

/** Each scanned test file, and the key of each context in it that turns a shipped default off. */
async function contextsThatTurnADefaultOff(): Promise<{ readonly scanned: number; readonly keys: readonly string[] }> {
  const { scannedRoots, defaults } = POLICY.shippedDefaultTwins;
  const files = await listTrackedFiles(REPO_ROOT, {
    extensions: ['.ts'],
    exclude: (relative) =>
      !scannedRoots.some((root) => relative.startsWith(`${root}/`)) || !relative.endsWith('.test.ts'),
  });
  const keys: string[] = [];
  for (const file of files) {
    const source = commentlessSource(file) ?? '';
    for (const shipped of defaults) {
      if (new RegExp(shipped.offPattern).test(source)) keys.push(contextKey(file, shipped.id));
    }
  }
  return { scanned: files.length, keys };
}

/**
 * The body of one case of a test file, from its declaration to the next case or the end of its
 * block. It is undefined when the file declares no case with that name.
 */
function caseBody(source: string, test: string): string | undefined {
  const escaped = test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`\\bit\\(\\s*['"\`]${escaped}['"\`]`).exec(source);
  if (declaration === null) return undefined;
  const rest = source.slice(declaration.index + declaration[0].length);
  const end = /\n\s*it(?:\.each)?\(|\n\}\);/.exec(rest);
  return rest.slice(0, end === null ? rest.length : end.index);
}

/** The fault of one record, or undefined when the record accounts for its context. */
function recordFault(record: DefaultContext): string | undefined {
  if (record.twin === undefined) {
    return record.reason !== undefined && record.reason.length > 0 && record.owner !== undefined && record.owner.length > 0
      ? undefined
      : 'it names no twin and no reason with an owner';
  }
  const source = commentlessSource(record.twin.file);
  if (source === undefined) return `its twin file ${record.twin.file} does not exist`;
  const body = caseBody(source, record.twin.test);
  if (body === undefined) return `${record.twin.file} declares no case ${record.twin.test}`;
  if (!body.includes(record.twin.keeps)) return `the twin case does not hold ${JSON.stringify(record.twin.keeps)}`;
  return undefined;
}

/**
 * The faults of a set of records against the contexts that the scan found. A context needs exactly
 * one record, and the record must account for it. A record for a context that the scan did not find
 * is stale.
 */
function twinFaults(records: readonly DefaultContext[], found: readonly string[]): string[] {
  const byKey = new Map<string, DefaultContext[]>();
  for (const record of records) {
    const key = contextKey(record.file, record.default);
    byKey.set(key, [...(byKey.get(key) ?? []), record]);
  }
  const faults: string[] = [];
  for (const key of found) {
    const matching = byKey.get(key) ?? [];
    const [only] = matching;
    if (matching.length !== 1 || only === undefined) {
      faults.push(`${key}: ${matching.length} records, and the rule needs exactly one`);
      continue;
    }
    const fault = recordFault(only);
    if (fault !== undefined) faults.push(`${key}: ${fault}`);
  }
  for (const key of byKey.keys()) {
    if (!found.includes(key)) faults.push(`${key}: a stale record, because the file does not turn the default off`);
  }
  return faults;
}

/**
 * A test that turns a shipped default off proves a composition that the product does not ship.
 * The policy records, for each such test file, a twin case that keeps the default or a reason.
 */
describe('shipped defaults kept by a twin', () => {
  /**
   * The first assertions are denominators. An empty walk or a stale pattern finds no context, and
   * then the last assertion is true for nothing.
   */
  it('ShippedDefaultTwins_EachContextThatTurnsADefaultOff_HasATwinOrAReason', async () => {
    const policy = POLICY.shippedDefaultTwins;
    const { scanned, keys } = await contextsThatTurnADefaultOff();
    expect(scanned, 'the scan read too few test files, so the walk is broken').toBeGreaterThanOrEqual(
      policy.minimumScannedFiles,
    );
    expect(keys.length, 'the patterns found too few contexts, so a pattern is stale').toBeGreaterThanOrEqual(
      policy.minimumContexts,
    );
    for (const shipped of policy.defaults) {
      expect(keys.some((key) => key.endsWith(` :: ${shipped.id}`)), `no context turns ${shipped.id} off`).toBe(true);
    }
    expect(
      twinFaults(policy.contexts, keys),
      'each context that turns a shipped default off needs a twin case that keeps it, or a reason ' +
        'with an owner in tools/audit/reachable-controls.json',
    ).toEqual([]);
  });

  /**
   * The self-test. Without the record of a twin, or without the record of a reason, the checker
   * must report the context. A twin that names a case the file does not declare is a fault too.
   */
  it('ShippedDefaultTwins_KillFixture_ARecordDroppedOrATwinMissing_IsReported', async () => {
    const policy = POLICY.shippedDefaultTwins;
    const { keys } = await contextsThatTurnADefaultOff();
    expect(policy.killFixture.drops.length).toBeGreaterThan(0);
    for (const drop of policy.killFixture.drops) {
      const key = contextKey(drop.file, drop.default);
      expect(keys, `the scan does not find ${key}`).toContain(key);
      const kept = policy.contexts.filter((record) => contextKey(record.file, record.default) !== key);
      expect(kept).toHaveLength(policy.contexts.length - 1);
      expect(twinFaults(kept, keys)).toEqual([`${key}: 0 records, and the rule needs exactly one`]);
    }
    const missingTwin = policy.contexts.map((record) =>
      record.twin === undefined ? record : { ...record, twin: { ...record.twin, test: 'NoSuchCase_IsDeclared' } },
    );
    expect(twinFaults(missingTwin, keys).length).toBe(policy.contexts.filter((record) => record.twin !== undefined).length);
  });
});
