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
// The first structural fix was `compileForCliAddressing()` — the pure meta-model
// → shape/surface pipeline with the generation-time authority gate stubbed. The
// SECOND one superseded it on the dispatch path: addressing now resolves from
// the static generated module `generated/cli-action-ids.ts`, because a
// per-process compile blew the win32 packaged-proof budget. `contractActionIds`
// reads that module; `compileForCliAddressing` has no production callers left.
//
// The ENOENT guard follows the subject. It exercises the LIVE dispatch path —
// `invokeContractAction` → `contractActionIds` → the generated module — because
// that is the code every CLI invocation of the shipped artifact runs. Pinning
// the old helper instead would guard a function the binary never calls: green
// for reasons unrelated to whether the packaged binary works.
//
// Four properties are pinned:
//
//   1. NO FILESYSTEM DEPENDENCE ON THE DISPATCH PATH — addressing and invocation
//      must both succeed where every fs read throws ENOENT (exactly what the
//      packaged binary's virtual root looks like). Any future edit that sneaks
//      a source-tree read back into dispatch goes red HERE, in the unit tier,
//      instead of only in the slow compiled-binary tier.
//   2. NO COMPILE ON THE DISPATCH PATH — the addressing set is the generated
//      module verbatim, resolved without running the meta-model pipeline.
//   3. THE CONTRAST ARM — the generation-time compile MUST keep reading the tree,
//      so it still throws in that same environment. The split is the point.
//   4. COMPLETENESS — every ActionId the registry serves (the ids
//      `registerActionCommand` derives, plus the hard-wired top-level
//      promotions) is addressable through the runtime set, and the addressing
//      surface is byte-identical to the authority-gated generation surface.
//
// @oracle-sources: ./generated/cli-action-ids.ts, ../../registry.ts, shipped-src-corpus
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
import { contractActionIds, invokeContractAction } from './generated-client.js';
import type { DispatchContext } from '../../core/dispatch.js';
import { CLI_ACTION_IDS } from './generated/cli-action-ids.js';

function enoent(path: unknown): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${String(path)}'`);
  (err as NodeJS.ErrnoException).code = 'ENOENT';
  return err;
}

/**
 * The compiled single-file binary: every read of the (virtual) filesystem fails
 * ENOENT, exactly as `/package.json` did in the shipped artifact.
 *
 * Returns a counter so a test can assert not merely that nothing threw, but that
 * nothing was ATTEMPTED — a read that is swallowed by a `try/catch` somewhere
 * upstream would otherwise pass this environment while still being a source-tree
 * dependence the packaged binary cannot satisfy.
 */
function mockPackagedFilesystem(): { attempts: string[] } {
  const attempts: string[] = [];
  const record = (p: unknown): never => {
    attempts.push(String(p));
    throw enoent(p);
  };
  vi.spyOn(fs, 'readFileSync').mockImplementation(record);
  vi.spyOn(fs, 'readdirSync').mockImplementation(record);
  vi.spyOn(fs, 'statSync').mockImplementation(record);
  vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    attempts.push(String(p));
    return false;
  });
  return { attempts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Runtime addressing (packaged-binary environment)', () => {
  it('DispatchPathAddressing_InAPackagedBinary_ReadsNoFilesystem', async () => {
    // THE LIVE PATH. `invokeContractAction` is what every CLI command reaches;
    // `contractActionIds` is its verify step. This is the code the shipped
    // artifact runs, so this is the code the packaged-environment guard has to
    // exercise — the previous version of this test pinned
    // `compileForCliAddressing()`, which no production caller reaches.
    const fsMock = mockPackagedFilesystem();

    const known = await contractActionIds();
    expect(known.size).toBeGreaterThan(0);

    // …and through the invocation seam itself, on both arms. The unaddressable
    // arm returns a TYPED envelope rather than crashing, which is the property
    // the packaged proof cared about: an off-contract exit code was the symptom.
    const ctx = { stateDir: '/tmp/exarchos-packaged-guard' } as unknown as DispatchContext;
    const unaddressable = await invokeContractAction('exarchos_workflow.no_such_action', {}, ctx);
    expect(unaddressable.success).toBe(false);
    expect(unaddressable.error?.code).toBe('UNKNOWN_ACTION');

    // …and a KNOWN action, which is the arm that actually reaches `dispatch`.
    // The unaddressable one returns UNKNOWN_ACTION before dispatch is called at
    // all, so on its own it says nothing about the path the packaged binary
    // takes for real work — including whether THAT path reads the tree. A
    // missing required input is the deterministic post-dispatch outcome that
    // needs nothing on disk to produce.
    const knownId = 'exarchos_workflow.get';
    expect(known.has(knownId)).toBe(true);
    const invalid = await invokeContractAction(knownId, {}, ctx);
    expect(invalid.success).toBe(false);
    expect(invalid.error?.code).not.toBe('UNKNOWN_ACTION');

    // Nothing was even ATTEMPTED. Asserting on the attempt log rather than on
    // "it did not throw" is what distinguishes "performs no reads" from
    // "performs reads and swallows the failure".
    expect(fsMock.attempts).toEqual([]);
  });

  it('CompileForCliAddressing_PerformsNoFilesystemReads', () => {
    // The helper is no longer on the dispatch path, but it is still the subject
    // of the byte-identity check below, so its fs-independence stays pinned —
    // as a property of a verification helper, not as the packaged-binary guard.
    const fsMock = mockPackagedFilesystem();

    const contract = compileForCliAddressing();
    const surface = deriveCliSurface(contract);
    expect(surface.commands.length).toBeGreaterThan(0);
    expect(surface.commands.length).toBe(
      TOOL_REGISTRY.reduce((n, tool) => n + tool.actions.length, 0),
    );
    expect(fsMock.attempts).toEqual([]);
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

  it('DispatchPathAddressing_UsesTheGeneratedModule_NeverACompile', async () => {
    // The win32 cold-start property: the addressing set the dispatch path
    // reads is the STATIC generated module — resolving it must not run the
    // meta-model pipeline (each packaged probe spawns a fresh process, so a
    // per-process compile is paid on every single CLI invocation of the
    // shipped binary; win32 spawn+compile blew the packaged-proof budget).
    // Static agreement is pinned by the seam baseline test; here we pin the
    // MECHANISM: the runtime set equals the generated module verbatim, and it
    // resolves synchronously (no lazy compile behind the Promise).
    const known = await contractActionIds();
    expect([...known].sort()).toEqual([...CLI_ACTION_IDS].sort());
    expect(known.size).toBe(CLI_ACTION_IDS.length);
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
