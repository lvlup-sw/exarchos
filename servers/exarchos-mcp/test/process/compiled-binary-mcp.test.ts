/**
 * Task 1.6 — Compiled-binary MCP integration test.
 *
 * Proves the artifact produced by `scripts/build-binary.ts` (task 1.4) actually
 * runs `exarchos mcp` in real stdio-transport mode and handles MCP tool calls
 * identically to the JS bundle. This is the PR1 integration gate for the v2.9
 * install rewrite — earlier tests (1.1, 1.2) cover the build script's
 * structural invariants, but nothing yet proves the resulting binary can
 * complete a real MCP handshake + dispatch a workflow action end-to-end.
 *
 * Hermeticity:
 *   - Each test uses a fresh temp `WORKFLOW_STATE_DIR` so feature IDs never
 *     collide across runs and cleanup is trivial.
 *   - `EXARCHOS_PLUGIN_ROOT` is set to the repo root so the spawned binary
 *     resolves plugin-scoped paths without touching the developer's
 *     `~/.claude` or `~/.exarchos` state.
 *   - The child process is spawned via `StdioClientTransport`, which
 *     terminates when the `Client` is closed — tests cannot leak processes.
 *
 * beforeAll rebuild guard:
 *   - Runs `bun run scripts/build-binary.ts` only if the host binary is
 *     absent OR older than any file in `servers/exarchos-mcp/src/**`.
 *   - Keeps local iteration fast; CI always sees a fresh binary because the
 *     workspace is clean.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_VERSION } from '../../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Repo root discovery ────────────────────────────────────────────────────
//
// Tests run under `cd servers/exarchos-mcp && vitest`, so `process.cwd()` at
// test time is the MCP server package. The binary lives at
// `<repo-root>/dist/bin/exarchos-<os>-<arch>`. Walk up from the test file's
// directory to the first ancestor that contains a `dist/` sibling and a
// `scripts/build-binary.ts` — that is the monorepo root.
function findRepoRoot(): string {
  let cursor = path.resolve(__dirname);
  for (let i = 0; i < 8; i++) {
    const marker = path.join(cursor, 'scripts', 'build-binary.ts');
    if (fs.existsSync(marker)) return cursor;
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error('Unable to locate repo root (no scripts/build-binary.ts in any ancestor)');
}

const REPO_ROOT = findRepoRoot();

// ─── Host-binary path resolver ──────────────────────────────────────────────

function hostBinaryPath(): string {
  const platform = os.platform();
  const arch = os.arch();
  const osName =
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux';
  const archName: 'x64' | 'arm64' = arch === 'arm64' ? 'arm64' : 'x64';
  const ext = osName === 'windows' ? '.exe' : '';
  return path.join(REPO_ROOT, 'dist', 'bin', `exarchos-${osName}-${archName}${ext}`);
}

// ─── Freshness check ────────────────────────────────────────────────────────
//
// Recursively walk `servers/exarchos-mcp/src/` and return the newest mtime
// among `.ts` files. If the binary's mtime is newer, skip rebuild.

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

function ensureBinaryBuilt(): { binaryPath: string; rebuilt: boolean } {
  const binaryPath = hostBinaryPath();
  const srcDir = path.join(REPO_ROOT, 'servers', 'exarchos-mcp', 'src');
  const srcNewest = newestMtimeUnder(srcDir, (p) => p.endsWith('.ts'));

  let rebuild = false;
  if (!fs.existsSync(binaryPath)) {
    rebuild = true;
  } else {
    const binMtime = fs.statSync(binaryPath).mtimeMs;
    if (srcNewest > binMtime) rebuild = true;
  }

  if (!rebuild) return { binaryPath, rebuilt: false };

  const result = spawnSync('bun', ['run', 'scripts/build-binary.ts'], {
    cwd: REPO_ROOT,
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

// ─── Shared transport fixture ───────────────────────────────────────────────

interface Fixture {
  client: Client;
  transport: StdioClientTransport;
  stateDir: string;
}

async function openFixture(binaryPath: string): Promise<Fixture> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'exarchos-compiled-test-'));
  const transport = new StdioClientTransport({
    command: binaryPath,
    args: ['mcp'],
    env: {
      ...process.env,
      WORKFLOW_STATE_DIR: stateDir,
      EXARCHOS_PLUGIN_ROOT: REPO_ROOT,
      // Silence pino output to stderr during tests (it would clutter CI logs).
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

async function closeFixture(fx: Fixture): Promise<void> {
  try {
    await fx.client.close();
  } catch {
    /* ignore */
  }
  try {
    await fsp.rm(fx.stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Build once, share across both test cases ───────────────────────────────

let BINARY_PATH: string;

beforeAll(() => {
  const { binaryPath } = ensureBinaryBuilt();
  BINARY_PATH = binaryPath;
}, 120_000);

// ─── Test cases ─────────────────────────────────────────────────────────────

describe('Compiled binary MCP integration (task 1.6)', () => {
  it('CompiledBinary_McpSubcommand_HandshakesSuccessfully', async () => {
    const fx = await openFixture(BINARY_PATH);
    try {
      const info = fx.client.getServerVersion();
      expect(info).toBeDefined();
      // Name must match the canonical constant exported by src/index.ts.
      // A divergence here indicates a drift in the server-identity block of
      // src/adapters/mcp.ts relative to the source-of-truth export.
      expect(info!.name).toBe(SERVER_NAME);
      // The compiled binary's advertised version must equal the canonical
      // SERVER_VERSION from src/index.ts. This is the TDD gate: the JS
      // adapter historically hardcoded its own constant which drifted from
      // the root export, so this assertion catches that drift in CI.
      expect(info!.version).toBe(SERVER_VERSION);
    } finally {
      await closeFixture(fx);
    }
  }, 30_000);

  it('CompiledBinary_McpWorkflowInit_ReturnsExpectedShape', async () => {
    const fx = await openFixture(BINARY_PATH);
    const featureId = 'test-1-6-compiled';
    try {
      const result = await fx.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', featureId, workflowType: 'oneshot' },
      });

      // Wire-format assertions: content is an array with a text entry, and
      // that text entry parses back to a ToolResult with success=true.
      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThan(0);
      const first = content[0];
      expect(first.type).toBe('text');
      expect(typeof first.text).toBe('string');

      const parsed = JSON.parse(first.text) as {
        success: boolean;
        data?: { featureId?: string };
      };
      expect(parsed.success).toBe(true);
      expect(parsed.data).toBeDefined();
      expect(parsed.data!.featureId).toBe(featureId);

      // Cleanup — cancel the workflow so repeated runs do not leak state.
      // (Temp stateDir is also nuked in the finally block, but an explicit
      // cancel matches the task spec and exercises a second dispatch.)
      await fx.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'cancel', featureId },
      });
    } finally {
      await closeFixture(fx);
    }
  }, 30_000);
});
