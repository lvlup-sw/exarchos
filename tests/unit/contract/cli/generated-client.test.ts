// Guards for the runtime addressing of the generated client in a packaged binary.
//
// In the compiled single-file binary, module-relative paths resolve into a
// virtual root, and a read of the source tree throws ENOENT. `compileForCli()`
// runs a freeze gate that reads the source tree, so it cannot run on the
// dispatch path. The dispatch path resolves addressing from the static
// generated module `generated/cli-action-ids.ts`. It runs no compile, because
// each CLI invocation is a new process and a compile costs time in each one.
//
// The tests pin four properties. The dispatch path reads no file. The runtime
// id set equals the static generated module. The generation-time compile still
// reads the tree. Each ActionId that the registry serves is addressable at
// runtime.
//
// @oracle-sources: ../../../../src/contract/cli/generated/cli-action-ids.ts, ../../../../src/registry.ts, shipped-src-corpus

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';

import { TOOL_REGISTRY } from '../../../../src/registry.js';
import {
  compileForCli,
  compileForCliAddressing,
  deriveCliSurface,
  serializeCliSurface,
} from '../../../../src/contract/cli/cli-surface.js';
import { contractActionIds, invokeContractAction } from '../../../../src/contract/cli/generated-client.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { CLI_ACTION_IDS } from '../../../../src/contract/cli/generated/cli-action-ids.js';

function enoent(path: unknown): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${String(path)}'`);
  (err as NodeJS.ErrnoException).code = 'ENOENT';
  return err;
}

/**
 * Simulates the compiled single-file binary: each filesystem read fails with ENOENT.
 * The returned log records each read attempt. A test asserts on the log, because an
 * upstream `try/catch` can hide a failed read that the packaged binary cannot satisfy.
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
  /**
   * `invokeContractAction` is the path of every CLI action command, and `contractActionIds` is its verify step.
   * The unknown id returns a typed `UNKNOWN_ACTION` envelope before any dispatch.
   * The known id reaches `dispatch` and fails on a missing required input, which needs nothing on disk.
   * The attempt log must be empty, because a `try/catch` can hide a failed read from a no-throw assertion.
   */
  it('DispatchPathAddressing_InAPackagedBinary_ReadsNoFilesystem', async () => {
    const fsMock = mockPackagedFilesystem();

    const known = await contractActionIds();
    expect(known.size).toBeGreaterThan(0);

    const ctx = { stateDir: '/tmp/exarchos-packaged-guard' } as unknown as DispatchContext;
    const unaddressable = await invokeContractAction('exarchos_workflow.no_such_action', {}, ctx);
    expect(unaddressable.success).toBe(false);
    expect(unaddressable.error?.code).toBe('UNKNOWN_ACTION');

    const knownId = 'exarchos_workflow.get';
    expect(known.has(knownId)).toBe(true);
    const invalid = await invokeContractAction(knownId, {}, ctx);
    expect(invalid.success).toBe(false);
    expect(invalid.error?.code).not.toBe('UNKNOWN_ACTION');

    expect(fsMock.attempts).toEqual([]);
  });

  /**
   * `compileForCliAddressing` is not on the dispatch path.
   * The byte-identity test uses it, so this test pins that it reads no filesystem.
   */
  it('CompileForCliAddressing_PerformsNoFilesystemReads', () => {
    const fsMock = mockPackagedFilesystem();

    const contract = compileForCliAddressing();
    const surface = deriveCliSurface(contract);
    expect(surface.commands.length).toBeGreaterThan(0);
    expect(surface.commands.length).toBe(
      TOOL_REGISTRY.reduce((n, tool) => n + tool.actions.length, 0),
    );
    expect(fsMock.attempts).toEqual([]);
  });

  /**
   * The generation-time compile must read the tree for its freeze gate, so it throws in the packaged environment.
   * If the compile stops that read, the authority freeze is dead, and this test fails.
   */
  it('CompileForCli_IsAuthorityGated_AndThrowsInThatSameEnvironment', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation((p) => {
      throw enoent(p);
    });
    expect(() => compileForCli()).toThrow(/ENOENT/);
  });

  /**
   * The authority verdict gates generation and does not change the compiler output.
   * On an approved tree, the two compiles give the same surface bytes.
   */
  it('AddressingSurface_IsByteIdentical_ToTheGenerationSurface', () => {
    expect(serializeCliSurface(deriveCliSurface(compileForCliAddressing()))).toBe(
      serializeCliSurface(deriveCliSurface(compileForCli())),
    );
  });

  /**
   * Each CLI invocation is a new process, so a compile on the dispatch path costs time on every invocation.
   * On win32, process spawn plus a compile exceeded the time budget of the packaged-binary proof.
   * The runtime set must equal the static generated module.
   */
  it('DispatchPathAddressing_UsesTheGeneratedModule_NeverACompile', async () => {
    const known = await contractActionIds();
    expect([...known].sort()).toEqual([...CLI_ACTION_IDS].sort());
    expect(known.size).toBe(CLI_ACTION_IDS.length);
  });
});

describe('Runtime addressing completeness (registry ⊆ compiled surface)', () => {
  /**
   * `registerActionCommand` derives `<tool>.<action>` for each registry action and gives it to `invokeContractAction`.
   * A served id that is not in the runtime set fails at the seam.
   */
  it('EveryRegistryServedActionId_IsAddressableAtRuntime', async () => {
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
