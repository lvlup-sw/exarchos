// ─── Integration-suite harness — the PUBLIC ROOT seam (DR-27 / DR-28) ───────
//
// Every test in `test/integration/**` drives the system through this module.
// Its whole purpose is to make the "public root" claim *mechanical* rather
// than aspirational:
//
//   • the dispatch context is built by the PRODUCTION composition root
//     (`dispatch/core/context.ts::initializeContext`) over a REAL SQLite storage
//     backend (`index.ts::initializeBackend`) in a REAL temp state dir. No
//     hand-rolled `{ stateDir, eventStore, … }` object literal is ever
//     synthesized here — that is precisely the shortcut DR-27 forbids.
//   • the entry point is the REAL `dispatch/core/dispatch.ts::dispatch`, imported
//     directly. Nothing is `vi.mock`ed, and `assertNoStubbedCompositeHandlers`
//     below actively proves that the handler the dispatcher cached is the
//     genuine module export rather than a `stubCompositeHandler` install.
//   • the wire envelope is produced by the SAME carrier adapter the CLI
//     facade uses (`format.ts::toEnvelope`, called at `adapters/cli/cli.ts`
//     `emitResult`), so envelope conformance is asserted against the shape a
//     real caller observes — not against a test-local re-wrap.
//
// The action DENOMINATOR is deliberately *not* defined here. It is re-exported
// from `src/parity/__tests__/packaged-proof.ts::derivePackagedDenominators`,
// the same module the packaged (compiled-binary) sweep in
// `test/process/packaged-proof.test.ts` measures itself against, so the two
// tiers' denominators cannot drift apart (DR-27: "the same 120-action
// denominator the packaged sweep uses").
//
// Consumed by:
//   • T-36 / DR-27 — `test/integration/public-root/actions.test.ts`
//   • T-37 / DR-28 — `test/integration/governance/**` (gate → durable
//     evidence → admission → transition chains). For those, see
//     `PublicRootHarness.events()` / `.appendEvent()` / `.phaseOf()` and the
//     `overrides` option on `createPublicRootHarness` (vcsProvider /
//     capabilityResolver / callerIdentity injection at the CONTEXT level —
//     never at the handler level).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { dispatch, COMPOSITE_HANDLERS, COMPOSITE_HANDLER_LOADERS } from '../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { initializeContext } from '../../src/dispatch/core/context.js';
import { initializeBackend } from '../../src/index.js';
import { toEnvelope } from '../../src/format.js';
import type { ToolResult } from '../../src/format.js';
import { TOOL_REGISTRY } from '../../src/registry.js';
import type { CompositeTool } from '../../src/registry.js';
import type { EventStore } from '../../src/events/store.js';
import type { StorageBackend } from '../../src/storage/backend.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import {
  derivePackagedDenominators,
  classifyErrorLayer,
} from '../../src/parity/__tests__/packaged-proof.js';
import type { FailureLayer } from '../../src/contract/error-families.js';

// ─── The registered surface (single source: the live TOOL_REGISTRY) ─────────

/**
 * One registered composite action, carrying the two schemas the contract
 * declares for it. `outputSchema` is the *registered* envelope schema — the
 * exact `z.ZodType` the MCP facade advertises — and is what
 * `PublicRoot_ActionEnvelope_MatchesRegisteredOutputSchema` validates the
 * observed envelope against. It is pulled off the registry entry, never
 * hand-written.
 */
export interface RegisteredAction {
  /** `<tool>.<action>` — the identifier the coverage denominator uses. */
  readonly actionId: string;
  readonly toolName: string;
  readonly actionName: string;
  readonly outputSchema: { safeParse(value: unknown): { success: boolean; error?: unknown } };
}

/**
 * Every registered action, keyed by the SAME `<tool>.<action>` identifier the
 * packaged sweep's denominator uses, with its registered output schema
 * attached.
 *
 * The id construction mirrors `contract/compiler/meta-model.ts` (which is what
 * `derivePackagedDenominators` runs through); the consistency of the two is
 * asserted, not assumed — see
 * `PublicRoot_DenominatorSource_IsThePackagedSweepSource`.
 */
export function registeredActions(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly RegisteredAction[] {
  const out: RegisteredAction[] = [];
  for (const tool of registry) {
    for (const action of tool.actions) {
      out.push({
        actionId: `${tool.name}.${action.name}`,
        toolName: tool.name,
        actionName: action.name,
        outputSchema: action.outputSchema as RegisteredAction['outputSchema'],
      });
    }
  }
  return out.sort((a, b) => (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0));
}

/**
 * The COVERAGE DENOMINATOR — re-exported from the packaged sweep's own
 * derivation so the T1 tier and the packaged tier measure themselves against
 * one list. This is the *only* denominator source this harness exposes;
 * numerators come from {@link PublicRootHarness.reachedActionIds}, which is
 * populated at RUNTIME by actual `dispatch()` calls.
 */
export function packagedActionDenominator(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly string[] {
  return derivePackagedDenominators(registry).actions;
}

// ─── Routing classification (reachable ≠ non-throwing) ──────────────────────

/**
 * Why an action was NOT reached. These are the envelopes dispatch emits when
 * it could not route the call to the named action at all:
 *
 *   • `unknown-tool`      — `UNKNOWN_TOOL` (no composite for this tool name)
 *   • `unknown-action`    — the built-in path's `unknown action "<name>"`
 *                           INVALID_INPUT, or the custom-tool path's
 *                           `UNKNOWN_ACTION` / `MISSING_ACTION`
 *   • `handler-load-failed` — `COMPOSITE_LOAD_FAILED`
 *   • `threw`             — `dispatch()` rejected instead of returning
 *   • `timed-out`         — no envelope inside the per-action budget
 *
 * Everything else is REACHED: dispatch resolved the registered action and
 * returned a contract envelope for it. A typed error envelope (a missing
 * required field, a denied capability, a handler-layer failure) is a *reached*
 * outcome — the action exists, was routed to, and answered in-contract.
 */
export type RoutingRejection =
  | 'unknown-tool'
  | 'unknown-action'
  | 'handler-load-failed'
  | 'threw'
  | 'timed-out';

const UNROUTED_CODES: Readonly<Record<string, RoutingRejection>> = {
  UNKNOWN_TOOL: 'unknown-tool',
  UNKNOWN_ACTION: 'unknown-action',
  MISSING_ACTION: 'unknown-action',
  COMPOSITE_LOAD_FAILED: 'handler-load-failed',
};

/**
 * Classify a returned `ToolResult` as routed / not-routed. Pure, so the test
 * can exercise it directly on synthetic envelopes (the classifier itself must
 * not be taken on faith).
 */
export function classifyRouting(result: ToolResult): RoutingRejection | null {
  const code = result.error?.code;
  if (typeof code === 'string') {
    const mapped = UNROUTED_CODES[code];
    if (mapped !== undefined) return mapped;
    if (code === 'INVALID_INPUT') {
      const message = result.error?.message ?? '';
      // `dispatch/core/dispatch.ts` built-in path: unknown action name, or an `action`
      // field that is missing/not-a-string. Both mean "never routed".
      if (/unknown action "/.test(message)) return 'unknown-action';
      if (/required field "action" is missing or not a string/.test(message)) {
        return 'unknown-action';
      }
    }
  }
  return null;
}

// ─── Observations ──────────────────────────────────────────────────────────

export interface DispatchObservation {
  readonly actionId: string;
  readonly toolName: string;
  readonly actionName: string;
  /** The raw dispatch-core result (undefined when it threw / timed out). */
  readonly result?: ToolResult;
  /** The wire envelope the CLI facade would emit (`toEnvelope(result)`). */
  readonly envelope?: unknown;
  /** `null` when the action was reached; otherwise why it was not. */
  readonly rejection: RoutingRejection | null;
  readonly reached: boolean;
  readonly success?: boolean;
  readonly errorCode?: string;
  /** Contract failure layer of `errorCode`, via the stable error registry. */
  readonly layer?: FailureLayer;
  /**
   * True when the outcome could only have been produced by the composite
   * handler itself: a success, or a failure whose layer is NOT one of the
   * pre-handler dispatch layers (`protocol` = schema/routing validation,
   * `authorization` = the readonly / shared-mutating capability gates).
   */
  readonly handlerEntered: boolean;
  readonly threw?: string;
  readonly durationMs: number;
}

const PRE_HANDLER_LAYERS: ReadonlySet<FailureLayer> = new Set<FailureLayer>([
  'protocol',
  'authorization',
]);

// ─── The harness ───────────────────────────────────────────────────────────

export interface PublicRootHarness {
  /** The production-built dispatch context (real store, real state dir). */
  readonly ctx: DispatchContext;
  readonly stateDir: string;
  /** A real, NON-git scratch directory used as the workspace/cwd. */
  readonly workspaceDir: string;
  readonly eventStore: EventStore;
  readonly storage: StorageBackend;

  /**
   * Drive one registered action through the REAL `dispatch()`. Records an
   * observation in the runtime ledger. `args` are merged over
   * `{ action: <actionName> }`.
   */
  runAction(
    toolName: string,
    actionName: string,
    args?: Record<string, unknown>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<DispatchObservation>;

  /**
   * Escape hatch for negative/control probes: dispatch an arbitrary payload
   * (including a deliberately-unregistered action name) WITHOUT recording it
   * in the coverage ledger.
   */
  probe(
    toolName: string,
    args: Record<string, unknown>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<DispatchObservation>;

  /** Every observation recorded by `runAction`, in call order. */
  observations(): readonly DispatchObservation[];

  /**
   * The RUNTIME numerator: the ids of actions that were actually driven
   * through `dispatch()` AND reached. Derived from `observations()`, never
   * from the registry.
   */
  reachedActionIds(): readonly string[];

  /** Real event-store read — the T2 tier's durable-evidence oracle. */
  events(streamId: string): Promise<WorkflowEvent[]>;

  /** Real event-store append — for seeding a governance precondition. */
  appendEvent(streamId: string, event: Record<string, unknown>): Promise<unknown>;

  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * Project root handed to `initializeContext`. Defaults to `undefined`
   * (the cold-start fast path: no config / vcs / hooks). T2 governance tests
   * that need the real `.exarchos.yml`-driven wiring pass a fixture root.
   */
  readonly projectRoot?: string;
  /**
   * Context-level overrides merged onto the production-built context. Intended
   * for T2: `vcsProvider`, `capabilityResolver`, `callerIdentity`, `cwd`.
   * NOTE: this is a CONTEXT seam, not a handler seam — overriding a composite
   * handler is out of bounds for this suite and
   * {@link assertNoStubbedCompositeHandlers} will catch it.
   */
  readonly overrides?: Partial<DispatchContext>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Prove that the composite handlers the dispatch core will use are the genuine
 * module exports, not `stubCompositeHandler` installs. Called by the T1 tier
 * both before and after the sweep.
 *
 * Only tools that have already been LOADED are checked (the map is populated
 * lazily by `loadCompositeHandler`); a tool absent from the cache has no stub
 * by definition. Returns the list of tools it verified so a caller can assert
 * the check was not vacuous.
 */
export async function assertNoStubbedCompositeHandlers(): Promise<readonly string[]> {
  const verified: string[] = [];
  for (const [tool, loader] of Object.entries(COMPOSITE_HANDLER_LOADERS)) {
    const cached = COMPOSITE_HANDLERS[tool];
    if (cached === undefined) continue;
    const real = await loader();
    if (cached !== real) {
      throw new Error(
        `integration-suite invariant violated: composite handler for '${tool}' is not the ` +
          `real module export (a stub/mock is installed). The public-root tier must drive ` +
          `production handlers.`,
      );
    }
    verified.push(tool);
  }
  return verified;
}

async function mkTemp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  // `os.tmpdir()` is a symlink on macOS; realpath keeps paths comparable.
  return fs.realpath(dir);
}

/**
 * Build a public-root harness: real SQLite backend → real EventStore → real
 * DispatchContext via the production composition root.
 */
export async function createPublicRootHarness(
  options: HarnessOptions = {},
): Promise<PublicRootHarness> {
  const stateDir = await mkTemp('exq-t1-state-');
  const workspaceDir = await mkTemp('exq-t1-cwd-');

  const storage = await initializeBackend(stateDir);
  const baseCtx = await initializeContext(stateDir, {
    backend: storage,
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
  });

  const ctx: DispatchContext = {
    ...baseCtx,
    cwd: workspaceDir,
    ...(options.overrides ?? {}),
  };

  const recorded: DispatchObservation[] = [];

  async function drive(
    toolName: string,
    actionName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<DispatchObservation> {
    const actionId = `${toolName}.${actionName}`;
    const started = Date.now();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'__t36_timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__t36_timeout__'), timeoutMs);
      timer.unref?.();
    });

    let result: ToolResult | undefined;
    let threw: string | undefined;
    let timedOut = false;
    try {
      const raced = await Promise.race([dispatch(toolName, args, ctx), timeout]);
      if (raced === '__t36_timeout__') timedOut = true;
      else result = raced;
    } catch (err) {
      threw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const durationMs = Date.now() - started;

    if (result === undefined) {
      return {
        actionId,
        toolName,
        actionName,
        rejection: timedOut ? 'timed-out' : 'threw',
        reached: false,
        handlerEntered: false,
        ...(threw !== undefined ? { threw } : {}),
        durationMs,
      };
    }

    const rejection = classifyRouting(result);
    const errorCode = result.error?.code;
    const layer = errorCode !== undefined ? classifyErrorLayer(errorCode) : undefined;
    // The envelope is produced by the SAME adapter the CLI facade uses.
    const envelope = toEnvelope(result);

    return {
      actionId,
      toolName,
      actionName,
      result,
      envelope,
      rejection,
      reached: rejection === null,
      success: result.success,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(layer !== undefined ? { layer } : {}),
      handlerEntered:
        rejection === null && (result.success === true || layer === undefined || !PRE_HANDLER_LAYERS.has(layer)),
      durationMs,
    };
  }

  return {
    ctx,
    stateDir,
    workspaceDir,
    eventStore: ctx.eventStore,
    storage,

    async runAction(toolName, actionName, args = {}, opts = {}) {
      const observation = await drive(
        toolName,
        actionName,
        { action: actionName, ...args },
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      recorded.push(observation);
      return observation;
    },

    async probe(toolName, args, opts = {}) {
      const actionName = typeof args.action === 'string' ? args.action : '<none>';
      return drive(toolName, actionName, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    },

    observations() {
      return recorded;
    },

    reachedActionIds() {
      return [...new Set(recorded.filter((o) => o.reached).map((o) => o.actionId))].sort();
    },

    async events(streamId) {
      return ctx.eventStore.query(streamId);
    },

    async appendEvent(streamId, event) {
      return ctx.eventStore.append(streamId, event as never);
    },

    async dispose() {
      try {
        ctx.eventStore.close();
      } catch {
        /* already closed — teardown is best-effort */
      }
      for (const dir of [stateDir, workspaceDir]) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
