// DR-5 / G1 — the source-level CLI derivation guard, and its two self-tests.
//
// @oracle-sources: ../src/adapters/cli.ts, the task-020 specification's hand-enumerated kill-fixture list of 11 literal command names
//
// The two authorities are genuinely independent: one is the live composition
// root parsed by the guard, the other is a human enumeration written down in the
// specification and transcribed into `EXPECTED_HAND_WRITTEN_LITERALS` below. If
// the parser drifts (a broken matcher, a renamed file, a changed registration
// idiom) the two disagree and this suite reddens. A guard that compared the
// parse against itself could never disagree with itself.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  GOVERNED_SOURCES,
  REPO_ROOT,
  ALLOWLIST_PATH,
  KILL_FIXTURE_COMMANDS,
  scanGovernedSources,
  scanSourceForCommandSites,
  findDerivationViolations,
  readAllowlist,
  extractPolicyFileReferences,
  findPolicyReferenceProblems,
} from './cli-derivation-guard.js';

/**
 * The module this policy data points at. Written out here as a SECOND authority:
 * the guard derives nothing from this constant, so if the module is renamed and
 * only one of the two is updated, the suite disagrees with the tree.
 */
const GUARD_MODULE_PATH = 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts';

/** The pre-rename path that actually shipped inside the policy `$comment`. */
const RENAMED_AWAY_MODULE_PATH = 'servers/exarchos-mcp/scripts/cli-derivation-seam.ts';

/**
 * Write a policy file into a throwaway tree.
 *
 * The default `$comment` names a file that RESOLVES inside that tree, because
 * the reader now refuses a policy file whose prose points at something that is
 * not there (task 022). Fixtures that are about the ENTRY rules therefore have
 * to be valid on the reference rules, and vice versa — which is the point: the
 * two rejections are independent.
 */
function seedAllowlist(
  root: string,
  allowed: readonly string[],
  comment?: readonly string[],
): void {
  const abs = path.join(root, ALLOWLIST_PATH);
  mkdirSync(path.dirname(abs), { recursive: true });
  // The guard module lives in the same directory as its policy data; a stub is
  // enough because only the reference's EXISTENCE is under test.
  writeFileSync(path.join(root, GUARD_MODULE_PATH), '', 'utf8');
  writeFileSync(
    abs,
    JSON.stringify({ $comment: comment ?? [`policy data for ${GUARD_MODULE_PATH}`], allowed }),
    'utf8',
  );
}

/** The message a throwing call produced, so two failure paths can be compared. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the call to throw, and it did not');
}

/**
 * The kill fixture: the hand-written literals present on the landing branch,
 * transcribed from the task-020 specification. This is the SECOND authority —
 * written by a human from the spec, not read out of the parser.
 */
const EXPECTED_HAND_WRITTEN_LITERALS: readonly string[] = [
  'doctor',
  'emissions',
  'feedback',
  'init',
  'install-skills',
  'mcp',
  'merge-orchestrate',
  'onboard',
  'schema',
  'topology',
  'version',
];

/** The three derivation helpers that take their name from a registry declaration. */
const EXPECTED_DERIVED_EXPRESSIONS: readonly string[] = ['cliName', 'commandName', 'harness'];

function governedSourcePath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return path.join(REPO_ROOT, rel);
}

describe('cli-derivation-guard (DR-5 / G1)', () => {
  it('CliDerivationGuard_LandingBranch_ReportsElevenHandWrittenLiterals', () => {
    const scan = scanGovernedSources();

    // The population under policy: names baked into the composition root.
    const names = scan.literals.map((s) => s.name).sort();
    expect(names).toEqual([...EXPECTED_HAND_WRITTEN_LITERALS].sort());
    expect(scan.literals).toHaveLength(11);

    // The three derivation loops — these are the compliant sites, and the guard
    // must NOT report them. A guard that flagged these would be unusable.
    expect(scan.derived.map((s) => s.expression).sort()).toEqual(
      [...EXPECTED_DERIVED_EXPRESSIONS].sort(),
    );

    // Fail-closed classification: nothing unclassifiable.
    expect(scan.indeterminate).toHaveLength(0);

    // 14 total = 3 derivation loops + 11 hand-written literals. NOT 15, and NOT
    // "14 hand-written" — both are numbers a careless measurement produces here.
    expect(scan.sites).toHaveLength(14);

    // The guard REPORTS all 11 on introduction: the allowlist ships empty, so
    // nothing is blessed away.
    expect(readAllowlist().size).toBe(0);
    const violations = findDerivationViolations(scan, readAllowlist());
    expect(violations).toHaveLength(11);

    // ── Comment blanking, demonstrated rather than asserted in prose ─────────
    // A naive text scan counts one MORE site than the parser, because a JSDoc
    // block writes `program.command(...)` in prose. The parser classifies that
    // as trivia so it never becomes a CallExpression. This is the measure-the-
    // text-instead-of-the-structure failure this guard exists to avoid, pinned
    // as an executable fact.
    const raw = readFileSync(governedSourcePath(), 'utf8');
    const naiveTextMatches = raw.match(/\.command\(/g) ?? [];
    expect(naiveTextMatches).toHaveLength(15);
    expect(scan.sites.length).toBe(naiveTextMatches.length - 1);

    // The prose occurrence is inside a comment, and no reported site sits on it.
    const proseLine = raw.split('\n').findIndex((l) => l.includes('* literal id its `program.command(...)`')) + 1;
    expect(proseLine).toBeGreaterThan(0);
    expect(scan.sites.map((s) => s.line)).not.toContain(proseLine);
  });

  it('CliDerivationGuard_TwelfthLiteralSeeded_Fails', () => {
    const raw = readFileSync(governedSourcePath(), 'utf8');

    // Baseline: the unmodified composition root reports 11.
    const before = scanSourceForCommandSites(raw, 'cli.ts');
    expect(findDerivationViolations(before)).toHaveLength(11);

    // Seed a 12th hand-written literal into the real source.
    const seeded = `${raw}\nconst __seededTwelfth = program.command('seeded-twelfth').description('x');\n`;
    const after = scanSourceForCommandSites(seeded, 'cli.ts');

    expect(after.literals).toHaveLength(12);
    const violations = findDerivationViolations(after);
    expect(violations).toHaveLength(12);
    expect(violations.map((v) => v.name)).toContain('seeded-twelfth');

    // Detection alone is not the claim — the guard must move from 11 to 12, so a
    // NEW literal is distinguishable from the tolerated landing-branch debt.
    expect(after.literals.length).toBe(before.literals.length + 1);
  });

  it('CliDerivationGuard_ZeroCommandSitesParsed_FailsClosed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'imo-020-'));
    const rel = GOVERNED_SOURCES[0];
    if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });

    // A governed source that parses cleanly but registers NOTHING. Without the
    // non-empty-denominator tooth this is a clean run: zero sites, zero
    // literals, zero violations, guard green — which is exactly how a moved or
    // renamed composition root would silently stop being governed.
    writeFileSync(abs, 'export const nothing = 1;\n', 'utf8');
    expect(() => scanGovernedSources(root)).toThrow(/yielded 0 `\.command\(` sites/);

    // A file that has been MOVED away entirely also fails closed.
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'imo-020-missing-'));
    expect(() => scanGovernedSources(emptyRoot)).toThrow(/does not exist/);

    // An empty policy list fails closed too: nothing governed is not compliance.
    expect(() => scanGovernedSources(REPO_ROOT, [])).toThrow(/no governed sources declared/);

    // A recovered parse is fatal rather than silently under-reporting.
    expect(() => scanSourceForCommandSites('const x = (;', 'broken.ts')).toThrow(
      /did not parse cleanly/,
    );
  });

  // ─── DR-5 kill fixture (task 021) ──────────────────────────────────────────
  //
  // `merge_orchestrate` is declared TWICE: as a registry action carrying
  // `posture: 'shared-mutating'`, and by hand as `.command('merge-orchestrate')`
  // in the composition root. That duplication is the finding. The registry
  // declaration is the survivor; the hand-written command is DELETED by DR-5's
  // remediation, not exempted.
  //
  // These two tests exist because an earlier revision of the policy allowlisted
  // `merge-orchestrate`, neutralizing the very rejection DR-5 requires. The
  // guard is not demonstrated by running — only by rejecting a real, currently
  // present subject.

  it('CliDerivationGuard_MergeOrchestrateLiteral_IsRejected', () => {
    // The LIVE composition root on disk — not a synthetic fixture. Anything
    // proven here is proven about the shipped `cli.ts`.
    const scan = scanGovernedSources();

    const sites = scan.literals.filter((s) => s.name === 'merge-orchestrate');
    expect(sites).toHaveLength(1);
    const site = sites[0];
    if (site === undefined) throw new Error('unreachable: length asserted above');

    expect(site.kind).toBe('literal');
    expect(site.expression).toBe("'merge-orchestrate'");
    expect(site.file).toBe('servers/exarchos-mcp/src/adapters/cli.ts');

    // Anchor the parser's report to the live TEXT: the hand-written call is
    // still physically present. This doubles as the standing proof that DR-5's
    // remediation (deleting it) has NOT happened yet — the guard therefore has
    // a real failing subject rather than a hypothetical one.
    const lines = readFileSync(governedSourcePath(), 'utf8').split('\n');
    const literalLine = lines.findIndex((l) => l.includes(".command('merge-orchestrate')")) + 1;
    expect(literalLine).toBeGreaterThan(0);
    // The reported line anchors the head of the chained call (`program`), which
    // may sit above the `.command(...)` continuation line — hence `<=`, not `===`.
    expect(site.line).toBeLessThanOrEqual(literalLine);

    // Rejected under the shipped allowlist.
    const reported = findDerivationViolations(scan, readAllowlist());
    expect(reported.map((v) => v.name)).toContain('merge-orchestrate');

    // THE DECISIVE ASSERTION. Today the allowlist is empty, so "is rejected"
    // would hold for any name at all — a vacuous pass. Bless the other ten
    // literals (the tracked debt this allowlist exists to carry) and the kill
    // fixture must be the ONLY survivor. This is what distinguishes a real
    // exclusion from an accident of the allowlist being empty right now, and it
    // is the assertion that goes red if a later wave populates the allowlist
    // and quietly includes `merge-orchestrate`.
    const otherTen = new Set(
      EXPECTED_HAND_WRITTEN_LITERALS.filter((n) => n !== 'merge-orchestrate'),
    );
    expect(otherTen.size).toBe(10);
    const survivors = findDerivationViolations(scan, otherTen);
    expect(survivors.map((v) => v.name)).toEqual(['merge-orchestrate']);

    // And the exclusion is a MECHANISM, not data: handing the guard an
    // allowlist that names the kill fixture does not suppress it.
    const withKillFixtureAllowed = new Set([...otherTen, 'merge-orchestrate']);
    const stillRejected = findDerivationViolations(scan, withKillFixtureAllowed);
    expect(stillRejected.map((v) => v.name)).toEqual(['merge-orchestrate']);

    // The failure message must tell the reader the remedy is DELETION, not an
    // exemption — otherwise the next author reaches for the allowlist again.
    const detail = stillRejected[0]?.detail ?? '';
    expect(detail).toContain('not allowlistable');
    expect(detail).toMatch(/[Dd]elete the hand-written command/);
  });

  it('CliDerivationGuard_MergeOrchestrate_IsAbsentFromTheAllowlist', () => {
    // (1) Absence in the shipped POLICY DATA, read as raw JSON rather than
    // through `readAllowlist` — the parsed view now refuses such a file, so
    // checking only the parsed view could never observe the entry.
    const rawAllowlist: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'),
    );
    const allowedRaw =
      typeof rawAllowlist === 'object' && rawAllowlist !== null
        ? Reflect.get(rawAllowlist, 'allowed')
        : undefined;
    expect(Array.isArray(allowedRaw)).toBe(true);
    expect(allowedRaw).not.toContain('merge-orchestrate');

    // (2) Absence in the parsed view.
    expect([...readAllowlist()]).not.toContain('merge-orchestrate');

    // (3) The name is registered as a kill fixture, so the exclusion is
    // declared policy rather than an omission nobody wrote down.
    expect(KILL_FIXTURE_COMMANDS).toContain('merge-orchestrate');

    // (4) THE TOOTH. A future well-meaning addition must FAIL. Assertions (1)
    // and (2) alone are satisfied by an empty file and would be satisfied
    // again by a file that simply had not been edited yet; they cannot show
    // that adding the entry is rejected. Seed an allowlist that grants the
    // exemption and confirm the guard refuses the file outright — loudly,
    // rather than silently dropping the entry, because a silently ignored
    // allowlist line reads to its author as granted.
    const root = mkdtempSync(path.join(tmpdir(), 'imo-021-'));
    seedAllowlist(root, ['doctor', 'merge-orchestrate']);
    expect(() => readAllowlist(root)).toThrow(/allowlists the kill fixture/);

    // The same file WITHOUT the kill fixture is accepted — so the rejection is
    // specific to the excluded name, not a guard that refuses every allowlist.
    seedAllowlist(root, ['doctor']);
    expect([...readAllowlist(root)]).toEqual(['doctor']);
  });

  // ─── Task 022 (a): the non-empty denominator, pushed down ──────────────────
  //
  // Task 021 reported this tooth as HALF-INSTALLED: it lived in
  // `scanGovernedSources`, while the pure `scanSourceForCommandSites` parsed an
  // empty string cleanly and handed back a zero-site scan without complaint.
  // Latent only because nothing called the pure function directly — and two
  // callers have since appeared (`authority-live-proof`). A future gate wired to
  // the pure function would have bypassed the protection entirely, which is the
  // failure the tooth exists to prevent, one level down.

  it('CliDerivationGuard_PureScanner_ZeroCommandSites_Throws', () => {
    // (1) The empty string: parses cleanly, registers nothing. This is the exact
    // input task 021 reported as returning a clean zero-site scan.
    expect(() => scanSourceForCommandSites('', 'empty.ts')).toThrow(
      /yielded 0 `\.command\(` sites/,
    );

    // (2) A syntactically valid module that simply registers no commands — what
    // a moved or renamed composition root looks like to the scanner.
    expect(() => scanSourceForCommandSites('export const nothing = 1;\n', 'moved.ts')).toThrow(
      /yielded 0 `\.command\(` sites/,
    );

    // (3) The message names the file, so the failure says WHICH source is empty
    // rather than only that something was.
    expect(messageOf(() => scanSourceForCommandSites('', 'moved-root.ts'))).toContain(
      '"moved-root.ts"',
    );

    // (4) The refusal is about ZERO SITES, not about the absence of the TEXT
    // `.command`. Near-miss members (`.commands`, `.commandName`) are not sites,
    // so a file full of them is still empty as far as the policy is concerned —
    // a text-matching implementation would pass this and is thereby excluded.
    expect(() =>
      scanSourceForCommandSites('const n = program.commands.length + x.commandName;\n', 'near.ts'),
    ).toThrow(/yielded 0 `\.command\(` sites/);

    // (5) Off-by-one control: ONE site is enough. Without this the tooth could
    // be a `<= 1` and the test above would not notice.
    const single = scanSourceForCommandSites('program.command(cliName);\n', 'one.ts');
    expect(single.sites).toHaveLength(1);
    expect(single.derived).toHaveLength(1);

    // (6) THE ERROR SURFACES ONCE. `scanGovernedSources` no longer keeps its own
    // copy of this check, so a governed source that registers nothing fails with
    // the SAME message the pure scanner produces for the same input — one
    // wording, one origin, and no possibility of the two drifting apart.
    const rel = GOVERNED_SOURCES[0];
    if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
    const root = mkdtempSync(path.join(tmpdir(), 'imo-022-denominator-'));
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, 'export const nothing = 1;\n', 'utf8');

    const viaOuter = messageOf(() => scanGovernedSources(root));
    const viaPure = messageOf(() => scanSourceForCommandSites('export const nothing = 1;\n', rel));
    expect(viaOuter).toBe(viaPure);
    expect(viaOuter).toContain(rel);
  });

  // ─── Task 022 (b): the policy file's own pointers are bound ────────────────
  //
  // Task 021 found the shipped `$comment` pointing at `cli-derivation-seam.ts`,
  // a module renamed to `cli-derivation-guard.ts` and therefore absent. That is
  // the text a future author reads to decide whether their entry is legitimate.
  // Correcting the string alone would leave the class open, so the reference is
  // BOUND: a file named by the policy must exist, or the policy is not read.

  it('CliDerivationGuard_PolicyCommentNamingAMissingModule_IsRejected', () => {
    // ── The live subject, and this measurement's non-empty denominator ────────
    // A reference extractor that silently matched nothing would report every
    // policy file clean. Pin the shipped file's references as non-empty and
    // name-checked, so a regression in the extractor reddens here.
    const rawAllowlist: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'),
    );
    const commentLines: unknown =
      typeof rawAllowlist === 'object' && rawAllowlist !== null
        ? Reflect.get(rawAllowlist, '$comment')
        : undefined;
    expect(Array.isArray(commentLines)).toBe(true);
    const commentText = Array.isArray(commentLines) ? commentLines.join('\n') : '';

    const references = extractPolicyFileReferences(commentText);
    expect(references.length).toBeGreaterThan(0);
    expect(references).toContain(GUARD_MODULE_PATH);
    expect(references).toContain('servers/exarchos-mcp/src/adapters/cli.ts');
    // The renamed-away path is gone from the shipped data.
    expect(references).not.toContain(RENAMED_AWAY_MODULE_PATH);
    expect(findPolicyReferenceProblems(commentText)).toEqual([]);
    expect(() => readAllowlist()).not.toThrow();

    // ── KILL FIXTURE: the defect exactly as it shipped ───────────────────────
    // Restore the pre-rename pointer and the policy file must be refused.
    const root = mkdtempSync(path.join(tmpdir(), 'imo-022-reference-'));
    seedAllowlist(root, ['doctor'], [`DR-5 / G1 policy data for ${RENAMED_AWAY_MODULE_PATH}.`]);
    expect(() => readAllowlist(root)).toThrow(/cli-derivation-seam\.ts" does not exist/);

    // ── The two ways a pointer fails to be checkable ─────────────────────────
    // A bare basename names no single place on disk, so it can be neither
    // verified nor followed. Rejecting it is what stops the class from
    // reappearing as `see cli-derivation-guard.ts` in some future comment.
    seedAllowlist(root, ['doctor'], ['see KILL_FIXTURE_COMMANDS in cli-derivation-guard.ts.']);
    expect(() => readAllowlist(root)).toThrow(/is a bare filename/);

    // Prose that names NO file is refused too: it leaves the reader nothing to
    // follow, and it is indistinguishable from a broken extractor.
    seedAllowlist(root, ['doctor'], ['DR-5 policy data. Entries are tolerated literals.']);
    expect(() => readAllowlist(root)).toThrow(/names no file at all/);

    const abs = path.join(root, ALLOWLIST_PATH);
    writeFileSync(abs, JSON.stringify({ allowed: ['doctor'] }), 'utf8');
    expect(() => readAllowlist(root)).toThrow(/names no file at all/);

    // ── And the corrected pointer is accepted ────────────────────────────────
    // Without this the rejection could be a reader that refuses every comment.
    seedAllowlist(root, ['doctor'], [`DR-5 / G1 policy data for ${GUARD_MODULE_PATH}.`]);
    expect([...readAllowlist(root)]).toEqual(['doctor']);

    // ── Ordering: a stale pointer never MASKS the DR-5 kill-fixture refusal ───
    // Both rules can fire on one file; only one error can surface. The
    // load-bearing one must win.
    seedAllowlist(
      root,
      ['merge-orchestrate'],
      [`DR-5 / G1 policy data for ${RENAMED_AWAY_MODULE_PATH}.`],
    );
    expect(() => readAllowlist(root)).toThrow(/allowlists the kill fixture/);
  });
});
