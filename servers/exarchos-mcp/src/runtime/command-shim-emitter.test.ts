import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitCommandShim,
  CANONICAL_COMMANDS,
  type CommandShimResult,
} from './command-shim-emitter.js';

// ─── In-memory fs stub ─────────────────────────────────────────────────────

interface FsStub {
  files: Map<string, string>;
  dirs: Set<string>;
  writeFile(p: string, data: string): Promise<void>;
  mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>;
}

function createFsStub(): FsStub {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    async writeFile(p: string, data: string): Promise<void> {
      files.set(p, data);
    },
    async mkdir(p: string, _opts?: { recursive?: boolean }): Promise<void> {
      dirs.add(p);
    },
  };
}

describe('CommandShimEmitter', () => {
  let fs: FsStub;

  beforeEach(() => {
    fs = createFsStub();
  });

  it('CommandShimEmitter_Copilot_GeneratesInstructionsPreamble', async () => {
    const result: CommandShimResult = await emitCommandShim('copilot', '/project', { fs });

    expect(result.runtime).toBe('copilot');
    expect(result.status).toBe('written');
    expect(result.commandCount).toBe(18);

    // Verify the file was written
    const written = fs.files.get('/project/.github/copilot-instructions.md');
    expect(written).toBeDefined();

    // Check preamble
    expect(written).toContain('## Exarchos Commands');

    // Check a specific mapping
    expect(written).toContain('/ideate');
    expect(written).toContain('exarchos_orchestrate');
  });

  it('CommandShimEmitter_Cursor_GeneratesRulesFile', async () => {
    const result: CommandShimResult = await emitCommandShim('cursor', '/project', { fs });

    expect(result.runtime).toBe('cursor');
    expect(result.status).toBe('written');
    expect(result.commandCount).toBe(18);

    // Verify the file was written to .cursor/rules/
    const written = fs.files.get('/project/.cursor/rules/exarchos-commands.md');
    expect(written).toBeDefined();

    // Check structure
    expect(written).toContain('## Exarchos Commands');
    expect(written).toContain('/plan');
    expect(written).toContain('exarchos_orchestrate');
  });

  it('CommandShimEmitter_ClaudeCode_ReturnsSkipped', async () => {
    const result: CommandShimResult = await emitCommandShim('claude-code', '/project', { fs });

    expect(result.runtime).toBe('claude-code');
    expect(result.status).toBe('skipped');
    expect(result.commandCount).toBe(0);

    // No files should have been written
    expect(fs.files.size).toBe(0);
  });

  it('CommandShimEmitter_Copilot_IncludesAllCommands', async () => {
    await emitCommandShim('copilot', '/project', { fs });

    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).toBeDefined();

    const expectedCommands = [
      'ideate', 'plan', 'tdd', 'review', 'synthesize', 'shepherd',
      'debug', 'refactor', 'oneshot', 'delegate', 'rehydrate',
      'checkpoint', 'cleanup', 'prune', 'autocompact', 'dogfood',
      'reload', 'tag',
    ];

    for (const cmd of expectedCommands) {
      expect(written).toContain(`/${cmd}`);
    }

    // Verify CANONICAL_COMMANDS export has all 18
    expect(CANONICAL_COMMANDS).toHaveLength(18);
  });
});
