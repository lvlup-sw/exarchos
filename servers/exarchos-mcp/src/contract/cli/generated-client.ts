// ─── Generated CLI client: the contract-derived dispatch seam (DR-25) ────────
//
// The governing INV-2 framing makes the CLI a GENERATED client of the compiled
// contract, equal to the MCP wire BY CONSTRUCTION. This module is the CLI's
// realization of that framing for dispatch ADDRESSING: it is the ONE module on
// the CLI side permitted to import the runtime `dispatch` value, and it will
// only address an action the compiled contract actually contains.
//
// What "generated" buys here — and what the old hand-assembled call sites in
// `adapters/cli.ts` could not: an action is addressed by its stable contract
// `ActionId` (`<tool>.<action>`), and the id is verified against
// `deriveCliSurface(compileForCli())` — the SAME derivation the checked-in
// `generated/cli-surface.json` baseline and its drift guard pin — before any
// dispatch runs. An action the contract does not compile cannot be addressed:
// a renamed or removed action fails LOUD at the seam instead of silently
// dispatching into an UNKNOWN_ACTION envelope the caller hand-coordinated
// around. The `(tool, action)` pair the shared handler receives is SPLIT from
// the verified ActionId, never assembled by the caller, so the CLI cannot
// target an action the contract does not know by construction.
//
// The Commander tree's SHAPE (groups, command names, flags) remains
// presentation authored in `adapters/cli.ts`; behavior stays in the shared
// dispatch core. This seam owns exactly one concern: contract-verified
// addressing of the shared handler.
//
// COLD-START DISCIPLINE (DR-5): the contract compiler pulls
// `zod-to-json-schema` and the full meta-model graph — several MB the CLI's
// static import graph deliberately excludes (see the lazy-import notes in
// `adapters/cli.ts`). The surface is therefore compiled LAZILY on the first
// invocation and memoized for the life of the process; importing this module
// costs only the `core/dispatch` edge the CLI already paid before DR-25.
// ────────────────────────────────────────────────────────────────────────────

import { dispatch } from '../../core/dispatch.js';
import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';

/**
 * The diagnostic for an ActionId that is not part of the compiled contract
 * surface. This is the seam failing LOUD — nothing is dispatched — but loud
 * means a TYPED, enveloped failure with a stable exit code, never an uncaught
 * crash: {@link invokeContractAction} returns this as a standard contract
 * error envelope (`UNKNOWN_ACTION`, the same code the dispatch core answers
 * for an unroutable action, mapped through `exitCodeForError`). An
 * unaddressable action is a build-time drift bug (a renamed/removed action,
 * or a caller inventing an id), never a user-input condition — the message
 * says so explicitly.
 */
export class UnknownContractActionError extends Error {
  override readonly name = 'UnknownContractActionError';

  constructor(readonly actionId: string) {
    super(
      `ActionId "${actionId}" is not part of the compiled contract surface — ` +
        `the generated CLI client can only address actions the contract compiles ` +
        `(deriveCliSurface(compileForCliAddressing())). If the action was renamed or removed, ` +
        `update the caller; if it is new, it must compile before it can be addressed.`,
    );
  }
}

/**
 * The memoized compiled surface. One compile per process, on first use — see
 * the cold-start note in the module header. Memoizing the PROMISE (not the
 * value) makes concurrent first invocations share a single compile.
 */
let actionIdsPromise: Promise<ReadonlySet<string>> | undefined;

/**
 * The ActionId set of the compiled contract surface. Lazy dynamic import keeps
 * the compiler graph out of this module's static dependencies (mirroring the
 * census's own `collectLiveCliCommands` idiom in the other direction). The
 * import targets `cli-surface.ts` — the generation half — NOT the census seam,
 * which dynamically imports `adapters/cli.js` and would close a runtime import
 * cycle adapter → generated client → seam → adapter.
 *
 * The compile is the RUNTIME-ADDRESSING variant (`compileForCliAddressing`):
 * the pure meta-model → shape/surface pipeline, WITHOUT the generation-time
 * authority freeze gate. The freeze gate reads the source tree (package.json,
 * the invariant catalog, `.ts` sources), which does not exist inside a
 * compiled single-file binary — routing dispatch through it crashed every CLI
 * invocation of the shipped artifact (P05-02 packaged proof). Authority
 * verification stays a generation/CI gate; the addressing surface it would
 * have gated is byte-identical (the verdict never alters compiler output).
 */
export function contractActionIds(): Promise<ReadonlySet<string>> {
  actionIdsPromise ??= (async () => {
    const { deriveCliSurface, compileForCliAddressing } = await import('./cli-surface.js');
    const surface = deriveCliSurface(compileForCliAddressing());
    return new Set(surface.commands.map((command) => command.actionId));
  })();
  return actionIdsPromise;
}

/**
 * Invoke ONE contract action through the shared dispatch core.
 *
 * The single contract-derived dispatch site for the CLI:
 *   1. VERIFY  — `actionId` must exist in the derived contract surface. A miss
 *      fails LOUD as a TYPED failure: a standard contract error envelope with
 *      the stable `UNKNOWN_ACTION` code (the same answer the dispatch core
 *      gives an unroutable action), which the adapter maps to its stable exit
 *      code via `exitCodeForError` — never an uncaught crash. Nothing is
 *      dispatched on a miss; that is the "generated" property.
 *   2. SPLIT   — `(tool, action)` come from the verified id, never from the
 *      caller, so tool and action cannot be hand-mismatched.
 *   3. DISPATCH — `{ action, ...args }` to the shared handler, the same
 *      payload shape the MCP wire delivers (behavior stays in the core;
 *      `args` carries only what the caller's schema validation produced).
 */
export async function invokeContractAction(
  actionId: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const known = await contractActionIds();
  if (!known.has(actionId)) {
    const diagnostic = new UnknownContractActionError(actionId);
    const separator = actionId.indexOf('.');
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: diagnostic.message,
        ...(separator > 0
          ? { tool: actionId.slice(0, separator), action: actionId.slice(separator + 1) }
          : {}),
      },
    };
  }
  // ActionIds are `<tool>.<action>`; tools never contain `.`, so the first
  // separator is the split point (actions are snake_case and dot-free too,
  // but slicing at the first `.` matches the id grammar rather than assuming).
  const separator = actionId.indexOf('.');
  const tool = actionId.slice(0, separator);
  const action = actionId.slice(separator + 1);
  return dispatch(tool, { action, ...args }, ctx);
}
