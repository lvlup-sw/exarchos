/**
 * The harness of the integration suite: the public-root seam.
 * The public-root tests and most governance tests under `tests/core/integration` drive the system through this module.
 *
 * - The production composition root (`initializeContext`) builds the dispatch context over a real SQLite backend.
 *   The state directory is a real temporary directory. This module adds only `cwd` and the overrides of the caller to that context.
 * - The entry point is the real `dispatch`. Nothing is mocked.
 *   `assertNoStubbedCompositeHandlers` proves that each cached handler is the module export.
 * - `toEnvelope`, the adapter that the CLI facade uses, makes the wire envelope.
 *
 * The action denominator comes from `derivePackagedDenominators`, which the packaged sweep also measures against.
 * Thus the denominators of the two tiers cannot drift apart.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { dispatch, COMPOSITE_HANDLERS, COMPOSITE_HANDLER_LOADERS } from '../../../src/dispatch/core/dispatch.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { initializeContext } from '../../../src/dispatch/core/context.js';
import { initializeBackend } from '../../../src/index.js';
import { toEnvelope } from '../../../src/format.js';
import type { ToolResult } from '../../../src/format.js';
import { TOOL_REGISTRY } from '../../../src/registry.js';
import type { CompositeTool } from '../../../src/registry.js';
import type { EventStore } from '../../../src/events/store.js';
import type { StorageBackend } from '../../../src/storage/backend.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import {
  derivePackagedDenominators,
  classifyErrorLayer,
} from '../../../tools/conformance/src/parity/__tests__/packaged-proof.js';
import type { FailureLayer } from '../../../src/contract/error-families.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * One registered composite action.
 * `outputSchema` is the registered envelope schema from the registry entry, which the MCP facade advertises.
 * `PublicRoot_ActionEnvelope_MatchesRegisteredOutputSchema` validates the observed envelope against it.
 */
export interface RegisteredAction {
  /** The `<tool>.<action>` identifier that the coverage denominator uses. */
  readonly actionId: string;
  readonly toolName: string;
  readonly actionName: string;
  readonly outputSchema: { safeParse(value: unknown): { success: boolean; error?: unknown } };
}

/**
 * Lists each registered action with its output schema, sorted by action id.
 * The id has the same `<tool>.<action>` form as the denominator of the packaged sweep.
 * `PublicRoot_DenominatorSource_IsThePackagedSweepDerivation` asserts that the two agree.
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
 * The coverage denominator, from the derivation of the packaged sweep, so both tiers measure against one list.
 * This harness exposes no other denominator source.
 * The numerator comes from {@link PublicRootHarness.reachedActionIds}, which real `dispatch()` calls fill at run time.
 */
export function packagedActionDenominator(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
): readonly string[] {
  return derivePackagedDenominators(registry).actions;
}

/**
 * Why dispatch did not route a call to the named action:
 * - `unknown-tool`: `UNKNOWN_TOOL`, because no composite has this tool name.
 * - `unknown-action`: `UNKNOWN_ACTION` or `MISSING_ACTION` on the custom-tool path.
 *   On the built-in path, it is an `INVALID_INPUT` whose message reports an unknown or missing `action`.
 * - `handler-load-failed`: `COMPOSITE_LOAD_FAILED`.
 * - `threw`: `dispatch()` rejected.
 * - `timed-out`: no envelope arrived in the budget of the action.
 *
 * Each other outcome is reached: dispatch resolved the action and returned a contract envelope.
 * A typed error envelope, such as a missing required field or a denied capability, is a reached outcome.
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
 * Classifies a `ToolResult` as routed (`null`) or not routed. The function is pure, so a test can call it on synthetic results.
 * The built-in path reports an unknown action name, or an `action` field that is missing or not a string, as `INVALID_INPUT`.
 * Both cases mean that dispatch did not route the call.
 */
export function classifyRouting(result: ToolResult): RoutingRejection | null {
  const code = result.error?.code;
  if (typeof code === 'string') {
    const mapped = UNROUTED_CODES[code];
    if (mapped !== undefined) return mapped;
    if (code === 'INVALID_INPUT') {
      const message = result.error?.message ?? '';
      if (/unknown action "/.test(message)) return 'unknown-action';
      if (/required field "action" is missing or not a string/.test(message)) {
        return 'unknown-action';
      }
    }
  }
  return null;
}

export interface DispatchObservation {
  readonly actionId: string;
  readonly toolName: string;
  readonly actionName: string;
  /** The raw result of the dispatch core. It is absent after a throw or a timeout. */
  readonly result?: ToolResult;
  /** The wire envelope that the CLI facade emits: `toEnvelope(result)`. */
  readonly envelope?: unknown;
  /** `null` when dispatch reached the action. Otherwise, the reason that it did not. */
  readonly rejection: RoutingRejection | null;
  readonly reached: boolean;
  readonly success?: boolean;
  readonly errorCode?: string;
  /** The contract failure layer of `errorCode`, from the stable error registry. An unregistered code maps to `handler`. */
  readonly layer?: FailureLayer;
  /**
   * True when dispatch reached the action and only the composite handler can produce the outcome.
   * That outcome is a success, or a failure whose layer is not a pre-handler layer.
   * The pre-handler layers are `protocol` (schema and routing validation) and `authorization` (the capability gates).
   */
  readonly handlerEntered: boolean;
  readonly threw?: string;
  readonly durationMs: number;
}

const PRE_HANDLER_LAYERS: ReadonlySet<FailureLayer> = new Set<FailureLayer>([
  'protocol',
  'authorization',
]);

export interface PublicRootHarness {
  /** The dispatch context from the production composition root, with a real store and a real state directory. */
  readonly ctx: DispatchContext;
  readonly stateDir: string;
  /** A real scratch directory that is not a git repository. It is the workspace and the `cwd`. */
  readonly workspaceDir: string;
  readonly eventStore: EventStore;
  readonly storage: StorageBackend;

  /**
   * Drives one registered action through the real `dispatch()` and records the observation.
   * `args` merge over `{ action: <actionName> }`.
   */
  runAction(
    toolName: string,
    actionName: string,
    args?: Record<string, unknown>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<DispatchObservation>;

  /** Dispatches an arbitrary payload, such as an unregistered action name, and does not record the observation. */
  probe(
    toolName: string,
    args: Record<string, unknown>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<DispatchObservation>;

  /** Each observation that `runAction` recorded, in call order. */
  observations(): readonly DispatchObservation[];

  /**
   * The runtime numerator: the sorted ids of the actions that `runAction` drove and dispatch reached.
   * It comes from the recorded observations, never from the registry.
   */
  reachedActionIds(): readonly string[];

  /** Reads the real event store. It is the durable-evidence oracle of the governance tier. */
  events(streamId: string): Promise<WorkflowEvent[]>;

  /** Appends to the real event store, to seed a governance precondition. */
  appendEvent(streamId: string, event: Record<string, unknown>): Promise<unknown>;

  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * The project root for `initializeContext`. The default is `undefined`, the cold-start path with no config, VCS or hooks.
   * A governance test that needs the wiring of a real `.exarchos.yml` passes a fixture root.
   */
  readonly projectRoot?: string;
  /**
   * Context-level overrides that merge onto the production-built context.
   * Examples are `vcsProvider`, `capabilityResolver`, `callerIdentity` and `cwd`.
   * This is a context seam, not a handler seam. {@link assertNoStubbedCompositeHandlers} catches a stubbed composite handler.
   */
  readonly overrides?: Partial<DispatchContext>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Proves that each loaded composite handler is the real module export, not a `stubCompositeHandler` install.
 * It checks only the tools in the lazy cache, because a tool that is absent from the cache has no stub.
 * It returns the tools that it verified, so a caller can assert that the check was not vacuous.
 *
 * @throws When a cached handler is not the module export.
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

/** Makes a temporary directory and returns its real path, because `os.tmpdir()` is a symlink on macOS. */
async function mkTemp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
}

/**
 * Builds a public-root harness: a real SQLite backend, a real event store, and a dispatch context from the production composition root.
 * `toEnvelope`, the adapter that the CLI facade uses, makes each envelope.
 * `dispose` ignores a store that is already closed and a directory that it cannot remove.
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
      }
      for (const dir of [stateDir, workspaceDir]) {
        await rmrfAsync(dir).catch(() => undefined);
      }
    },
  };
}
