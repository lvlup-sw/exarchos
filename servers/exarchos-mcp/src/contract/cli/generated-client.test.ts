// ─── Generated-client runtime addressing — packaged-environment guards ───────
//
// Regression guards for the P05-02 packaged-proof failure class: the generated
// client's verify step ran the authority-gated `compileForCli()`, whose freeze
// gate READS THE SOURCE TREE (package.json, the invariant catalog, `.ts`
// sources) via module-relative paths. Inside the compiled single-file binary
// those paths resolve into the bundle's virtual root (`/package.json`) and
// throw ENOENT — crashing EVERY CLI invocation of the shipped artifact with an
// UNCAUGHT_EXCEPTION envelope and an off-contract exit code.
//
// The structural fix is `compileForCliAddressing()`: the pure meta-model →
// shape/surface pipeline with the generation-time authority gate stubbed.
// These tests pin the two properties that make that fix hold:
//
//   1. NO FILESYSTEM DEPENDENCE — the runtime addressing compile must succeed
//      in an environment where every fs read throws ENOENT (exactly what the
//      packaged binary's virtual root looks like). Any future edit that sneaks
//      a source-tree read back into the dispatch path goes red HERE, in the
//      unit tier, instead of only in the slow compiled-binary tier.
//   2. COMPLETENESS — every ActionId the registry serves (the ids
//      `registerActionCommand` derives, plus the hard-wired top-level
//      promotions) is addressable through the runtime set, and the addressing
//      surface is byte-identical to the authority-gated generation surface.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

import { TOOL_REGISTRY } from '../../registry.js';
import {
  compileForCli,
  compileForCliAddressing,
  deriveCliSurface,
  serializeCliSurface,
} from './cli-surface.js';
import { contractActionIds } from './generated-client.js';

function enoent(path: unknown): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${String(path)}'`);
  (err as NodeJS.ErrnoException).code = 'ENOENT';
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Runtime addressing compile (packaged-binary environment)', () => {
  it('CompileForCliAddressing_PerformsNoFilesystemReads', () => {
    // Simulate the compiled single-file binary: every read of the (virtual)
    // filesystem fails ENOENT, exactly as `/package.json` did in the shipped
    // artifact. The runtime addressing compile must not notice.
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      throw enoent(p);
    });
    vi.spyOn(fs, 'readdirSync').mockImplementation((p) => {
      throw enoent(p);
    });
    vi.spyOn(fs, 'statSync').mockImplementation((p) => {
      throw enoent(p);
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const contract = compileForCliAddressing();
    const surface = deriveCliSurface(contract);
    expect(surface.commands.length).toBeGreaterThan(0);
    expect(surface.commands.length).toBe(
      TOOL_REGISTRY.reduce((n, tool) => n + tool.actions.length, 0),
    );
  });

  it('CompileForCli_IsAuthorityGated_AndThrowsInThatSameEnvironment', () => {
    // The CONTRAST arm: the generation-time compile MUST keep reading the
    // tree (the freeze gate is its whole point), so in the packaged-binary
    // environment it throws. This pins the split — if someone "fixes" the
    // generation gesture to stop reading the tree, the authority freeze is
    // silently dead and this test says so.
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      throw enoent(p);
    });
    expect(() => compileForCli()).toThrow(/ENOENT/);
  });

  it('AddressingSurface_IsByteIdentical_ToTheGenerationSurface', () => {
    // The authority verdict gates generation but never alters compiler
    // output: on an approved tree the two compiles project the SAME surface,
    // byte for byte — so verifying an ActionId against the addressing surface
    // IS verifying it against the generated contract.
    expect(serializeCliSurface(deriveCliSurface(compileForCliAddressing()))).toBe(
      serializeCliSurface(deriveCliSurface(compileForCli())),
    );
  });
});

describe('Runtime addressing completeness (registry ⊆ compiled surface)', () => {
  it('EveryRegistryServedActionId_IsAddressableAtRuntime', async () => {
    // `registerActionCommand` derives `<tool>.<action>` for EVERY registry
    // action (describe/meta verbs included) and hands it to
    // `invokeContractAction` — so every served id must resolve in the runtime
    // set or the command is dead on arrival at the seam.
    const known = await contractActionIds();
    for (const tool of TOOL_REGISTRY) {
      for (const action of tool.actions) {
        const actionId = `${tool.name}.${action.name}`;
        expect(
          known.has(actionId),
          `${actionId} is served by the registry but not addressable through the runtime surface`,
        ).toBe(true);
      }
    }
  });
});
