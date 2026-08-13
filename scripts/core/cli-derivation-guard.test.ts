// DR-5 / G1 — the source-level CLI derivation guard, and its two self-tests.
//
// @oracle-sources: ../src/adapters/cli/cli.ts, the task-020 specification's hand-enumerated kill-fixture list of 11 literal command names
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
  isKillFixture,
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
const GUARD_MODULE_PATH = 'scripts/core/cli-derivation-guard.ts';

/** The pre-rename path that actually shipped inside the policy `$comment`. */
const RENAMED_AWAY_MODULE_PATH = 'scripts/core/cli-derivation-seam.ts';

/**
 * Write a policy file into a throwaway tree.
 *
 * The default `$comment` names a file that RESOLVES inside that tree, because
 * the reader now refuses a policy file whose prose points at something that is
 * not there (task 022). Fixtures that are about the ENTRY rules therefore have
 * to be valid on the reference rules, and vice versa — which is the point: the
 * two rejections are independent.
 *
 * Callers still pass a bare list of NAMES: every fixture here is about which
 * names a policy file may contain, not about owners or deadlines, so the
 * `{ owner, expires }` records task 023 introduced are filled in with a uniform
 * placeholder rather than repeated at each call site.
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
  const entries: Record<string, { owner: string; expires: string }> = {};
  for (const name of allowed) entries[name] = { owner: 'cli-surface', expires: '2027-02-28' };
  writeFileSync(
    abs,
    JSON.stringify({
      $comment: comment ?? [`policy data for ${GUARD_MODULE_PATH}`],
      allowed: entries,
      retired: {},
    }),
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
 * The hand-written literals present in the composition root, transcribed from
 * the task-020 specification. This is the SECOND authority — written by a human
 * from the spec, not read out of the parser.
 *
 * `merge-orchestrate` was on this list until task 076 deleted the hand-written
 * `.command('merge-orchestrate')` call and moved the promotion to the registry's
 * `cli.topLevel` hint (DR-5's stated remediation — deletion, never exemption).
 * It is GONE from the live composition root, which is why it is gone from here;
 * the guard's proof that it would still be rejected now runs against
 * {@link KILL_FIXTURE_SOURCE} instead of the live file.
 */
const EXPECTED_HAND_WRITTEN_LITERALS: readonly string[] = [
  'doctor',
  'emissions',
  'feedback',
  'init',
  'install-skills',
  'mcp',
  'onboard',
  'schema',
  'topology',
  'version',
];

/**
 * The re-seeded DR-5 kill fixture (task 021, preserved by task 076).
 *
 * Task 021's proof was "the guard rejects a hand-written `merge-orchestrate`
 * definition", and its subject was the live composition root. Task 076 removed
 * that subject by fixing the defect — so the proof is re-seeded HERE rather than
 * deleted with the code. Deleting the test alongside the remediation would
 * retire the guarantee at the exact moment it starts being load-bearing: nothing
 * would then stop a future author from re-adding the hand-written promotion.
 *
 * Shaped like the block task 076 deleted (chained `program.command(...)` with a
 * `.description(...)`), so the parser sees the same construct it used to see in
 * `cli.ts`.
 */
const KILL_FIXTURE_SOURCE = [
  "const mergeOrchestrateCmd = program",
  "  .command('merge-orchestrate')",
  "  .description('Run the autonomous merge orchestrator.');",
  'mergeOrchestrateCmd.action(async () => {});',
].join('\n');

/** The three derivation helpers that take their name from a registry declaration. */
const EXPECTED_DERIVED_EXPRESSIONS: readonly string[] = ['cliName', 'commandName', 'harness'];

function governedSourcePath(): string {
  const rel = GOVERNED_SOURCES[0];
  if (rel === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return path.join(REPO_ROOT, rel);
}

describe('cli-derivation-guard (DR-5 / G1)', () => {
  it('CliDerivationGuard_CompositionRoot_ReportsOnlyAllowlistedHandWrittenLiterals', () => {
    const scan = scanGovernedSources();

    // The population under policy: names baked into the composition root.
    const names = scan.literals.map((s) => s.name).sort();
    expect(names).toEqual([...EXPECTED_HAND_WRITTEN_LITERALS].sort());
    expect(scan.literals).toHaveLength(EXPECTED_HAND_WRITTEN_LITERALS.length);

    // Task 076's remediation, asserted on the live tree: the hand-written
    // `merge-orchestrate` promotion is GONE from the composition root. This is
    // the positive half of the kill fixture — the negative half (that the guard
    // would still reject it) is re-seeded below against KILL_FIXTURE_SOURCE.
    expect(names).not.toContain('merge-orchestrate');

    // The three derivation loops — these are the compliant sites, and the guard
    // must NOT report them. A guard that flagged these would be unusable.
    expect(scan.derived.map((s) => s.expression).sort()).toEqual(
      [...EXPECTED_DERIVED_EXPRESSIONS].sort(),
    );

    // Fail-closed classification: nothing unclassifiable.
    expect(scan.indeterminate).toHaveLength(0);

    // Total = derivation loops + hand-written literals, DERIVED from the two
    // populations rather than written as a number. A literal total here is what
    // broke four assertions in this wave: task 076's correct paydown moves it,
    // and a hard-coded 14 would have reddened on a change that is the whole
    // point of the guard. The claim is the PARTITION (every site is one or the
    // other, nothing unclassified), not the magnitude.
    expect(scan.sites).toHaveLength(
      scan.literals.length + scan.derived.length + scan.indeterminate.length,
    );
    expect(scan.sites).toHaveLength(
      EXPECTED_HAND_WRITTEN_LITERALS.length + EXPECTED_DERIVED_EXPRESSIONS.length,
    );

    // ── What the shipped allowlist blesses, and what it cannot ───────────────
    // Task 020 shipped this file EMPTY and asserted `size === 0`, so the guard's
    // first run stated the real size of the debt. Task 023 populated it with the
    // TEN allowlistable literals — every hand-written name except the kill
    // fixture, which `readPolicy` refuses outright.
    //
    // Both sides are DERIVED. The expected key set is the second authority
    // (`EXPECTED_HAND_WRITTEN_LITERALS`, transcribed from the spec) minus the
    // declared kill fixtures; the actual is read off disk. A count written as a
    // literal here would be broken by a correct paydown, which is how four
    // assertions in this wave broke.
    const allowlistable = EXPECTED_HAND_WRITTEN_LITERALS.filter((n) => !isKillFixture(n));
    expect([...readAllowlist()].sort()).toEqual([...allowlistable].sort());
    expect(readAllowlist().size).toBe(allowlistable.length);

    // No kill fixture survives in the live population — task 076 deleted the
    // only one. Stated as a derived predicate so declaring a NEW kill fixture
    // that is still hand-written reddens here rather than passing quietly.
    expect(EXPECTED_HAND_WRITTEN_LITERALS.filter(isKillFixture)).toEqual([]);

    // The guard therefore reports ZERO violations on the live tree. Task 023
    // allowlisted the ten tolerated literals and task 076 deleted the eleventh
    // (the kill fixture, which `readPolicy` refuses to exempt), so G1 is
    // green-on-clean and can finally be wired direct-and-blocking. An empty
    // violation list is only meaningful because the seeded-violation tests
    // below show the guard still bites.
    const violations = findDerivationViolations(scan, readAllowlist());
    expect(violations).toEqual([]);

    // ── Comment blanking, demonstrated rather than asserted in prose ─────────
    // A naive text scan counts MORE sites than the parser, because doc comments
    // write the call form out in prose. The parser classifies those as trivia so
    // they never become CallExpressions. This is the measure-the-text-instead-
    // of-the-structure failure this guard exists to avoid, pinned as an
    // executable fact.
    //
    // The comment lines are LOCATED, not transcribed. An earlier revision
    // anchored on a verbatim sentence fragment, and rewording that docblock (in
    // task 076, for an unrelated reason) broke the anchor while the property it
    // guarded still held — a test pinned to prose rather than to structure.
    const raw = readFileSync(governedSourcePath(), 'utf8');
    const lines = raw.split('\n');
    const naiveTextMatches = raw.match(/\.command\(/g) ?? [];

    // Comment lines carrying the call form, by shape: a JSDoc continuation or a
    // line comment. These are the entire gap between the text scan and the parse.
    const proseLines = lines
      .map((line, i) => ({ line, number: i + 1 }))
      .filter(({ line }) => /^\s*(\*|\/\/)/.test(line) && line.includes('.command('));

    expect(proseLines.length).toBeGreaterThan(0);
    expect(scan.sites.length).toBe(naiveTextMatches.length - proseLines.length);

    // No reported site sits on any of them.
    const siteLines = new Set(scan.sites.map((s) => s.line));
    for (const { number } of proseLines) {
      expect(siteLines.has(number)).toBe(false);
    }
  });

  it('CliDerivationGuard_OneMoreLiteralSeeded_Fails', () => {
    const raw = readFileSync(governedSourcePath(), 'utf8');

    // Baseline: the unmodified composition root, measured rather than asserted
    // at a magnitude. With NO allowlist passed, every hand-written literal is a
    // violation — that is the un-exempted population the seed has to move.
    const before = scanSourceForCommandSites(raw, 'cli.ts');
    expect(findDerivationViolations(before)).toHaveLength(
      EXPECTED_HAND_WRITTEN_LITERALS.length,
    );

    // Seed one more hand-written literal into the real source.
    const seeded = `${raw}\nconst __seededExtra = program.command('seeded-extra').description('x');\n`;
    const after = scanSourceForCommandSites(seeded, 'cli.ts');

    const violations = findDerivationViolations(after);
    expect(violations.map((v) => v.name)).toContain('seeded-extra');

    // Detection alone is not the claim — the guard must move by exactly one, so
    // a NEW literal is distinguishable from the tolerated tracked debt.
    expect(after.literals.length).toBe(before.literals.length + 1);
    expect(violations.length).toBe(findDerivationViolations(before).length + 1);

    // And it must survive the SHIPPED allowlist: the live tree is clean now, so
    // a seeded literal is the only thing that can redden G1 — this is the
    // assertion that keeps "green" meaning "checked" rather than "empty".
    const underShippedPolicy = findDerivationViolations(after, readAllowlist());
    expect(underShippedPolicy.map((v) => v.name)).toEqual(['seeded-extra']);
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
    // ── The remediation actually happened ────────────────────────────────────
    // First, on the LIVE composition root: the hand-written promotion task 021
    // proved rejectable is gone, and the verb's name now comes from the registry
    // declaration. If someone re-adds it, this half goes red before the seeded
    // half below even runs.
    // Asserted STRUCTURALLY, off the parse — not as a raw-text `not.toContain`.
    // A text check would fail on the explanatory comment `cli.ts` now carries
    // about the deletion, which is the very measure-the-text-instead-of-the-
    // structure mistake this guard exists to avoid. The parser blanks trivia,
    // so this claim is about registered commands and nothing else.
    const live = scanGovernedSources();
    expect(live.literals.map((s) => s.name)).not.toContain('merge-orchestrate');

    // ── The guarantee survives its subject (task 076) ────────────────────────
    // Task 021's proof needs a subject, and fixing the defect removed the live
    // one. Re-seed it: splice the deleted block back into the real composition
    // root and re-run the SAME guard. Deleting this test with the code would
    // have retired the guarantee exactly when it became load-bearing.
    const seededSource = `${readFileSync(governedSourcePath(), 'utf8')}\n${KILL_FIXTURE_SOURCE}\n`;
    const scan = scanSourceForCommandSites(
      seededSource,
      'src/adapters/cli/cli.ts',
    );

    const sites = scan.literals.filter((s) => s.name === 'merge-orchestrate');
    expect(sites).toHaveLength(1);
    const site = sites[0];
    if (site === undefined) throw new Error('unreachable: length asserted above');

    expect(site.kind).toBe('literal');
    expect(site.expression).toBe("'merge-orchestrate'");
    expect(site.file).toBe('src/adapters/cli/cli.ts');

    // Rejected under the shipped allowlist.
    const reported = findDerivationViolations(scan, readAllowlist());
    expect(reported.map((v) => v.name)).toContain('merge-orchestrate');

    // THE DECISIVE ASSERTION. "Is rejected" would hold vacuously for any name
    // the allowlist happens not to cover. Bless every OTHER literal (the tracked
    // debt the allowlist exists to carry) and the kill fixture must be the ONLY
    // survivor. This is the assertion that goes red if a later wave populates
    // the allowlist and quietly includes `merge-orchestrate`.
    const everyOtherLiteral = new Set(EXPECTED_HAND_WRITTEN_LITERALS);
    expect(everyOtherLiteral.has('merge-orchestrate')).toBe(false);
    const survivors = findDerivationViolations(scan, everyOtherLiteral);
    expect(survivors.map((v) => v.name)).toEqual(['merge-orchestrate']);

    // And the exclusion is a MECHANISM, not data: handing the guard an
    // allowlist that names the kill fixture does not suppress it.
    const withKillFixtureAllowed = new Set([
      ...everyOtherLiteral,
      'merge-orchestrate',
    ]);
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
    // checking only the parsed view could never observe the entry. Both maps are
    // checked: task 023 added the `retired` graveyard, and "retire the kill
    // fixture" is the same authoring mistake one map over.
    const rawAllowlist: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ALLOWLIST_PATH), 'utf8'),
    );
    const rawMapKeys = (field: string): string[] => {
      const raw: unknown =
        typeof rawAllowlist === 'object' && rawAllowlist !== null
          ? Reflect.get(rawAllowlist, field)
          : undefined;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`the shipped policy file has no "${field}" object`);
      }
      return Object.keys(raw);
    };
    expect(rawMapKeys('allowed').length).toBeGreaterThan(0);
    expect(rawMapKeys('allowed')).not.toContain('merge-orchestrate');
    expect(rawMapKeys('retired')).not.toContain('merge-orchestrate');

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
    expect(references).toContain('src/adapters/cli/cli.ts');
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

    // The same, with the `$comment` key ABSENT rather than uninformative. The
    // policy body is otherwise well-shaped, so this isolates the reference rule
    // from the shape rule the reader applies first.
    const abs = path.join(root, ALLOWLIST_PATH);
    writeFileSync(
      abs,
      JSON.stringify({
        allowed: { doctor: { owner: 'cli-surface', expires: '2027-02-28' } },
        retired: {},
      }),
      'utf8',
    );
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
