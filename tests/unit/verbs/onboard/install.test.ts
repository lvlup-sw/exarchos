/**
 * Tests for the onboard install step and the rename migration.
 *
 * `makeInstallStep` copies the skills bundle from a local source through the real `installSkills` seam.
 * It starts no process. A missing local source fails the step with a refusal, and the step never runs
 * `npx skills add` or the install command of the project.
 *
 * The hook has no surface guard. The core `apply` router calls `ctx.installStep` only on the
 * `cli` surface and gives an advisory on other surfaces.
 *
 * `onboardMigrate` removes an old-name skill directory only when provenance proves that
 * Exarchos installed it.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ApplyCtx } from '../../../../src/dispatch/core/onboarding/reconcile.js';
import type { PlanStep } from '../../../../src/dispatch/core/onboarding/types.js';
import type { CheckResult } from '../../../../src/verbs/doctor/schema.js';
import { buildWriterDeps } from '../../../../src/verbs/init/probes.js';
import type { WriterDeps } from '../../../../src/verbs/init/probes.js';

import {
  handleOnboard,
  type HandleOnboardArgs,
  type OnboardDeps,
  defaultOnboardDeps,
} from '../../../../src/verbs/onboard/index.js';
import { makeInstallStep, type InstallStepDeps } from '../../../../src/verbs/onboard/install.js';
import {
  onboardMigrate,
  hashInstalledSkillDir,
  hashInstalledSkillMd,
  RENAMED_AWAY_SKILL_DIRS,
  type ProvenanceManifest,
  type RuntimeSkillsTarget,
} from '../../../../src/verbs/onboard/install.js';
import {
  hashSkillDirContent,
  hashSkillMdContent,
} from '../../../../src/install/install-skills.js';
import { rmrfAsync, rmrf } from '../../../../tools/test-helpers/temp-dir.js';

interface Fixture {
  readonly repoRoot: string;
  readonly home: string;
  readonly stateDir: string;
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

/**
 * Creates a temp Node repo, an isolated home for the skills target, and an isolated store.
 * The `package-lock.json` gives the repo a resolvable npm install command, which the step must not run.
 */
async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'onboard-install-'));
  const repoRoot = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const stateDir = path.join(base, 'state');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(repoRoot, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '0.0.0', scripts: { 'test:run': 'vitest run' } },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(path.join(repoRoot, 'package-lock.json'), '{}\n', 'utf8');
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false, cwd: repoRoot };
  return { repoRoot, home, stateDir, base, ctx, eventStore };
}

async function cleanup(fx: Fixture): Promise<void> {
  await rmrfAsync(fx.base).catch(
    () => {},
  );
}

/** Real `WriterDeps` with `cwd` at the fixture repo and `home` at the fixture home. */
function fixtureWriterDeps(fx: Fixture): WriterDeps {
  const real = buildWriterDeps();
  return { ...real, cwd: () => fx.repoRoot, home: () => fx.home };
}

/** Builds a minimal `install` plan step, the kind that the reconciler routes to the install hook. */
function installPlanStep(): PlanStep {
  return {
    kind: 'install',
    surface: 'cli-only',
    key: 'plugin-skill-hash-sync',
    description: 'reinstall the skills bundle',
  };
}

/** Builds an `ApplyCtx` for the fixture. The default surface is `cli`, where the install hook runs. */
function applyCtx(fx: Fixture, surface: ApplyCtx['surface'] = 'cli'): ApplyCtx {
  return {
    repoRoot: fx.repoRoot,
    surface,
    force: false,
    writerDeps: fixtureWriterDeps(fx),
    writers: [],
  };
}

/**
 * Writes a fake skills source at `<base>/skills/claude/ideate/` for the local-copy fast path.
 * Returns the parent `skills/` directory.
 */
async function seedSkillsSource(fx: Fixture): Promise<string> {
  const skillsRoot = path.join(fx.base, 'skills');
  const runtimeDir = path.join(skillsRoot, 'claude', 'ideate');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, 'SKILL.md'), '# ideate\n', 'utf8');
  return skillsRoot;
}

describe('installStep (local skills copy)', () => {
  /**
   * A fake copy records its calls. The test sets `agent` to skip runtime detection, and a stub `registerMcp` writes no `~/.claude.json`.
   * The local source gives a copy, and a missing source gives the refusal that names the plugin and `exarchos skills get`.
   * The step forwards `localSourceOnly`, so `installSkills` never reaches `npx skills add`, and the repo gets no `node_modules`.
   * A `PATH` with no programs makes a regression fail on a missing `npx`, and not install skills into the real home of the user.
   */
  it('Install_LocalCopyFastPath_MissingSourceRefusesWithNoProcess', async () => {
    const fx = await createFixture();
    vi.stubEnv('PATH', path.join(fx.base, 'no-bin'));
    try {
      const skillsSource = await seedSkillsSource(fx);

      const copyDir = vi.fn((_src: string, _dest: string) => {});

      const deps: InstallStepDeps = {
        agent: 'claude',
        resolveSkillsSource: () => skillsSource,
        runtimes: [
          {
            name: 'claude',
            skillsInstallPath: path.join(fx.home, '.claude', 'skills'),
          } as never,
        ],
        homeDir: () => fx.home,
        copyDir,
        registerMcp: () => {},
        log: () => {},
        errLog: () => {},
      };

      const step = installPlanStep();
      const ctx = applyCtx(fx);
      const installStep = makeInstallStep(deps);

      await installStep(step, ctx);

      expect(copyDir).toHaveBeenCalled();
      expect(nodeFs.existsSync(path.join(fx.repoRoot, 'node_modules'))).toBe(false);

      const forwarded: { localSourceOnly?: boolean }[] = [];
      await makeInstallStep({
        ...deps,
        resolveSkillsSource: () => undefined,
        runSkillsInstall: async (opts) => {
          forwarded.push(opts);
        },
      })(step, ctx);
      expect(forwarded.map((o) => o.localSourceOnly)).toEqual([true]);

      const copyDir2 = vi.fn((_src: string, _dest: string) => {});
      const missingSourceStep = makeInstallStep({
        ...deps,
        resolveSkillsSource: () => undefined,
        copyDir: copyDir2,
      });
      await expect(missingSourceStep(step, ctx)).rejects.toThrow(
        /No local skills source was found for runtime "claude"[\s\S]*Exarchos plugin[\s\S]*`exarchos skills get`/,
      );
      expect(copyDir2).not.toHaveBeenCalled();
      expect(nodeFs.existsSync(path.join(fx.repoRoot, 'node_modules'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await cleanup(fx);
    }
  });

  /**
   * The rename migration removes old skill directories, so it must not run when the install refuses.
   * With no local source the step refuses and the migration does not run. With a local source the migration runs once, before the first copy.
   */
  it('Install_MigrationRunsOnlyBeforeALocalCopy_NeverOnARefusal', async () => {
    const fx = await createFixture();
    vi.stubEnv('PATH', path.join(fx.base, 'no-bin'));
    try {
      const skillsSource = await seedSkillsSource(fx);
      const order: string[] = [];
      const deps: InstallStepDeps = {
        agent: 'claude',
        runtimes: [
          { name: 'claude', skillsInstallPath: path.join(fx.home, '.claude', 'skills') } as never,
        ],
        homeDir: () => fx.home,
        copyDir: () => { order.push('copy'); },
        registerMcp: () => {},
        log: () => {},
        errLog: () => {},
        runMigrate: () => { order.push('migrate'); },
      };
      const step = installPlanStep();
      const ctx = applyCtx(fx);

      await expect(makeInstallStep({ ...deps, resolveSkillsSource: () => undefined })(step, ctx)).rejects.toThrow(
        /No local skills source was found for runtime "claude"/,
      );
      expect(order).toEqual([]);

      await makeInstallStep({ ...deps, resolveSkillsSource: () => skillsSource })(step, ctx);
      expect(order[0]).toBe('migrate');
      expect(order.filter((entry) => entry === 'migrate')).toHaveLength(1);
      expect(order.slice(1).every((entry) => entry === 'copy')).toBe(true);
      expect(order.length).toBeGreaterThan(1);
    } finally {
      vi.unstubAllEnvs();
      await cleanup(fx);
    }
  });

  /**
   * The GENERATE step of the reconciler owns MCP registration. The default `registerMcp` of
   * `installSkills` writes `~/.claude.json`, so the install step must pass a no-op, or claude
   * repos register twice. The test injects no `registerMcp`. It captures the function that the
   * step forwards and calls it to prove that it writes nothing.
   */
  it('Install_DoesNotRegisterMcp_SingleRegistrationInGenerate', async () => {
    const fx = await createFixture();
    try {
      const skillsSource = await seedSkillsSource(fx);

      let capturedRegisterMcp: ((home: string) => void) | undefined;
      const runSkillsInstall = vi.fn(async (opts: { registerMcp?: (home: string) => void }) => {
        capturedRegisterMcp = opts.registerMcp;
      });

      const deps: InstallStepDeps = {
        agent: 'claude',
        resolveSkillsSource: () => skillsSource,
        runtimes: [
          { name: 'claude', skillsInstallPath: path.join(fx.home, '.claude', 'skills') } as never,
        ],
        homeDir: () => fx.home,
        runSkillsInstall,
      };

      const step = installPlanStep();
      const ctx = applyCtx(fx);
      const installStep = makeInstallStep(deps);
      await installStep(step, ctx);

      expect(runSkillsInstall).toHaveBeenCalledTimes(1);
      expect(typeof capturedRegisterMcp).toBe('function');

      const claudeJson = path.join(fx.home, '.claude.json');
      capturedRegisterMcp!(fx.home);
      const homeEntries = await readdir(fx.home).catch(() => [] as string[]);
      expect(homeEntries).not.toContain('.claude.json');
      await expect(readFile(claudeJson, 'utf8')).rejects.toThrow();
    } finally {
      await cleanup(fx);
    }
  });

  /**
   * `defaultOnboardDeps` must supply a real install step, and a spy replaces it for the run.
   * The doctor stub gives one cli-only install failure before apply and a pass after it. On the
   * `cli` surface the pipeline calls the step. On `any`, the surface that the MCP adapter stamps,
   * the core does not call the step and gives a cli-only advisory.
   */
  it('Install_WiredIntoDefaultOnboardDeps_CliSurface', async () => {
    const fx = await createFixture();
    try {
      const INSTALL_FAIL: CheckResult = {
        category: 'plugin',
        name: 'plugin-skill-hash-sync',
        status: 'Fail',
        message: 'skills bundle out of sync',
        fix: 'reinstall the skills bundle',
        durationMs: 0,
      };
      const GREEN: CheckResult = {
        category: 'plugin',
        name: 'plugin-skill-hash-sync',
        status: 'Pass',
        message: 'skills bundle in sync',
        durationMs: 0,
      };

      const prodDeps = defaultOnboardDeps(fx.ctx, {});
      expect(typeof prodDeps.installStep).toBe('function');

      const installSpy = vi.fn().mockResolvedValue(undefined);

      let phase = 0;
      const runDoctorChecks = async (): Promise<readonly CheckResult[]> => {
        phase += 1;
        return phase === 1 ? [INSTALL_FAIL] : [GREEN];
      };

      const baseDeps: OnboardDeps = {
        ...prodDeps,
        repoRoot: fx.repoRoot,
        writerDeps: fixtureWriterDeps(fx),
        writers: [],
        runDoctorChecks,
        seed: vi.fn(() => ({ wrote: true, path: path.join(fx.repoRoot, '.exarchos.yml') })),
        detectOptions: { detectRuntimes: async () => [], vcs: 'git' },
      };

      const cliDeps: OnboardDeps = { ...baseDeps, installStep: installSpy };
      const cliArgs: HandleOnboardArgs = { surface: 'cli', format: 'json' };
      const cliResult = await handleOnboard(cliArgs, fx.ctx, cliDeps);

      expect(cliResult.success).toBe(true);
      expect(installSpy).toHaveBeenCalled();
      const cliData = cliResult.data as {
        result: { applied: { key: string }[]; advisories: { surface: string }[] };
        verify: { residualBlocking: number };
      };
      expect(cliData.result.applied.map((s) => s.key)).toContain('plugin-skill-hash-sync');
      expect(cliData.verify.residualBlocking).toBe(0);

      let phase2 = 0;
      const runDoctorChecks2 = async (): Promise<readonly CheckResult[]> => {
        phase2 += 1;
        return phase2 === 1 ? [INSTALL_FAIL] : [INSTALL_FAIL];
      };
      const installSpy2 = vi.fn().mockResolvedValue(undefined);
      const mcpDeps: OnboardDeps = {
        ...baseDeps,
        runDoctorChecks: runDoctorChecks2,
        installStep: installSpy2,
      };
      const mcpArgs: HandleOnboardArgs = { surface: 'any', format: 'json' };
      const mcpResult = await handleOnboard(mcpArgs, fx.ctx, mcpDeps);

      expect(installSpy2).not.toHaveBeenCalled();
      const mcpData = mcpResult.data as {
        result: { applied: { key: string }[]; advisories: { surface: string; commands?: string[] }[] };
      };
      expect(mcpData.result.applied.map((s) => s.key)).not.toContain('plugin-skill-hash-sync');
      const advisorySurfaces = mcpData.result.advisories.map((a) => a.surface);
      expect(advisorySurfaces).toContain('cli-only');
    } finally {
      await cleanup(fx);
    }
  });
});

/** Each fixture has one claude runtime, and `loc` is the skills directory that the migration scans. */
describe('onboardMigrate (DR-3/DR-8 — stale old-name skill dir reconcile)', () => {
  interface MigrateFixture {
    readonly base: string;
    readonly home: string;
    readonly projectRoot: string;
    readonly loc: string;
    readonly runtimes: readonly RuntimeSkillsTarget[];
  }

  function makeMigrateFixture(): MigrateFixture {
    const base = nodeFs.mkdtempSync(path.join(tmpdir(), 'onboard-migrate-'));
    const home = path.join(base, 'home');
    const projectRoot = path.join(base, 'project');
    const loc = path.join(base, 'claude-skills');
    nodeFs.mkdirSync(home, { recursive: true });
    nodeFs.mkdirSync(projectRoot, { recursive: true });
    nodeFs.mkdirSync(loc, { recursive: true });
    return {
      base,
      home,
      projectRoot,
      loc,
      runtimes: [{ name: 'claude', skillsInstallPath: loc }],
    };
  }

  function placeSkillDir(parent: string, name: string, content: string): string {
    const dir = path.join(parent, name);
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8');
    return dir;
  }

  /** The install manifest records a whole-directory hash that matches the stale directory. */
  it('onboardMigrate_ManifestProvenance_Removed', () => {
    const fx = makeMigrateFixture();
    try {
      const content = '# brainstorming\n\nOrient the ideation workflow.\n';
      const staleDir = placeSkillDir(fx.loc, 'brainstorming', content);
      const manifest: ProvenanceManifest = {
        placements: [
          { path: fx.loc, hashes: { brainstorming: hashSkillDirContent(staleDir) } },
        ],
      };

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        installManifests: [manifest],
      });

      expect(result.removed.map((r) => r.path)).toContain(staleDir);
      expect(result.removed.find((r) => r.path === staleDir)?.via).toBe('install-manifest');
      expect(result.preserved).toEqual([]);
      expect(nodeFs.existsSync(staleDir)).toBe(false);
    } finally {
      rmrf(fx.base);
    }
  });

  /** The `SKILL.md` hash matches one entry in a set of legacy release hashes that also holds a decoy. */
  it('onboardMigrate_LegacyHashMatchAnyRelease_Removed', () => {
    const fx = makeMigrateFixture();
    try {
      const content = '# delegation\n\nDelegate to sub-agents.\n';
      const staleDir = placeSkillDir(fx.loc, 'delegation', content);
      const legacy = new Map<string, Set<string>>([
        ['delegation', new Set([hashSkillMdContent(content), 'a-different-release-hash'])],
      ]);

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        legacyHashesBySkill: legacy,
      });

      expect(result.removed.map((r) => r.path)).toContain(staleDir);
      expect(result.removed.find((r) => r.path === staleDir)?.via).toBe('legacy-hash');
      expect(nodeFs.existsSync(staleDir)).toBe(false);
    } finally {
      rmrf(fx.base);
    }
  });

  /**
   * The legacy hash covers the LF render, and the installed copy has CRLF line endings.
   * Newline normalization must make the hashes match.
   */
  it('onboardMigrate_CrlfInstalledCopy_StillMatches', () => {
    const fx = makeMigrateFixture();
    try {
      const lf = '# synthesis\n\nSynthesize the workflow outputs.\n';
      const legacyHash = hashSkillMdContent(lf);
      const staleDir = placeSkillDir(fx.loc, 'synthesis', lf.replace(/\n/g, '\r\n'));
      const legacy = new Map<string, Set<string>>([['synthesis', new Set([legacyHash])]]);

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        legacyHashesBySkill: legacy,
      });

      expect(result.removed.map((r) => r.path)).toContain(staleDir);
      expect(result.removed.find((r) => r.path === staleDir)?.via).toBe('legacy-hash');
      expect(nodeFs.existsSync(staleDir)).toBe(false);
    } finally {
      rmrf(fx.base);
    }
  });

  /**
   * The install location holds a symlink to a target outside the scanned location. The
   * migration removes the link and does not follow it, so the target stays.
   */
  it('onboardMigrate_SymlinkedInstall_RemovesLinkOnly', () => {
    const fx = makeMigrateFixture();
    try {
      const content = '# discovery\n\nDiscover prior workflows.\n';
      const targetParent = path.join(fx.base, 'shared-target');
      const targetDir = placeSkillDir(targetParent, 'discovery', content);
      const link = path.join(fx.loc, 'discovery');
      nodeFs.symlinkSync(targetDir, link);

      const legacy = new Map<string, Set<string>>([
        ['discovery', new Set([hashSkillMdContent(content)])],
      ]);

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        legacyHashesBySkill: legacy,
      });

      const removed = result.removed.find((r) => r.path === link);
      expect(removed).toBeDefined();
      expect(removed?.symlink).toBe(true);
      expect(nodeFs.existsSync(link)).toBe(false);
      expect(nodeFs.existsSync(path.join(targetDir, 'SKILL.md'))).toBe(true);
    } finally {
      rmrf(fx.base);
    }
  });

  /**
   * The content of the stale directory matches no provenance source, so the migration must keep
   * it. It warns once and reports the directory for the doctor finding.
   */
  it('onboardMigrate_UserModifiedDir_PreservedWithWarning', () => {
    const fx = makeMigrateFixture();
    try {
      const staleDir = placeSkillDir(
        fx.loc,
        'oneshot-workflow',
        '# oneshot-workflow\n\nHand-edited by the user.\n',
      );
      const warn = vi.fn();

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        installManifests: [{ placements: [] }],
        legacyHashesBySkill: new Map(),
        warn,
      });

      expect(result.removed).toEqual([]);
      expect(result.preserved.map((p) => p.path)).toContain(staleDir);
      expect(result.preserved[0]?.reason).toBe('no-provenance-match');
      expect(nodeFs.existsSync(path.join(staleDir, 'SKILL.md'))).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain(staleDir);
    } finally {
      rmrf(fx.base);
    }
  });

  /** The second run removes nothing and does not change the bytes of the modified directory. */
  it('onboardMigrate_RepeatedRuns_Idempotent', () => {
    const fx = makeMigrateFixture();
    try {
      const matchedContent = '# prune-workflows\n\nPrune stale workflows.\n';
      const matchedDir = placeSkillDir(fx.loc, 'prune-workflows', matchedContent);
      const modifiedDir = placeSkillDir(
        fx.loc,
        'authoring-invariants',
        '# authoring-invariants\n\nHand-edited.\n',
      );
      const legacy = new Map<string, Set<string>>([
        ['prune-workflows', new Set([hashSkillMdContent(matchedContent)])],
      ]);
      const run = (): ReturnType<typeof onboardMigrate> =>
        onboardMigrate({
          runtimes: fx.runtimes,
          homeDir: () => fx.home,
          projectRoot: fx.projectRoot,
          legacyHashesBySkill: legacy,
        });

      const first = run();
      expect(first.removed.map((r) => r.path)).toEqual([matchedDir]);
      expect(first.preserved.map((p) => p.path)).toEqual([modifiedDir]);
      expect(nodeFs.existsSync(matchedDir)).toBe(false);
      expect(nodeFs.existsSync(modifiedDir)).toBe(true);
      const modifiedBytes = nodeFs.readFileSync(path.join(modifiedDir, 'SKILL.md'));

      const second = run();
      expect(second.removed).toEqual([]);
      expect(second.preserved.map((p) => p.path)).toEqual([modifiedDir]);
      expect(nodeFs.existsSync(matchedDir)).toBe(false);
      expect(nodeFs.readFileSync(path.join(modifiedDir, 'SKILL.md'))).toEqual(modifiedBytes);
    } finally {
      rmrf(fx.base);
    }
  });

  /**
   * The migration acts only on retired skill names. A current skill directory in the same
   * location must stay and get no flag, even when a manifest vouches for it.
   */
  it('onboardMigrate_NewAndLiveSkillNames_NeverTargeted', () => {
    const fx = makeMigrateFixture();
    try {
      const liveDir = placeSkillDir(fx.loc, 'ideate', '# ideate\n');
      expect(RENAMED_AWAY_SKILL_DIRS).not.toContain('ideate');
      const manifest: ProvenanceManifest = {
        placements: [{ path: fx.loc, hashes: { ideate: hashSkillDirContent(liveDir) } }],
      };

      const result = onboardMigrate({
        runtimes: fx.runtimes,
        homeDir: () => fx.home,
        projectRoot: fx.projectRoot,
        installManifests: [manifest],
      });

      expect(result.removed).toEqual([]);
      expect(result.preserved).toEqual([]);
      expect(nodeFs.existsSync(liveDir)).toBe(true);
    } finally {
      rmrf(fx.base);
    }
  });

  /**
   * The migration hashers copy the hashers in `src/install/install-skills.ts`. This test fails
   * when an edit to one side makes their results differ, which breaks provenance matching.
   */
  it('migrationHashers_MirrorInstallSkillsSourceOfTruth', () => {
    const base = nodeFs.mkdtempSync(path.join(tmpdir(), 'migrate-hashguard-'));
    try {
      const dir = path.join(base, 'delegation');
      nodeFs.mkdirSync(path.join(dir, 'references'), { recursive: true });
      nodeFs.writeFileSync(path.join(dir, 'SKILL.md'), '# delegation\r\nline\r\n', 'utf8');
      nodeFs.writeFileSync(path.join(dir, 'references', 'r.md'), 'ref\nbody\n', 'utf8');

      expect(hashInstalledSkillDir(dir)).toBe(hashSkillDirContent(dir));
      expect(hashInstalledSkillMd(dir)).toBe(hashSkillMdContent('# delegation\r\nline\r\n'));
    } finally {
      rmrf(base);
    }
  });
});
