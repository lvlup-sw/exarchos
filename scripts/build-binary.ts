#!/usr/bin/env bun
/**
 * Compile the Exarchos CLI + MCP server into a single self-contained native
 * binary via `bun build --compile`.
 *
 * Entry point: `servers/exarchos-mcp/src/index.ts`. This file is the *same*
 * entry used by `scripts/build-bundle.ts` and already implements unified
 * mode dispatch:
 *   - `isMcpServerInvocation(argv)` → MCP stdio server mode.
 *   - Hook commands (session-start, pre-compact, guard, ...) → short-lived
 *     subprocess mode via `adapters/hooks.ts`.
 *   - Everything else → Commander CLI via `adapters/cli.ts`.
 *
 * Reusing that entry keeps a single-responsibility surface for bundle and
 * binary variants; see axiom/distill in the v29 install-rewrite design.
 *
 * Usage:
 *   bun run scripts/build-binary.ts            # host-only (default)
 *   bun run scripts/build-binary.ts --all      # all cross-compile targets
 */
import { $ } from 'bun';
import { mkdirSync } from 'node:fs';

interface Target {
  readonly os: 'linux' | 'darwin' | 'windows';
  readonly arch: 'x64' | 'arm64';
  readonly bunTarget:
    | 'bun-linux-x64'
    | 'bun-linux-arm64'
    | 'bun-darwin-x64'
    | 'bun-darwin-arm64'
    | 'bun-windows-x64';
}

const TARGETS: readonly Target[] = [
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

const wantAll = process.argv.includes('--all');

if (wantAll) {
  for (const t of TARGETS) {
    await buildOne(t);
  }
} else {
  await buildOne(getHostTarget());
}
