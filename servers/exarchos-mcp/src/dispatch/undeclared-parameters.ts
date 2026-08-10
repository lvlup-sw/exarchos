// ─── DR-7 — a parameter is honoured by the action that receives it, or refused ─
//
// Every composite tool flattens its actions into ONE registration schema, so
// the wire accepts the UNION of every action's fields. Routing then hands the
// payload to a single action whose own schema knows only its own fields. That
// asymmetry is the hole: a field some *other* action declares passes the wire
// check, reaches an action that never heard of it, and is dropped. The call
// still reports success.
//
// `dryRun` on `exarchos_workflow.transition` is the instance that made this
// visible — `cancel` and `cleanup` declare it, `transition` does not, so
// `{action:'transition', target:'synthesize', dryRun:true}` was accepted,
// reported success, and moved the workflow. A parameter whose entire purpose
// is "do not mutate" read as honoured, and the caller had no way to tell "the
// dry run passed" from "the thing happened". It is not the first: the
// `checkpoint` action carries a comment describing the same silent strip
// swallowing `handoff` (#1240), repaired then by hand at that one site.
//
// The rule here is one sentence: a parameter the caller supplied is refused
// unless the receiving action's OWN schema keeps it. Two narrow exemptions
// keep that rule honest rather than merely strict:
//
//   1. Transport keys (`_meta`) ride alongside domain parameters on every
//      call and belong to no action. They are carrier, not payload.
//   2. Defaults the MCP SDK injects. The SDK validates against the flattened
//      parent schema, which carries every action's `.default()`, so it hands
//      dispatch fields the caller never typed. Those are indistinguishable
//      from a caller's own keystroke EXCEPT by value — so a sibling-declared
//      key is dropped only when its value equals the default that would have
//      been injected. A different value means a human chose it, and a chosen
//      value is refused rather than dropped.
//
// Exemption 2 leaves one residue that cannot be closed from here: a caller
// who explicitly passes the exact default value is indistinguishable from the
// SDK injecting it, and is dropped. That case loses nothing — the value the
// caller asked for is the value the action would have seen anyway.
//
// Deciding by the schema's OWN verdict (rather than by its declared shape) is
// what keeps this from breaking the actions that deliberately accept more
// than they declare. `exarchos_orchestrate.prune_stale_workflows` is a
// `.passthrough().superRefine(...)` that takes a `now` clock override outside
// its shape and produces its own actionable error for a removed knob; a
// `.strict()` action produces Zod's unrecognized-keys error. In both cases the
// action already answers for the key, so this module stays out of the way and
// only speaks up for the third case — the plain `z.object` that quietly
// discards it.

import { z } from 'zod';
import type { ToolAction } from '../registry.js';
import { buildInvalidInput, type ValidationError } from '../adapters/schema-to-flags.js';

/**
 * Keys that belong to the transport envelope rather than to any action's
 * parameter list. `_meta` carries MCP correlation continuity
 * (`correlationId` / `causationId`) and is read by
 * `mintDispatchContextFromRequest` before routing.
 *
 * `action` and `task` are NOT listed: dispatch peels both off the payload
 * before this partition runs.
 */
const TRANSPORT_KEYS: ReadonlySet<string> = new Set(['_meta']);

/** Result of separating carrier and SDK noise from a caller's real parameters. */
export interface ForwardedParameters {
  /** What to hand the receiving action's schema. */
  readonly forwarded: Record<string, unknown>;
  /**
   * Keys in `forwarded` that the receiving action does not declare in its
   * shape. Each is either honoured by that action's own schema (passthrough,
   * or rejected outright) or silently discarded — {@link findIgnoredParameters}
   * reads the parse output to tell which.
   */
  readonly unshaped: readonly string[];
}

/**
 * Read the value a field would contribute when the caller supplies nothing.
 *
 * Uses the field's own parse rather than reaching into Zod internals, so the
 * probe survives a Zod major: a `.default()` / `.prefault()` field answers
 * `undefined` with its default, a merely `.optional()` field answers with
 * `undefined`, and a required field fails to parse. Only the first case can
 * ever be injected by the SDK; `undefined` is returned for the rest.
 */
function injectedDefaultOf(field: z.core.$ZodType): unknown {
  const probe = z.safeParse(field, undefined);
  return probe.success ? probe.data : undefined;
}

/**
 * True when `supplied` is the same scalar the SDK would have injected.
 *
 * Deliberately scalar-only: every default in the registry today is a boolean
 * or a string enum, and an object/array default compared structurally would
 * widen the silent-drop exemption for no gain. A non-scalar default therefore
 * never matches, so its key is refused rather than dropped — the fail-closed
 * direction.
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

/** Would the SDK have injected exactly this `key: value` from a sibling's default? */
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
 * Of the keys the receiving action did not declare, which did its schema
 * accept and then throw away?
 *
 * A key still present in the parse output was kept (a `.passthrough()` action
 * that answers for it downstream). A key that vanished was silently
 * discarded — the action reported success while ignoring what the caller
 * asked for. Only the second kind is returned. Actions whose schema REJECTS
 * unknown keys never reach here: their parse fails and dispatch surfaces
 * Zod's own error first.
 */
export function findIgnoredParameters(
  unshaped: readonly string[],
  parsedData: Readonly<Record<string, unknown>>,
): readonly string[] {
  return unshaped.filter((key) => !Object.prototype.hasOwnProperty.call(parsedData, key));
}

/**
 * Build the refusal for a payload whose parameters the action would ignore.
 *
 * The message names the receiving action's real parameter list and, for each
 * ignored key, the sibling actions that do declare it — so a caller who aimed
 * `dryRun` at `transition` is told which actions actually honour it instead of
 * being left to guess. Both halves are derived from the registry, so a renamed
 * action or a newly-declared field updates the message with no edit here.
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
