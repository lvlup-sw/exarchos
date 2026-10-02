#!/usr/bin/env bun
/**
 * Compiles the Exarchos CLI and MCP server into one self-contained native binary with
 * `bun build --compile`. The binary is the only distribution artifact.
 *
 * The entry is `src/index.ts`, which dispatches the MCP server, the hook commands and the CLI.
 * Usage: `bun run tools/release/build-binary.ts [--all | --target <os-arch>] [--outdir <dir>]`.
 * With no flag it builds the host target. CI passes `--target`, and a test passes `--outdir`.
 * The build runs only when this file is the entry point, so an import does not start a build.
 *
 * Each artifact embeds the git commit, the source-tree digest and the contract-authority digest.
 * The signed release manifest uses the same collectors. So an installer can reject a signed
 * manifest that describes a different source or contract than the binary.
 *
 * `tests/core/process/compiled-binary-mcp.test.ts` runs the host artifact. If the output path or
 * the target matrix changes, update that test.
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
 * Reads the version from the root `package.json`. `--define` inlines it into the binary, which
 * has no `package.json` on disk. See `adapters/cli/cli.ts:resolvePackageVersion`.
 */
function readBuildVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..');
  const pkg = JSON.parse(
    readFileSync(resolve(root, 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof pkg.version !== 'string') {
    throw new Error('root package.json is missing a string `version` field');
  }
  return pkg.version;
}

export { TARGETS };
export type { Target };

/**
 * Returns the target of the host. An unknown host throws, and does not fall back to a supported
 * target. A Linux binary built on such a host cannot run there, and it hides the configuration
 * error.
 */
function getHostTarget(): Target {
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
 * Generates `src/install/runtimes/embedded.ts` before each `bun build --compile`. The runtime
 * YAML files do not ship inside the binary, so `install-skills` resolves runtimes from this
 * embedded module. Generation here keeps the binary correct when a developer skipped
 * `npm run codegen:runtimes`. `runtimes:guard` checks the committed copy for drift.
 */
function codegenEmbeddedRuntimes(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..');
  generateEmbeddedRuntimesModule({
    runtimesDir: resolve(root, 'content/harness/runtimes'),
    outFile: resolve(root, 'src/install/runtimes/embedded.ts'),
  });
}

/**
 * The `--banner` payload that stamps source and contract identity into each artifact. It is
 * collected once per process, because the collectors run git and digest the tracked source.
 * The artifacts of a `--all` run then share one identity, even if a file changes mid-build.
 *
 * `sourceState` records a modified working tree, and the build does not fail on it.
 * `codegenEmbeddedRuntimes()` rewrites a tracked file on each build, so a dirty-tree failure
 * stops every release. The state is also printed to the build log.
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

/**
 * Builds one target. It generates the embedded runtimes module first, so the binary cannot ship a
 * stale copy. `--target` selects the Bun runtime to embed, `--define` inlines the version, and
 * `--banner` stamps the build identity into the artifact.
 */
async function buildOne(target: Target, outdir: string = DEFAULT_OUTDIR): Promise<void> {
  codegenEmbeddedRuntimes();

  const ext = target.os === 'windows' ? '.exe' : '';
  const outfile = join(outdir, `exarchos-${target.os}-${target.arch}${ext}`);
  mkdirSync(outdir, { recursive: true });

  const versionDefine = `EXARCHOS_BUILD_VERSION="${readBuildVersion()}"`;
  const banner = identityBanner();
  await $`bun build src/index.ts --compile --target=${target.bunTarget} --define ${versionDefine} --banner ${banner} --outfile ${outfile}`;

  console.log(`Built ${outfile}`);
}

/** Reads the value of a flag in the form `--flag value` or `--flag=value`. */
function parseFlagValue(argv: readonly string[], flag: string): string | undefined {
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

/**
 * Finds a target by its `os-arch` name. The `dist/bin/` file name and the CI matrix use the same
 * name.
 */
function findTargetByName(name: string): Target {
  const match = TARGETS.find((t) => `${t.os}-${t.arch}` === name);
  if (!match) {
    const known = TARGETS.map((t) => `${t.os}-${t.arch}`).join(', ');
    throw new Error(`unknown --target ${name}. Expected one of: ${known}`);
  }
  return match;
}

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
