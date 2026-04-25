/**
 * Shared fixtures for compiled-binary MCP integration tests (task 1.6 +
 * follow-ons). Kept in `test/process/` so vitest's test glob does not try
 * to treat this file as a suite — there are no `describe()` blocks here.
 *
 * Exposes:
 *   - `findRepoRoot()` — walks up from a given directory to the monorepo
 *     root (the ancestor that contains `scripts/build-binary.ts`).
 *   - `hostBinaryPath(repoRoot)` — computes the `dist/bin/exarchos-<os>-<arch>`
 *     path for the host platform, including the `.exe` suffix on Windows.
 *   - `ensureBinaryBuilt(repoRoot)` — the beforeAll rebuild guard: runs
 *     `bun run scripts/build-binary.ts` if the binary is missing or older
 *     than any file under `servers/exarchos-mcp/src/**`.
 *   - `openFixture(binaryPath, repoRoot)` / `closeFixture(fx)` — opens a
 *     live MCP stdio Client against the spawned binary with a hermetic
 *     `WORKFLOW_STATE_DIR` temp directory and tears it down.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Repo-root discovery ────────────────────────────────────────────────────

export function findRepoRoot(startDir: string): string {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const marker = path.join(cursor, 'scripts', 'build-binary.ts');
    if (fs.existsSync(marker)) return cursor;
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error(
    `Unable to locate repo root (no scripts/build-binary.ts in any ancestor of ${startDir})`,
  );
}

// ─── Host-binary path resolver ──────────────────────────────────────────────

export function hostBinaryPath(repoRoot: string): string {
  const platform = os.platform();
  const arch = os.arch();
  const osName =
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
  const archName: 'x64' | 'arm64' = arch === 'arm64' ? 'arm64' : 'x64';
  const ext = osName === 'windows' ? '.exe' : '';
  return path.join(repoRoot, 'dist', 'bin', `exarchos-${osName}-${archName}${ext}`);
}

// ─── Freshness check ────────────────────────────────────────────────────────

function newestMtimeUnder(dir: string, predicate: (p: string) => boolean): number {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && predicate(full)) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  }
  return newest;
}

export interface BinaryBuildResult {
  readonly binaryPath: string;
  readonly rebuilt: boolean;
}

export function ensureBinaryBuilt(repoRoot: string): BinaryBuildResult {
  const binaryPath = hostBinaryPath(repoRoot);

  // The compiled binary's content depends on every input bun bundles plus
  // the build orchestration script itself. Restricting the freshness scan
  // to `servers/exarchos-mcp/src/**` would miss edits to the build
  // pipeline (`scripts/build-binary.ts`) and to root sources that may be
  // bundled in future, leaving a stale binary in place during integration
  // tests. Scanning each tracked input directory keeps the check cheap
  // while catching the realistic edit surfaces.
  const inputs = [
    path.join(repoRoot, 'servers', 'exarchos-mcp', 'src'),
    path.join(repoRoot, 'scripts'),
    path.join(repoRoot, 'src'),
  ];

  let srcNewest = 0;
  for (const dir of inputs) {
    if (!fs.existsSync(dir)) continue;
    const newest = newestMtimeUnder(dir, (p) => p.endsWith('.ts'));
    if (newest > srcNewest) srcNewest = newest;
  }

  let rebuild = false;
  if (!fs.existsSync(binaryPath)) {
    rebuild = true;
  } else {
    const binMtime = fs.statSync(binaryPath).mtimeMs;
    if (srcNewest > binMtime) rebuild = true;
  }

  if (!rebuild) return { binaryPath, rebuilt: false };

  const result = spawnSync('bun', ['run', 'scripts/build-binary.ts'], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `build-binary.ts failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Binary missing after build: ${binaryPath}`);
  }
  return { binaryPath, rebuilt: true };
}

// ─── Transport fixture ──────────────────────────────────────────────────────

export interface Fixture {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stateDir: string;
}

export async function openFixture(binaryPath: string, repoRoot: string): Promise<Fixture> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-compiled-test-'));
  const transport = new StdioClientTransport({
    command: binaryPath,
    args: ['mcp'],
    env: {
      ...process.env,
      WORKFLOW_STATE_DIR: stateDir,
      EXARCHOS_PLUGIN_ROOT: repoRoot,
      LOG_LEVEL: 'error',
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const client = new Client(
    { name: 'compiled-binary-integration-test', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  return { client, transport, stateDir };
}

export async function closeFixture(fx: Fixture): Promise<void> {
  try {
    await fx.client.close();
  } catch {
    /* ignore — transport already torn down */
  }
  try {
    await fsp.rm(fx.stateDir, { recursive: true, force: true });
  } catch {
    /* ignore — temp dir may have been cleaned by GC */
  }
}
