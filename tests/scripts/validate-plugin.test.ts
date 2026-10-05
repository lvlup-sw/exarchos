/**
 * Self-tests for the plugin-packaging gate (`tools/audit/gates/validate-plugin.mjs`).
 *
 * The expectations of the gate are data in `.claude-plugin/packaging-policy.json`, so the
 * tests have two parts:
 *
 *   A. The interpreter. Each policy clause gives a check, and each check can fail. These
 *      tests use seeded trees, not the repository tree.
 *   B. The shipped policy. It must describe the shipped package.
 *
 * The gate is an `.mjs` module with no `.d.ts` file. `allowJs` in `tests/tsconfig.json`
 * lets the checker infer its types.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePackaging,
  isClean,
  renderReport,
  diskTree,
  DEFAULT_POLICY_PATH,
} from '../../tools/audit/gates/validate-plugin.mjs';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../..');
const GATE = path.join(SCRIPTS_DIR, '../../tools/audit/gates/validate-plugin.mjs');

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
 * The minimum file tree that satisfies the shipped policy. It is a plain map, so a test
 * can delete or change one entry and see one check fail.
 */
function conformingFiles(): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'exarchos',
      version: '9.9.9',
      commands: './rendered/commands/',
      skills: './rendered/skills/',
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

const CONFORMING_DIRS = ['rendered/commands', 'rendered/skills'];

/**
 * An in-memory `TreeReader` over a file map and a directory list. `readText` narrows with
 * one lookup, because `Object.hasOwn` does not narrow the value type for the checker.
 */
function memoryTree(files: Record<string, string>, dirs: string[] = CONFORMING_DIRS) {
  return {
    fileExists: (rel: string) => Object.hasOwn(files, rel),
    dirExists: (rel: string) => dirs.includes(rel),
    readText: (rel: string): string => {
      const text = files[rel];
      if (text === undefined) throw new Error(`ENOENT: ${rel}`);
      return text;
    },
  };
}

/** Fixture lookup that names the absent key rather than yielding `undefined`. */
function fileAt(files: Record<string, string>, rel: string): string {
  const text = files[rel];
  if (text === undefined) throw new Error(`fixture has no ${rel}`);
  return text;
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
    const manifest = JSON.parse(fileAt(files, '.claude-plugin/plugin.json')) as Record<string, unknown>;
    delete manifest.skills;
    files['.claude-plugin/plugin.json'] = JSON.stringify(manifest);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'manifest.field.skills')?.passed).toBe(false);
    expect(isClean(report)).toBe(false);
  });

  /** A `hooks` field in `plugin.json` registers the hooks a second time, so the policy forbids it. */
  it('ValidatePlugin_ForbiddenManifestFieldPresent_Fails', () => {
    const files = conformingFiles();
    const manifest = JSON.parse(fileAt(files, '.claude-plugin/plugin.json')) as Record<string, unknown>;
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
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(conformingFiles(), ['rendered/commands']));
    expect(check(report, 'dir.rendered/skills')?.passed).toBe(false);
  });

  /** The named server stays present, so only the exactness clause fails. */
  it('ValidatePlugin_ExtraBundledMcpServer_Fails', () => {
    const files = conformingFiles();
    const manifest = JSON.parse(fileAt(files, '.claude-plugin/plugin.json')) as Record<string, unknown>;
    (manifest.mcpServers as Record<string, unknown>).stowaway = { type: 'stdio' };
    files['.claude-plugin/plugin.json'] = JSON.stringify(manifest);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'manifest.mcp-servers.exact')?.passed).toBe(false);
    expect(check(report, 'manifest.mcp-server.exarchos')?.passed).toBe(true);
  });

  it('ValidatePlugin_RetiredHookReintroduced_Fails', () => {
    const files = conformingFiles();
    const hooks = JSON.parse(fileAt(files, 'hooks/hooks.json')) as { hooks: Record<string, unknown> };
    hooks.hooks.PreToolUse = [{ hooks: [{ type: 'command', command: 'exarchos guard' }] }];
    files['hooks/hooks.json'] = JSON.stringify(hooks);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.retired.PreToolUse')?.passed).toBe(false);
    expect(check(report, 'hooks.exact')?.passed).toBe(false);
  });

  /**
   * A hook type that is not expected and not retired is still a new enforcement surface.
   * Only the `exact` clause catches it.
   */
  it('ValidatePlugin_UnlistedHookType_FailsTheExactnessClause', () => {
    const files = conformingFiles();
    const hooks = JSON.parse(fileAt(files, 'hooks/hooks.json')) as { hooks: Record<string, unknown> };
    hooks.hooks.Notification = [{ hooks: [{ type: 'command', command: 'exarchos whatever' }] }];
    files['hooks/hooks.json'] = JSON.stringify(hooks);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.exact')?.passed).toBe(false);
    expect(check(report, 'hooks.exact')?.detail).toContain('Notification');
  });

  it('ValidatePlugin_MissingExpectedHook_Fails', () => {
    const files = conformingFiles();
    const hooks = JSON.parse(fileAt(files, 'hooks/hooks.json')) as { hooks: Record<string, unknown> };
    delete hooks.hooks.SubagentStop;
    files['hooks/hooks.json'] = JSON.stringify(hooks);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.expected.SubagentStop')?.passed).toBe(false);
  });

  it('ValidatePlugin_UnsubstitutedCliPathPlaceholder_Fails', () => {
    const files = conformingFiles();
    files['hooks/hooks.json'] = fileAt(files, 'hooks/hooks.json').replace(
      'exarchos session-start',
      'node "{{CLI_PATH}}" session-start',
    );
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'hooks.token.{{CLI_PATH}}')?.passed).toBe(false);
  });

  /**
   * With invalid JSON, the parse clause fails. Each `expected` clause and the `exact`
   * clause also fail, because the declared set is unknown. The token sweep reads the raw
   * text, so it passes. The run still fails.
   */
  it('ValidatePlugin_UnparseableHooksJson_FailsTheParseButStillSweepsTheText', () => {
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

  /**
   * No package can satisfy a policy that lists one hook as expected and as retired. The
   * report must name the policy as the fault, not the package.
   */
  it('ValidatePlugin_SelfContradictoryHookPolicy_IsReportedAsAPolicyViolation', () => {
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

/**
 * The interpreter treats an absent family as empty, so it never looks for a family under
 * a misspelled key. The zero-checks rule fails only when all families are absent. Thus
 * one typo removes the checks of one family while the gate exits 0, unless the schema
 * rejects the unknown key.
 */
describe('validate-plugin — the policy is validated before it is interpreted', () => {
  const baselineCheckCount = (): number =>
    (evaluatePackaging(shippedPolicy(), memoryTree(conformingFiles())) as Report).checks.length;

  /**
   * The typo changes one character of `requiredFiles`. The test first proves that the
   * `file.` checks are gone. Thus the violation reports a real loss of coverage, not a
   * harmless key.
   */
  it('ValidatePluginPolicy_UnknownTopLevelKey_IsReportedAsFinding', () => {
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    const before = baselineCheckCount();

    policy['requiredfiles'] = policy['requiredFiles'];
    delete policy['requiredFiles'];

    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));

    expect(report.checks.length).toBeLessThan(before);
    expect(report.checks.filter((c) => c.id.startsWith('file.'))).toEqual([]);

    expect(report.violations.join('\n')).toContain('[policy-unknown-key]');
    expect(report.violations.join('\n')).toContain('requiredfiles');
    expect(isClean(report)).toBe(false);
  });

  /**
   * Three families have misspelled keys. Each remaining check passes and the zero-checks
   * rule stays silent, so only the three unknown-key violations fail the run.
   */
  it('ValidatePluginPolicy_ThreeDroppedFamilies_NoLongerExitZero', () => {
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    for (const [wrong, right] of [
      ['requiredfiles', 'requiredFiles'],
      ['requireddirs', 'requiredDirs'],
      ['forbiddenfiles', 'forbiddenFiles'],
    ] as const) {
      policy[wrong] = policy[right];
      delete policy[right];
    }

    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.violations.filter((v) => v.includes('[policy-unknown-key]'))).toHaveLength(3);
    expect(isClean(report)).toBe(false);
  });

  /**
   * A nested typo also removes its family. The schema thus checks the keys one level down
   * and the keys of an array entry.
   */
  it('ValidatePluginPolicy_TypoOneLevelDown_IsAlsoReported', () => {
    const nested = clone(shippedPolicy()) as { hooks: Record<string, unknown> };
    nested.hooks['retried'] = nested.hooks['retired'];
    delete nested.hooks['retired'];
    const hooksReport: Report = evaluatePackaging(nested, memoryTree(conformingFiles()));
    expect(hooksReport.violations.join('\n')).toContain('[policy-unknown-key]');
    expect(hooksReport.violations.join('\n')).toContain('hooks.retried');
    expect(hooksReport.checks.filter((c) => c.id.startsWith('hooks.retired.'))).toEqual([]);

    const entry = clone(shippedPolicy()) as { requiredFiles: Record<string, unknown>[] };
    entry.requiredFiles[0]!['pth'] = entry.requiredFiles[0]!['path'];
    delete entry.requiredFiles[0]!['path'];
    const entryReport: Report = evaluatePackaging(entry, memoryTree(conformingFiles()));
    expect(entryReport.violations.join('\n')).toContain('[policy-unknown-key]');
    expect(entryReport.violations.join('\n')).toContain('requiredFiles[0].pth');
    expect(entryReport.violations.join('\n')).toContain('[policy-incomplete]');
    expect(isClean(entryReport)).toBe(false);
  });

  /** A family of the wrong type gives no checks, which looks the same as a family that passed. */
  it('ValidatePluginPolicy_FamilyOfTheWrongType_IsReported', () => {
    const policy = clone(shippedPolicy()) as Record<string, unknown>;
    policy['requiredFiles'] = {};
    const report: Report = evaluatePackaging(policy, memoryTree(conformingFiles()));
    expect(report.violations.join('\n')).toContain('[policy-type]');
    expect(isClean(report)).toBe(false);
  });

  /** The failure message prints `because` and `decidedIn` as the citation, so each must be a string. */
  it('ValidatePluginPolicy_NonStringProvenance_IsReported', () => {
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

  /**
   * The gate must report each violation, and a `TypeError` reports only one. A null entry
   * and a null `hooks` family must each give a violation, not a throw. The gate must still
   * interpret the valid entry of the same family.
   */
  it('ValidatePluginPolicy_MalformedFamilies_AccumulateRatherThanThrow', () => {
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
    expect(report.checks.some((c) => c.id === 'file.README.md')).toBe(true);
  });

  /**
   * The control: the shipped policy gives no violation, so the rejections in the other
   * tests come from the bad keys. The shipped policy holds a `$comment` key, which the
   * schema accepts at the root.
   */
  it('ValidatePluginPolicy_ShippedPolicy_UsesOnlyKnownKeys', () => {
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

  /** An earlier bash gate stated each of these four clauses in the opposite direction. */
  it.each([
    ['.mcp.json stays absent (2b62e1bf3)', 'forbidden-file..mcp.json'],
    ['plugin.json does not declare `hooks` (e334a392b)', 'manifest.forbidden-field.hooks'],
    ['hooks.json ships SessionStart (#1485)', 'hooks.expected.SessionStart'],
    ['hooks.json does not ship SessionEnd (DR-7 / task 016)', 'hooks.retired.SessionEnd'],
  ])('ValidatePlugin_FormerlyInvertedClause_%s', (_label, id) => {
    const result = check(report, id);
    expect(result, `${id} is not among the checks the policy produces`).toBeDefined();
    expect(result?.passed).toBe(true);
  });

  /**
   * The expected hook types of the policy must equal the hook types of the shipped
   * `hooks/hooks.json`. `tests/unit/install/plugin-validation.test.ts` asserts the same
   * two types.
   */
  it('ValidatePlugin_PolicyHookSet_MatchesTheAssertionsInPluginValidationTest', () => {
    const policy = shippedPolicy() as { hooks: { expected: { type: string }[] } };
    const declared = Object.keys(
      (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
        hooks: Record<string, unknown>;
      }).hooks,
    ).sort();
    expect(policy.hooks.expected.map((h) => h.type).sort()).toEqual(declared);
    expect(declared).toEqual(['SessionStart', 'SubagentStop']);
  });

  /** With the `because` text, a reader can tell a package regression from a stale policy entry. */
  it('ValidatePlugin_EveryPolicyEntry_CarriesItsReason', () => {
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
  async function runGate(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const result = await spawnAsync('node', [GATE, ...args], { cwd: REPO_ROOT });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  it('ValidatePluginCli_ShippedTree_ExitsZero', async () => {
    const { status, stdout } = await runGate([]);
    expect(status).toBe(0);
    expect(stdout).toContain('**Result: PASS**');
  }, 20000);

  /**
   * The tree on disk has no `rendered/skills` directory and holds a forbidden `.mcp.json`.
   * One run must report the two failures.
   */
  it('ValidatePluginCli_SeededBrokenTree_ExitsOneAndNamesEveryFailure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-plugin-fixture-'));
    try {
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'rendered', 'commands'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
      const files = conformingFiles();
      fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), fileAt(files, '.claude-plugin/plugin.json'));
      fs.writeFileSync(path.join(dir, 'hooks/hooks.json'), fileAt(files, 'hooks/hooks.json'));
      fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"exarchos":{}}}');

      const { status, stdout } = await runGate([
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
      expect(failedIds).toContain('dir.rendered/skills');
      expect(failedIds).toContain('forbidden-file..mcp.json');
    } finally {
      rmrf(dir);
    }
  }, 20000);

  it('ValidatePluginCli_UnreadablePolicy_ExitsTwoNotZero', async () => {
    const { status, stderr } = await runGate(['--policy', '.claude-plugin/does-not-exist.json']);
    expect(status).toBe(2);
    expect(stderr).toContain('could not be read');
  }, 20000);

  it('ValidatePluginCli_UnknownArgument_ExitsTwo', async () => {
    const { status } = await runGate(['--nope']);
    expect(status).toBe(2);
  }, 20000);
});
