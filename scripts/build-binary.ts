#!/usr/bin/env bun
/**
 * Compile the Exarchos CLI + MCP server into a single self-contained native
 * binary via `bun build --compile`.
 *
 * ── Entry-point choice ──────────────────────────────────────────────────
 * Uses `src/index.ts` — the single process entry
 * point — rather than introducing a parallel `cli-entry.ts`. That file
 * already implements unified mode dispatch:
 *
 *   - `isMcpServerInvocation(argv)` → MCP stdio server mode.
 *   - Observer hook commands (session-end, subagent-stop) → short-lived
 *     subprocess mode via `adapters/hooks.ts`.
 *   - Everything else → Commander CLI via `adapters/cli.ts`.
 *
 * One entry, one distribution variant (the compiled binary): honours the
 * axiom:distill principle of single-responsibility entry surfaces. The v29
 * install-rewrite design explicitly calls this out — a second entry would
 * fracture the mode-dispatch invariants documented in DR-5 / F-022-2.
 *
 * Historical note: task 3.6 removed the companion `scripts/build-bundle.ts`
 * + `dist/exarchos.js` emission path; the binary is the sole distribution
 * artifact now.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   bun run scripts/build-binary.ts                         # host-only (default)
 *   bun run scripts/build-binary.ts --all                   # all cross-compile targets
 *   bun run scripts/build-binary.ts --target linux-x64      # single target by os-arch name
 *   bun run scripts/build-binary.ts --outdir /tmp/x         # emit elsewhere than dist/bin
 *
 * The `--target <os-arch>` form is used by the CI binary-matrix job so
 * each runner builds exactly one artifact. `--outdir` exists so a test can
 * build a real artifact into a scratch directory without racing the
 * canonical `dist/bin` output that other suites read.
 *
 * ── Embedded source + contract identity (DR-20) ─────────────────────────
 * Every artifact carries, IN ITS OWN BYTES, the git commit + source-tree
 * digest it was built from and the P03-01 frozen contract-authority digest
 * it was built against. The record is rendered by
 * `scripts/build-release-manifest.ts:buildIdentityBanner` and injected with
 * `bun build --banner`, which prepends it to the bundled JS *after*
 * minification — so the bytes survive verbatim into the compiled executable
 * and are recoverable with `extractEmbeddedBuildIdentity(<artifact bytes>)`.
 *
 * The SAME collectors produce the signed release manifest, so the manifest's
 * `source`/`contract` and the binary's embedded `source`/`contract` are
 * identical by construction — which is exactly what lets an installer reject
 * a validly-signed manifest that describes a different source or contract
 * than the binary it is about to install.
 *
 * ── Integration test (task 1.6) ────────────────────────────────────────
 * The artifact produced by this script — specifically the host-target
 * output at `dist/bin/exarchos-<os>-<arch>` — is the subject-under-test
 * for `test/core/process/compiled-binary-mcp.test.ts`.
 * That test spawns the binary with `mcp` subcommand and performs a real
 * MCP handshake + `exarchos_workflow init` round-trip to prove the
 * compiled output behaves identically to the JS bundle. If you change
 * the output path or target matrix, update the path resolver in that
 * test file in the same commit.
 */
import { $ } from 'bun';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, type Target } from './build-binary-targets.js';
import { generateEmbeddedRuntimesModule } from './codegen-runtimes.js';
import {
  buildIdentityBanner,
  collectEmbeddedBuildIdentity,
  renderSourceStateReport,
  repoRootFromHere,
} from './build-release-manifest.js';

/** Default output directory for compiled artifacts. */
export const DEFAULT_OUTDIR = 'dist/bin';

/**
 * Read the canonical version from root `package.json`. Inlined into the
 * compiled binary via `--define` so `--version` and the `version` subcommand
 * survive `bun build --compile` (the compiled bundle has no on-disk
 * `package.json` to walk up to). See `adapters/cli.ts:resolvePackageVersion`
 * for the runtime fallback.
 */
function readBuildVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');
  const pkg = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof pkg.version !== 'string') {
    throw new Error('root package.json is missing a string `version` field');
  }
  return pkg.version;
}

// Re-export so existing importers of `./build-binary.js` keep working.
export { TARGETS };
export type { Target };

function getHostTarget(): Target {
  // Refuse to coerce unknown hosts into supported targets — silently
  // building a Linux binary on, say, OpenBSD would produce something that
  // can't run locally and obscures the configuration error.
  let os: Target['os'];
  if (process.platform === 'darwin') {
    os = 'darwin';
  } else if (process.platform === 'win32') {
    os = 'windows';
  } else if (process.platform === 'linux') {
    os = 'linux';
  } else {
    throw new Error(`unsupported host platform: ${process.platform}`);
  }

  let arch: Target['arch'];
  if (process.arch === 'x64' || process.arch === 'arm64') {
    arch = process.arch;
  } else {
    throw new Error(`unsupported host arch: ${process.arch}`);
  }

  const match = TARGETS.find((t) => t.os === os && t.arch === arch);
  if (!match) {
    throw new Error(`unsupported host platform: ${os}-${arch}`);
  }
  return match;
}

/**
 * Codegen `src/install/runtimes/embedded.ts` BEFORE every `bun build --compile`
 * call so the bundled artifact always embeds an up-to-date runtimes
 * module. The compiled binary is the primary install path for
 * `install-skills` (#1213, #1214) — the YAML files don't ship inside
 * the bundle, so the bridge MUST resolve runtimes from the embedded
 * import. Re-running codegen here makes the binary self-consistent
 * even when a developer skipped `npm run codegen:runtimes` before
 * hitting `npm run build:binary`. CI's `runtimes:guard` separately
 * enforces drift on the checked-in copy.
 */
function codegenEmbeddedRuntimes(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');
  generateEmbeddedRuntimesModule({
    runtimesDir: resolve(root, 'runtimes'),
    outFile: resolve(root, 'src/install/runtimes/embedded.ts'),
  });
}

/**
 * Render the `--banner` payload that stamps source + contract identity into
 * every compiled artifact (DR-20). Collected ONCE per process and cached: the
 * collectors shell out to git and digest ~2k tracked source files, and a
 * `--all` run must produce five artifacts that agree on a single identity
 * (five separate collections could straddle a mid-build edit and emit
 * divergent digests).
 *
 * The identity also carries `sourceState`, so an artifact compiled from a
 * modified working tree cannot claim clean-HEAD provenance. That is RECORDED,
 * never fail-closed — `codegenEmbeddedRuntimes()` above rewrites a tracked
 * file on every single build, so aborting on a dirty tree would abort every
 * real release. The state is echoed here so the condition is visible in the
 * build log and not only in the artifact's bytes.
 */
let cachedIdentityBanner: string | undefined;
function identityBanner(): string {
  if (cachedIdentityBanner === undefined) {
    const identity = collectEmbeddedBuildIdentity(repoRootFromHere());
    for (const line of renderSourceStateReport({
      state: identity.sourceState,
      modifiedPaths: identity.modifiedPaths,
      modifiedCount: identity.modifiedCount,
    })) {
      console.log(line);
    }
    cachedIdentityBanner = buildIdentityBanner(identity);
  }
  return cachedIdentityBanner;
}

async function buildOne(target: Target, outdir: string = DEFAULT_OUTDIR): Promise<void> {
  // Regenerate the embedded runtimes module before bundling so that
  // the produced binary cannot ship a stale embedded array. See the
  // helper's docstring for the full rationale.
  codegenEmbeddedRuntimes();

  const ext = target.os === 'windows' ? '.exe' : '';
  const outfile = join(outdir, `exarchos-${target.os}-${target.arch}${ext}`);
  mkdirSync(outdir, { recursive: true });

  // `bun build --compile` produces a single executable that embeds the Bun
  // runtime + the bundled JS graph. --target selects the host-OS bun
  // runtime to embed (for cross-compilation). --define inlines the package
  // version so `--version` works inside the bundled binary (no on-disk
  // package.json to walk up to). --banner stamps the DR-20 source/contract
  // identity into the artifact's bytes.
  const versionDefine = `EXARCHOS_BUILD_VERSION="${readBuildVersion()}"`;
  const banner = identityBanner();
  await $`bun build src/index.ts --compile --target=${target.bunTarget} --define ${versionDefine} --banner ${banner} --outfile ${outfile}`;

  console.log(`Built ${outfile}`);
}

function parseFlagValue(argv: readonly string[], flag: string): string | undefined {
  // Support both `--flag value` and `--flag=value`.
  const eq = `${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag && i + 1 < argv.length) return argv[i + 1];
    if (a && a.startsWith(eq)) return a.slice(eq.length);
  }
  return undefined;
}

function parseTargetFlag(argv: readonly string[]): string | undefined {
  return parseFlagValue(argv, '--target');
}

function findTargetByName(name: string): Target {
  // Accept `os-arch` form (e.g. `linux-x64`) matching the `dist/bin/`
  // filename convention — this is the same identifier the CI matrix
  // strategy declares, so it stays grep-able across the two files.
  const match = TARGETS.find((t) => `${t.os}-${t.arch}` === name);
  if (!match) {
    const known = TARGETS.map((t) => `${t.os}-${t.arch}`).join(', ');
    throw new Error(`unknown --target ${name}. Expected one of: ${known}`);
  }
  return match;
}

// Guard the side-effecting build invocation behind an entrypoint check so
// `import { TARGETS } from './build-binary.js'` (e.g.
// `scripts/ci-binary-matrix.test.ts`) doesn't kick off a real build.
// `import.meta.main` is the bun-supplied "is this module the entry point"
// signal — exactly what we need for a script that's also a library
// surface for the contract test.
//
// Bun sets `import.meta.main = true` for the script invoked via
// `bun run <file>`. When this module is imported as a library, the value
// is `false` (or `undefined` under non-Bun runners like vitest's tsx),
// so the dispatch below is skipped. The field is declared by `@types/node`
// (`module.d.ts` → `interface ImportMeta { main: boolean }`), so the local
// `declare global` augmentation this file used to carry is gone: keeping it
// now collides with the upstream declaration (TS2687).
if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) {
  const wantAll = process.argv.includes('--all');
  const wantTarget = parseTargetFlag(process.argv);
  const outdir = parseFlagValue(process.argv, '--outdir') ?? DEFAULT_OUTDIR;

  if (wantAll) {
    for (const t of TARGETS) {
      await buildOne(t, outdir);
    }
  } else if (wantTarget) {
    await buildOne(findTargetByName(wantTarget), outdir);
  } else {
    await buildOne(getHostTarget(), outdir);
  }
}
