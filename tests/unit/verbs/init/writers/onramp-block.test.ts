import { describe, it, expect } from 'vitest';
import { readFileSync as realReadFileSync } from 'node:fs';

import {
  BINDING_MARKER_START,
  BINDING_MARKER_END,
  type InsertManagedBlockDeps,
} from '../../../../../src/install/onramp/managed-block.js';
import {
  AGENTS_MD_FILENAME,
  CLAUDE_MD_FILENAME,
  CLAUDE_MD_IMPORT_LINE,
  CODEX_WARN_BYTES,
  containsAtImport,
  deployOnrampBlocks,
  loadCanonicalBlockBody,
  resolveCanonicalBlockPath,
  stripBindingFences,
  writeAgentsMdBlock,
  writeClaudeMdShim,
} from '../../../../../src/verbs/init/writers/onramp-block.js';

/** In-memory synchronous fs implementing the {@link InsertManagedBlockDeps} seam. */
function memFs(seed: Record<string, string> = {}): {
  store: Map<string, string>;
  deps: InsertManagedBlockDeps;
} {
  const store = new Map<string, string>(Object.entries(seed));
  const deps: InsertManagedBlockDeps = {
    existsSync: (p) => store.has(p),
    readFileSync: (p) => {
      const v = store.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFileAtomic: (p, content) => {
      store.set(p, content);
    },
    copyFileSync: (src, dest) => {
      const v = store.get(src);
      if (v !== undefined) store.set(dest, v);
    },
  };
  return { store, deps };
}

/** Read the real canonical block body (fences stripped) from the repo asset. */
function realCanonicalBody(): string {
  return stripBindingFences(realReadFileSync(resolveCanonicalBlockPath(), 'utf8'));
}

describe('onramp-block writers (Task 013, DR-5)', () => {
  /**
   * The canonical block has no build-time placeholders, names the exarchos MCP
   * tools, and carries no `@import`. The installed block sits between the binding
   * fence markers and also carries no `@import`.
   */
  it('writers_AgentsMdBlock_RuntimeNeutralAndNoAtImports', () => {
    const canonicalBody = realCanonicalBody();

    expect(canonicalBody).not.toMatch(/\{\{/);
    expect(canonicalBody).toContain('exarchos_workflow');
    expect(containsAtImport(canonicalBody)).toBe(false);

    const { store, deps } = memFs();
    const result = writeAgentsMdBlock({ projectRoot: '/proj', canonicalBody }, deps);
    expect(result.ok).toBe(true);

    const written = store.get(`/proj/${AGENTS_MD_FILENAME}`);
    expect(written).toBeDefined();
    expect(written).toContain(BINDING_MARKER_START);
    expect(written).toContain(BINDING_MARKER_END);
    expect(containsAtImport(stripBindingFences(written as string))).toBe(false);
  });

  /** The installed AGENTS.md block body is byte-identical to the canonical block with fences stripped. */
  it('agentsMdBlock_ByteIdenticalToCanonical', () => {
    const expected = realCanonicalBody();
    expect(loadCanonicalBlockBody()).toBe(expected);

    const { store, deps } = memFs();
    writeAgentsMdBlock({ projectRoot: '/proj', canonicalBody: expected }, deps);
    const installedBody = stripBindingFences(store.get(`/proj/${AGENTS_MD_FILENAME}`) as string);
    expect(installedBody).toBe(expected);
  });

  /** The AGENTS.md block must be self-contained. The `@AGENTS.md` import belongs in the CLAUDE.md shim. */
  it('writers_AgentsMdBlock_RejectsAtImportInBlock', () => {
    const { deps } = memFs();
    const result = writeAgentsMdBlock(
      { projectRoot: '/proj', canonicalBody: 'orientation\n@AGENTS.md' },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/self-contained/i);
  });

  /** A target file near the Codex size cap gives a size warning. */
  it('writer_FileNearCodexCap_Warns', () => {
    const bigUserContent = 'x'.repeat(31 * 1024);
    const { deps } = memFs({ [`/proj/${AGENTS_MD_FILENAME}`]: bigUserContent });

    const result = writeAgentsMdBlock(
      { projectRoot: '/proj', canonicalBody: realCanonicalBody() },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /near the Codex/i.test(w))).toBe(true);
  });

  it('writer_SmallFile_NoCapWarning', () => {
    const { deps } = memFs();
    const result = writeAgentsMdBlock(
      { projectRoot: '/proj', canonicalBody: realCanonicalBody() },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(CODEX_WARN_BYTES).toBeGreaterThan(4 * 1024);
    expect(result.warnings.some((w) => /near the Codex/i.test(w))).toBe(false);
  });

  /** The `@AGENTS.md` import is on its own line between the fence markers, and it is the whole shim payload. */
  it('claudeWriter_Shim_ImportOnOwnLineInsideBlock', () => {
    const { store, deps } = memFs();
    const result = writeClaudeMdShim({ projectRoot: '/proj' }, deps);
    expect(result.ok).toBe(true);

    const written = store.get(`/proj/${CLAUDE_MD_FILENAME}`) as string;
    expect(written).toBeDefined();

    const startIdx = written.indexOf(BINDING_MARKER_START);
    const endIdx = written.indexOf(BINDING_MARKER_END);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    const block = written.slice(startIdx, endIdx);
    const ownLine = block
      .split('\n')
      .some((line) => line.trim() === CLAUDE_MD_IMPORT_LINE);
    expect(ownLine).toBe(true);

    expect(stripBindingFences(written)).toBe(CLAUDE_MD_IMPORT_LINE);
  });

  /**
   * Claude Code reaches AGENTS.md only through the CLAUDE.md shim. When the shim
   * write fails, `wrote` is true for the AGENTS.md block, but `failed` is also
   * true because the on-ramp is incomplete.
   */
  it('deployOnrampBlocks_ShimWriteFailsAgentsOk_ReportsFailed', () => {
    const { deps } = memFs();
    const shimFailingDeps: InsertManagedBlockDeps = {
      ...deps,
      writeFileAtomic: (p, content) => {
        if (p.endsWith(CLAUDE_MD_FILENAME)) {
          throw new Error(`EACCES: read-only ${p}`);
        }
        deps.writeFileAtomic!(p, content);
      },
    };

    const result = deployOnrampBlocks(
      { projectRoot: '/proj', canonicalBody: 'Use Exarchos for SDLC.\n' },
      shimFailingDeps,
    );

    expect(result.wrote).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/CLAUDE\.md|EACCES|managed block/i);
  });

  it('deployOnrampBlocks_BothSurfacesWrite_NotFailed', () => {
    const { deps } = memFs();
    const result = deployOnrampBlocks(
      { projectRoot: '/proj', canonicalBody: 'Use Exarchos for SDLC.\n' },
      deps,
    );
    expect(result.wrote).toBe(true);
    expect(result.failed).toBe(false);
  });

  /** A throwing atomic writer gives a structured error, not a throw. */
  it('writeAgentsMdBlock_UnwritableTarget_FailsOpenNoThrow', () => {
    const { deps } = memFs();
    const throwing: InsertManagedBlockDeps = {
      ...deps,
      writeFileAtomic: () => {
        throw new Error('EACCES');
      },
    };
    const result = writeAgentsMdBlock(
      { projectRoot: '/proj', canonicalBody: realCanonicalBody() },
      throwing,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
