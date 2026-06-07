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
import { homedir } from 'node:os';

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
  };

  await bridge.runInstallSkills(
    opts.agent !== undefined ? { agent: opts.agent } : {},
    {
      ...(opts.runtimes ? { embedded: opts.runtimes } : {}),
      installSkillsOpts,
    },
  );
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
      ...(deps.registerMcp ? { registerMcp: deps.registerMcp } : {}),
      ...(deps.log ? { log: deps.log } : {}),
      ...(deps.errLog ? { errLog: deps.errLog } : {}),
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
 */
export const installStep: (step: PlanStep, ctx: ApplyCtx) => Promise<void> =
  makeInstallStep();
