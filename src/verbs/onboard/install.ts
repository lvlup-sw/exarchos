/**
 * The skills and dependencies install hook behind {@link ApplyCtx.installStep}.
 * The reconciler calls it only on the CLI surface, and converts the step to an {@link Advisory} elsewhere. So this hook has no surface guard.
 *
 * It first removes stale skill directories from a skill rename, when provenance proves that Exarchos installed them.
 * Then it installs the skills bundle through `installSkills`, with a local-copy fast path and an `npx skills add` fallback.
 * Then it runs the project install command from `resolveTestRuntime(repoRoot).install`. A `null` command means no known toolchain, and the step does nothing.
 * All I/O is injected, so tests need no network `npx`.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { orchestrateLogger } from '../../logger.js';
import { atomicCopyTreeSync } from '../../install/atomic-promotion.js';

import type { ApplyCtx } from '../../dispatch/core/onboarding/reconcile.js';
import type { PlanStep } from '../../dispatch/core/onboarding/types.js';
import {
  resolveTestRuntime,
  type ResolvedRuntime,
} from '../../config/test-runtime-resolver.js';

/**
 * The injected side effects for {@link makeInstallStep}. Production uses {@link installStep}, with all defaults.
 * Most fields match the injection points of `installSkills`, and the bridge forwards them.
 */
export interface InstallStepDeps {
  /**
   * Resolves the skills source tree, the parent of `<runtime>/<skill>/SKILL.md`.
   * A value selects the local-copy fast path, and `undefined` selects `npx skills add`. When absent, the bridge uses `findSkillsSourceDir()`.
   */
  readonly resolveSkillsSource?: () => string | undefined;
  /** Resolves the `command-aliases/` source tree, so opencode aliases install with the skills. When absent, the bridge uses `findCommandAliasesSourceDir()`. */
  readonly resolveAliasesSource?: () => string | undefined;
  /** Target runtime id, such as `claude` or `codex`. When absent, `installSkills` detects the runtime. */
  readonly agent?: string;
  /** The runtime maps for the skills install. When absent, the bridge uses the generated `EMBEDDED_RUNTIMES`. */
  readonly runtimes?: readonly unknown[];
  /** Resolves the home directory of the user. Default `os.homedir`. */
  readonly homeDir?: () => string;
  /** Recursive directory copy for the fast path. Default `atomicCopyTreeSync`. */
  readonly copyDir?: (src: string, dest: string) => void;
  /** Single-file copy (command aliases). Default `fs.copyFileSync`. */
  readonly copyFile?: (src: string, dest: string) => void;
  /** Spawn for the `npx skills add` fallback. Tests inject a recorder, so the fallback never uses the network. */
  readonly spawn?: (
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ) => Promise<{ code: number; stderr: string }>;
  /** Registers the Exarchos MCP server in `~/.claude.json`. Default is a no-op. */
  readonly registerMcp?: (home: string) => void;
  /** Information log sink. */
  readonly log?: (msg: string) => void;
  /** Error logging sink. Default `console.error`. */
  readonly errLog?: (msg: string) => void;
  /**
   * Install scope for the `.agents/skills` path and the provenance manifest. Default `'project'`.
   * The manifest then goes under `<repoRoot>/.agents/`, so `doctor` can find layout drift per project.
   */
  readonly scope?: 'user' | 'project';
  /** Project root for `scope: 'project'`. Defaults to the apply `ctx.repoRoot`. */
  readonly projectRoot?: string;
  /** Host platform. On `win32`, the canonical placement is a file copy, never a symlink. */
  readonly platform?: NodeJS.Platform;
  /** Exarchos version for the provenance manifest. */
  readonly version?: string;
  /** Resolves the project install command. Default `resolveTestRuntime(repoRoot).install`. It returns `null` when no known toolchain is present. */
  readonly resolveInstallCommand?: (repoRoot: string) => string | null;
  /** Runs the install command in `cwd`. Default spawns it through a shell. */
  readonly runCommand?: (command: string, cwd: string) => Promise<void>;
  /** Replaces the bridge call. Default is a dynamic import of `lifecycle/install-skills-bridge.js`. */
  readonly runSkillsInstall?: (opts: SkillsInstallOpts) => Promise<void>;
  /** The rename migration. It runs before the skills install, so old and new names never exist together. Default {@link defaultRunMigrate}. */
  readonly runMigrate?: (ctx: ApplyCtx) => void;
}

/** The options forwarded to `installSkills` through the bridge, a subset of `InstallSkillsOpts`. */
export interface SkillsInstallOpts {
  /** Target runtime id. When absent, `installSkills` detects the runtime. */
  readonly agent?: string;
  readonly runtimes?: readonly unknown[];
  /** Override the skills source tree (only when {@link skillsSourceOverridden}). */
  readonly skillsSource?: string | undefined;
  /** True when the caller injected a `resolveSkillsSource` (override the bridge's). */
  readonly skillsSourceOverridden?: boolean;
  /** Override the alias source tree (only when {@link aliasesSourceOverridden}). */
  readonly aliasesSource?: string | undefined;
  /** True when the caller injected a `resolveAliasesSource` (override the bridge's). */
  readonly aliasesSourceOverridden?: boolean;
  readonly homeDir?: () => string;
  readonly copyDir?: (src: string, dest: string) => void;
  readonly copyFile?: (src: string, dest: string) => void;
  readonly spawn?: (
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ) => Promise<{ code: number; stderr: string }>;
  readonly registerMcp?: (home: string) => void;
  readonly log?: (msg: string) => void;
  readonly errLog?: (msg: string) => void;
  /** Install scope. See {@link InstallStepDeps.scope}. */
  readonly scope?: 'user' | 'project';
  /** Project root for `scope: 'project'` canonical/manifest paths. */
  readonly projectRoot?: string;
  /** Host platform. On `win32`, the canonical placement is a copy. */
  readonly platform?: NodeJS.Platform;
  /** Exarchos version recorded in the provenance manifest. */
  readonly version?: string;
}

/** Returns the install command from the layered resolver `resolveTestRuntime`, or `null` when no known toolchain is present. */
function defaultResolveInstallCommand(repoRoot: string): string | null {
  const resolved: ResolvedRuntime = resolveTestRuntime(repoRoot);
  return resolved.install;
}

/**
 * Spawns the install command in `cwd` through a shell, so a command with arguments runs as written. The operator sees the output.
 * It rejects on a non-zero exit or a spawn error, and the onboard pipeline then leaves the step residual.
 */
function defaultRunCommand(command: string, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = nodeSpawn(command, {
      cwd,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if ((code ?? 0) === 0) resolve();
      else reject(new Error(`install command exited ${code}: ${command}`));
    });
  });
}

/**
 * Calls `runInstallSkills` of the bridge, and passes the injected hooks through its `installSkillsOpts`.
 * The bridge resolves the runtime and the source trees. A source field goes in only when a `resolve*Source` seam was injected.
 * The bridge is JavaScript and imported dynamically, so tsc (`allowJs: false`) does not resolve it, but the bun `--compile` bundler follows it.
 */
async function defaultRunSkillsInstall(opts: SkillsInstallOpts): Promise<void> {
  const bridge = (await import('../../lifecycle/install-skills-bridge.js')) as {
    runInstallSkills: (
      o: { agent?: string },
      deps?: {
        embedded?: readonly unknown[];
        installSkillsOpts?: Record<string, unknown>;
      },
    ) => Promise<void>;
  };

  const installSkillsOpts: Record<string, unknown> = {
    ...(opts.skillsSourceOverridden ? { skillsSource: opts.skillsSource } : {}),
    ...(opts.aliasesSourceOverridden ? { aliasesSource: opts.aliasesSource } : {}),
    ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
    ...(opts.copyDir ? { copyDir: opts.copyDir } : {}),
    ...(opts.copyFile ? { copyFile: opts.copyFile } : {}),
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.registerMcp ? { registerMcp: opts.registerMcp } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.errLog ? { errLog: opts.errLog } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.version ? { version: opts.version } : {}),
  };

  await bridge.runInstallSkills(
    opts.agent !== undefined ? { agent: opts.agent } : {},
    {
      ...(opts.runtimes ? { embedded: opts.runtimes } : {}),
      installSkillsOpts,
    },
  );
}

/**
 * Default `registerMcp` for the install step. The GENERATE step of the reconciler owns MCP registration.
 * The default `registerMcp` of `installSkills` writes `~/.claude.json`, so without this no-op the claude path registers twice.
 */
const NOOP_REGISTER_MCP = (_home: string): void => {
};

/**
 * The retired names of nine renamed skills. A directory with one of these names is residue from an older release.
 * No current skill name is in the list, so the migration can only delete a retired directory.
 */
export const RENAMED_AWAY_SKILL_DIRS: readonly string[] = [
  /** The new name is `ideate`. */
  'brainstorming',
  /** The new name is `plan`. */
  'implementation-planning',
  /** The new name is `delegate`. */
  'delegation',
  /** The new name is `synthesize`. */
  'synthesis',
  /** The new name is `discover`. */
  'discovery',
  /** The new name is `oneshot`. */
  'oneshot-workflow',
  /** The new name is `prune`. */
  'prune-workflows',
  /** The new name is `invariants`. */
  'authoring-invariants',
  /** The new names are `rehydrate` and `checkpoint`. */
  'workflow-state',
];

/** Install scope for the canonical `.agents/skills` convention path. */
export type SkillsScope = 'user' | 'project';

/** The subset of a runtime map the migration reads (its native skills dir). */
export interface RuntimeSkillsTarget {
  readonly name: string;
  readonly skillsInstallPath: string;
}

/** One placement record from an install provenance manifest. */
export interface ProvenancePlacement {
  readonly path: string;
  readonly hashes: Record<string, string>;
}

/** The part of an install provenance manifest that the migration reads. */
export interface ProvenanceManifest {
  readonly placements: readonly ProvenancePlacement[];
}

/** One stale dir the migration acted on (removed) or declined to act on (preserved). */
export interface StaleDirOutcome {
  /** Absolute path of the old-name skill dir. */
  readonly path: string;
  /** The install scope / harness the dir belonged to (for reporting). */
  readonly location: string;
  /** Whether the on-disk entry was a symlink (link removed, target untouched). */
  readonly symlink: boolean;
}

/** A preserved dir, with the reason it was NOT removed. */
export interface PreservedDirOutcome extends StaleDirOutcome {
  readonly reason: 'no-provenance-match';
}

/** A removed dir, with which provenance source vouched for it. */
export interface RemovedDirOutcome extends StaleDirOutcome {
  readonly via: 'install-manifest' | 'legacy-hash';
}

export interface OnboardMigrateResult {
  readonly removed: RemovedDirOutcome[];
  readonly preserved: PreservedDirOutcome[];
  readonly warnings: string[];
}

/** Injected filesystem seam so the migration is unit-testable without real I/O. */
export interface MigrateFsSeam {
  /** Lists directory entries. It returns no entries for an absent directory and does not throw. */
  readonly readdir: (dir: string) => Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
  /** Runs lstat on a path, so it does not follow symlinks. */
  readonly lstat: (p: string) => { isSymbolicLink: boolean };
  /** Content hash of the whole directory, through symlinks, for install-manifest provenance. */
  readonly hashDir: (dir: string) => string;
  /** Content hash of `SKILL.md`, through symlinks, or undefined. It serves legacy provenance. */
  readonly hashSkillMd: (dir: string) => string | undefined;
  /** Removes a real directory recursively. */
  readonly removeDir: (dir: string) => void;
  /** Removes a symlink, never its target. */
  readonly removeLink: (link: string) => void;
}

export interface OnboardMigrateOptions {
  /** Per-harness native skills dirs to scan. */
  readonly runtimes?: readonly RuntimeSkillsTarget[];
  /** Resolves the home directory for `~` and `$HOME` expansion and for the user-scope directory. */
  readonly homeDir: () => string;
  /** Project root for the project-scope canonical `.agents/skills` dir. */
  readonly projectRoot: string;
  /** Install manifests, one for each scope, for the first provenance source. */
  readonly installManifests?: readonly ProvenanceManifest[];
  /** Legacy-render hash index by skill name, for the second provenance source. */
  readonly legacyHashesBySkill?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Fold skill-name keys case-insensitively (case-insensitive filesystems). */
  readonly caseInsensitive?: boolean;
  /** Filesystem seam. Default is the real `node:fs`. */
  readonly fsSeam?: MigrateFsSeam;
  /** Warning sink for preserved directories. Default is silent. */
  readonly warn?: (msg: string) => void;
}

/** Expands a leading `~` or `$HOME`, the same as `expandTilde` in `install-skills`. */
function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p === '$HOME') return home;
  if (p.startsWith('$HOME/')) return path.join(home, p.slice('$HOME/'.length));
  return p;
}

/** Converts a path to POSIX separators for stable deduplication keys. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Content hash of a whole directory, the same as `hashSkillDirContent` in `src/install/install-skills.ts`.
 * It hashes the sorted relative paths and the LF-normalized contents. It reads through symlinks, so a symlinked install hashes to its target.
 * `install.test.ts` guards it against drift.
 */
export function hashInstalledSkillDir(skillDir: string): string {
  const rels: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, childRel);
      else if (st.isFile()) rels.push(childRel);
    }
  };
  walk(skillDir, '');
  rels.sort();
  const h = createHash('sha256');
  for (const rel of rels) {
    const content = fs.readFileSync(path.join(skillDir, rel)).toString('utf8');
    h.update(rel);
    h.update('\0');
    h.update(content.replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * SHA-256 hash of the LF-normalized `SKILL.md`, the same as `hashSkillMdContent` and the `normalizeAndHash` of the legacy-hash generator.
 * A CRLF checkout thus still matches. It returns `undefined` when the directory has no `SKILL.md`.
 */
export function hashInstalledSkillMd(
  skillDir: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string | undefined {
  try {
    return createHash('sha256')
      .update(readFile(path.join(skillDir, 'SKILL.md')).replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');
  } catch {
    return undefined;
  }
}

/** The real `node:fs`-backed migration filesystem seam. */
function defaultMigrateFsSeam(): MigrateFsSeam {
  return {
    readdir: (dir) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isSymbolicLink: e.isSymbolicLink(),
      }));
    },
    lstat: (p) => ({ isSymbolicLink: fs.lstatSync(p).isSymbolicLink() }),
    hashDir: (dir) => hashInstalledSkillDir(dir),
    hashSkillMd: (dir) => hashInstalledSkillMd(dir),
    removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    removeLink: (link) => fs.unlinkSync(link),
  };
}

/**
 * Returns the directories that the migration scans: the user and project `.agents/skills` directories, and each harness `skillsInstallPath`.
 * It removes duplicates by resolved POSIX path, so a harness directory that is the user directory appears once.
 */
export function resolveMigrationScanLocations(
  opts: Pick<OnboardMigrateOptions, 'runtimes' | 'homeDir' | 'projectRoot'>,
): string[] {
  const home = opts.homeDir();
  const raw: string[] = [
    expandHome('~/.agents/skills', home),
    path.join(opts.projectRoot, '.agents', 'skills'),
  ];
  for (const rt of opts.runtimes ?? []) {
    raw.push(expandHome(rt.skillsInstallPath, home));
  }
  const seen = new Set<string>();
  const locations: string[] = [];
  for (const loc of raw) {
    const key = toPosix(path.resolve(loc));
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(loc);
  }
  return locations;
}

/**
 * Removes the stale skill directories with a {@link RENAMED_AWAY_SKILL_DIRS} name from every scan location, when provenance proves them.
 * The first provenance source is a whole-directory hash that an install manifest records for the skill.
 * The second is a `SKILL.md` hash that matches a legacy render of the skill from any release.
 *
 * For a symlink it removes only the link. A real directory is deleted recursively.
 * A directory with no provenance match stays, with a warning, and the `doctor` check `stale-skill-dirs` reports it.
 * A second run writes nothing.
 */
export function onboardMigrate(opts: OnboardMigrateOptions): OnboardMigrateResult {
  const seam = opts.fsSeam ?? defaultMigrateFsSeam();
  const warn = opts.warn ?? ((_msg: string) => {});
  const manifests = opts.installManifests ?? [];
  const legacy = opts.legacyHashesBySkill;
  const caseInsensitive = opts.caseInsensitive ?? false;
  const stale = new Set(
    RENAMED_AWAY_SKILL_DIRS.map((n) => (caseInsensitive ? n.toLowerCase() : n)),
  );

  const removed: RemovedDirOutcome[] = [];
  const preserved: PreservedDirOutcome[] = [];
  const warnings: string[] = [];

  const locations = resolveMigrationScanLocations(opts);
  for (const location of locations) {
    for (const entry of seam.readdir(location)) {
      const nameKey = caseInsensitive ? entry.name.toLowerCase() : entry.name;
      if (!entry.isDirectory && !entry.isSymbolicLink) continue;
      if (!stale.has(nameKey)) continue;

      const skillDir = path.join(location, entry.name);
      const symlink = entry.isSymbolicLink || (() => {
        try {
          return seam.lstat(skillDir).isSymbolicLink;
        } catch {
          return false;
        }
      })();

      let via: RemovedDirOutcome['via'] | undefined;
      let dirHash: string | undefined;
      try {
        dirHash = seam.hashDir(skillDir);
      } catch {
        dirHash = undefined;
      }
      if (dirHash !== undefined && manifestVouches(manifests, entry.name, dirHash, caseInsensitive)) {
        via = 'install-manifest';
      }

      if (via === undefined && legacy !== undefined) {
        const mdHash = seam.hashSkillMd(skillDir);
        const set = legacy.get(entry.name);
        if (mdHash !== undefined && set !== undefined && set.has(mdHash)) {
          via = 'legacy-hash';
        }
      }

      if (via !== undefined) {
        if (symlink) seam.removeLink(skillDir);
        else seam.removeDir(skillDir);
        removed.push({ path: skillDir, location, symlink, via });
      } else {
        const msg =
          `Preserved stale skill directory "${skillDir}" — it matches no Exarchos ` +
          `install manifest or legacy render hash (modified or unrecognized). Review ` +
          `and remove it by hand if it is safe to delete.`;
        preserved.push({ path: skillDir, location, symlink, reason: 'no-provenance-match' });
        warnings.push(msg);
        warn(msg);
      }
    }
  }

  return { removed, preserved, warnings };
}

/** Whether an install manifest placement records `dirHash` for `skillName`. */
function manifestVouches(
  manifests: readonly ProvenanceManifest[],
  skillName: string,
  dirHash: string,
  caseInsensitive: boolean,
): boolean {
  const wanted = caseInsensitive ? skillName.toLowerCase() : skillName;
  for (const manifest of manifests) {
    for (const placement of manifest.placements) {
      for (const [recordedSkill, recordedHash] of Object.entries(placement.hashes)) {
        const key = caseInsensitive ? recordedSkill.toLowerCase() : recordedSkill;
        if (key === wanted && recordedHash === dirHash) return true;
      }
    }
  }
  return false;
}

/**
 * Filename of the install provenance manifest for each scope. It must match `SKILLS_MANIFEST_FILENAME` in `src/install/install-skills.ts`. No test compares the two.
 */
const SKILLS_MANIFEST_FILENAME = '.exarchos-skills.json';
/** Filename of the committed legacy-render hash manifest that `tools/release/generate-legacy-skill-hashes.mjs` writes. */
const LEGACY_HASH_MANIFEST_FILENAME = 'legacy-skill-render-hashes.json';

/** Reads one install manifest and checks its shape. It returns `undefined` when the file is absent or malformed. */
export function loadInstallManifest(manifestPath: string): ProvenanceManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const placements = (parsed as { placements?: unknown }).placements;
  if (!Array.isArray(placements)) return undefined;
  return parsed as ProvenanceManifest;
}

/** Loads the install manifests of the user scope under `home` and the project scope under `projectRoot`. */
function loadInstallManifests(home: string, projectRoot: string): ProvenanceManifest[] {
  const candidates = [
    path.join(expandHome('~/.agents', home), SKILLS_MANIFEST_FILENAME),
    path.join(projectRoot, '.agents', SKILLS_MANIFEST_FILENAME),
  ];
  const manifests: ProvenanceManifest[] = [];
  for (const c of candidates) {
    const m = loadInstallManifest(c);
    if (m) manifests.push(m);
  }
  return manifests;
}

/** Finds the legacy-render hash manifest under the cwd `tools/migrations/`, or relative to the binary. */
function findLegacyHashManifestPath(): string | undefined {
  const candidates = [path.join(process.cwd(), 'tools', 'migrations', LEGACY_HASH_MANIFEST_FILENAME)];
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(
      path.resolve(
        path.dirname(process.execPath),
        '..',
        '..',
        'migrations',
        LEGACY_HASH_MANIFEST_FILENAME,
      ),
    );
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
    }
  }
  return undefined;
}

/**
 * Loads the legacy-render hash manifest and indexes it by skill name.
 * It returns `undefined` when the manifest is absent or does not parse. That source is then unavailable, so directories stay.
 */
export function loadLegacyHashIndexFromDisk(
  manifestPath: string | undefined = findLegacyHashManifestPath(),
): Map<string, Set<string>> | undefined {
  if (manifestPath === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return undefined;
  const index = new Map<string, Set<string>>();
  for (const e of entries as Array<{ skill?: unknown; hash?: unknown }>) {
    if (typeof e?.skill !== 'string' || typeof e?.hash !== 'string') continue;
    let set = index.get(e.skill);
    if (!set) {
      set = new Set<string>();
      index.set(e.skill, set);
    }
    set.add(e.hash);
  }
  return index;
}

/** Treats `win32` and `darwin` as case-insensitive, the same as `defaultCaseInsensitiveFs` in `install-skills`. */
function migrateCaseInsensitiveFs(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * The production migration hook. It loads the manifests and the legacy hash index from disk, then runs {@link onboardMigrate}.
 * A missing manifest or directory removes nothing. The hook never throws, so a migration fault does not block the skills install.
 */
function defaultRunMigrate(deps: InstallStepDeps): (ctx: ApplyCtx) => void {
  return (ctx: ApplyCtx): void => {
    try {
      const home = (deps.homeDir ?? (() => homedir()))();
      const projectRoot = deps.projectRoot ?? ctx.repoRoot;
      const platform = deps.platform ?? process.platform;
      onboardMigrate({
        ...(deps.runtimes
          ? { runtimes: deps.runtimes as readonly RuntimeSkillsTarget[] }
          : {}),
        homeDir: () => home,
        projectRoot,
        installManifests: loadInstallManifests(home, projectRoot),
        ...((): { legacyHashesBySkill?: ReadonlyMap<string, ReadonlySet<string>> } => {
          const legacy = loadLegacyHashIndexFromDisk();
          return legacy ? { legacyHashesBySkill: legacy } : {};
        })(),
        caseInsensitive: migrateCaseInsensitiveFs(platform),
        warn: deps.errLog ?? ((msg: string) => orchestrateLogger.warn(msg)),
      });
    } catch {
    }
  };
}

/**
 * Builds the {@link ApplyCtx.installStep} hook over the injected {@link InstallStepDeps}.
 * The returned function runs the migration, the skills install and the project install. It does not read `step`.
 * The skills copy defaults to `atomicCopyTreeSync`, which stages the tree and swaps it in with a rename.
 * An interrupted copy then leaves no half-populated skill directory, and a second onboard run converges.
 * The install scope defaults to `'project'` under `ctx.repoRoot`.
 */
export function makeInstallStep(
  deps: InstallStepDeps = {},
): (step: PlanStep, ctx: ApplyCtx) => Promise<void> {
  return async (_step: PlanStep, ctx: ApplyCtx): Promise<void> => {
    const runSkillsInstall = deps.runSkillsInstall ?? defaultRunSkillsInstall;
    const resolveInstallCommand = deps.resolveInstallCommand ?? defaultResolveInstallCommand;
    const runCommand = deps.runCommand ?? defaultRunCommand;
    const homeDir = deps.homeDir ?? (() => homedir());
    const runMigrate = deps.runMigrate ?? defaultRunMigrate(deps);
    const registerMcp = deps.registerMcp ?? NOOP_REGISTER_MCP;

    runMigrate(ctx);

    const skillsSourceOverridden = deps.resolveSkillsSource !== undefined;
    const aliasesSourceOverridden = deps.resolveAliasesSource !== undefined;

    await runSkillsInstall({
      ...(deps.agent !== undefined ? { agent: deps.agent } : {}),
      ...(deps.runtimes ? { runtimes: deps.runtimes } : {}),
      ...(skillsSourceOverridden
        ? { skillsSourceOverridden: true, skillsSource: deps.resolveSkillsSource!() }
        : {}),
      ...(aliasesSourceOverridden
        ? { aliasesSourceOverridden: true, aliasesSource: deps.resolveAliasesSource!() }
        : {}),
      homeDir,
      copyDir: deps.copyDir ?? atomicCopyTreeSync,
      ...(deps.copyFile ? { copyFile: deps.copyFile } : {}),
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      registerMcp,
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.errLog ? { errLog: deps.errLog } : {}),
      scope: deps.scope ?? 'project',
      projectRoot: deps.projectRoot ?? ctx.repoRoot,
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.version ? { version: deps.version } : {}),
    });

    const installCommand = resolveInstallCommand(ctx.repoRoot);
    if (installCommand !== null) {
      await runCommand(installCommand, ctx.repoRoot);
    }
  };
}

/** The production {@link ApplyCtx.installStep}, with all I/O on the real seams. `registerMcp` is a no-op, so only the GENERATE step registers MCP. */
export const installStep: (step: PlanStep, ctx: ApplyCtx) => Promise<void> =
  makeInstallStep();
