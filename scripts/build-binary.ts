#!/usr/bin/env bun
/**
 * Compile the Exarchos CLI + MCP server into a single self-contained native
 * binary via `bun build --compile`.
 *
 * ── Entry-point choice ──────────────────────────────────────────────────
 * Uses `servers/exarchos-mcp/src/index.ts` — the single process entry
 * point — rather than introducing a parallel `cli-entry.ts`. That file
 * already implements unified mode dispatch:
 *
 *   - `isMcpServerInvocation(argv)` → MCP stdio server mode.
 *   - Hook commands (session-start, pre-compact, guard, ...) → short-lived
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
 *
 * The `--target <os-arch>` form is used by the CI binary-matrix job so
 * each runner builds exactly one artifact.
 *
 * ── Integration test (task 1.6) ────────────────────────────────────────
 * The artifact produced by this script — specifically the host-target
 * output at `dist/bin/exarchos-<os>-<arch>` — is the subject-under-test
 * for `servers/exarchos-mcp/test/process/compiled-binary-mcp.test.ts`.
 * That test spawns the binary with `mcp` subcommand and performs a real
 * MCP handshake + `exarchos_workflow init` round-trip to prove the
 * compiled output behaves identically to the JS bundle. If you change
 * the output path or target matrix, update the path resolver in that
 * test file in the same commit.
 */
import { $ } from 'bun';
import { mkdirSync } from 'node:fs';
import { TARGETS, type Target } from './build-binary-targets.js';

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
// so the dispatch below is skipped.
declare global {
  // Augment ImportMeta so the bun-only `main` field typechecks under tsc.
  interface ImportMeta {
    readonly main?: boolean;
  }
}

if (import.meta.main) {
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
}
