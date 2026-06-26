import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitCommandShim,
  CANONICAL_COMMANDS,
  COMMAND_DESCRIPTIONS,
  type CommandShimResult,
} from './command-shim-emitter.js';
// Cross-package-boundary import of the root canonical SoT. The MCP package
// cannot import this in PRODUCTION code (`rootDir: ./src`), so the coupling
// between the shim's command set and the root SoT is enforced TEST-ONLY. This
// `../../../../src/...` reach into the repo root is an established test pattern
// (see cli-commands/install-skills-bridge.test.ts).
import { canonicalCommandSet } from '../../../../src/config/canonical-skills.js';

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
      'ideate', 'plan', 'review', 'synthesize', 'shepherd',
      'debug', 'refactor', 'oneshot', 'delegate', 'rehydrate',
      'checkpoint', 'cleanup', 'prune', 'autocompact', 'dogfood',
      'discover', 'invariants', 'tag',
    ];

    for (const cmd of expectedCommands) {
      expect(written).toContain(`/${cmd}`);
    }

    // Verify CANONICAL_COMMANDS export has all 18
    expect(CANONICAL_COMMANDS).toHaveLength(18);
  });

  it('CommandShimEmitter_DoesNotAdvertiseRetiredTddCommand', async () => {
    // Regression for the #1590 retirement gap: commands/tdd.md, its alias, and
    // the COMMAND_TO_SKILL entry were deleted, but this hardcoded shim list still
    // advertised `/tdd` → exarchos:tdd (a skill that no longer exists), so every
    // runtime consuming command shims dispatched a dead command. Lock it out.
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'tdd')).toBe(false);
    expect(CANONICAL_COMMANDS.some((c) => c.skill === 'exarchos:tdd')).toBe(false);

    await emitCommandShim('copilot', '/project', { fs });
    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).not.toContain('/tdd');
  });

  it('EmitCommandShim_AdvertisesDiscoverAndInvariants', async () => {
    // #1609: `discover` and `invariants` both have command files + SoT entries
    // but were missing from the hardcoded shim list, so shim-consuming runtimes
    // (Copilot, Cursor) never advertised them. Lock them in.
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'discover')).toBe(true);
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'invariants')).toBe(true);
    expect(CANONICAL_COMMANDS.find((c) => c.name === 'discover')?.skill).toBe('exarchos:discover');
    expect(CANONICAL_COMMANDS.find((c) => c.name === 'invariants')?.skill).toBe('exarchos:invariants');

    await emitCommandShim('copilot', '/project', { fs });
    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).toContain('/discover');
    expect(written).toContain('/invariants');
  });

  it('EmitCommandShim_DropsRetiredReload', async () => {
    // #1609: `reload` had no commands/reload.md and no SoT entry — it was a
    // phantom the hand-kept shim list advertised. Lock it out.
    expect(CANONICAL_COMMANDS.some((c) => c.name === 'reload')).toBe(false);
    expect(CANONICAL_COMMANDS.some((c) => c.skill === 'exarchos:reload')).toBe(false);

    await emitCommandShim('copilot', '/project', { fs });
    const written = fs.files.get('/project/.github/copilot-instructions.md')!;
    expect(written).not.toContain('/reload');
  });

  // ─── Coupling guard: shim set == root canonical SoT (#1609, test-only) ──────
  //
  // The shim's hand-kept COMMAND_DESCRIPTIONS map and the root SoT
  // (`canonicalCommandSet()`) are physically separate files in separate
  // packages, so they can drift. This guard pins them together: any command
  // added/removed in the root SoT (which is itself guarded against commands/*.md)
  // must be mirrored in the shim, or CI fails here.

  /** Equality predicate mirroring the guard, so the drift test exercises the
   *  exact comparison logic that protects the real export. */
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

    // The specific drift this guard was born to catch (#1609).
    expect(Object.keys(COMMAND_DESCRIPTIONS)).not.toContain('reload');
    expect(Object.keys(COMMAND_DESCRIPTIONS)).toContain('discover');
    expect(Object.keys(COMMAND_DESCRIPTIONS)).toContain('invariants');
  });

  it('CommandShim_Guard_FailsOnInjectedDrift', () => {
    // Prove the comparison actually CATCHES drift — otherwise a guard that
    // always passes is worthless. Drift a COPY of the key set (never mutate the
    // real export) two ways and assert each fails the canonical equality check.
    const realKeys = Object.keys(COMMAND_DESCRIPTIONS);

    const withBogusAdded = [...realKeys, 'bogus-command'];
    expect(matchesCanonical(withBogusAdded)).toBe(false);

    const withRealDropped = realKeys.filter((name) => name !== 'plan');
    expect(matchesCanonical(withRealDropped)).toBe(false);

    // The real export is untouched and still matches.
    expect(Object.keys(COMMAND_DESCRIPTIONS)).toContain('plan');
    expect(matchesCanonical(realKeys)).toBe(true);
  });
});
