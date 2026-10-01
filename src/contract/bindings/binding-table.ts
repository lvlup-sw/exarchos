// Maps each composite tool to one non-serializable implementation binding.
// A binding holds a real handler function reference, never a string name that a config file can forge.
// Handlers bind per composite tool, and each composite handler routes its own actions.
// So the binding of an ActionId is the loader of its tool.
// The table derives from `COMPOSITE_HANDLER_LOADERS`, and `verifyBindings` catches drift between the registry and that map.
//
// Two things keep a binding non-serializable. A branded type rejects a plain object at compile time.
// At runtime, a JSON round-trip loses the `load` function, so the check fails.

import { COMPOSITE_HANDLER_LOADERS, type CompositeHandler } from '../../dispatch/core/dispatch.js';

/** A lazy loader for the real handler of a composite tool. It has the value type of `COMPOSITE_HANDLER_LOADERS`. */
export type CompositeHandlerLoader = () => Promise<CompositeHandler>;

/**
 * A compile-time brand that does not exist at runtime.
 * Other modules cannot name it, so only `implementationBinding` can construct an `ImplementationBinding`.
 */
declare const IMPLEMENTATION_BINDING_BRAND: unique symbol;

/** An opaque holder for the implementation binding of one tool. The brand rejects a plain object or a JSON value. */
export interface ImplementationBinding {
  readonly [IMPLEMENTATION_BINDING_BRAND]: 'implementation-binding';
  /** The composite tool that this binding implements, such as `exarchos_workflow`. */
  readonly tool: string;
  readonly load: CompositeHandlerLoader;
}

/** Construct an {@link ImplementationBinding}. The cast applies the brand, so no caller can make one from a serializable value. */
export function implementationBinding(
  tool: string,
  load: CompositeHandlerLoader,
): ImplementationBinding {
  return { tool, load } as unknown as ImplementationBinding;
}

/**
 * Return true when `value` is a well-formed implementation binding.
 * A serialized value loses its `load` function, so it fails this check.
 */
export function isImplementationBinding(value: unknown): value is ImplementationBinding {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { tool?: unknown; load?: unknown };
  return typeof candidate.tool === 'string' && typeof candidate.load === 'function';
}

const byTool = (a: ImplementationBinding, b: ImplementationBinding): number =>
  a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;

/**
 * Build the binding table from the real loader map, sorted by tool.
 * A registry tool without a loader, or a loader without a registry tool, shows in `verifyBindings`.
 */
export function buildBindingTable(
  loaders: Readonly<Record<string, CompositeHandlerLoader>> = COMPOSITE_HANDLER_LOADERS,
): readonly ImplementationBinding[] {
  return Object.entries(loaders)
    .map(([tool, load]) => implementationBinding(tool, load))
    .sort(byTool);
}

/** The live binding table. The pre-startup verification checks it against the compiled contract. */
export const BINDING_TABLE: readonly ImplementationBinding[] = buildBindingTable();
