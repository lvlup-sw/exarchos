import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  extractCliSurface,
  findVocabViolations,
  findLiveCliViolations,
  type CliSurface,
} from './cli-vocab-guard.js';
import {
  GOVERNED_SOURCES,
  REPO_ROOT,
  scanSourceForCommandSites,
  findDerivationViolations,
  readAllowlist,
} from './cli-derivation-guard.js';
import { getFullRegistry } from '../../src/registry.js';

// ─── Synthetic-surface helpers ────────────────────────────────────────────────
//
// The guard's detection logic is pure over a `CliSurface`. We drive it directly
// with planted surfaces so the FAIL path is exercised without mutating the real
// registry, and we also build a small Commander program to prove `extractCliSurface`
// walks names, aliases, and flags the way `buildCli` produces them.

function surface(
  verbs: { path: string; token: string }[],
  flags: { path: string; token: string }[] = [],
): CliSurface {
  return { verbs, flags };
}

describe('cli-vocab-guard: findVocabViolations (FAIL path)', () => {
  it('flags a banned verb alias (`info`) with its canonical replacement', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf info', token: 'info' }]),
      new Set(), // no exceptions — prove the ban bites
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'verb',
      token: 'info',
      path: 'exarchos wf info',
      canonical: 'get',
    });
  });

  it('flags a banned verb alias (`ls`) when not excepted', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos something ls', token: 'ls' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.token).toBe('ls');
    expect(violations[0]?.canonical).toBe('list');
  });

  it('flags a banned destructive verb alias (`rm`)', () => {
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf rm', token: 'rm' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('verb');
    expect(violations[0]?.token).toBe('rm');
  });

  it('flags a banned flag alias (`--format` as a JSON carrier) when not excepted', () => {
    const violations = findVocabViolations(
      surface([], [{ path: 'exarchos wf get --format', token: '--format' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      kind: 'flag',
      token: '--format',
      canonical: '--json',
    });
  });

  it('flags a banned confirmation-bypass flag (`--skip-confirmations`)', () => {
    const violations = findVocabViolations(
      surface([], [{ path: 'exarchos wf cancel --skip-confirmations', token: '--skip-confirmations' }]),
      new Set(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.canonical).toBe('--force');
  });

  it('reports every violation when several banned tokens are present', () => {
    const violations = findVocabViolations(
      surface(
        [
          { path: 'exarchos wf info', token: 'info' },
          { path: 'exarchos vw ls', token: 'ls' },
        ],
        [{ path: 'exarchos doctor --format', token: '--format' }],
      ),
      new Set(),
    );
    expect(violations).toHaveLength(3);
  });
});

describe('cli-vocab-guard: findVocabViolations (PASS path)', () => {
  it('passes a surface using only canonical vocabulary', () => {
    const violations = findVocabViolations(
      surface(
        [
          { path: 'exarchos wf get', token: 'get' },
          { path: 'exarchos vw list', token: 'list' },
          { path: 'exarchos wf list_prs', token: 'list_prs' },
        ],
        [
          { path: 'exarchos wf get --json', token: '--json' },
          { path: 'exarchos wf cancel --force', token: '--force' },
          // `--skip-tests` is a build-step skip, NOT a confirmation bypass — must not trip.
          { path: 'exarchos orch create_pr --skip-tests', token: '--skip-tests' },
        ],
      ),
      new Set(),
    );
    expect(violations).toEqual([]);
  });

  it('honors KNOWN_EXCEPTIONS keyed by exact command path + token', () => {
    const exceptions = new Set(['exarchos vw ls::ls']);
    const violations = findVocabViolations(
      surface([{ path: 'exarchos vw ls', token: 'ls' }]),
      exceptions,
    );
    expect(violations).toEqual([]);
  });

  it('exception is surgical: same banned token on a DIFFERENT path still fails', () => {
    const exceptions = new Set(['exarchos vw ls::ls']);
    const violations = findVocabViolations(
      surface([{ path: 'exarchos wf ls', token: 'ls' }]),
      exceptions,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('exarchos wf ls');
  });
});

describe('cli-vocab-guard: extractCliSurface', () => {
  it('walks command names, aliases, and long flags (skipping the program root)', () => {
    const program = new Command('exarchos');
    const wf = program.command('workflow').alias('wf');
    wf.command('get').option('--json', 'Output raw JSON').option('--feature-id <value>', 'id');
    const view = program.command('view').alias('vw');
    view.command('pipeline').alias('ls');

    const { verbs, flags } = extractCliSurface(program);
    const verbTokens = verbs.map((v) => v.token);

    // Program root `exarchos` is not a verb.
    expect(verbTokens).not.toContain('exarchos');
    // Names and aliases both appear.
    expect(verbTokens).toEqual(expect.arrayContaining(['workflow', 'wf', 'get', 'view', 'vw', 'pipeline', 'ls']));
    // Flags carry their declaring command path.
    expect(flags).toEqual(
      expect.arrayContaining([
        { path: 'exarchos workflow get', token: '--json' },
        { path: 'exarchos workflow get', token: '--feature-id' },
      ]),
    );
  });
});

describe('cli-vocab-guard: live CLI surface', () => {
  // This is the contract the guard protects: the real rendered surface must use
  // canonical vocabulary (modulo tracked KNOWN_EXCEPTIONS). If anyone introduces
  // a NEW banned verb/flag, this assertion goes red — which is exactly the
  // regression `cli:vocab-guard` exists to catch in CI.
  it('the current rendered CLI surface has no un-excepted vocabulary violations', () => {
    const violations = findLiveCliViolations();
    expect(violations).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DR-5 / G1 SELF-TEST (task 022) — the guard measures DERIVATION, not VOCABULARY
// ════════════════════════════════════════════════════════════════════════════
//
// This suite lives beside `cli-vocab-guard` deliberately: the gap being closed
// is THIS guard's. `cli-vocab-guard` walks the rendered Commander surface and
// asks what each token IS. That question cannot distinguish a command whose name
// was baked into the composition root by hand from one the registry supplied,
// because the rendered tree records no provenance — `.command('wait')` and
// `.command(commandName)` produce byte-identical nodes.
//
// So the self-test builds a hand-written command whose vocabulary is ENTIRELY
// CLEAN and shows the two guards disagree about it:
//
//   - its NAME is a registry declaration (`cli.topLevel`), read out of the live
//     registry rather than invented here;
//   - its FLAGS are the canonical tokens `cli-vocab-guard` itself prescribes,
//     read out of the guard's own output rather than transcribed;
//   - `cli-vocab-guard` passes it with ZERO exceptions granted;
//   - `cli-derivation-guard` REJECTS it, because it is hand-written.
//
// A guard that passed this command would be measuring vocabulary — the defect
// this wave has now recorded seven times. The assertions below are written so
// that any name-based, token-based or tree-based reformulation of the derivation
// predicate turns this suite red.

/**
 * The seeded command's NAME. Written down here by hand — the second authority.
 * The registry is the first; the two are asserted to agree below, so a rename in
 * either place is a disagreement rather than a silent drift.
 */
const SELF_TEST_COMMAND_NAME = 'wait';

/** Top-level command names the registry DECLARES (`cli.topLevel` promotions). */
function registryDeclaredTopLevelNames(): readonly string[] {
  const names: string[] = [];
  for (const tool of getFullRegistry()) {
    for (const action of tool.actions) {
      const topLevel = action.cli?.topLevel;
      if (typeof topLevel === 'string') names.push(topLevel);
    }
  }
  return names;
}

/**
 * The canonical token `cli-vocab-guard` prescribes in place of `bannedToken`,
 * read from the guard's own verdict. Derived, not transcribed: if the policy
 * renames a canonical form, the fixture follows it instead of going stale.
 */
function canonicalReplacementFor(bannedToken: string): string {
  const [violation] = findVocabViolations(
    surface([], [{ path: 'exarchos probe', token: bannedToken }]),
    new Set(),
  );
  if (violation === undefined) {
    throw new Error(
      `\`${bannedToken}\` is no longer a banned flag, so no canonical replacement can be ` +
        'read from the policy. The vocabulary policy moved; update this fixture.',
    );
  }
  return violation.canonical;
}

function governedSourceRelPath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return rel;
}

describe('G1 self-test: a clean-vocabulary hand-written command still fails (DR-5)', () => {
  it('CliDerivationGuard_CleanVocabularyHandWrittenCommand_IsStillRejected', () => {
    // ── 1. The name is a genuine registry declaration ────────────────────────
    // Not a plausible-looking invention: `cli.ts` already registers this exact
    // name through the DR-7 hoist loop, i.e. through `.command(commandName)` —
    // a derived site. Anything asserted below is therefore about a name the
    // registry owns.
    const declaredTopLevel = registryDeclaredTopLevelNames();
    expect(declaredTopLevel.length).toBeGreaterThan(0);
    expect(declaredTopLevel).toContain(SELF_TEST_COMMAND_NAME);

    // ── 2. The flags are the vocabulary policy's own canonical tokens ────────
    const jsonFlag = canonicalReplacementFor('--format');
    const forceFlag = canonicalReplacementFor('--skip-confirmations');
    expect(jsonFlag).toBe('--json');
    expect(forceFlag).toBe('--force');

    // ── 3. `cli-vocab-guard` PASSES the hand-written command ─────────────────
    // Run for real over a rendered Commander tree, with an EMPTY exception set
    // so nothing is excused. This is the "vocabulary is entirely clean" claim,
    // established by the vocabulary guard itself rather than asserted in prose.
    const handWritten = new Command('exarchos');
    handWritten
      .command(SELF_TEST_COMMAND_NAME)
      .option(jsonFlag, 'Output raw JSON')
      .option(forceFlag, 'Bypass the confirmation guard');
    expect(findVocabViolations(extractCliSurface(handWritten), new Set())).toEqual([]);

    // ── 4. The rendered tree cannot tell the two apart ───────────────────────
    // Build the SAME command from a name sourced out of the registry. The
    // surfaces are identical, which is precisely why a tree-walking guard can
    // never see this defect and why the derivation guard is source-level.
    const nameFromRegistry = declaredTopLevel.find((n) => n === SELF_TEST_COMMAND_NAME);
    if (nameFromRegistry === undefined) throw new Error('unreachable: membership asserted above');
    const derivedTwin = new Command('exarchos');
    derivedTwin
      .command(nameFromRegistry)
      .option(jsonFlag, 'Output raw JSON')
      .option(forceFlag, 'Bypass the confirmation guard');
    expect(extractCliSurface(handWritten)).toEqual(extractCliSurface(derivedTwin));

    // ── 5. `cli-derivation-guard` REJECTS it ─────────────────────────────────
    // Seeded into the LIVE composition root's source, so the subject is the real
    // `cli.ts` with one hand-written command added — not a synthetic file.
    const rel = governedSourceRelPath();
    const cliSource = readFileSync(path.join(REPO_ROOT, rel), 'utf8');

    const baseline = scanSourceForCommandSites(cliSource, rel);
    // EVERY count here is DERIVED, never written down. The history of this block
    // is the history of that lesson: task 022 pinned the literals at 11 with an
    // empty allowlist; task 023 populated it and the VIOLATION count became 1;
    // task 076 deleted the `merge-orchestrate` literal and the LITERAL count
    // became 10 while violations became 0. Three correct changes, and each one
    // would have broken a hard-coded number here. The claim this test makes is
    // not any magnitude — it is that seeding a hand-written command MOVES the
    // count by exactly one. So the baseline is measured, and every assertion
    // below is relative to it.
    expect(baseline.literals.length).toBeGreaterThan(0);
    expect(baseline.derived.length).toBeGreaterThan(0);
    expect(baseline.indeterminate).toHaveLength(0);

    const baselineViolations = findDerivationViolations(baseline, readAllowlist());
    // Zero as of task 076: the live tree is clean, which is why G1 could finally
    // be wired blocking. Not asserted as `> 0` — that would demand the tree stay
    // dirty. The delta below is what carries the claim.
    expect(baselineViolations.map((v) => v.name)).not.toContain(SELF_TEST_COMMAND_NAME);

    const handWrittenCall = `.command('${SELF_TEST_COMMAND_NAME}')`;
    const seeded =
      `${cliSource}\n` +
      `const __g1CleanVocabularySelfTest = program\n` +
      `  ${handWrittenCall}\n` +
      `  .option('${jsonFlag}', 'Output raw JSON')\n` +
      `  .option('${forceFlag}', 'Bypass the confirmation guard');\n`;

    const seededScan = scanSourceForCommandSites(seeded, rel);
    expect(seededScan.literals).toHaveLength(baseline.literals.length + 1);
    expect(seededScan.derived).toHaveLength(baseline.derived.length);

    const seededViolations = findDerivationViolations(seededScan, readAllowlist());
    expect(seededViolations).toHaveLength(baselineViolations.length + 1);
    const reported = seededViolations.filter((v) => v.name === SELF_TEST_COMMAND_NAME);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.kind).toBe('literal');
    expect(reported[0]?.detail).toContain('bakes the command name into the composition');

    // ── 6. THE DECISIVE ASSERTION ────────────────────────────────────────────
    // Rewrite ONLY the seeded call's argument — string literal to identifier —
    // and the verdict flips back to clean. Same command, same name, same flags,
    // same file, same position; the single differing fact is HOW the name
    // arrives. A guard keyed on the name, the token, or the rendered node cannot
    // produce these two answers, so this is the assertion that fails if the
    // derivation predicate is ever reformulated as a vocabulary check.
    expect(seeded.split(handWrittenCall)).toHaveLength(2); // exactly one occurrence
    const derivedVariant = seeded.replace(handWrittenCall, '.command(topLevelName)');
    expect(derivedVariant).not.toBe(seeded);

    const derivedScan = scanSourceForCommandSites(derivedVariant, rel);
    // The rewrite moves exactly ONE site from `literal` to `derived` and changes
    // nothing else — stated relative to the seeded scan, not as transcribed
    // totals, for the same reason as every other count in this block.
    expect(derivedScan.sites).toHaveLength(seededScan.sites.length);
    expect(derivedScan.literals).toHaveLength(seededScan.literals.length - 1);
    expect(derivedScan.derived).toHaveLength(seededScan.derived.length + 1);
    const derivedViolations = findDerivationViolations(derivedScan, readAllowlist());
    expect(derivedViolations).toHaveLength(baselineViolations.length);
    expect(derivedViolations.map((v) => v.name)).not.toContain(SELF_TEST_COMMAND_NAME);

    // ── 7. And the vocabulary guard is unmoved by that same rewrite ──────────
    // It reported nothing before and reports nothing after, because the fact
    // that changed is invisible to it. The two guards measure different things,
    // which is the whole content of DR-5's self-test criterion.
    expect(findVocabViolations(extractCliSurface(handWritten), new Set())).toEqual([]);
    expect(findVocabViolations(extractCliSurface(derivedTwin), new Set())).toEqual([]);
  });
});
