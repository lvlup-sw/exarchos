/**
 * installStep — the DR-2/DR-6 skills + deps INSTALL hook (task 015).
 *
 * This is the real impl behind {@link ApplyCtx.installStep} (the reconciler's
 * `install`-step seam). The reconciler's `apply` install router (DR-6) invokes
 * it ONLY on the CLI surface — `ctx.surface === 'cli'` — and otherwise downgrades
 * the step to a cli-only {@link Advisory}. So this hook performs its side effects
 * UNCONDITIONALLY: the surface gate lives in the core, never here (and a
 * redundant guard here would be dead code that drifts from the core contract).
 *
 * Two side effects, both reusing existing single-source seams (no reimplemented
 * install logic — INV-2):
 *
 *   1. Skills bundle — `installSkills()` (from the workspace-root
 *      `src/install-skills.ts`, reached through the JS bridge to satisfy the MCP
 *      server's tsc `rootDir: "./src"`). It already encodes the #1355 contract:
 *      a local-copy FAST PATH (copy `skills/<runtime>/` → the runtime's skills
 *      dir) when a `skillsSource` is resolvable, falling back to the
 *      `npx skills add github:lvlup-sw/exarchos …` shell-out otherwise. We reuse
 *      that seam verbatim and only inject the source-dir + runtime resolution
 *      (the bridge's job).
 *
 *   2. Project deps — the install command is resolved through the Bundle B
 *      layered resolver (`resolveTestRuntime(repoRoot).install`: override →
 *      `.exarchos.yml` → user `toolchains:` → task-runner → the vendored
 *      `package-manager-detector` registry). INV-6: the command came from the
 *      resolver; nothing is string-rewritten in. An unresolved install command
 *      (`null`) means there is no Node/known toolchain to install for, so the
 *      deps step is a clean no-op.
 *
 * Every real I/O is injected (the bridge invocation, the deps command runner) so
 * the unit tests drive the fast-path / fallback contract without shelling out to
 * a network `npx`.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { ApplyCtx } from '../../core/onboarding/reconcile.js';
import type { PlanStep } from '../../core/onboarding/types.js';
import {
  resolveTestRuntime,
  type ResolvedRuntime,
} from '../../config/test-runtime-resolver.js';

// ─── Injected dependency bundle (testable seam) ───────────────────────────────

/**
 * The injected side-effect bundle for {@link makeInstallStep}. Production uses
 * {@link installStep} (all defaults: the real bridge → `installSkills` seam + a
 * real spawn for project-deps install). Tests inject spies / temp dirs so the
 * local-copy / `npx` contract is exercised without touching the network.
 *
 * The fields mirror {@link installSkills}'s own injection points so the reuse is
 * transparent — we forward them straight through the bridge's `installer` seam.
 */
export interface InstallStepDeps {
  /**
   * Resolve the per-runtime skills source tree (the repo's `skills/` dir, parent
   * of `<runtime>/<skill>/SKILL.md`). A defined value selects the local-copy
   * FAST PATH; `undefined` falls back to the `npx skills add` shell-out. Defaults
   * to `findSkillsSourceDir()` from the bridge (cwd / binary-relative / src-dev).
   */
  readonly resolveSkillsSource?: () => string | undefined;
  /**
   * Resolve the per-runtime command-alias source tree (the repo's
   * `command-aliases/` dir). Defaults to `findCommandAliasesSourceDir()`. Threaded
   * through so opencode's canonical aliases install alongside skills (#1471/#1472).
   */
  readonly resolveAliasesSource?: () => string | undefined;
  /**
   * Explicit target runtime id (`claude`, `codex`, …). When set it is threaded
   * to `installSkills` so detection is skipped; when omitted `installSkills`
   * auto-detects the runtime (the `install-skills` CLI's default behavior).
   */
  readonly agent?: string;
  /**
   * The known runtime maps the skills install targets. Defaults to the
   * codegen-emitted `EMBEDDED_RUNTIMES` (the binary's zero-fs runtime table).
   */
  readonly runtimes?: readonly unknown[];
  /** Resolve the user's home dir (skills install path expansion). Default `os.homedir`. */
  readonly homeDir?: () => string;
  /** Recursive dir copy (the local-copy fast path). Default `fs.cpSync(recursive)`. */
  readonly copyDir?: (src: string, dest: string) => void;
  /** Single-file copy (command aliases). Default `fs.copyFileSync`. */
  readonly copyFile?: (src: string, dest: string) => void;
  /**
   * Spawn for the `npx skills add` fallback. Default wraps `child_process.spawn`.
   * Tests inject a recorder so the fallback never hits the network.
   */
  readonly spawn?: (
    cmd: string,
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ) => Promise<{ code: number; stderr: string }>;
  /** Register the Exarchos MCP server in `~/.claude.json` (claude runtime only). */
  readonly registerMcp?: (home: string) => void;
  /** Informational logging sink. Default: silent (onboard owns the summary). */
  readonly log?: (msg: string) => void;
  /** Error logging sink. Default `console.error`. */
  readonly errLog?: (msg: string) => void;
  /**
   * Install scope for the canonical `.agents/skills` convention path + the DR-4
   * provenance manifest. Onboard operates on a project, so it defaults to
   * `'project'` with `projectRoot` = the apply `ctx.repoRoot`, so a project-scoped
   * manifest lands under `<repoRoot>/.agents/` and `doctor` can flag layout drift
   * per project. The standalone `install-skills` CLI uses the user scope
   * (`~/.agents/skills`). The per-harness native dirs are scope-independent.
   */
  readonly scope?: 'user' | 'project';
  /** Project root for `scope: 'project'`. Defaults to the apply `ctx.repoRoot`. */
  readonly projectRoot?: string;
  /**
   * Host platform threaded to the skills-install seam: `win32` ⇒ the canonical
   * placement is a file copy, never a symlink (INV-16). Default `process.platform`.
   */
  readonly platform?: NodeJS.Platform;
  /** Exarchos version recorded in the provenance manifest. Default: root package.json. */
  readonly version?: string;
  /**
   * Resolve the project's install command for `repoRoot` (Bundle B / INV-6).
   * Defaults to `resolveTestRuntime(repoRoot).install`. Returns `null` when no
   * known toolchain is present (deps install is then a no-op).
   */
  readonly resolveInstallCommand?: (repoRoot: string) => string | null;
  /**
   * Run the resolved install command in `cwd`. Default spawns the command via a
   * shell. Tests inject a recorder so the deps install never executes for real.
   */
  readonly runCommand?: (command: string, cwd: string) => Promise<void>;
  /**
   * Override the bridge invocation (the cross-package `installSkills` reach).
   * Defaults to a dynamic import of `cli-commands/install-skills-bridge.js`.
   * Tests do NOT need to override this — they steer behavior via `copyDir` /
   * `spawn` / `resolveSkillsSource` which thread through to the real seam.
   */
  readonly runSkillsInstall?: (opts: SkillsInstallOpts) => Promise<void>;
  /**
   * The DR-3/DR-8 onboard rename migration hook (Task 011), run BEFORE the skills
   * install so a consumer never sees both the old-name residue and the new names
   * mid-pass. Defaults to {@link defaultRunMigrate} (disk-loaded provenance →
   * {@link onboardMigrate}). Tests inject a spy / no-op to isolate the install
   * side effects, or drive {@link onboardMigrate} directly.
   */
  readonly runMigrate?: (ctx: ApplyCtx) => void;
}

/**
 * The opts forwarded to the reused `installSkills` seam. Mirrors the subset of
 * `InstallSkillsOpts` we steer: source trees, runtime table, home, and the
 * injectable copy/spawn/registration hooks. `agent` is omitted so `installSkills`
 * auto-detects the runtime (the same behavior the `install-skills` CLI gives).
 */
export interface SkillsInstallOpts {
  /** Explicit target runtime id; omitted ⇒ `installSkills` auto-detects. */
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
  /** Canonical-layout install scope (DR-4). See {@link InstallStepDeps.scope}. */
  readonly scope?: 'user' | 'project';
  /** Project root for `scope: 'project'` canonical/manifest paths. */
  readonly projectRoot?: string;
  /** Host platform (win32 ⇒ canonical copy-mode, INV-16). */
  readonly platform?: NodeJS.Platform;
  /** Exarchos version recorded in the provenance manifest. */
  readonly version?: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Default project-deps install command resolution — the Bundle B layered
 * resolver. Single-sourced (INV-6): the command is whatever
 * `resolveTestRuntime` derives (override → `.exarchos.yml` → toolchains →
 * task-runner → vendored `package-manager-detector` registry), never a
 * string-rewritten literal. `null` ⇒ no known toolchain ⇒ deps step no-ops.
 */
function defaultResolveInstallCommand(repoRoot: string): string | null {
  const resolved: ResolvedRuntime = resolveTestRuntime(repoRoot);
  return resolved.install;
}

/**
 * Default command runner: spawn the install command in `cwd` with the shell so a
 * multi-token command (`npm ci`, `pnpm install --frozen-lockfile`, …) runs as
 * written. Inherits stdio so the operator sees install progress; resolves on a
 * zero exit and rejects on a non-zero exit or spawn error (the onboard pipeline
 * leaves the step residual on a throw — forward-only, DR-10).
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
 * Default skills-install invocation: reuse the bridge's `runInstallSkills`,
 * threading our injected copy/spawn/home/register hooks (and any source-tree
 * overrides) through the bridge's `installSkillsOpts` passthrough. The bridge's
 * DEFAULT installer merges those into the real `installSkills` call, so THIS
 * module never imports `installSkills` directly — which would trip the MCP
 * server's tsc `rootDir: "./src"` (TS6059), the exact reason the bridge is JS.
 * The bridge owns runtime + source-dir resolution (`findSkillsSourceDir` /
 * `findCommandAliasesSourceDir`); the `installSkillsOpts` source fields OVERRIDE
 * that resolution only when a source was injected (the tests' fast-path /
 * fallback lever).
 *
 * The bridge is dynamically imported (the same pattern `adapters/cli.ts` uses);
 * being JS, tsc (`allowJs: false`) never resolves into it while bun's
 * `--compile` bundler follows it at build time. The `../../cli-commands/`
 * specifier is TWO hops up from `orchestrate/onboard/` (onboard → orchestrate →
 * src, then into `cli-commands/`).
 */
async function defaultRunSkillsInstall(opts: SkillsInstallOpts): Promise<void> {
  const bridge = (await import('../../cli-commands/install-skills-bridge.js')) as {
    runInstallSkills: (
      o: { agent?: string },
      deps?: {
        embedded?: readonly unknown[];
        installSkillsOpts?: Record<string, unknown>;
      },
    ) => Promise<void>;
  };

  // Injectable I/O hooks for the reused `installSkills` seam — forwarded through
  // the bridge's `installSkillsOpts` passthrough, never a direct import. Source
  // fields are present (override) ONLY when a `resolve*Source` seam was injected.
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
    // DR-4 canonical-layout controls threaded through to the reused
    // `installSkills` seam (the bridge spreads these into the real call).
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
 * DR-5 (task 018): MCP registration is single-sourced to the reconciler's
 * GENERATE step (the init writers — `ClaudeCodeWriter` → `~/.claude.json`, the
 * `mcp-json-writer` → `.vscode`/`.cursor` `mcp.json`). The install step reuses
 * `installSkills`, whose DEFAULT `registerMcp` is `registerExarchosInClaudeJson`
 * — so without this no-op the claude path would register MCP a SECOND time. The
 * install step therefore defaults `registerMcp` to a no-op, so MCP registration
 * happens EXACTLY once (in GENERATE). A caller can still inject a real
 * `registerMcp` (the tests do) to exercise the seam in isolation.
 */
const NOOP_REGISTER_MCP = (_home: string): void => {
  /* MCP registration is owned by GENERATE — the install step never registers. */
};

// ─── Onboard rename migration (Task 011, DR-3/DR-8) ───────────────────────────
//
// The atomic rename wave (Task 004) renamed 9 skills (skill name == verb == dir).
// Prior-release installs therefore carry STALE OLD-NAME skill dirs on disk. The
// onboard reconciler removes those across BOTH install scopes (project + user)
// AND every per-harness `skillsInstallPath` — but ONLY when provenance is
// established via the Task 010 install manifest OR the Task 023 multi-release
// legacy-render hash manifest. Modified / unmatched dirs are PRESERVED with a
// warning + a `doctor` finding; symlinked installs have the LINK removed only
// (never the target); the pass is idempotent (byte-stable after the first run).
//
// This module lives in the MCP server package (tsc `rootDir: "./src"`), so it
// cannot import the root `src/install-skills.ts` provenance helpers directly. The
// two hashers below MIRROR those (`hashSkillDirContent` / `hashSkillMdContent`)
// and are drift-guarded against them by a co-located cross-package test — the
// same "own-constants + cross-package equality guard" idiom DR-5 uses for the
// managed-block fences.

/**
 * The 9 skills the DR-3 atomic rename wave renamed away. A dir bearing one of
 * these names in a consumer install is a prior-release residue (the new names —
 * `ideate`, `plan`, `delegate`, `synthesize`, `discover`, `oneshot`, `prune`,
 * `invariants`, and the `rehydrate`/`checkpoint` split — are the live set and are
 * NEVER in this list, so the migration can only ever delete a genuinely-retired
 * directory).
 */
export const RENAMED_AWAY_SKILL_DIRS: readonly string[] = [
  'brainstorming', // → ideate
  'implementation-planning', // → plan
  'delegation', // → delegate
  'synthesis', // → synthesize
  'discovery', // → discover
  'oneshot-workflow', // → oneshot
  'prune-workflows', // → prune
  'authoring-invariants', // → invariants
  'workflow-state', // → rehydrate + checkpoint
];

/** Install scope for the canonical `.agents/skills` convention path. */
export type SkillsScope = 'user' | 'project';

/** The subset of a runtime map the migration reads (its native skills dir). */
export interface RuntimeSkillsTarget {
  readonly name: string;
  readonly skillsInstallPath: string;
}

/** One placement record from a Task 010 install provenance manifest (real shape). */
export interface ProvenancePlacement {
  readonly path: string;
  readonly hashes: Record<string, string>;
}

/** A Task 010 install provenance manifest (the subset the migration reads). */
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
  /** List directory entries (name + isDirectory/isSymbolicLink) — non-throwing on absent. */
  readonly readdir: (dir: string) => Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
  /** lstat a path (does NOT follow symlinks). */
  readonly lstat: (p: string) => { isSymbolicLink: boolean };
  /** Whole-dir content hash (follows symlinks) — install-manifest provenance. */
  readonly hashDir: (dir: string) => string;
  /** SKILL.md content hash (follows symlinks), or undefined — legacy provenance. */
  readonly hashSkillMd: (dir: string) => string | undefined;
  /** Remove a real directory recursively. */
  readonly removeDir: (dir: string) => void;
  /** Remove a symlink (the LINK only, never its target). */
  readonly removeLink: (link: string) => void;
}

export interface OnboardMigrateOptions {
  /** Per-harness native skills dirs to scan. */
  readonly runtimes?: readonly RuntimeSkillsTarget[];
  /** Resolve the user's home (tilde/`$HOME` expansion + user-scope canonical dir). */
  readonly homeDir: () => string;
  /** Project root for the project-scope canonical `.agents/skills` dir. */
  readonly projectRoot: string;
  /** Install manifests (Task 010) — one per scope — the migration reads for provenance (a). */
  readonly installManifests?: readonly ProvenanceManifest[];
  /** Legacy-render hash index (Task 023) by skill name — provenance (b). */
  readonly legacyHashesBySkill?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Fold skill-name keys case-insensitively (case-insensitive filesystems). */
  readonly caseInsensitive?: boolean;
  /** Filesystem seam (defaults to real `node:fs`). */
  readonly fsSeam?: MigrateFsSeam;
  /** Warning sink for preserved dirs (defaults to silent — onboard owns the summary). */
  readonly warn?: (msg: string) => void;
}

/** Expand a leading `~` / `$HOME` marker (mirrors install-skills' `expandTilde`). */
function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`;
  if (p === '$HOME') return home;
  if (p.startsWith('$HOME/')) return `${home}${p.slice('$HOME'.length)}`;
  return p;
}

/** POSIX-normalize a path for stable dedup keys (mirrors install-skills). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Whole-dir content hash — MIRRORS `hashSkillDirContent` in
 * `src/install-skills.ts` byte-for-byte (sorted POSIX rel-paths, each
 * newline-normalized, `rel\0content\0`). Reads THROUGH symlinks (stat, not
 * lstat) so a symlinked install hashes to its target. Drift-guarded by the
 * cross-package test in `install.test.ts`.
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
 * SKILL.md-only content hash (CRLF→LF + sha256) — MIRRORS `hashSkillMdContent`
 * in `src/install-skills.ts` and the Task 023 generator's `normalizeAndHash`, so
 * a CRLF-checkout install still legacy-hash-matches. Reads through symlinks;
 * `undefined` when the dir carries no `SKILL.md`.
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
 * Resolve every directory the migration scans for stale old-name skill dirs: the
 * canonical `.agents/skills` convention dir for BOTH scopes plus each harness's
 * native `skillsInstallPath`. Deduped by POSIX-resolved path (the `generic`
 * runtime's native dir IS the user canonical dir, so it collapses to one).
 */
export function resolveMigrationScanLocations(
  opts: Pick<OnboardMigrateOptions, 'runtimes' | 'homeDir' | 'projectRoot'>,
): string[] {
  const home = opts.homeDir();
  const raw: string[] = [
    expandHome('~/.agents/skills', home), // user-scope canonical
    path.join(opts.projectRoot, '.agents', 'skills'), // project-scope canonical
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
 * Reconcile stale OLD-NAME skill dirs across every install scope + per-harness
 * native dir (Task 011, DR-3/DR-8).
 *
 * For each scanned location, every top-level dir whose name is a
 * {@link RENAMED_AWAY_SKILL_DIRS} entry is evaluated:
 *   - provenance (a): the on-disk whole-dir hash matches a Task 010 install
 *     manifest placement's recorded hash for that skill; OR
 *   - provenance (b): the on-disk `SKILL.md` newline-normalized hash matches ANY
 *     release's Task 023 legacy-render hash for that skill.
 * A provenance-matched dir is REMOVED (symlink ⇒ the link only, never the target;
 * real dir ⇒ recursive delete). A dir matching neither manifest is PRESERVED,
 * a warning is emitted, and the read-only `doctor` `stale-skill-dirs` check
 * surfaces it for manual review. Idempotent: removed dirs are gone on the next
 * run, and preserved dirs re-preserve with no filesystem write (byte-stable).
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

      // Provenance (a): whole-dir hash vouched by an install manifest placement.
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

      // Provenance (b): SKILL.md hash matches any historical legacy render.
      if (via === undefined && legacy !== undefined) {
        const mdHash = seam.hashSkillMd(skillDir);
        const set = legacy.get(entry.name);
        if (mdHash !== undefined && set !== undefined && set.has(mdHash)) {
          via = 'legacy-hash';
        }
      }

      if (via !== undefined) {
        // Symlinked install ⇒ unlink the LINK only (never follow to the target).
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

/** Does any install manifest placement vouch for `skillName` at content `dirHash`? */
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

// ─── Provenance loading (production defaults) ─────────────────────────────────
//
// The disk shapes these loaders parse are single-sourced in
// `src/install-skills.ts` (Task 010 `.exarchos-skills.json`) and
// `scripts/generate-legacy-skill-hashes.mjs` / `migrations/` (Task 023). The
// server package cannot import those (tsc `rootDir: "./src"`), so the filename
// literals and shape checks are mirrored here and pinned by `install.test.ts`.

/** Task 010 per-scope provenance manifest filename (mirrors `SKILLS_MANIFEST_FILENAME`). */
const SKILLS_MANIFEST_FILENAME = '.exarchos-skills.json';
/** Task 023 committed legacy-render hash manifest filename. */
const LEGACY_HASH_MANIFEST_FILENAME = 'legacy-skill-render-hashes.json';

/** Read + shape-check one Task 010 install manifest; `undefined` when absent/malformed. */
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

/** Both-scope install manifests for `home` (user) + `projectRoot` (project). */
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

/** Resolve the committed Task 023 legacy-render hash manifest on disk. */
function findLegacyHashManifestPath(): string | undefined {
  const candidates = [path.join(process.cwd(), 'migrations', LEGACY_HASH_MANIFEST_FILENAME)];
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
      // try next
    }
  }
  return undefined;
}

/**
 * Load + index the Task 023 legacy-render hash manifest by skill name.
 * `undefined` when the manifest is absent or unparseable — provenance (b) is then
 * simply unavailable (the conservative PRESERVE default, never a false delete).
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

/** Case-insensitive-filesystem heuristic (mirrors install-skills' `defaultCaseInsensitiveFs`). */
function migrateCaseInsensitiveFs(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * The production migration hook wired into {@link makeInstallStep}: loads both-
 * scope install manifests + the legacy-render hash index from disk and runs
 * {@link onboardMigrate} across the resolved scan locations. Defensive by design
 * — a missing manifest / absent dir simply contributes no removal (PRESERVE), and
 * the whole hook never throws (a migration fault must not block the skills
 * install that follows it, forward-only DR-10).
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
        warn: deps.errLog ?? ((msg: string) => console.error(msg)),
      });
    } catch {
      // Forward-only: a migration fault never blocks the ensuing skills install.
    }
  };
}

// ─── Installer ────────────────────────────────────────────────────────────────

/**
 * Build the {@link ApplyCtx.installStep} hook over an injected
 * {@link InstallStepDeps} bundle. Production calls {@link installStep} (all
 * defaults). The returned function conforms to the seam signature
 * `(step, ctx) => Promise<void>` and runs BOTH side effects (skills + deps); the
 * `step` is accepted for seam stability but unused today (a single install kind
 * covers the skills/deps bundle).
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
    // DR-5: default to a no-op so MCP registration happens ONCE (in GENERATE),
    // never a second time here. Injected `registerMcp` overrides (tests only).
    const registerMcp = deps.registerMcp ?? NOOP_REGISTER_MCP;

    // ── 0. Rename migration (Task 011, DR-3/DR-8) ──
    // Remove provenance-matched stale OLD-NAME skill dirs across every scope +
    // per-harness dir BEFORE installing the new names, so the two never coexist.
    // Modified / unmatched dirs are preserved with a warning + a `doctor` finding.
    runMigrate(ctx);

    // ── 1. Skills bundle (local-copy fast path + npx fallback) ──
    // The bridge resolves source trees by default; we only OVERRIDE them when a
    // `resolve*Source` seam was injected (the tests' fast-path / fallback lever).
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
      ...(deps.copyDir ? { copyDir: deps.copyDir } : {}),
      ...(deps.copyFile ? { copyFile: deps.copyFile } : {}),
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
      registerMcp,
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.errLog ? { errLog: deps.errLog } : {}),
      // DR-4: onboard installs at PROJECT scope (canonical + manifest under
      // `<repoRoot>/.agents/`) so `doctor` can detect layout drift per project.
      scope: deps.scope ?? 'project',
      projectRoot: deps.projectRoot ?? ctx.repoRoot,
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.version ? { version: deps.version } : {}),
    });

    // ── 2. Project deps (Bundle B resolved command — INV-6) ──
    const installCommand = resolveInstallCommand(ctx.repoRoot);
    if (installCommand !== null) {
      await runCommand(installCommand, ctx.repoRoot);
    }
  };
}

/**
 * The production {@link ApplyCtx.installStep}: the skills + deps install hook
 * with all I/O defaulted to the real seams (the bridge → `installSkills` for the
 * skills bundle, `resolveTestRuntime` + a real spawn for project deps). Wired
 * into `defaultOnboardDeps` (task 010's no-op seam replaced).
 *
 * DR-5 (task 018): `registerMcp` defaults to a no-op (see `NOOP_REGISTER_MCP`)
 * so MCP registration happens EXACTLY once — in the GENERATE step — and is NOT
 * duplicated here.
 */
export const installStep: (step: PlanStep, ctx: ApplyCtx) => Promise<void> =
  makeInstallStep();
