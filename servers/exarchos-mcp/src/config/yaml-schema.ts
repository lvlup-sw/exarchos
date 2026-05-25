import { z } from 'zod';
import { InvariantsConfigSchema } from './exarchos-config-schema.js';

// ─── Dimension Configuration ────────────────────────────────────────────────

const DimensionSeverity = z.enum(['blocking', 'warning', 'disabled']);

const DimensionLongform = z.object({
  severity: DimensionSeverity.optional(),
  enabled: z.boolean().optional(),
}).strict();

const DimensionConfig = z.union([DimensionSeverity, DimensionLongform]);

const DimensionKey = z.enum(['D1', 'D2', 'D3', 'D4', 'D5']);

// v4: `z.record(K, V)` makes ALL enum keys required (a breaking change from
// v3 where they were partial). `z.partialRecord(K, V)` restores the v3
// partial-record behavior — any subset of `D1..D5` is valid.
const DimensionsMap = z.partialRecord(DimensionKey, DimensionConfig);

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
  models: z.partialRecord(AgentSpecIdKey, AgentModelValue).optional(),
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
  impeccable: PluginConfig.optional(),
}).strict();

// ─── Invariants Configuration ─────────────────────────────────────────────
//
// invariants-catalog-v2 (#1441 / spec 2026-05-20) — dev-invariants gating.
//
// `ProjectConfigSchema` reuses the canonical `InvariantsConfigSchema`
// definition from `exarchos-config-schema.ts` (PR #1459 CodeRabbit
// finding 2 — single source of truth). The committed root `.exarchos.yml`
// (which carries the other project-level keys `agents` / `review` / `vcs`
// / `workflow` / `tools` validated by this schema) continues to parse
// cleanly under `ProjectConfigSchema.strict()` via this shared block.
// The architecture-invariants loader does NOT consume this projection —
// it slices the `invariants` block out of the raw YAML directly via
// `architecture/invariants-loader.ts:readInvariantsConfig`, decoupling
// the loader from this schema's other concerns.
//
// Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §4.0
// User-facing doc: docs/guides/exarchos-yml-invariants.md

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
  invariants: InvariantsConfigSchema.optional(),
}).strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
