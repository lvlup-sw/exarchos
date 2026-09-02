import type { DeclaredOutputSchema, ExtensionOutputSchema, RegisteredOutputSchema } from '../output-schema-declaration.js';
import type { AgentPosture } from '../runtime/agents/spec.js';
import { z } from 'zod';
import type { ActionContract } from './action-contract.js';
import type { ActionAnnotations } from './annotations.js';
import type { GateMetadata } from './gate-metadata.js';
import type { CliActionHints, CliToolHints, DispatchHints, EconomyHints } from './hints.js';

export interface ToolAction {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly phases: ReadonlySet<string>;
  readonly roles: ReadonlySet<string>;
  readonly cli?: CliActionHints;
  readonly gate?: GateMetadata;
  /**
   * Canonical contract. Built-in and extension declaration types require
   * the field; this consumer type keeps it optional so a mixed read of
   * unmigrated fixtures still typechecks. A missing block is never
   * admitted at load or registration.
   */
  readonly actionContract?: ActionContract;
  /**
   * Dispatch-layer metadata (#1440 Op 2, preview-4 T2, design §4.3).
   * Sibling-level (not under `cli`) because the Tasks dispatch-core is
   * shared between CLI and MCP facades (INV-2). Advisory only — the
   * binding opt-in gate stays at `dispatch/core/dispatch.ts:927-954`. Surfaced
   * via `exarchos_view describe` so clients can enumerate
   * task-suitable actions.
   */
  readonly dispatch?: DispatchHints;
  /**
   * DR-1 (design §"The economy block") — response-economy metadata:
   * per-action token budget (+ optional summarizer / compact-by-default
   * markers). Sibling-level (not under `cli`) because the budget is
   * action-behavior metadata shared by both facades (INV-2), mirroring
   * `dispatch`. Undefined leaves the action on {@link DEFAULT_ECONOMY_BUDGET_TOKENS};
   * every action resolves a number via {@link resolveEconomyBudget}. The
   * effective budget is surfaced via `exarchos_view describe`
   * (`economyBudgetTokens`); the binding cap lives at the dispatch-core
   * measurement seam (Task 003).
   */
  readonly economy?: EconomyHints;
  /**
   * DR-5: When true, the action can take multiple seconds to complete and
   * the CLI adapter should emit stderr heartbeats under `--json` so a long
   * silence doesn't look like the process hung.  MCP hosts render progress
   * natively and ignore this flag.
   */
  readonly longRunning?: boolean;
  /**
   * DR-4 / DR-11 (durable-substrate, #1259) — when true, this action is
   * scheduled for removal one release ahead and currently routes through a
   * deprecation rerouting surface. Surfaces in `describe` entries so model-
   * facing agents can self-correct toward the canonical action without
   * human prompting.
   */
  readonly deprecated?: boolean;
  /**
   * #1305 — Trust-tier posture for this action's handler. When declared, the
   * capability resolver mints this action's write capabilities from the
   * posture table (`capabilities/posture-mapping.ts`) rather than inferring
   * them from the (advisory, MCP-untrusted) annotation hints. Today only
   * `merge_orchestrate` declares a posture: `shared-mutating`, because it
   * mutates shared state (the integration branch, the working tree, the
   * event store) from the main worktree with no worktree isolation. Most
   * actions leave this undefined and rely on annotations alone; #1305 T14/T15
   * (read-only-caller rejection, transition exclusivity) build on this
   * declaration being the trust-tier source of truth.
   */
  readonly posture?: AgentPosture;
  /**
   * Typed Zod schema describing the action's response envelope (Wave 0
   * task E.1-E.5, DR-11, design §2.1).
   *
   * DR-4 (task 055) narrowed this field from `z.ZodType` to
   * {@link DeclaredOutputSchema}. Under the old type the field recorded
   * PRESENCE, not SUBSTANCE: the cheapest satisfying expression was
   * `EnvelopeSchema(z.unknown())`, whose success-branch `data` accepts every
   * payload, and 112 of 122 declarations wrote exactly that. A schema total
   * over every shape satisfies INV-17's totality precondition trivially, so
   * INV-2's "schema-checked in addition to byte-checked" collapsed into
   * byte-checked plus a tautology for 92% of the surface.
   *
   * There are now exactly two ways to produce a value of this type:
   *   • `withCappedShape(<typed envelope>)` — the sole constructor of a
   *     SUBSTANTIVE schema;
   *   • `vacuityWaiver('<tool>.<action>')` — the explicit allowlist escape,
   *     whose id parameter is the literal union of the ids seeded in
   *     `output-schema-vacuity-allowlist.ts`.
   * A new action therefore cannot declare a vacuous `outputSchema`: the bare
   * expression is unbranded, and the waiver rejects an unseeded id. See
   * `_OutputSchema*` below for the machine-checked statement of that.
   *
   * TASK 060 widened THIS field — the CONSUMER-facing one — to
   * {@link RegisteredOutputSchema}, the union of the registry brand and the
   * out-of-registry extension brand, so dispatch / the MCP adapter / the CLI
   * adapter / `describe` keep seeing one action type across built-in and
   * `.exarchos.yml` tools. The narrowing that closes DR-4's first hole moved to
   * the DECLARATION types: {@link BuiltinToolAction} (what {@link TOOL_REGISTRY}
   * is declared with) accepts `DeclaredOutputSchema` only, and
   * {@link ExtensionToolAction} accepts `ExtensionOutputSchema` only. Widening
   * here is not a loosening of the tooth: nothing can be constructed for this
   * union that could not already be constructed for one of its members, and no
   * value of this union type can reach `TOOL_REGISTRY`.
   *
   * The field is required at the interface boundary; the registration-
   * time validator (`validateAction`) also enforces presence at module
   * load so a malformed declaration fails the import (DIM-3 fail-closed).
   */
  readonly outputSchema: RegisteredOutputSchema;
  /**
   * DR-1 structural marker for the worktree "DR-10 surface" actions
   * (acquire_worktree, release_worktree, prune_worktrees, serialize_merge, ps,
   * wait, worktrees). Reads sit on `exarchos_view` and mutations on
   * `exarchos_orchestrate`, so the surface is otherwise not structurally
   * distinguishable; this marker lets a registry-driven conformance harness
   * enumerate exactly the surface (typed outputSchema + parity) by filter
   * rather than a hardcoded name list. Undefined on every non-surface action.
   */
  readonly surface?: 'worktree';
  /**
   * Per-action annotations (Wave 0 task E.1-E.5, design §2.4, #1289).
   * `safety` is server-trusted and is consumed by HSM guards +
   * computeNextActions in a later task. The four Hint flags
   * (readOnly/destructive/idempotent/openWorld) are spec-defined
   * advisory hints surfaced to MCP clients via `tools/list`; per the
   * MCP spec they are EXPLICITLY untrusted unless the server itself
   * is trusted.
   */
  readonly annotations: ActionAnnotations;
}

/**
 * A registry action that carries a complete {@link ActionContract}.
 * Omitting `actionContract` is not assignable to this type. Live
 * declarations stay {@link ToolAction} until family migration authors the
 * block; {@link withActionContract} is the constructor that produces this
 * contracted form.
 */
export type ContractedToolAction = ToolAction & {
  readonly actionContract: ActionContract;
};

export interface CompositeTool {
  readonly name: string;
  readonly description: string;
  readonly actions: readonly ToolAction[];
  readonly cli?: CliToolHints;
  /** When true, the tool is excluded from MCP registration (not exposed to agents). CLI access is preserved. */
  readonly hidden?: boolean;
  /** One-line summary for slim MCP registration. Used when slimRegistration is enabled. */
  readonly slimDescription?: string;
}

// ─── DR-4 (task 060): the two DECLARATION paths, told apart nominally ────────
//
// `ToolAction` / `CompositeTool` above are the CONSUMER types — what dispatch,
// the adapters and `describe` read. The two types below are the DECLARATION
// types, and they are the ones that carry DR-4's compile-time tooth.
//
// Task 055 closed `outputSchema` vacuity for the built-in registry and then
// reported the residual: `unregisteredActionOutputSchema()` — the bounded escape
// for actions whose name is not a compile-time literal — minted the same brand
// as the two registry constructors, so a NEW registry action could call it and
// compile. The audit still reported it (`UNWAIVED_VACUITY`), but at run time,
// while DR-4 claims compile time.
//
// The fix is nominal, not a deletion: `.exarchos.yml` custom tools are a
// SUPPORTED surface and must keep working. The escape now mints
// `ExtensionOutputSchema`, `ExtensionToolAction` is the type the two extension
// sites build, and `TOOL_REGISTRY` is declared `readonly BuiltinCompositeTool[]`
// — so the escape is not merely discouraged in this file, it does not typecheck
// in it, and the door is the registry constant rather than any single array's
// annotation (adding a sixth `readonly ToolAction[]` array to TOOL_REGISTRY is
// itself a compile error).

/**
 * An action DECLARED in {@link TOOL_REGISTRY}.
 *
 * Identical to {@link ToolAction} except that `outputSchema` is narrowed to
 * {@link DeclaredOutputSchema} — the brand minted only by `withCappedShape`
 * (substantive) and `vacuityWaiver` (allowlisted). The out-of-registry escape
 * mints the other brand and is therefore not assignable here.
 */
export interface BuiltinToolAction extends ToolAction {
  readonly outputSchema: DeclaredOutputSchema;
  readonly actionContract: ActionContract;
}

/** Declaration shape before {@link withActionContract} attaches the block. */
export type BuiltinActionDraft = Omit<BuiltinToolAction, 'actionContract'>;

/** A composite tool whose actions are all built-in declarations. */
export interface BuiltinCompositeTool extends CompositeTool {
  readonly actions: readonly BuiltinToolAction[];
}

/**
 * An action declared OUTSIDE the built-in registry: a `.exarchos.yml` custom
 * tool (`config/register.ts`) or the oracle registration probe
 * (`contract/oracle/fixtures.ts`). Its name is a runtime string, so it has no
 * census id to waive and no compile-time literal to match against the allowlist
 * union — which is exactly why it needs its own nominal type rather than a
 * shared escape.
 *
 * Assignable to {@link ToolAction}, so an extension action is dispatchable,
 * registrable and describable exactly like a built-in one. NOT assignable to
 * {@link BuiltinToolAction}, which is the whole point.
 */
export interface ExtensionToolAction extends ToolAction {
  readonly outputSchema: ExtensionOutputSchema;
  readonly actionContract: ActionContract;
}

/** Extension declaration shape before the contract block is attached. */
export type ExtensionActionDraft = Omit<ExtensionToolAction, 'actionContract'>;

/** A composite tool assembled from extension-declared actions. */
export interface ExtensionCompositeTool extends CompositeTool {
  readonly actions: readonly ExtensionToolAction[];
}
