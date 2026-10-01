import { z } from 'zod';
import {
  InvariantsConfigSchema,
  ExarchosConfigSchema,
  StorageConfigSchema,
  SynthesisConfigSchema,
  EscalationConfigSchema,
} from './exarchos-config-schema.js';
import { VERIFICATION_GATE_NAMES } from '../workflow/verification-policy.js';
import {
  REMOVED_PRUNE_CONFIG_KNOBS,
  PRUNE_CONFIG_KNOWN_KEYS,
  removedPruneKnobMessage,
  unrecognizedPruneKeyMessage,
} from './prune-removed-knobs.js';

const DimensionSeverity = z.enum(['blocking', 'warning', 'disabled']);

const DimensionLongform = z.object({
  severity: DimensionSeverity.optional(),
  enabled: z.boolean().optional(),
}).strict();

const DimensionConfig = z.union([DimensionSeverity, DimensionLongform]);

const DimensionKey = z.enum(['D1', 'D2', 'D3', 'D4', 'D5']);

/**
 * Any subset of `D1` to `D5`. In Zod v4, `z.record` with enum keys requires every key, so this
 * map uses `z.partialRecord`.
 */
const DimensionsMap = z.partialRecord(DimensionKey, DimensionConfig);

const GateConfig = z.object({
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

const RiskWeights = z.record(z.string(), z.number()).refine(
  (weights) => {
    const values = Object.values(weights);
    if (values.length === 0) return true;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return Math.abs(sum - 1.0) < 0.001;
  },
  { message: 'Risk weights must sum to 1.0' },
);

const RoutingConfig = z.object({
  'coderabbit-threshold': z.number().min(0).max(1).optional(),
  'risk-weights': RiskWeights.optional(),
}).strict();

const ReviewConfig = z.object({
  dimensions: DimensionsMap.optional(),
  gates: z.record(z.string(), GateConfig).optional(),
  /** Mutation-score enforcement at the review to synthesize transition. Advisory by default. */
  'mutation-enforcement': z.enum(['block', 'advisory']).optional(),
  routing: RoutingConfig.optional(),
}).strict();

const VcsConfig = z.object({
  provider: z.enum(['github', 'gitlab', 'azure-devops']).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();

const PhaseConfig = z.object({
  'human-checkpoint': z.boolean().optional(),
}).strict();

const WorkflowConfig = z.object({
  'skip-phases': z.array(z.string()).optional(),
  'max-fix-cycles': z.number().int().min(1).max(10).optional(),
  /**
   * Cap on plan-review revise cycles. The transition injects it as the ephemeral
   * `_maxPlanRevisions` for the `revisionsExhausted` guard. It is never event-sourced, because a
   * config threshold is not a fact.
   */
  'max-plan-revisions': z.number().int().min(1).max(10).optional(),
  'required-reviews': z.array(z.string().min(1)).optional(),
  phases: z.record(z.string(), PhaseConfig).optional(),
}).strict();

const AgentModelValue = z.enum(['opus', 'sonnet', 'haiku']);
const AgentSpecIdKey = z.enum(['implementer', 'fixer', 'reviewer', 'scaffolder']);

/**
 * Keys of the tier-to-model policy. The record is partial, so an operator can map one tier and
 * keep the default for the others. `validateTierModels` in `resolve.ts` checks the merged table,
 * so its error can name the bad cell.
 */
const RiskTierKey = z.enum(['low', 'medium', 'high']);

const AgentsConfig = z.object({
  'default-model': AgentModelValue.optional(),
  models: z.partialRecord(AgentSpecIdKey, AgentModelValue).optional(),
  'tier-models': z.partialRecord(RiskTierKey, AgentModelValue).optional(),
}).strict();

const ToolsConfig = z.object({
  'default-branch': z.string().optional(),
  'commit-style': z.enum(['conventional', 'freeform']).optional(),
  'pr-template': z.string().optional(),
  'auto-merge': z.boolean().optional(),
  'pr-strategy': z.enum(['github-native', 'single']).optional(),
}).strict();

const HookAction = z.object({
  command: z.string(),
  timeout: z.number().int().min(1000).max(300000).optional(),
}).strict();

const HooksConfig = z.object({
  on: z.record(z.string(), z.array(HookAction)).optional(),
}).strict();

const PluginConfig = z.object({
  enabled: z.boolean().default(true),
}).strict();

const PluginsConfig = z.object({
  impeccable: PluginConfig.optional(),
}).strict();

/**
 * The `prune:` block. Per-phase staleness lives in the `staleness` blocks of `topology.yaml`.
 * A bare `.strict()` reports a removed staleness key as an opaque `unrecognized_keys` error.
 * Thus `.passthrough().superRefine` gives the shared actionable message for a removed key, and
 * rejects every other unknown key.
 */
const PruneConfig = z
  .object({
    'max-batch-size': z.number().int().min(1).max(100).default(25),
    'phase-exclusions': z.array(z.string()).default(['delegate', 'review', 'synthesize']),
    'malformed-handling': z.enum(['report', 'include', 'skip']).default('report'),
    'require-dry-run': z.boolean().default(true),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    for (const key of Object.keys(val)) {
      if (REMOVED_PRUNE_CONFIG_KNOBS.has(key)) {
        ctx.addIssue({ code: 'custom', path: [key], message: removedPruneKnobMessage(key) });
      } else if (!PRUNE_CONFIG_KNOWN_KEYS.has(key)) {
        ctx.addIssue({ code: 'custom', path: [key], message: unrecognizedPruneKeyMessage(key) });
      }
    }
  });

const CheckpointConfig = z.object({
  'operation-threshold': z.number().int().min(1).default(20),
  'enforce-on-phase-transition': z.boolean().default(true),
  'enforce-on-wave-dispatch': z.boolean().default(true),
}).strict();

/**
 * How the post-dispatch emission verifier reports a violation. A violation is a declared emission
 * that does not land, or an event that lands although its registration names no emitter.
 */
export const EMISSION_ENFORCEMENT_MODES = ['block', 'advisory'] as const;

/**
 * The `events:` block. It uses a dedicated mode key, not a boolean, because a boolean cannot tell
 * an explicit `false` from an unset value. The default is `block` in every environment, because a
 * lenient dev default hides drift from the earliest check.
 */
const EventsConfig = z
  .object({
    'emission-enforcement': z.enum(EMISSION_ENFORCEMENT_MODES).default('block'),
  })
  .strict();

/**
 * Ordered, duplicate-free list of `VERIFICATION_GATE_NAMES` for one policy cell. An empty array
 * means "run nothing for this cell". An omitted cell inherits the base table.
 */
const VerificationGateSequence = z
  .array(z.enum(VERIFICATION_GATE_NAMES))
  .refine(
    (gates) => new Set(gates).size === gates.length,
    { message: 'verification gate sequence must not contain duplicates' },
  );

/**
 * The boundary-touching sub-policy: per-tier gate sequences applied when a task
 * crosses an I/O / schema boundary. Mirrors the base-tier keys.
 */
const VerificationBoundaryPolicy = z
  .object({
    low: VerificationGateSequence.optional(),
    medium: VerificationGateSequence.optional(),
    high: VerificationGateSequence.optional(),
  })
  .strict();

/**
 * The policy overlay: base-tier gate sequences and an optional `boundary` sub-policy. Each key
 * is optional, so a consumer overrides only some cells. `.strict()` at each level makes a typo in
 * a cell key fail at parse.
 */
const VerificationPolicyConfig = z
  .object({
    low: VerificationGateSequence.optional(),
    medium: VerificationGateSequence.optional(),
    high: VerificationGateSequence.optional(),
    boundary: VerificationBoundaryPolicy.optional(),
  })
  .strict();

const VerificationConfig = z
  .object({
    policy: VerificationPolicyConfig.optional(),
  })
  .strict();

/**
 * The validated `verification:` block of `.exarchos.yml`. The overlay replaces cells of the base
 * table in `workflow/verification-policy.ts`, and `ResolvedProjectConfig.verification` uses this
 * type.
 */
export type VerificationPolicyOverlay = z.infer<typeof VerificationPolicyConfig>;

/**
 * Where authored workflow artifacts live. Both directories are relative to the project root. The
 * schema rejects an absolute path, because it cannot match a repo-relative path in an artifact
 * map. `config/artifacts.ts` normalizes the separators and the trailing slash.
 */
const ArtifactsConfig = z.object({
  'spec-dir': z.string().min(1).refine((v) => !/^([a-zA-Z]:)?[\\/]/.test(v), {
    message: 'spec-dir must be relative to the project root, not absolute',
  }).optional(),
  'legacy-design-dir': z.string().min(1).refine((v) => !/^([a-zA-Z]:)?[\\/]/.test(v), {
    message: 'legacy-design-dir must be relative to the project root, not absolute',
  }).optional(),
}).strict();

/** The project keys of `.exarchos.yml`. The `invariants` block reuses `InvariantsConfigSchema`. */
export const ProjectConfigSchema = z.object({
  agents: AgentsConfig.optional(),
  artifacts: ArtifactsConfig.optional(),
  review: ReviewConfig.optional(),
  vcs: VcsConfig.optional(),
  workflow: WorkflowConfig.optional(),
  tools: ToolsConfig.optional(),
  hooks: HooksConfig.optional(),
  plugins: PluginsConfig.optional(),
  prune: PruneConfig.optional(),
  checkpoint: CheckpointConfig.optional(),
  events: EventsConfig.optional(),
  verification: VerificationConfig.optional(),
  invariants: InvariantsConfigSchema.optional(),
  storage: StorageConfigSchema.optional(),
  synthesis: SynthesisConfigSchema.optional(),
  escalation: EscalationConfigSchema.optional(),
}).strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * The full `.exarchos.yml` schema: the merge of `ExarchosConfigSchema` and `ProjectConfigSchema`.
 * It accepts a key that is valid in either schema and rejects a key that is valid in neither.
 * The config loaders and the invariants loader use it, so they reach the same verdict on a file.
 */
export const FullExarchosConfigSchema = ExarchosConfigSchema.merge(
  ProjectConfigSchema,
).strict();

export type FullExarchosConfig = z.infer<typeof FullExarchosConfigSchema>;
