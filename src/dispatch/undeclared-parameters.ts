/**
 * The action that receives a parameter honors it, or dispatch refuses it.
 *
 * A composite tool flattens its actions into one registration schema, so the wire accepts the
 * fields of every action. Routing then gives the payload to one action. Its schema drops a field
 * that only a sibling declares, and the call still reports success. This module refuses a supplied
 * parameter unless the schema of the receiving action keeps it.
 *
 * Two exemptions apply. Transport keys belong to no action. A sibling-declared key is dropped when
 * its value equals the default that the MCP SDK injects from the flattened schema. A caller who
 * passes that exact default is also dropped, and loses nothing.
 *
 * The decision reads the parse output, so a `.passthrough()` or `.strict()` action still answers
 * for its own extra keys. Only a plain `z.object` that discards a key gets this refusal.
 */

import { z } from 'zod';
import type { ToolAction } from '../registry.js';
import { buildInvalidInput, type ValidationError } from '../adapters/cli/schema-to-flags.js';

/**
 * Keys of the transport envelope, not of any action. `_meta` carries the MCP correlation ids, and
 * `mintDispatchContextFromRequest` reads it before routing. The CLI adapter stamps `surface` onto
 * the `onboard` payload, and the operator never sets it.
 *
 * `surface` is not on the `onboard` schema, because flags come from that schema and the operator
 * must not get a `--surface` flag. Dispatch removes `action` and `task` before this partition runs.
 */
const TRANSPORT_KEYS: ReadonlySet<string> = new Set(['_meta', 'surface']);

/** Result of separating carrier and SDK noise from a caller's real parameters. */
export interface ForwardedParameters {
  /** What to hand the receiving action's schema. */
  readonly forwarded: Record<string, unknown>;
  /**
   * Keys in `forwarded` that the receiving action does not declare in its shape. The schema of the
   * action keeps or rejects each one, or discards it without an error.
   * {@link findIgnoredParameters} reads the parse output to find the discarded keys.
   */
  readonly unshaped: readonly string[];
}

/**
 * Returns the value that a field gives when the caller supplies nothing. It parses `undefined` with
 * the field and reads no Zod internals. A `.default()` or `.prefault()` field gives its default. An
 * optional field or a required field gives `undefined`.
 */
function injectedDefaultOf(field: z.core.$ZodType): unknown {
  const probe = z.safeParse(field, undefined);
  return probe.success ? probe.data : undefined;
}

/**
 * Returns true when `supplied` is the same scalar that the SDK injects. A structural compare of an
 * object or array default widens the silent-drop exemption. A non-scalar default never matches, so
 * its key is refused.
 */
function matchesInjectedDefault(supplied: unknown, injected: unknown): boolean {
  if (injected === undefined) return false;
  const kind = typeof injected;
  if (kind !== 'boolean' && kind !== 'string' && kind !== 'number') return false;
  return supplied === injected;
}

/**
 * Drop the transport carrier and any SDK-injected sibling default, and report
 * which of the remaining keys the receiving action does not declare.
 *
 * @param supplied  Payload with `action` (and any `task` augmentation) already removed.
 * @param receiving The action the payload routed to.
 * @param siblings  Every action on the same tool, INCLUDING `receiving` (filtered internally).
 */
export function selectForwardedParameters(
  supplied: Readonly<Record<string, unknown>>,
  receiving: ToolAction,
  siblings: readonly ToolAction[],
): ForwardedParameters {
  const declared = receiving.schema.shape;
  const forwarded: Record<string, unknown> = {};
  const unshaped: string[] = [];

  for (const [key, value] of Object.entries(supplied)) {
    if (Object.prototype.hasOwnProperty.call(declared, key)) {
      forwarded[key] = value;
      continue;
    }
    if (TRANSPORT_KEYS.has(key)) continue;
    if (isInjectedSiblingDefault(key, value, receiving, siblings)) continue;

    forwarded[key] = value;
    unshaped.push(key);
  }

  return { forwarded, unshaped };
}

/** Returns true when the SDK injects exactly this `key: value` from the default of a sibling. */
function isInjectedSiblingDefault(
  key: string,
  value: unknown,
  receiving: ToolAction,
  siblings: readonly ToolAction[],
): boolean {
  for (const sibling of siblings) {
    if (sibling.name === receiving.name) continue;
    const field = sibling.schema.shape[key];
    if (field === undefined) continue;
    if (matchesInjectedDefault(value, injectedDefaultOf(field))) return true;
  }
  return false;
}

/**
 * Returns the undeclared keys that the schema accepted and then discarded. A key in the parse output
 * was kept, as by a `.passthrough()` action. A key that is absent was discarded.
 *
 * A schema that rejects unknown keys fails to parse, so dispatch reports the Zod error first.
 */
export function findIgnoredParameters(
  unshaped: readonly string[],
  parsedData: Readonly<Record<string, unknown>>,
): readonly string[] {
  return unshaped.filter((key) => !Object.prototype.hasOwnProperty.call(parsedData, key));
}

/**
 * Builds the refusal for parameters that the action ignores. The message lists the parameters of
 * the receiving action. For each ignored key, it names the sibling actions that declare it. Both
 * parts come from the registry.
 */
export function buildIgnoredParameterError(
  tool: string,
  receiving: ToolAction,
  siblings: readonly ToolAction[],
  ignored: readonly string[],
): ValidationError {
  const detail = ignored
    .map((key) => {
      const declaredBy = siblings
        .filter((s) => s.name !== receiving.name && s.schema.shape[key] !== undefined)
        .map((s) => `${tool}.${s.name}`)
        .sort();
      return declaredBy.length > 0
        ? `"${key}" (declared by ${declaredBy.join(', ')}, not by ${receiving.name})`
        : `"${key}" (declared by no action on ${tool})`;
    })
    .join('; ');
  const known = Object.keys(receiving.schema.shape).sort();
  return buildInvalidInput(
    `${tool}/${receiving.name}: unrecognized parameter(s): ${detail}. ` +
      `${receiving.name} accepts: ${known.length > 0 ? known.join(', ') : '(no parameters)'}. ` +
      'Remove the parameter or dispatch the action that declares it — it would otherwise be ignored while the call reported success.',
  );
}
