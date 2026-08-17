// ─── Generated MCP tool discovery / registration (P03-04) ────────────────────
//
// PROGRAM-03, API-004. MCP is a standards-compliant WIRE PROJECTION of the
// Exarchos contract. Tool discovery/registration is therefore GENERATED from the
// compiled contract (P03-03) rather than hand-maintained as a parallel list — a
// deterministic manifest of `<tool>` → its ActionIds, so registration cannot
// silently drift from the contract it projects.
//
// Determinism discipline (mirrors P03-03): tools + actions are pre-sorted,
// descriptions are line-ending-normalized (`canonicalizeText`), and the
// serialization is canonical JSON with a trailing newline — so `serialize`
// is byte-identical across repeated generation and across a CRLF working tree
// vs. an LF CI checkout.
// ────────────────────────────────────────────────────────────────────────────

import { canonicalJson } from '../request-context.js';
import { canonicalizeText } from '../authority-digest.js';
import { CONTRACT_SURFACE_VERSION } from '../compatibility.js';
import { TOOL_REGISTRY, type CompositeTool } from '../../registry.js';

/** The current MCP-registration manifest schema version. */
export const REGISTRATION_VERSION = 1 as const;

/** One action's discovery entry (its stable ActionId + wire-visible metadata). */
export interface RegistrationAction {
  readonly actionId: string;
  readonly action: string;
  readonly description: string;
}

/** One tool's discovery entry — the MCP registration unit — and its actions. */
export interface RegistrationTool {
  readonly tool: string;
  readonly actions: readonly RegistrationAction[];
}

/** The whole deterministic MCP registration/discovery manifest. */
export interface RegistrationManifest {
  readonly registrationVersion: typeof REGISTRATION_VERSION;
  readonly surfaceVersion: string;
  readonly tools: readonly RegistrationTool[];
}

/** A minimal `{ actionId, tool }` reference the binding verifier consumes. */
export interface RegistrationActionRef {
  readonly actionId: string;
  readonly tool: string;
}

/** The compiled-contract shape this generator projects (structural subset). */
export interface RegistrationSource {
  readonly surfaceVersion: string;
  readonly descriptors: readonly {
    readonly actionId: string;
    readonly tool: string;
    readonly action: string;
    readonly description: string;
  }[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** An action entry tagged with its owning tool, before grouping. */
type TaggedAction = RegistrationAction & { readonly tool: string };

/** Group + sort action entries into deterministic per-tool registration tools. */
function assembleTools(entries: readonly TaggedAction[]): readonly RegistrationTool[] {
  const byToolName = new Map<string, RegistrationAction[]>();
  for (const entry of entries) {
    const bucket = byToolName.get(entry.tool);
    const action: RegistrationAction = {
      actionId: entry.actionId,
      action: entry.action,
      description: entry.description,
    };
    if (bucket) {
      bucket.push(action);
    } else {
      byToolName.set(entry.tool, [action]);
    }
  }
  return [...byToolName.entries()]
    .map(([tool, actions]): RegistrationTool => ({
      tool,
      actions: [...actions].sort((a, b) => byString(a.actionId, b.actionId)),
    }))
    .sort((a, b) => byString(a.tool, b.tool));
}

/**
 * Generate the MCP registration manifest from the COMPILED CONTRACT. Pure and
 * deterministic: descriptions are line-ending-normalized and every list is
 * sorted, so the manifest is byte-stable across runs and platforms.
 */
export function generateRegistration(source: RegistrationSource): RegistrationManifest {
  const entries = source.descriptors.map((d) => ({
    tool: d.tool,
    actionId: d.actionId,
    action: d.action,
    description: canonicalizeText(d.description),
  }));
  return {
    registrationVersion: REGISTRATION_VERSION,
    surfaceVersion: source.surfaceVersion,
    tools: assembleTools(entries),
  };
}

/**
 * Derive the same registration manifest cheaply from the live `TOOL_REGISTRY`
 * (no schema compilation) — the fast path the pre-startup gate uses to obtain
 * the set of contract ActionIds without paying the full `compile()` cost. It
 * projects the SAME shape as {@link generateRegistration}, so the two agree
 * byte-for-byte (asserted in the co-located test).
 */
export function deriveRegistrationFromRegistry(
  registry: readonly CompositeTool[] = TOOL_REGISTRY,
  surfaceVersion: string = CONTRACT_SURFACE_VERSION,
): RegistrationManifest {
  const entries: TaggedAction[] = [];
  for (const tool of registry) {
    for (const action of tool.actions) {
      entries.push({
        tool: tool.name,
        actionId: `${tool.name}.${action.name}`,
        action: action.name,
        description: canonicalizeText(action.description),
      });
    }
  }
  return {
    registrationVersion: REGISTRATION_VERSION,
    surfaceVersion,
    tools: assembleTools(entries),
  };
}

/**
 * Extract the `{ actionId, tool }` references from a manifest — the exact input
 * the binding verifier checks every ActionId against.
 */
export function registrationActionRefs(
  manifest: RegistrationManifest,
): readonly RegistrationActionRef[] {
  const refs: RegistrationActionRef[] = [];
  for (const tool of manifest.tools) {
    for (const action of tool.actions) {
      refs.push({ actionId: action.actionId, tool: tool.tool });
    }
  }
  return refs;
}

/**
 * Canonical, byte-stable serialization of a registration manifest (trailing
 * newline). Reuses the P03-03 canonical-JSON discipline so repeated generation
 * is byte-identical.
 */
export function serializeRegistration(manifest: RegistrationManifest): string {
  return canonicalJson(manifest) + '\n';
}
