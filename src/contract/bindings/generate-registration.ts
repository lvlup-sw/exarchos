/**
 * Generates MCP tool registration from the compiled contract. MCP is a wire projection of the
 * contract. The manifest of each tool and its ActionIds thus cannot drift from the contract.
 *
 * Tools and actions are sorted, descriptions get normalized line endings, and the output is
 * canonical JSON with a trailing newline. The serialized manifest is thus byte-identical across
 * runs and across CRLF and LF checkouts.
 */

import { canonicalJson } from '../request-context.js';
import { canonicalizeText } from '../authority-digest.js';
import { CONTRACT_SURFACE_VERSION } from '../compatibility.js';
import { TOOL_REGISTRY, type CompositeTool } from '../../registry.js';
import type { ActionContract } from '../../registry/action-contract.js';
import {
  compactActionContract,
  projectCompactActionContract,
  type CompactActionContract,
} from '../../registry/schema-builders.js';

/** The current MCP-registration manifest schema version. */
export const REGISTRATION_VERSION = 1 as const;

/** One action's discovery entry (its stable ActionId + wire-visible metadata). */
export interface RegistrationAction {
  readonly actionId: string;
  readonly action: string;
  readonly description: string;
  /** The compact contract projection. It is null when the action declares no contract block. */
  readonly contractSummary: CompactActionContract | null;
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
    readonly actionContract?: ActionContract | undefined;
    readonly policy?: { readonly actionContract?: ActionContract | undefined };
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
      contractSummary: entry.contractSummary,
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

function sourceContractSummary(
  descriptor: RegistrationSource['descriptors'][number],
): CompactActionContract | null {
  const declared = descriptor.actionContract ?? descriptor.policy?.actionContract;
  if (declared === undefined) return null;
  return compactActionContract(declared);
}

/** Generate the MCP registration manifest from the compiled contract. The function is pure. */
export function generateRegistration(source: RegistrationSource): RegistrationManifest {
  const entries = source.descriptors.map((d) => ({
    tool: d.tool,
    actionId: d.actionId,
    action: d.action,
    description: canonicalizeText(d.description),
    contractSummary: sourceContractSummary(d),
  }));
  return {
    registrationVersion: REGISTRATION_VERSION,
    surfaceVersion: source.surfaceVersion,
    tools: assembleTools(entries),
  };
}

/**
 * Derive the same manifest from the live `TOOL_REGISTRY` without schema compilation. The startup
 * binding gate uses this fast path to get the ActionId set. The shape is the same as the output of
 * {@link generateRegistration}.
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
        contractSummary: projectCompactActionContract(action) ?? null,
      });
    }
  }
  return {
    registrationVersion: REGISTRATION_VERSION,
    surfaceVersion,
    tools: assembleTools(entries),
  };
}

/** Extract the `{ actionId, tool }` references from a manifest for the binding verifier. */
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

/** Serialize a registration manifest as canonical JSON with a trailing newline. */
export function serializeRegistration(manifest: RegistrationManifest): string {
  return canonicalJson(manifest) + '\n';
}
