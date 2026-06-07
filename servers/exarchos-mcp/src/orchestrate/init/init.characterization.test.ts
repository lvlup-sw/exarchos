/**
 * Characterization test (Feathers baseline) for the `init` orchestrate
 * handler — DR-9 / Task 001 of the onboard/doctor consolidation epic.
 *
 * PURPOSE: This is a REGRESSION ORACLE, not a spec for new behavior. It
 * PINS the CURRENT observable outputs of `init` so the upcoming
 * consolidation refactor (DR-1–DR-8: the fold into `onboard`/`doctor`)
 * cannot silently change what init writes to disk or emits. It MUST pass
 * against the code as it exists today.
 *
 * The four observable surfaces pinned (per DR-9 acceptance criteria):
 *   1. The set of files written (paths + content shape).
 *   2. The MCP-registration JSON shape written to the `~/.claude.json`
 *      target (read-modify-write, merge semantics).
 *   3. The `.exarchos.yml` seed produced (header + detected commands +
 *      commented invariants stanza).
 *   4. The `init.executed` event payload shape.
 *
 * STRATEGY — pin REAL disk side effects, not mock returns:
 *   - We drive `handleInitWithWriters` with the *real* production writers
 *     (the same five classes `getAllWriters()` instantiates) so the
 *     observable behavior is the production behavior.
 *   - We inject a REAL-fs `WriterDeps` (`buildWriterDeps()`) but redirect
 *     `home()` and `cwd()` at temp directories, so the writers' real
 *     read-modify-write logic runs against an isolated fixture instead of
 *     the developer's actual `~/.claude.json`.
 *   - We invoke `seedExarchosConfig` directly against the fixture repo
 *     root — exactly what `runPostInitSeed()` does in production, minus
 *     the `git rev-parse`/`process.cwd()` root discovery (which we cannot
 *     redirect without mutating the process). The seed wiring itself is
 *     unchanged.
 *
 * Absolute-path and timestamp noise is normalized so the pins are stable
 * across machines and runs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { WriterDeps } from './probes.js';
import { buildWriterDeps } from './probes.js';
import type { RuntimeConfigWriter } from './writers/writer.js';
import type { ConfigWriteResult, InitOutput } from './schema.js';
import type { VcsEnvironment } from '../../vcs/detector.js';

import { handleInitWithWriters, INIT_STREAM_ID } from './index.js';
import { seedExarchosConfig } from './seed-exarchos-config.js';

import { ClaudeCodeWriter } from './writers/claude-code.js';
import { CopilotWriter } from './writers/copilot.js';
import { CursorWriter } from './writers/cursor.js';
import { CodexWriter } from './writers/codex.js';
import { OpenCodeWriter } from './writers/opencode.js';

// ─── Production writer list (mirror of index.ts getAllWriters) ──────────────

/** The exact five writers, in the exact order, that `handleInit` runs. */
function productionWriters(): ReadonlyArray<RuntimeConfigWriter> {
  return [
    new ClaudeCodeWriter(),
    new CopilotWriter(),
    new CursorWriter(),
    new CodexWriter(),
    new OpenCodeWriter(),
  ];
}

// ─── Fixture ────────────────────────────────────────────────────────────────

interface Fixture {
  /** Temp dir standing in for the user's HOME (`~/.claude.json` lives here). */
  readonly home: string;
  /** Temp dir standing in for the project root (`.vscode`, `.cursor` here). */
  readonly projectRoot: string;
  /** Event-store state dir. */
  readonly stateDir: string;
  readonly ctx: DispatchContext;
  /** Real-fs WriterDeps with home()/cwd() redirected at the fixture. */
  readonly deps: WriterDeps;
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'init-char-'));
  const home = path.join(base, 'home');
  const projectRoot = path.join(base, 'project');
  const stateDir = path.join(base, 'state');
  await mkdir(home, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // Seed the project with a Node toolchain marker so `seedExarchosConfig`
  // resolves real commands (npm). The `test:run` script is required for the
  // npm resolver to emit `test`/`typecheck` (it gates on `scripts.test:run`);
  // without it only `install` would resolve, under-pinning the `.exarchos.yml`
  // surface.
  await writeFile(
    path.join(projectRoot, 'package.json'),
    JSON.stringify(
      { name: 'fixture', version: '0.0.0', scripts: { 'test:run': 'vitest run' } },
      null,
      2,
    ),
    'utf8',
  );

  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();

  // Real-fs deps, but home()/cwd() point at the fixture so the writers'
  // real read-modify-write logic runs against isolated temp dirs.
  const realDeps = buildWriterDeps();
  const deps: WriterDeps = {
    ...realDeps,
    home: () => home,
    cwd: () => projectRoot,
  };

  return {
    home,
    projectRoot,
    stateDir,
    ctx: { stateDir, eventStore, enableTelemetry: false },
    deps,
  };
}

// ─── Normalizers ────────────────────────────────────────────────────────────

/** Replace any occurrence of a temp path with a stable token. */
function scrubPaths(value: string, fx: Fixture): string {
  return value
    .split(fx.home).join('<HOME>')
    .split(fx.projectRoot).join('<PROJECT>')
    .split(fx.stateDir).join('<STATE>');
}

/** Recursively list files (relative paths) under `dir`. */
async function listFilesRel(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(cur: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(cur);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(cur, e);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else out.push(path.relative(dir, p));
    }
  }
  await walk(dir);
  return out.map((p) => p.split(path.sep).join('/')).sort();
}

// ─── Test ─────────────────────────────────────────────────────────────────

describe('Init characterization (DR-9 baseline)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    // base is the parent of home/project/state — remove the whole tree.
    const base = path.dirname(fx.home);
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  });

  it('Init_CurrentOutputs_PinnedSnapshot', async () => {
    // ── Arrange: a null VCS detector (deterministic — no network/git probe).
    const nullVcs = async (): Promise<VcsEnvironment | null> => null;

    // ── Act: run the real production writers against the fixture via the
    // testable seam, with our redirected real-fs deps.
    const result = await handleInitWithWriters(
      { nonInteractive: true },
      fx.ctx,
      productionWriters(),
      nullVcs,
      () => fx.deps,
    );

    // And perform the post-init seed step exactly as production's
    // `runPostInitSeed()` does, pointed at the fixture repo root.
    const seed = seedExarchosConfig(fx.projectRoot);

    // ════════════════════════════════════════════════════════════════════
    // PIN 1 — ToolResult / per-runtime ConfigWriteResult shape.
    // ════════════════════════════════════════════════════════════════════
    expect(result.success).toBe(true);
    const data = result.data as InitOutput;

    // Five runtimes, in production order. claude-code/copilot/cursor write
    // real config; codex/opencode are stubs (format not finalized).
    const byRuntime = Object.fromEntries(
      data.runtimes.map((r) => [r.runtime, r]),
    ) as Record<string, ConfigWriteResult>;

    expect(data.runtimes.map((r) => r.runtime)).toEqual([
      'claude-code',
      'copilot',
      'cursor',
      'codex',
      'opencode',
    ]);

    // claude-code: MCP config written to ~/.claude.json (commands/skills
    // dirs absent in the fixture, so only mcp-config is written).
    expect(byRuntime['claude-code'].status).toBe('written');
    expect(byRuntime['claude-code'].componentsWritten).toEqual(['mcp-config']);
    expect(scrubPaths(byRuntime['claude-code'].path ?? '', fx)).toBe(
      '<HOME>/.claude.json',
    );

    // copilot + cursor: JSON writers always write mcp-config (no path field).
    expect(byRuntime['copilot'].status).toBe('written');
    expect(byRuntime['copilot'].componentsWritten).toEqual(['mcp-config']);
    expect(byRuntime['cursor'].status).toBe('written');
    expect(byRuntime['cursor'].componentsWritten).toEqual(['mcp-config']);

    // codex + opencode: stub status with the "format not yet finalized"
    // advisory warning.
    expect(byRuntime['codex'].status).toBe('stub');
    expect(byRuntime['codex'].componentsWritten).toEqual([]);
    expect(byRuntime['codex'].warnings?.[0]).toMatch(
      /Codex config format not yet finalized/,
    );
    expect(byRuntime['opencode'].status).toBe('stub');
    expect(byRuntime['opencode'].componentsWritten).toEqual([]);
    expect(byRuntime['opencode'].warnings?.[0]).toMatch(
      /OpenCode config format not yet finalized/,
    );

    // VCS null, durationMs a non-negative integer.
    expect(data.vcs).toBeNull();
    expect(Number.isInteger(data.durationMs)).toBe(true);
    expect(data.durationMs).toBeGreaterThanOrEqual(0);

    // ════════════════════════════════════════════════════════════════════
    // PIN 2 — The set of files written, paths + content shape.
    // ════════════════════════════════════════════════════════════════════
    const homeFiles = await listFilesRel(fx.home);
    const projectFiles = await listFilesRel(fx.projectRoot);

    // HOME gets exactly the Claude Code MCP config file.
    expect(homeFiles).toEqual(['.claude.json']);

    // PROJECT gets the seeded .exarchos.yml plus the copilot/cursor MCP
    // JSON configs (+ the package.json marker we planted).
    expect(projectFiles).toEqual([
      '.cursor/mcp.json',
      '.exarchos.yml',
      '.vscode/mcp.json',
      'package.json',
    ]);

    // ════════════════════════════════════════════════════════════════════
    // PIN 3 — MCP-registration JSON shape in the ~/.claude.json target.
    // ════════════════════════════════════════════════════════════════════
    const claudeJsonRaw = await readFile(
      path.join(fx.home, '.claude.json'),
      'utf8',
    );
    const claudeJson = JSON.parse(claudeJsonRaw) as {
      mcpServers: Record<string, unknown>;
    };

    function scrubObj<T>(v: T): unknown {
      return JSON.parse(scrubPaths(JSON.stringify(v), fx)) as unknown;
    }
    // The exarchos entry: node + path to the deployed server js + a
    // WORKFLOW_STATE_DIR env pointing under ~/.claude. Paths scrubbed
    // (the raw form embeds the temp HOME).
    expect(scrubObj(claudeJson.mcpServers.exarchos)).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['<HOME>/.claude/mcp-servers/exarchos-mcp.js'],
      env: { WORKFLOW_STATE_DIR: '<HOME>/.claude/workflow-state' },
    });

    // The copilot/cursor MCP JSON shape (npx-based stdio entry).
    const vscodeMcp = JSON.parse(
      await readFile(path.join(fx.projectRoot, '.vscode', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(vscodeMcp.mcpServers.exarchos).toEqual({
      command: 'npx',
      args: ['-y', '@anthropic-ai/claude-code', '--mcp-server-name=exarchos'],
      type: 'stdio',
    });

    const cursorMcp = JSON.parse(
      await readFile(path.join(fx.projectRoot, '.cursor', 'mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, unknown> };
    expect(cursorMcp.mcpServers.exarchos).toEqual(vscodeMcp.mcpServers.exarchos);

    // ════════════════════════════════════════════════════════════════════
    // PIN 4 — The `.exarchos.yml` seed produced.
    // ════════════════════════════════════════════════════════════════════
    expect(seed.wrote).toBe(true);
    expect(seed.reason).toBe('created');
    expect(scrubPaths(seed.path, fx)).toBe('<PROJECT>/.exarchos.yml');

    const exarchosYml = await readFile(
      path.join(fx.projectRoot, '.exarchos.yml'),
      'utf8',
    );
    // Header banner.
    expect(exarchosYml).toContain(
      '# .exarchos.yml — Exarchos project configuration.',
    );
    expect(exarchosYml).toContain(
      '# init time. Edit freely; subsequent inits will not overwrite it.',
    );
    expect(exarchosYml).toContain(
      'https://github.com/lvlup-sw/exarchos/issues/1199',
    );
    // Detected Node commands (package.json marker → npm toolchain).
    expect(exarchosYml).toMatch(/^test: npm run test:run$/m);
    expect(exarchosYml).toMatch(/^typecheck: tsc --noEmit$/m);
    expect(exarchosYml).toMatch(/^install: npm install$/m);
    // Commented (inactive) invariants stanza — documents opt-in only.
    expect(exarchosYml).toContain('# invariants:');
    expect(exarchosYml).toMatch(/#\s*devCatalog:\s*disabled/);
    expect(exarchosYml).not.toMatch(/^invariants:/m);

    // ════════════════════════════════════════════════════════════════════
    // PIN 5 — The `init.executed` event payload shape.
    // ════════════════════════════════════════════════════════════════════
    const events = await fx.ctx.eventStore.query(INIT_STREAM_ID);
    expect(events).toHaveLength(1);
    const ev = events[0];

    // Envelope.
    expect(ev.type).toBe('init.executed');
    expect(ev.streamId).toBe(INIT_STREAM_ID);
    expect(ev.sequence).toBe(1);
    expect(typeof ev.timestamp).toBe('string');

    // Payload: { runtimes, vcs, durationMs } — same shape as the output.
    const payload = ev.data as InitOutput;
    expect(payload).toHaveProperty('runtimes');
    expect(payload).toHaveProperty('vcs');
    expect(payload).toHaveProperty('durationMs');
    expect(payload.vcs).toBeNull();
    expect(payload.runtimes.map((r) => r.runtime)).toEqual([
      'claude-code',
      'copilot',
      'cursor',
      'codex',
      'opencode',
    ]);
    expect(payload.runtimes.map((r) => r.status)).toEqual([
      'written',
      'written',
      'written',
      'stub',
      'stub',
    ]);

    // Inline structural snapshot of the normalized event data (the
    // regression oracle for the fold). durationMs varies, so we replace it
    // with a stable token before snapshotting.
    const normalizedPayload = JSON.parse(
      scrubPaths(JSON.stringify({ ...payload, durationMs: '<MS>' }), fx),
    ) as unknown;

    expect(normalizedPayload).toMatchInlineSnapshot(`
      {
        "durationMs": "<MS>",
        "runtimes": [
          {
            "componentsWritten": [
              "mcp-config",
            ],
            "path": "<HOME>/.claude.json",
            "runtime": "claude-code",
            "status": "written",
          },
          {
            "componentsWritten": [
              "mcp-config",
            ],
            "runtime": "copilot",
            "status": "written",
          },
          {
            "componentsWritten": [
              "mcp-config",
            ],
            "runtime": "cursor",
            "status": "written",
          },
          {
            "componentsWritten": [],
            "runtime": "codex",
            "status": "stub",
            "warnings": [
              "Codex config format not yet finalized — run exarchos init again after Codex support is confirmed",
            ],
          },
          {
            "componentsWritten": [],
            "runtime": "opencode",
            "status": "stub",
            "warnings": [
              "OpenCode config format not yet finalized — run exarchos init again after OpenCode support is confirmed",
            ],
          },
        ],
        "vcs": null,
      }
    `);
  });
});
