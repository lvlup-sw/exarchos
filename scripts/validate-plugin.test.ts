/**
 * Self-tests for the plugin-packaging gate (task 064, DR-24).
 *
 * The gate's expectations are DATA (`.claude-plugin/packaging-policy.json`), so
 * these tests split cleanly in two:
 *
 *   A. THE INTERPRETER is correct — every policy clause produces a check, and
 *      each clause can actually fail. Seeded trees, no repo state.
 *   B. THE SHIPPED POLICY still describes the shipped package — including the
 *      four clauses that had drifted the other way before this task, each of
 *      which is pinned here against the tree AND against the green assertions in
 *      src/plugin-validation.test.ts, so a future edit cannot resurrect the
 *      divergence in either direction.
 *
 * Regression anchor: on 2026-08-07 the gate demanded `.mcp.json` (deleted in
 * 2b62e1bf3), demanded plugin.json `hooks` (removed in e334a392b), demanded a
 * `SessionEnd` hook (dropped by DR-7 task 016) and forbade `SessionStart`
 * (shipped per #1485). It was step 1 of an `&&` chain no workflow ran, so five
 * of its nine checks were wrong for months without anyone paying a cost.
 *
 * The gate is authored as ESM `.mjs`; NodeNext resolution requires the explicit
 * extension at import time.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — no .d.ts for this .mjs gate; contract is asserted here.
import {
  evaluatePackaging,
  isClean,
  renderReport,
  diskTree,
  DEFAULT_POLICY_PATH,
} from './validate-plugin.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');
const GATE = path.join(SCRIPTS_DIR, 'validate-plugin.mjs');

interface Check {
  id: string;
  description: string;
  passed: boolean;
  detail?: string;
}
interface Report {
  checks: Check[];
  violations: string[];
}

const shippedPolicy = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, DEFAULT_POLICY_PATH), 'utf8')) as Record<
    string,
    unknown
  >;

/** Deep clone so a mutation in one test cannot leak into the next. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A conforming synthetic tree: the minimum that satisfies the shipped policy.
 * Built as a plain map so a test can delete or corrupt exactly one entry and
 * watch exactly one check flip.
 */
function conformingFiles(): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'exarchos',
      version: '9.9.9',
      commands: './commands/',
      skills: './skills/',
      mcpServers: { exarchos: { type: 'stdio', command: 'exarchos', args: ['mcp'] } },
    }),
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'exarchos session-start' }] }],
        SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'exarchos subagent-stop' }] }],
      },
    }),
  };
}

const CONFORMING_DIRS = ['commands', 'skills'];

/** An in-memory TreeReader over the maps above. */
function memoryTree(files: Record<string, string>, dirs: string[] = CONFORMING_DIRS) {
  return {
    fileExists: (rel: string) => Object.hasOwn(files, rel),
    dirExists: (rel: string) => dirs.includes(rel),
    readText: (rel: string) => {
      if (!Object.hasOwn(files, rel)) throw new Error(`ENOENT: ${rel}`);
      return files[rel];
    },
  };
}

const check = (report: Report, id: string): Check | undefined => report.checks.find((c) => c.id === id);

describe('validate-plugin — the interpreter (task 064, DR-24)', () => {
  it('ValidatePlugin_ConformingTree_PassesEveryCheck', () => {
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(conformingFiles()));
    expect(report.violations).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(0);
    const failures = report.checks.filter((c) => !c.passed);
    expect(failures.map((f) => `${f.id}: ${f.detail ?? ''}`)).toEqual([]);
    expect(isClean(report)).toBe(true);
  });

  it('ValidatePlugin_MissingRequiredManifestField_Fails', () => {
    const files = conformingFiles();
    const manifest = JSON.parse(files['.claude-plugin/plugin.json']) as Record<string, unknown>;
    delete manifest.skills;
    files['.claude-plugin/plugin.json'] = JSON.stringify(manifest);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'manifest.field.skills')?.passed).toBe(false);
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePlugin_ForbiddenManifestFieldPresent_Fails', () => {
    // The exact regression that made the OLD gate wrong, now asserted in the
    // direction the repo actually decided: declaring `hooks` double-registers.
    const files = conformingFiles();
    const manifest = JSON.parse(files['.claude-plugin/plugin.json']) as Record<string, unknown>;
    manifest.hooks = './hooks/hooks.json';
    files['.claude-plugin/plugin.json'] = JSON.stringify(manifest);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    const failed = check(report, 'manifest.forbidden-field.hooks');
    expect(failed?.passed).toBe(false);
    expect(failed?.detail).toContain('e334a392b');
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePlugin_ForbiddenFilePresent_Fails', () => {
    const files = conformingFiles();
    files['.mcp.json'] = JSON.stringify({ mcpServers: { exarchos: {} } });
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    const failed = check(report, 'forbidden-file..mcp.json');
    expect(failed?.passed).toBe(false);
    expect(failed?.detail).toContain('2b62e1bf3');
  });

  it('ValidatePlugin_MissingRequiredDirectory_Fails', () => {
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(conformingFiles(), ['commands']));
    expect(check(report, 'dir.skills')?.passed).toBe(false);
  });

  it('ValidatePlugin_ExtraBundledMcpServer_Fails', () => {
    const files = conformingFiles();
    const manifest = JSON.parse(files['.claude-plugin/plugin.json']) as Record<string, unknown>;
    (manifest.mcpServers as Record<string, unknown>).stowaway = { type: 'stdio' };
    files['.claude-plugin/plugin.json'] = JSON.stringify(manifest);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'manifest.mcp-servers.exact')?.passed).toBe(false);
    // The named server is still present — only the exactness clause trips.
    expect(check(report, 'manifest.mcp-server.exarchos')?.passed).toBe(true);
  });

  it('ValidatePlugin_RetiredHookReintroduced_Fails', () => {
    const files = conformingFiles();
    const hooks = JSON.parse(files['hooks/hooks.json']) as { hooks: Record<string, unknown> };
    hooks.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'exarchos guard' }] }];
    files['hooks/hooks.json'] = JSON.stringify(hooks);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.retired.PreToolUse')?.passed).toBe(false);
    expect(check(report, 'hooks.exact')?.passed).toBe(false);
  });

  it('ValidatePlugin_UnlistedHookType_FailsTheExactnessClause', () => {
    // A hook type nobody retired and nobody expected is still a new enforcement
    // surface arriving by the back door — `exact` is what catches it.
    const files = conformingFiles();
    const hooks = JSON.parse(files['hooks/hooks.json']) as { hooks: Record<string, unknown> };
    hooks.hooks.Notification = [{ hooks: [{ type: 'command', command: 'exarchos whatever' }] }];
    files['hooks/hooks.json'] = JSON.stringify(hooks);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.exact')?.passed).toBe(false);
    expect(check(report, 'hooks.exact')?.detail).toContain('Notification');
  });

  it('ValidatePlugin_MissingExpectedHook_Fails', () => {
    const files = conformingFiles();
    const hooks = JSON.parse(files['hooks/hooks.json']) as { hooks: Record<string, unknown> };
    delete hooks.hooks.SubagentStop;
    files['hooks/hooks.json'] = JSON.stringify(hooks);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.expected.SubagentStop')?.passed).toBe(false);
  });

  it('ValidatePlugin_UnsubstitutedCliPathPlaceholder_Fails', () => {
    const files = conformingFiles();
    files['hooks/hooks.json'] = files['hooks/hooks.json'].replace(
      'exarchos session-start',
      'node "{{CLI_PATH}}" session-start',
    );
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.token.{{CLI_PATH}}')?.passed).toBe(false);
  });

  it('ValidatePlugin_UnparseableHooksJson_FailsTheParseButStillSweepsTheText', () => {
    // Readable-but-invalid JSON: the parse clause fails, and every hook-TYPE
    // clause fails with it because the declared set is unknown. The token sweep
    // is textual, so it genuinely did read its subject and honestly reports a
    // clean sweep — the run still fails, on the clauses that could not be
    // evaluated rather than on one that could.
    const files = conformingFiles();
    files['hooks/hooks.json'] = '{ not json';
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.parses')?.passed).toBe(false);
    expect(check(report, 'hooks.expected.SessionStart')?.passed).toBe(false);
    expect(check(report, 'hooks.exact')?.passed).toBe(false);
    expect(check(report, 'hooks.token.{{CLI_PATH}}')?.passed).toBe(true);
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePlugin_MissingHooksFile_FailsTheTokenSweepRatherThanPassingIt', () => {
    const files = conformingFiles();
    delete files['hooks/hooks.json'];
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'file.hooks/hooks.json')?.passed).toBe(false);
    expect(check(report, 'hooks.token.{{CLI_PATH}}')?.passed).toBe(false);
  });
});

describe('validate-plugin — non-empty denominator (task 064, DR-24)', () => {
  it('ValidatePlugin_PolicyYieldingZeroChecks_FailsRatherThanPassingClean', () => {
    const report: Report = evaluatePackaging({}, memoryTree(conformingFiles()));
    expect(report.checks).toEqual([]);
    expect(report.violations.join('\n')).toContain('[empty-policy]');
    expect(isClean(report)).toBe(false);
    expect(renderReport(report)).toContain('**Result: FAIL**');
  });

  it('ValidatePlugin_SelfContradictoryHookPolicy_IsReportedAsAPolicyViolation', () => {
    // A hook listed as both expected and retired makes the policy unsatisfiable.
    // That is a broken instrument, not a broken package, and it must say so.
    const policy = clone(shippedPolicy()) as { hooks: { retired: { type: string }[] } };
    policy.hooks.retired.push({ type: 'SessionStart' });
    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    expect(report.violations.join('\n')).toContain('[policy-contradiction]');
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePlugin_NonObjectPolicy_IsReportedRatherThanSilentlyPassing', () => {
    const report: Report = evaluatePackaging(null, memoryTree(conformingFiles()));
    expect(report.violations.join('\n')).toContain('[policy-unreadable]');
    expect(isClean(report)).toBe(false);
  });
});

// ─── The strict schema (task 085) ───────────────────────────────────────────
//
// The interpreter reads each family as `policy.<key> ?? []`, so an unrecognised
// key is not a name it fails on — it is a family it never looks for. The
// non-empty tooth above only fires when ALL families vanish at once, so a single
// typo silently drops one family's checks and the gate still exits 0.

describe('validate-plugin — the policy is validated before it is interpreted', () => {
  /** How many checks the shipped policy produces against a conforming tree. */
  const baselineCheckCount = (): number =>
    (evaluatePackaging(shippedPolicy(), memoryTree(conformingFiles())) as Report).checks.length;

  it('ValidatePluginPolicy_UnknownTopLevelKey_IsReportedAsFinding', () => {
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    const before = baselineCheckCount();

    // The exact typo: one character, one family gone.
    policy['requiredfiles'] = policy['requiredFiles'];
    delete policy['requiredFiles'];

    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));

    // The DEFECT, measured: checks really did disappear. Asserting this first
    // means the violation below is attributable to a real loss of coverage
    // rather than to a schema that objects to a harmless key.
    expect(report.checks.length).toBeLessThan(before);
    expect(report.checks.filter((c) => c.id.startsWith('file.'))).toEqual([]);

    // And the gate now says so, by name, instead of exiting 0.
    expect(report.violations.join('\n')).toContain('[policy-unknown-key]');
    expect(report.violations.join('\n')).toContain('requiredfiles');
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePluginPolicy_ThreeDroppedFamilies_NoLongerExitZero', () => {
    // The measured case from the finding: three families dropped at once, every
    // remaining check still passing, so the non-empty tooth stays silent.
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    for (const [wrong, right] of [
      ['requiredfiles', 'requiredFiles'],
      ['requireddirs', 'requiredDirs'],
      ['forbiddenfiles', 'forbiddenFiles'],
    ]) {
      policy[wrong] = policy[right];
      delete policy[right];
    }

    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.violations.filter((v) => v.includes('[policy-unknown-key]'))).toHaveLength(3);
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePluginPolicy_TypoOneLevelDown_IsAlsoReported', () => {
    // A nested typo drops its family exactly as completely, so the schema is
    // recursive rather than a root-level key list.
    const nested = clone(shippedPolicy()) as { hooks: Record<string, unknown> };
    nested.hooks['retried'] = nested.hooks['retired'];
    delete nested.hooks['retired'];
    const hooksReport: Report = evaluatePackaging(nested, memoryTree(conformingFiles()));
    expect(hooksReport.violations.join('\n')).toContain('[policy-unknown-key]');
    expect(hooksReport.violations.join('\n')).toContain('hooks.retried');
    expect(hooksReport.checks.filter((c) => c.id.startsWith('hooks.retired.'))).toEqual([]);

    // …and inside an array entry.
    const entry = clone(shippedPolicy()) as { requiredFiles: Record<string, unknown>[] };
    entry.requiredFiles[0]!['pth'] = entry.requiredFiles[0]!['path'];
    delete entry.requiredFiles[0]!['path'];
    const entryReport: Report = evaluatePackaging(entry, memoryTree(conformingFiles()));
    expect(entryReport.violations.join('\n')).toContain('[policy-unknown-key]');
    expect(entryReport.violations.join('\n')).toContain('requiredFiles[0].pth');
    expect(entryReport.violations.join('\n')).toContain('[policy-incomplete]');
    expect(isClean(entryReport)).toBe(false);
  });

  it('ValidatePluginPolicy_FamilyOfTheWrongType_IsReported', () => {
    // A family declared as the wrong type contributes no checks, which reads
    // identical to a family that passed.
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    policy['requiredFiles'] = {};
    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    expect(report.violations.join('\n')).toContain('[policy-type]');
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePluginPolicy_NonStringProvenance_IsReported', () => {
    // Key membership is not shape. `because` and `decidedIn` are what the
    // failure message prints as the citation, so a number there renders as a
    // provenance nobody can follow — and used to pass the entry check silently.
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    (policy['requiredFiles'] as Record<string, unknown>[])[0] = {
      path: 'README.md',
      because: 1,
      decidedIn: null,
    };
    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    const joined = report.violations.join('\n');
    expect(joined).toContain('[policy-type]');
    expect(joined).toContain('requiredFiles[0].because');
    expect(joined).toContain('requiredFiles[0].decidedIn');
    expect(isClean(report)).toBe(false);
  });

  it('ValidatePluginPolicy_MalformedFamilies_AccumulateRatherThanThrow', () => {
    // The discipline this gate exists to keep is "report every violation", and
    // a TypeError reports exactly one. A null entry used to reach `entry.path`
    // and a null `hooks` used to reach `hooksSpec.path`, so the run died on the
    // first malformed value instead of listing all of them.
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    policy['requiredFiles'] = [null, { path: 'README.md' }];
    policy['hooks'] = null;

    let report!: Report;
    expect(() => {
      report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    }).not.toThrow();

    const joined = report.violations.join('\n');
    expect(joined).toContain('requiredFiles[0]');
    expect(joined).toContain('hooks');
    expect(joined).toContain('[policy-type]');
    expect(isClean(report)).toBe(false);
    // …and the surviving well-formed entry was still interpreted, so skipping
    // the malformed one did not quietly drop the rest of the family.
    expect(report.checks.some((c) => c.id === 'file.README.md')).toBe(true);
  });

  it('ValidatePluginPolicy_ShippedPolicy_UsesOnlyKnownKeys', () => {
    // The negative twin: the live policy raises nothing, so the rejections above
    // are attributable to the typo rather than to a schema that rejects
    // everything. Includes the `$comment` prose channel, admitted at the root.
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(conformingFiles()));
    expect(report.violations).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(Object.keys(shippedPolicy())).toContain('$comment');
  });
});

describe('validate-plugin — the shipped policy vs the shipped tree (task 064, DR-24)', () => {
  const report: Report = evaluatePackaging(shippedPolicy(), diskTree(REPO_ROOT));

  it('ValidatePlugin_ShippedTree_SatisfiesTheShippedPolicy', () => {
    const failures = report.checks.filter((c) => !c.passed);
    expect(failures.map((f) => `${f.id}: ${f.detail ?? ''}`)).toEqual([]);
    expect(report.violations).toEqual([]);
    expect(isClean(report)).toBe(true);
  });

  it.each([
    ['.mcp.json stays absent (2b62e1bf3)', 'forbidden-file..mcp.json'],
    ['plugin.json does not declare `hooks` (e334a392b)', 'manifest.forbidden-field.hooks'],
    ['hooks.json ships SessionStart (#1485)', 'hooks.expected.SessionStart'],
    ['hooks.json does not ship SessionEnd (DR-7 / task 016)', 'hooks.retired.SessionEnd'],
  ])('ValidatePlugin_FormerlyInvertedClause_%s', (_label, id) => {
    // The four clauses the old bash gate had backwards. Each is now stated once,
    // in the policy, in the direction the repo actually decided.
    const result = check(report, id);
    expect(result, `${id} is not among the checks the policy produces`).toBeDefined();
    expect(result?.passed).toBe(true);
  });

  it('ValidatePlugin_PolicyHookSet_MatchesTheAssertionsInPluginValidationTest', () => {
    // The divergence this task removed was between the gate and the test suite.
    // This asserts they now agree by construction, against the shipped file.
    const policy = shippedPolicy() as { hooks: { expected: { type: string }[] } };
    const declared = Object.keys(
      (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
        hooks: Record<string, unknown>;
      }).hooks,
    ).sort();
    expect(policy.hooks.expected.map((h) => h.type).sort()).toEqual(declared);
    expect(declared).toEqual(['SessionStart', 'SubagentStop']);
  });

  it('ValidatePlugin_EveryPolicyEntry_CarriesItsReason', () => {
    // Provenance is the thing that would have let a reader in 2026-08 tell
    // "the package regressed" from "the gate is describing a package that
    // stopped existing". An entry without `because` cannot support that call.
    const policy = shippedPolicy() as Record<string, unknown>;
    const manifest = policy.manifest as Record<string, unknown>;
    const hooks = policy.hooks as Record<string, unknown>;
    const entries: { where: string; entry: { because?: string } }[] = [
      ...(manifest.requiredFields as { because?: string }[]).map((e) => ({ where: 'manifest.requiredFields', entry: e })),
      ...(manifest.forbiddenFields as { because?: string }[]).map((e) => ({ where: 'manifest.forbiddenFields', entry: e })),
      ...((manifest.mcpServers as { expected: { because?: string }[] }).expected).map((e) => ({ where: 'manifest.mcpServers.expected', entry: e })),
      ...(policy.requiredDirs as { because?: string }[]).map((e) => ({ where: 'requiredDirs', entry: e })),
      ...(policy.requiredFiles as { because?: string }[]).map((e) => ({ where: 'requiredFiles', entry: e })),
      ...(policy.forbiddenFiles as { because?: string }[]).map((e) => ({ where: 'forbiddenFiles', entry: e })),
      ...(hooks.expected as { because?: string }[]).map((e) => ({ where: 'hooks.expected', entry: e })),
      ...(hooks.retired as { because?: string }[]).map((e) => ({ where: 'hooks.retired', entry: e })),
      ...(hooks.forbiddenTokens as { because?: string }[]).map((e) => ({ where: 'hooks.forbiddenTokens', entry: e })),
    ];
    expect(entries.length).toBeGreaterThan(0);
    const unexplained = entries
      .filter(({ entry }) => typeof entry.because !== 'string' || entry.because.trim() === '')
      .map(({ where }) => where);
    expect(unexplained).toEqual([]);
  });
});

describe('validate-plugin — CLI (task 064, DR-24)', () => {
  function runGate(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('node', [GATE, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('ValidatePluginCli_ShippedTree_ExitsZero', () => {
    const { status, stdout } = runGate([]);
    expect(status).toBe(0);
    expect(stdout).toContain('**Result: PASS**');
  }, 20000);

  it('ValidatePluginCli_SeededBrokenTree_ExitsOneAndNamesEveryFailure', () => {
    // A real tree on disk, missing skills/ AND carrying a forbidden .mcp.json:
    // both failures must appear in one run. The old gate reported them too, but
    // only because bash `check` accumulated — the property is worth pinning.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-plugin-fixture-'));
    try {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
      const files = conformingFiles();
      fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), files['.claude-plugin/plugin.json']);
      fs.writeFileSync(path.join(dir, 'hooks/hooks.json'), files['hooks/hooks.json']);
      fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"exarchos":{}}}');

      const { status, stdout } = runGate([
        '--repo-root',
        dir,
        '--policy',
        path.join(REPO_ROOT, DEFAULT_POLICY_PATH),
        '--json',
      ]);
      expect(status).toBe(1);
      const parsed = JSON.parse(stdout) as Report & { ok: boolean };
      expect(parsed.ok).toBe(false);
      const failedIds = parsed.checks.filter((c) => !c.passed).map((c) => c.id);
      expect(failedIds).toContain('dir.skills');
      expect(failedIds).toContain('forbidden-file..mcp.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('ValidatePluginCli_UnreadablePolicy_ExitsTwoNotZero', () => {
    const { status, stderr } = runGate(['--policy', '.claude-plugin/does-not-exist.json']);
    expect(status).toBe(2);
    expect(stderr).toContain('could not be read');
  }, 20000);

  it('ValidatePluginCli_UnknownArgument_ExitsTwo', () => {
    const { status } = runGate(['--nope']);
    expect(status).toBe(2);
  }, 20000);
});
