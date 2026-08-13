import { describe, it, expect } from 'vitest';
import { readFileSync as realReadFileSync } from 'node:fs';

import {
  BINDING_MARKER_START,
  BINDING_MARKER_END,
  type InsertManagedBlockDeps,
} from '../../../install/onramp/managed-block.js';
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
} from './onramp-block.js';

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
  it('writers_AgentsMdBlock_RuntimeNeutralAndNoAtImports', () => {
    const canonicalBody = realCanonicalBody();

    // The canonical block is runtime-neutral: no build-time placeholders, no
    // per-harness fork, and it names the logical exarchos MCP tools.
    expect(canonicalBody).not.toMatch(/\{\{/);
    expect(canonicalBody).toContain('exarchos_workflow');
    // Self-contained: the block body carries no @import directive.
    expect(containsAtImport(canonicalBody)).toBe(false);

    const { store, deps } = memFs();
    const result = writeAgentsMdBlock({ projectRoot: '/proj', canonicalBody }, deps);
    expect(result.ok).toBe(true);

    const written = store.get(`/proj/${AGENTS_MD_FILENAME}`);
    expect(written).toBeDefined();
    // The installed block reuses the Task-012 fence constants.
    expect(written).toContain(BINDING_MARKER_START);
    expect(written).toContain(BINDING_MARKER_END);
    // And its body has no @import line inside the fenced block.
    expect(containsAtImport(stripBindingFences(written as string))).toBe(false);
  });

  it('agentsMdBlock_ByteIdenticalToCanonical', () => {
    // Boundary contract: the AGENTS.md block body is byte-identical to
    // binding/standard/block.md (fences stripped) — one content source.
    const expected = realCanonicalBody();
    expect(loadCanonicalBlockBody()).toBe(expected);

    const { store, deps } = memFs();
    writeAgentsMdBlock({ projectRoot: '/proj', canonicalBody: expected }, deps);
    const installedBody = stripBindingFences(store.get(`/proj/${AGENTS_MD_FILENAME}`) as string);
    expect(installedBody).toBe(expected);
  });

  it('writers_AgentsMdBlock_RejectsAtImportInBlock', () => {
    // A body carrying an @import is rejected — the AGENTS.md block must be
    // self-contained (the shim's @AGENTS.md lives in CLAUDE.md, not here).
    const { deps } = memFs();
    const result = writeAgentsMdBlock(
      { projectRoot: '/proj', canonicalBody: 'orientation\n@AGENTS.md' },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/self-contained/i);
  });

  it('writer_FileNearCodexCap_Warns', () => {
    // A target file already near the 32 KiB Codex cap yields a size advisory.
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
    // Sanity: a fresh small file is well under the near-cap threshold.
    expect(CODEX_WARN_BYTES).toBeGreaterThan(4 * 1024);
    expect(result.warnings.some((w) => /near the Codex/i.test(w))).toBe(false);
  });

  it('claudeWriter_Shim_ImportOnOwnLineInsideBlock', () => {
    const { store, deps } = memFs();
    const result = writeClaudeMdShim({ projectRoot: '/proj' }, deps);
    expect(result.ok).toBe(true);

    const written = store.get(`/proj/${CLAUDE_MD_FILENAME}`) as string;
    expect(written).toBeDefined();

    // The @AGENTS.md import is on its own line, between the fence markers.
    const startIdx = written.indexOf(BINDING_MARKER_START);
    const endIdx = written.indexOf(BINDING_MARKER_END);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    const block = written.slice(startIdx, endIdx);
    const ownLine = block
      .split('\n')
      .some((line) => line.trim() === CLAUDE_MD_IMPORT_LINE);
    expect(ownLine).toBe(true);

    // The shim block's payload is exactly the import (self-contained shim).
    expect(stripBindingFences(written)).toBe(CLAUDE_MD_IMPORT_LINE);
  });

  it('deployOnrampBlocks_ShimWriteFailsAgentsOk_ReportsFailed', () => {
    // DR-7: Claude Code reaches AGENTS.md ONLY via the CLAUDE.md @AGENTS.md shim
    // (the spec rejects a symlink in favour of the import). So an AGENTS.md block
    // that lands while the CLAUDE.md shim write fails still leaves Claude Code with
    // no reachable on-ramp — `failed` must be true so the onboard gate keeps the
    // retired SessionStart hooks in place. `failed` tracks BOTH surfaces, not just
    // AGENTS.md.
    const { deps } = memFs();
    // AGENTS.md write succeeds; the CLAUDE.md shim write throws (e.g. read-only file).
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

    // The AGENTS.md block DID write (wrote is true), but the shim failure makes the
    // composed on-ramp incomplete → failed.
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

  it('writeAgentsMdBlock_UnwritableTarget_FailsOpenNoThrow', () => {
    // A throwing atomic writer surfaces a structured error, never a throw.
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
