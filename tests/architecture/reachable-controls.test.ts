/**
 * A control that gates production behaviour must be reachable in production.
 *
 * `configureWorkflowMaterializer` set the value that decided whether
 * `workflow get` folded the event log or read the state file. Four test files
 * called it. Nothing in `src/` did. So the fold branch was dark in every
 * shipped composition — `get` always took the file, and `get --asOf` answered
 * with tip state rather than the bounded fold it advertises.
 *
 * Nothing was red, and that is the part worth guarding. The dark branches had
 * tests; the tests enabled the branch themselves, which is exactly what made
 * the coverage look complete while the shipped path was unreachable. It
 * surfaced only when a regression test for a fix inside one of those branches
 * passed with the fix removed.
 *
 * The rule is DATA (`tools/audit/reachable-controls.json`). This file decides
 * only how it is enforced, so an exemption is reviewable as an allowlist entry
 * with an owner and an expiry rather than as a code change.
 *
 * ## Why this is name-based, and why that is enough
 *
 * Deciding "does any production branch read what this sets" needs whole-program
 * dataflow. Deciding "is this named as an enabler" needs a convention, and this
 * repository already follows one. The population is every exported
 * `configureX` / `registerX` / `installX` / `enableX` / `wireX`; the assertion
 * is that each has a caller under `src/`. A false positive is a naming
 * question, answered by an allowlist entry; a false negative is a control named
 * unconventionally, which is a separate and more visible problem.
 */
import { readFileSync } from 'node:fs';
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
 * Every exported enabler declared in one file.
 *
 * Reads the LEXED source so a name inside a comment or a string — this file and
 * the policy both discuss `configureWorkflowMaterializer` by name — is not
 * mistaken for a declaration.
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

function sourceFiles(roots: readonly string[]): string[] {
  return listTrackedFiles(REPO_ROOT, {
    extensions: POLICY.sourceExtensions,
    exclude: (relative) =>
      !roots.some((root) => relative.startsWith(`${root}/`)) || relative.endsWith('.d.ts'),
  });
}

/**
 * Every caller-root file's executable source, read once.
 *
 * The reachability question is asked per symbol, and re-lexing the tree for
 * each one turned an architecture test into an eight-second one. The bodies do
 * not change during a run.
 */
const CALLER_BODIES: ReadonlyMap<string, string> = new Map(
  sourceFiles(POLICY.callerRoots).map((file) => [file, executableSource(file)]),
);

/**
 * The source of one file with its import and re-export statements removed.
 *
 * A symbol named in `import { x } from` or `export { x } from` is being routed,
 * not used: a barrel that re-exports a dead control does not make it reachable.
 * The motivating case was re-exported from `workflow/tools.ts` while nothing
 * called it, so counting those lines would have missed the very defect this
 * guard exists for.
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
 * True when `symbol` is USED anywhere in the shipped tree, its own declaration
 * excluded.
 *
 * Reference, not call. An enabler is frequently handed over rather than
 * invoked — `opts.registerMcp ?? registerExarchosInClaudeJson` passes one as a
 * default, and the doctor lists `installFreshness` in a probe array. Both are
 * production wiring, and a call-shaped detector reports both as dark. The
 * declaring file counts too: a control invoked beside its own definition is
 * reachable, and excluding that file wholesale — to avoid matching the
 * declaration — flagged `registerBackendCleanup`, which `src/index.ts` calls
 * eleven lines later.
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
  it('ReachableControls_NoEnabler_IsCalledOnlyFromTests', () => {
    const files = sourceFiles(POLICY.scannedRoots);

    // (1) Denominator. An empty walk makes the assertion below vacuously true,
    // which is precisely how this guard would fail open.
    expect(
      files.length,
      'the guard scanned an implausibly small population — the walk is broken, not the code',
    ).toBeGreaterThanOrEqual(POLICY.minimumScannedFiles);

    const enablers = files.flatMap((file) =>
      findEnablers(file, readFileSync(path.join(REPO_ROOT, file), 'utf8')),
    );

    // (2) The population itself must be non-empty. A pattern set that matches
    // nothing would pass this test forever while enforcing nothing.
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

  it('ReachableControls_KillFixture_IsReportedByTheSameScanner', () => {
    // The self-test. The control that motivated this guard, verbatim, run
    // through the SAME function that reads the source tree. A scanner that has
    // gone blind fails here rather than going quiet.
    const fixture = readFileSync(path.join(REPO_ROOT, POLICY.killFixture.path), 'utf8');
    const reported = findEnablers(POLICY.killFixture.path, fixture);

    expect(
      reported.map((enabler) => enabler.symbol),
      'the kill fixture is the evidence that this guard detects the real defect shape',
    ).toContain(POLICY.killFixture.expectedSymbol);

    // …and it must be reported as DARK, not merely found: nothing in `src/`
    // calls it, which is the condition the guard exists to catch.
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

// ─── Oracles: a verdict nobody asks for enforces nothing ─────────────────────
//
// The enabler rule reads NAMES, and an oracle is not named as an enabler; it
// is also usually a class method, which the enabler extractor does not read.
// So a method that walks durable state and returns a verdict can exist for its
// own tests alone while the property it checks is enforced nowhere in the
// shipped composition — which is how the run-bundle integrity sweep sat dormant
// for a week with every settled stream in violation. The roster below is DATA
// in the same policy file: each oracle declares the call chain from its method
// to the roster the composition root iterates, and every hop is checked.

/** A method declaration `name(` in a class body, on the lexed source. */
function declaresMethod(relativePath: string, symbol: string): boolean {
  const { maskedSource } = lexModule(
    readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    path.basename(relativePath),
  );
  return new RegExp(`(?:^|\\n)\\s+(?:async\\s+)?${symbol}\\s*(?:<[^>]*>)?\\s*\\(`).test(maskedSource);
}

/** The hops of a chain whose executable source does NOT reference what it must. */
function brokenHops(
  chain: readonly { readonly file: string; readonly mustReference: string }[],
  sourceOf: (file: string) => string,
): readonly { readonly file: string; readonly mustReference: string }[] {
  return chain.filter((hop) => {
    const escaped = hop.mustReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`\\b${escaped}\\b`).test(sourceOf(hop.file));
  });
}

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

  it('ReachableOracles_KillFixture_IsReportedAsABrokenChain', () => {
    // The self-test. The probe factory as it stood while the oracle was
    // dormant stands in for the real first hop; the scanner must report the
    // chain broken there. A scanner that passes this text has gone blind.
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
