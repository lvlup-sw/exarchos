#!/usr/bin/env bun
/**
 * Compile the Exarchos CLI + MCP server into a single self-contained native
 * binary via `bun build --compile`.
 *
 * ── Entry-point choice ──────────────────────────────────────────────────
 * Reuses `servers/exarchos-mcp/src/index.ts` — the same entry consumed by
 * `scripts/build-bundle.ts` — rather than introducing a parallel
 * `cli-entry.ts`. That file already implements unified mode dispatch:
 *
 *   - `isMcpServerInvocation(argv)` → MCP stdio server mode.
 *   - Hook commands (session-start, pre-compact, guard, ...) → short-lived
 *     subprocess mode via `adapters/hooks.ts`.
 *   - Everything else → Commander CLI via `adapters/cli.ts`.
 *
 * One entry, two distribution variants (bundle + binary): honours the
 * axiom:distill principle of single-responsibility entry surfaces. The v29
 * install-rewrite design explicitly calls this out — a second entry would
 * fracture the mode-dispatch invariants documented in DR-5 / F-022-2.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   bun run scripts/build-binary.ts                         # host-only (default)
 *   bun run scripts/build-binary.ts --all                   # all cross-compile targets
 *   bun run scripts/build-binary.ts --target linux-x64      # single target by os-arch name
 *
 * The `--target <os-arch>` form is used by the CI binary-matrix job so
 * each runner builds exactly one artifact.
 */
import { $ } from 'bun';
import { mkdirSync } from 'node:fs';

export interface Target {
  readonly os: 'linux' | 'darwin' | 'windows';
  readonly arch: 'x64' | 'arm64';
  readonly bunTarget:
    | 'bun-linux-x64'
    | 'bun-linux-arm64'
    | 'bun-darwin-x64'
    | 'bun-darwin-arm64'
    | 'bun-windows-x64';
}

/**
 * Exhaustive cross-compile target matrix for the v2.9 install rewrite.
 *
 * Exported so the CI matrix (task 1.5) and downstream tooling can iterate
 * the same set of OS/arch pairs without re-declaring the tuple — single
 * source of truth prevents build/publish drift.
 *
 * DRIFT CONTRACT:
 *   - Mirrored by `binary-matrix.strategy.matrix.target` in
 *     `.github/workflows/ci.yml`, using the `os-arch` naming convention
 *     (e.g. `linux-x64`) for each entry.
 *   - `scripts/ci-binary-matrix.test.ts` is the enforcement gate: editing
 *     this tuple without updating the CI matrix (or vice versa) fails
 *     `npm run test:run`.
 *   - The 2.7 release workflow should also consume this export when it
 *     lands, so additions/removals propagate automatically.
 */
export const TARGETS: readonly Target[] = [
  { os: 'linux', arch: 'x64', bunTarget: 'bun-linux-x64' },
  { os: 'linux', arch: 'arm64', bunTarget: 'bun-linux-arm64' },
  { os: 'darwin', arch: 'x64', bunTarget: 'bun-darwin-x64' },
  { os: 'darwin', arch: 'arm64', bunTarget: 'bun-darwin-arm64' },
  { os: 'windows', arch: 'x64', bunTarget: 'bun-windows-x64' },
] as const;

function getHostTarget(): Target {
  const os =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux';
  const arch: 'x64' | 'arm64' = process.arch === 'arm64' ? 'arm64' : 'x64';
  const match = TARGETS.find((t) => t.os === os && t.arch === arch);
  if (!match) {
    throw new Error(`unsupported host platform: ${os}-${arch}`);
  }
  return match;
}

async function buildOne(target: Target): Promise<void> {
  const ext = target.os === 'windows' ? '.exe' : '';
  const outfile = `dist/bin/exarchos-${target.os}-${target.arch}${ext}`;
  mkdirSync('dist/bin', { recursive: true });

  // `bun build --compile` produces a single executable that embeds the Bun
  // runtime + the bundled JS graph. --target selects the host-OS bun
  // runtime to embed (for cross-compilation).
  await $`bun build servers/exarchos-mcp/src/index.ts --compile --target=${target.bunTarget} --outfile ${outfile}`;

  console.log(`Built ${outfile}`);
}

function parseTargetFlag(argv: readonly string[]): string | undefined {
  // Support both `--target linux-x64` and `--target=linux-x64`.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' && i + 1 < argv.length) return argv[i + 1];
    if (a && a.startsWith('--target=')) return a.slice('--target='.length);
  }
  return undefined;
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

const wantAll = process.argv.includes('--all');
const wantTarget = parseTargetFlag(process.argv);

if (wantAll) {
  for (const t of TARGETS) {
    await buildOne(t);
  }
} else if (wantTarget) {
  await buildOne(findTargetByName(wantTarget));
} else {
  await buildOne(getHostTarget());
}
