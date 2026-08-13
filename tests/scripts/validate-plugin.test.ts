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
 *      src/install/plugin-validation.test.ts, so a future edit cannot resurrect the
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
// The gate has no `.d.ts`, but `allowJs` lets the checker read the `.mjs` and
// infer one, so this import is typed rather than suppressed.
import {
  evaluatePackaging,
  isClean,
  renderReport,
  diskTree,
  DEFAULT_POLICY_PATH,
} from '../../scripts/validate-plugin.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '../..');
const GATE = path.join(SCRIPTS_DIR, '../../scripts/validate-plugin.mjs');

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

/** An in-memory TreeReader over the maps above. */
function memoryTree(files: Record<string, string>, dirs: string[] = CONFORMING_DIRS) {
  return {
    fileExists: (rel: string) => Object.hasOwn(files, rel),
    dirExists: (rel: string) => dirs.includes(rel),
    // Narrowed by reading once, not by `Object.hasOwn`: the guard proves the
    // key is present but tells the checker nothing about the value, so the
    // reader's return type stayed `string | undefined` and did not satisfy
    // `TreeReader`. Same throw, same message, one lookup.
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

  it('ValidatePlugin_ForbiddenManifestFieldPresent_Fails', () => {
    // The exact regression that made the OLD gate wrong, now asserted in the
    // direction the repo actually decided: declaring `hooks` double-registers.
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

  it('ValidatePlugin_ExtraBundledMcpServer_Fails', () => {
    const files = conformingFiles();
    const manifest = JSON.parse(fileAt(files, '.claude-plugin/plugin.json')) as Record<string, unknown>;
    (manifest.mcpServers as Record<string, unknown>).stowaway = { type: 'stdio' };
    files['.claude-plugin/plugin.json'] = JSON.stringify(manifest);
    const report: Report = evaluatePackaging(shippedPolicy(), memoryTree(files));
    expect(check(report, 'manifest.mcp-servers.exact')?.passed).toBe(false);
    // The named server is still present — only the exactness clause trips.
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

  it('ValidatePlugin_UnlistedHookType_FailsTheExactnessClause', () => {
    // A hook type nobody retired and nobody expected is still a new enforcement
    // surface arriving by the back door — `exact` is what catches it.
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
      fs.mkdirSync(path.join(dir, 'rendered', 'commands'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
      const files = conformingFiles();
      fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), fileAt(files, '.claude-plugin/plugin.json'));
      fs.writeFileSync(path.join(dir, 'hooks/hooks.json'), fileAt(files, 'hooks/hooks.json'));
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
      expect(failedIds).toContain('dir.rendered/skills');
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
