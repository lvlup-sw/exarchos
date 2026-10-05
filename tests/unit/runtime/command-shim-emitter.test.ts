import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitCommandShim,
  CANONICAL_COMMANDS,
  COMMAND_DESCRIPTIONS,
  type CommandShimResult,
} from '../../../src/runtime/command-shim-emitter.js';
import { canonicalCommandSet } from '../../../src/install/config/canonical-skills.js';

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

/**
 * The key set of `COMMAND_DESCRIPTIONS` must equal `canonicalCommandSet()`. The two lists are in
 * different files and can drift, so this suite pins them together. `matchesCanonical` makes the
 * same comparison, and the drift test runs it on changed copies of the key set.
 */
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

    const written = fs.files.get('/project/.github/copilot-instructions.md');
    expect(written).toBeDefined();

    expect(written).toContain('## Exarchos Commands');

    expect(written).toContain('/ideate');
    expect(written).toContain('exarchos_orchestrate');
  });

  it('CommandShimEmitter_Cursor_GeneratesRulesFile', async () => {
    const result: CommandShimResult = await emitCommandShim('cursor', '/project', { fs });

    expect(result.runtime).toBe('cursor');
    expect(result.status).toBe('written');
    expect(result.commandCount).toBe(18);

    const written = fs.files.get('/project/.cursor/rules/exarchos-commands.md');
    expect(written).toBeDefined();

    expect(written).toContain('## Exarchos Commands');
    expect(written).toContain('/plan');
    expect(written).toContain('exarchos_orchestrate');
  });

  it('CommandShimEmitter_ClaudeCode_ReturnsSkipped', async () => {
    const result: CommandShimResult = await emitCommandShim('claude-code', '/project', { fs });

    expect(result.runtime).toBe('claude-code');
    expect(result.status).toBe('skipped');
    expect(result.commandCount).toBe(0);

    expect(fs.files.size).toBe(0);
  });

  it('CommandShimEmitter_Copilot_IncludesAllCommands', async () => {
    await emitCommandShim('copilot', '/project', { fs });

    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).toBeDefined();

    const expectedCommands = [
      'ideate', 'plan', 'review', 'synthesize', 'shepherd',
      'debug', 'refactor', 'oneshot', 'delegate', 'rehydrate',
      'checkpoint', 'cleanup', 'prune', 'autocompact', 'dogfood',
      'discover', 'invariants', 'tag',
    ];

    for (const cmd of expectedCommands) {
      expect(written).toContain(`/${cmd}`);
    }

    expect(CANONICAL_COMMANDS).toHaveLength(18);
  });

  /**
   * No `tdd` command file and no `exarchos:tdd` skill exist. A shim that advertises `/tdd` makes
   * each runtime that reads the shim dispatch a dead command.
   */
  it('CommandShimEmitter_DoesNotAdvertiseRetiredTddCommand', async () => {
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'tdd')).toBe(false);
    expect(CANONICAL_COMMANDS.some((c) => c.skill === 'exarchos:tdd')).toBe(false);

    await emitCommandShim('copilot', '/project', { fs });
    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).not.toContain('/tdd');
  });

  /** `discover` and `invariants` each have a command file, so the shim must advertise them. */
  it('EmitCommandShim_AdvertisesDiscoverAndInvariants', async () => {
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'discover')).toBe(true);
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'invariants')).toBe(true);
    expect(CANONICAL_COMMANDS.find((c) => c.name === 'discover')?.skill).toBe('exarchos:discover');
    expect(CANONICAL_COMMANDS.find((c) => c.name === 'invariants')?.skill).toBe('exarchos:invariants');

    await emitCommandShim('copilot', '/project', { fs });
    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).toContain('/discover');
    expect(written).toContain('/invariants');
  });

  /** `reload` has no command file and no canonical entry, so the shim must not advertise it. */
  it('EmitCommandShim_DropsRetiredReload', async () => {
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'reload')).toBe(false);
    expect(CANONICAL_COMMANDS.some((c) => c.skill === 'exarchos:reload')).toBe(false);

    await emitCommandShim('copilot', '/project', { fs });
    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).not.toContain('/reload');
  });

  const matchesCanonical = (names: readonly string[]): boolean => {
    const sortedNames = [...names].sort();
    const canonical = canonicalCommandSet();
    return (
      sortedNames.length === canonical.length &&
      sortedNames.every((name, i) => name === canonical[i])
    );
  };

  it('CommandShim_NameSet_EqualsCanonicalSoT', () => {
    expect(Object.keys(COMMAND_DESCRIPTIONS).sort()).toEqual(canonicalCommandSet());
    expect(matchesCanonical(Object.keys(COMMAND_DESCRIPTIONS))).toBe(true);

    expect(Object.keys(COMMAND_DESCRIPTIONS)).not.toContain('reload');
    expect(Object.keys(COMMAND_DESCRIPTIONS)).toContain('discover');
    expect(Object.keys(COMMAND_DESCRIPTIONS)).toContain('invariants');
  });

  /**
   * Proves that the comparison catches drift. The test changes a copy of the key set in two ways,
   * and each copy must fail the comparison. The real export stays unchanged.
   */
  it('CommandShim_Guard_FailsOnInjectedDrift', () => {
    const realKeys = Object.keys(COMMAND_DESCRIPTIONS);

    const withBogusAdded = [...realKeys, 'bogus-command'];
    expect(matchesCanonical(withBogusAdded)).toBe(false);

    const withRealDropped = realKeys.filter((name) => name !== 'plan');
    expect(matchesCanonical(withRealDropped)).toBe(false);

    expect(Object.keys(COMMAND_DESCRIPTIONS)).toContain('plan');
    expect(matchesCanonical(realKeys)).toBe(true);
  });
});
