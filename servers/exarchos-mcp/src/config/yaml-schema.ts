import { z } from 'zod';

// ─── Dimension Configuration ────────────────────────────────────────────────

const DimensionSeverity = z.enum(['blocking', 'warning', 'disabled']);

const DimensionLongform = z.object({
  severity: DimensionSeverity.optional(),
  enabled: z.boolean().optional(),
}).strict();

const DimensionConfig = z.union([DimensionSeverity, DimensionLongform]);

const DimensionKey = z.enum(['D1', 'D2', 'D3', 'D4', 'D5']);

const DimensionsMap = z.record(DimensionKey, DimensionConfig);

// ─── Gate Configuration ─────────────────────────────────────────────────────

const GateConfig = z.object({
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ─── Risk Weights ───────────────────────────────────────────────────────────

const RiskWeights = z.record(z.string(), z.number()).refine(
  (weights) => {
    const values = Object.values(weights);
    if (values.length === 0) return true;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return Math.abs(sum - 1.0) < 0.001;
  },
  { message: 'Risk weights must sum to 1.0' },
);

// ─── Routing Configuration ──────────────────────────────────────────────────

const RoutingConfig = z.object({
  'coderabbit-threshold': z.number().min(0).max(1).optional(),
  'risk-weights': RiskWeights.optional(),
}).strict();

// ─── Review Configuration ───────────────────────────────────────────────────

const ReviewConfig = z.object({
  dimensions: DimensionsMap.optional(),
  gates: z.record(z.string(), GateConfig).optional(),
  routing: RoutingConfig.optional(),
}).strict();

// ─── VCS Configuration ─────────────────────────────────────────────────────

const VcsConfig = z.object({
  provider: z.enum(['github', 'gitlab', 'azure-devops']).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();

// ─── Workflow Phase Configuration ───────────────────────────────────────────

const PhaseConfig = z.object({
  'human-checkpoint': z.boolean().optional(),
}).strict();

const WorkflowConfig = z.object({
  'skip-phases': z.array(z.string()).optional(),
  'max-fix-cycles': z.number().int().min(1).max(10).optional(),
  'required-reviews': z.array(z.string().min(1)).optional(),
  phases: z.record(z.string(), PhaseConfig).optional(),
}).strict();

// ─── Agents Configuration ──────────────────────────────────────────────────

const AgentModelValue = z.enum(['opus', 'sonnet', 'haiku']);
const AgentSpecIdKey = z.enum(['implementer', 'fixer', 'reviewer', 'scaffolder']);

const AgentsConfig = z.object({
  'default-model': AgentModelValue.optional(),
  models: z.record(AgentSpecIdKey, AgentModelValue).optional(),
}).strict();

// ─── Tools Configuration ───────────────────────────────────────────────────

const ToolsConfig = z.object({
  'default-branch': z.string().optional(),
  'commit-style': z.enum(['conventional', 'freeform']).optional(),
  'pr-template': z.string().optional(),
  'auto-merge': z.boolean().optional(),
  'pr-strategy': z.enum(['github-native', 'single']).optional(),
}).strict();

// ─── Hook Configuration ────────────────────────────────────────────────────

const HookAction = z.object({
  command: z.string(),
  timeout: z.number().int().min(1000).max(300000).optional(),
}).strict();

const HooksConfig = z.object({
  on: z.record(z.string(), z.array(HookAction)).optional(),
}).strict();

// ─── Plugin Configuration ─────────────────────────────────────────────────

const PluginConfig = z.object({
  enabled: z.boolean().default(true),
}).strict();

const PluginsConfig = z.object({
  axiom: PluginConfig.optional(),
  impeccable: PluginConfig.optional(),
}).strict();

// ─── Prune Configuration ──────────────────────────────────────────────────

const PruneConfig = z.object({
  'stale-after-days': z.number().int().min(1).default(14),
  'max-batch-size': z.number().int().min(1).max(100).default(25),
  'phase-exclusions': z.array(z.string()).default(['delegate', 'review', 'synthesize']),
  'malformed-handling': z.enum(['report', 'include', 'skip']).default('report'),
  'require-dry-run': z.boolean().default(true),
}).strict();

// ─── Checkpoint Configuration ─────────────────────────────────────────────

const CheckpointConfig = z.object({
  'operation-threshold': z.number().int().min(1).default(20),
  'enforce-on-phase-transition': z.boolean().default(true),
  'enforce-on-wave-dispatch': z.boolean().default(true),
}).strict();

// ─── Top-Level Project Config ──────────────────────────────────────────────

export const ProjectConfigSchema = z.object({
  agents: AgentsConfig.optional(),
  review: ReviewConfig.optional(),
  vcs: VcsConfig.optional(),
  workflow: WorkflowConfig.optional(),
  tools: ToolsConfig.optional(),
  hooks: HooksConfig.optional(),
  plugins: PluginsConfig.optional(),
  prune: PruneConfig.optional(),
  checkpoint: CheckpointConfig.optional(),
}).strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
