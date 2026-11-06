/**
 * The `exarchos` extension of a kernel workflow definition, and the reference rules that hold
 * for any definition.
 *
 * The kernel schema is a loose object, so it keeps any `exarchos` value. The strict parse of
 * this module is the only check of the extension. Every object is strict, and no field has a
 * default. So an absent optional field stays absent. The extension restates no kernel field.
 *
 * The executor runs two universal edges from each non-final state, and the extension declares
 * them. `cancel` has no guard and runs before the explicit edges, so it shadows an explicit edge
 * to the same target. `cleanup` has a guard and also runs before the explicit edges. When its
 * guard fails, the explicit edge to the same target decides.
 *
 * The valid targets of a state hold a universal target only when no explicit edge of that state
 * reaches it.
 */

import { z } from 'zod';
import {
  WorkflowDefinitionV1Schema,
  type WorkflowDefinitionV1,
} from '@lvlup-sw/strategos-contracts';

import { EdgeConditionNodeSchema, SharedStableIdSchema } from '../../contract/ir/admission-ir.js';

/** The key of the extension in a definition document. */
const EXTENSION_KEY = 'exarchos';

/** The effects that a state entry, a state exit or a transition runs. */
const EffectSchema = z.enum(['checkpoint', 'log', 'increment-fix-cycle']);

export type Effect = z.infer<typeof EffectSchema>;

/** The legacy-guard classification category of an edge. */
const EdgeCategorySchema = z.enum([
  'route-condition',
  'admission-requirement',
  'bounded-loop-rule',
  'approval',
  'obsolete-predicate',
]);

export type EdgeCategory = z.infer<typeof EdgeCategorySchema>;

/** A step id or a group id. */
const StepIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

/** A guard id. A composite id joins the ids of its inner guards with `+`. */
const GuardIdSchema = z.string().regex(/^[a-z][a-z0-9-]*(\+[a-z][a-z0-9-]*)*$/);

/** A list of effects. The list is not empty, so a state or an edge with no effect omits the key. */
const EffectListSchema = z.array(EffectSchema).min(1);

/**
 * A compound state over a contiguous run of kernel steps. The executor keeps shallow history for
 * each compound ancestor, so `history` is always `shallow`.
 */
const GroupSchema = z
  .object({
    groupId: StepIdSchema,
    members: z.array(StepIdSchema).min(1),
    initial: StepIdSchema,
    maxFixCycles: z.number().int().positive().optional(),
    history: z.literal('shallow'),
    onEntry: EffectListSchema.optional(),
    onExit: EffectListSchema.optional(),
  })
  .strict();

/** The admission obligation of an edge. An approval states `minimumApprovals`, with no default. */
const ObligationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('gate'),
      gateId: SharedStableIdSchema,
      presence: EdgeConditionNodeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval'),
      approvalClass: SharedStableIdSchema,
      minimumApprovals: z.number().int().positive(),
      presence: EdgeConditionNodeSchema,
    })
    .strict(),
]);

/** The guard data of one kernel transition. An absent `route` means that the route is always legal. */
const EdgeSchema = z
  .object({
    guardId: GuardIdSchema.optional(),
    category: EdgeCategorySchema,
    route: EdgeConditionNodeSchema.optional(),
    obligation: ObligationSchema,
    isFixCycle: z.literal(true).optional(),
    isRevision: z.literal(true).optional(),
    effects: EffectListSchema.optional(),
  })
  .strict();

/** One universal edge. A `cancel` edge has no guard, and a `cleanup` edge names its guard. */
const UniversalEdgeSchema = z.discriminatedUnion('edgeKind', [
  z.object({ edgeKind: z.literal('cancel'), to: StepIdSchema }).strict(),
  z.object({ edgeKind: z.literal('cleanup'), to: StepIdSchema, guardId: GuardIdSchema }).strict(),
]);

/** The strict schema of the `exarchos` extension. The kernel `transitionId` is the key of each edge. */
export const ExarchosExtensionSchema = z
  .object({
    extensionVersion: z.literal('1'),
    groups: z.array(GroupSchema),
    edges: z.record(z.string(), EdgeSchema),
    universal: z.array(UniversalEdgeSchema),
  })
  .strict();

export type ExarchosExtension = z.infer<typeof ExarchosExtensionSchema>;

/** One refusal of a definition: the id of the rule, and the keys and indices from the root of the document. */
export interface DefinitionFinding {
  readonly rule: string;
  readonly path: readonly (string | number)[];
}

/** The result of the strict parse of the extension of one document. */
export type ExtensionParseResult =
  | { readonly ok: true; readonly extension: ExarchosExtension }
  | { readonly ok: false; readonly findings: readonly DefinitionFinding[] };

/**
 * The top-level keys of a kernel document, from the kernel schema. A parsed kernel keeps a stray
 * key, so it cannot give this set.
 */
const KERNEL_KEYS: ReadonlySet<string> = new Set(Object.keys(WorkflowDefinitionV1Schema.shape));

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts one key of a zod issue path into a key of a finding path. */
function pathKey(key: PropertyKey): string | number {
  return typeof key === 'symbol' ? String(key) : key;
}

/**
 * Converts one zod issue of the extension parse into findings under the `exarchos` key. An unknown
 * key gives one finding for each key, with that key at the end of the path.
 */
function issueFindings(issue: z.core.$ZodIssue): DefinitionFinding[] {
  const path = [EXTENSION_KEY, ...issue.path.map(pathKey)];
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => ({ rule: 'extension-schema', path: [...path, key] }));
  }
  return [{ rule: 'extension-schema', path }];
}

/** Parses the `exarchos` value of a raw document with the strict schema. Each refusal names its path. */
export function parseExtension(raw: unknown): ExtensionParseResult {
  const parsed = ExarchosExtensionSchema.safeParse(isRecord(raw) ? raw[EXTENSION_KEY] : undefined);
  if (parsed.success) return { ok: true, extension: parsed.data };
  return { ok: false, findings: parsed.error.issues.flatMap(issueFindings) };
}

/** The `kernel-keys` rule: each top-level key of the raw document is a kernel key or `exarchos`. */
function kernelKeyFindings(raw: unknown): DefinitionFinding[] {
  if (!isRecord(raw)) return [{ rule: 'kernel-keys', path: [] }];
  return Object.keys(raw)
    .filter((key) => key !== EXTENSION_KEY && !KERNEL_KEYS.has(key))
    .map((key) => ({ rule: 'kernel-keys', path: [key] }));
}

/**
 * The `edge-keys` rule: the kernel transition ids are unique, and the edge keys equal them in both
 * directions. A transition with no edge names the edge key that is absent.
 */
function edgeKeyFindings(
  kernel: WorkflowDefinitionV1,
  extension: ExarchosExtension,
): DefinitionFinding[] {
  const findings: DefinitionFinding[] = [];
  const transitionIds = new Set<string>();
  kernel.transitions.forEach((transition, index) => {
    if (transitionIds.has(transition.transitionId)) {
      findings.push({ rule: 'edge-keys', path: ['transitions', index, 'transitionId'] });
    }
    transitionIds.add(transition.transitionId);
  });
  const edgeKeys = new Set(Object.keys(extension.edges));
  for (const transitionId of transitionIds) {
    if (!edgeKeys.has(transitionId)) {
      findings.push({ rule: 'edge-keys', path: [EXTENSION_KEY, 'edges', transitionId] });
    }
  }
  for (const edgeKey of edgeKeys) {
    if (!transitionIds.has(edgeKey)) {
      findings.push({ rule: 'edge-keys', path: [EXTENSION_KEY, 'edges', edgeKey] });
    }
  }
  return findings;
}

/**
 * The `group-members` rule. Each member is a non-terminal kernel step in one group only, and
 * `initial` is a member. The members follow kernel order with no gap. A group id is unique and is
 * not a step id.
 */
function groupFindings(
  kernel: WorkflowDefinitionV1,
  extension: ExarchosExtension,
): DefinitionFinding[] {
  const findings: DefinitionFinding[] = [];
  const stepIds = new Set(kernel.steps.map((step) => step.stepId));
  const kernelIndex = new Map<string, number>();
  kernel.steps.forEach((step, index) => {
    if (!step.isTerminal) kernelIndex.set(step.stepId, index);
  });
  const grouped = new Set<string>();
  const groupIds = new Set<string>();
  extension.groups.forEach((group, groupIndex) => {
    const at = [EXTENSION_KEY, 'groups', groupIndex];
    if (groupIds.has(group.groupId) || stepIds.has(group.groupId)) {
      findings.push({ rule: 'group-members', path: [...at, 'groupId'] });
    }
    groupIds.add(group.groupId);
    let previous: number | undefined;
    group.members.forEach((member, memberIndex) => {
      const index = kernelIndex.get(member);
      const known = index !== undefined && !grouped.has(member);
      const contiguous = previous === undefined || index === previous + 1;
      if (!known || !contiguous) {
        findings.push({ rule: 'group-members', path: [...at, 'members', memberIndex] });
      }
      previous = index;
      grouped.add(member);
    });
    if (!group.members.includes(group.initial)) {
      findings.push({ rule: 'group-members', path: [...at, 'initial'] });
    }
  });
  return findings;
}

/** The `universal-targets` rule: each universal edge goes to a terminal step, and each kind occurs once at most. */
function universalFindings(
  kernel: WorkflowDefinitionV1,
  extension: ExarchosExtension,
): DefinitionFinding[] {
  const findings: DefinitionFinding[] = [];
  const terminals = new Set(
    kernel.steps.filter((step) => step.isTerminal).map((step) => step.stepId),
  );
  const kinds = new Set<string>();
  extension.universal.forEach((edge, index) => {
    const at = [EXTENSION_KEY, 'universal', index];
    if (!terminals.has(edge.to)) findings.push({ rule: 'universal-targets', path: [...at, 'to'] });
    if (kinds.has(edge.edgeKind)) {
      findings.push({ rule: 'universal-targets', path: [...at, 'edgeKind'] });
    }
    kinds.add(edge.edgeKind);
  });
  return findings;
}

/**
 * Runs the four reference rules over one parsed definition and returns every finding, in rule
 * order. The rules hold for any definition. `raw` gives the top-level keys of the document.
 */
export function validateExtension(
  raw: unknown,
  kernel: WorkflowDefinitionV1,
  extension: ExarchosExtension,
): readonly DefinitionFinding[] {
  return [
    ...kernelKeyFindings(raw),
    ...edgeKeyFindings(kernel, extension),
    ...groupFindings(kernel, extension),
    ...universalFindings(kernel, extension),
  ];
}
