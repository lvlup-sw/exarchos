// ─── ActionId → implementation-binding table (P03-04) ────────────────────────
//
// PROGRAM-03, API-004. The crux of "generate MCP registration and bindings" is
// that every ActionId maps to exactly ONE *non-serializable* implementation
// binding — a real handler function reference, never a string name or a
// serializable descriptor that could be forged in a config file or drift away
// from the code it claims to name.
//
// This codebase binds handlers at the COMPOSITE-TOOL granularity: dispatch's
// `COMPOSITE_HANDLER_LOADERS` maps each tool (`exarchos_workflow`, `exarchos_
// event`, …) to a lazy loader for its real composite handler, and that composite
// handler performs the internal action-level routing. So an ActionId's binding
// is its tool's composite-handler loader, and this table is DERIVED from the
// real loader map rather than hand-maintaining a parallel list (drift between
// the registry and the loader map is exactly what `verifyBindings` catches).
//
// Non-serializability is STRUCTURAL, two ways:
//   • the holder is an opaque BRANDED type — a plain object / JSON value is not
//     assignable to `ImplementationBinding`, so a serializable stand-in cannot
//     be forged past the type system; and
//   • the held `load` is a function reference, which does not survive JSON
//     serialization at all — so `verifyBindings` (runtime) rejects any binding
//     whose `load` is not a function, catching a value that was round-tripped
//     through a config / the wire.
// ────────────────────────────────────────────────────────────────────────────

import { COMPOSITE_HANDLER_LOADERS, type CompositeHandler } from '../../core/dispatch.js';

/**
 * A lazy loader for a composite tool's REAL handler. A function — never a
 * serializable name. Mirrors dispatch's `COMPOSITE_HANDLER_LOADERS` value type
 * so the binding table can consume the real loaders without re-declaring them.
 */
export type CompositeHandlerLoader = () => Promise<CompositeHandler>;

// A phantom, compile-time-only brand: `declare const` never materializes at
// runtime, so the property is unforgeable outside this module. It makes
// `ImplementationBinding` an OPAQUE holder — external code cannot construct one
// without going through `implementationBinding` (they cannot name the brand).
declare const IMPLEMENTATION_BINDING_BRAND: unique symbol;

/**
 * An opaque, non-serializable holder for ONE tool's implementation binding. The
 * `load` field is the real handler-loader function reference. The phantom brand
 * makes a plain object / JSON value structurally unassignable to this type.
 */
export interface ImplementationBinding {
  readonly [IMPLEMENTATION_BINDING_BRAND]: 'implementation-binding';
  /** The composite tool this binding implements (e.g. `exarchos_workflow`). */
  readonly tool: string;
  /** The real, non-serializable handler-loader function reference. */
  readonly load: CompositeHandlerLoader;
}

/**
 * Construct an implementation binding from a tool name + its real handler
 * loader. The only sanctioned way to mint an {@link ImplementationBinding};
 * the phantom brand is applied via the (necessary) cast here so no caller can
 * fabricate one from a serializable value.
 */
export function implementationBinding(
  tool: string,
  load: CompositeHandlerLoader,
): ImplementationBinding {
  return { tool, load } as unknown as ImplementationBinding;
}

/**
 * Runtime guard: `value` is a well-formed, NON-SERIALIZABLE implementation
 * binding. The decisive check is `typeof load === 'function'` — a value that
 * was serialized (a JSON round-trip, a config entry, a wire payload) loses its
 * function and fails here, which is precisely the "non-serializable binding"
 * guarantee enforced at verification time.
 */
export function isImplementationBinding(value: unknown): value is ImplementationBinding {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { tool?: unknown; load?: unknown };
  return typeof candidate.tool === 'string' && typeof candidate.load === 'function';
}

const byTool = (a: ImplementationBinding, b: ImplementationBinding): number =>
  a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;

/**
 * Build the binding table from the real composite-handler loader map. Derived,
 * not duplicated: each entry references dispatch's actual loader for a tool, so
 * a tool that gains an entry in the registry but never gets a loader (or vice
 * versa) shows up as a missing/stale binding in `verifyBindings`. Sorted by tool
 * for a stable, diffable table.
 */
export function buildBindingTable(
  loaders: Readonly<Record<string, CompositeHandlerLoader>> = COMPOSITE_HANDLER_LOADERS,
): readonly ImplementationBinding[] {
  return Object.entries(loaders)
    .map(([tool, load]) => implementationBinding(tool, load))
    .sort(byTool);
}

/**
 * The live binding table — every built-in composite tool's ActionIds resolve
 * (through their tool) to exactly one of these bindings. This is the value the
 * pre-startup verification checks against the compiled contract.
 */
export const BINDING_TABLE: readonly ImplementationBinding[] = buildBindingTable();
