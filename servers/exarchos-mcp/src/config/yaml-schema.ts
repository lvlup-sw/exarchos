import { z } from 'zod';
import { InvariantsConfigSchema, ExarchosConfigSchema, StorageConfigSchema } from './exarchos-config-schema.js';
import { VERIFICATION_GATE_NAMES } from '../workflow/verification-policy.js';

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

// ─── Verification Configuration ────────────────────────────────────────────
//
// verification-ladder slice 1, R2 (#1517 / task 001) — the per-cell override
// layer that composes ON TOP of the frozen base policy table in
// `workflow/verification-policy.ts`. The base table maps each
// `(riskTier, boundaryTouching)` cell to an ordered gate sequence; this block
// lets a consumer REPLACE the sequence for any cell in `.exarchos.yml`. The
// resolver (a later task) layers these overrides over the table — this block
// only describes the override surface.
//
// `VERIFICATION_GATE_NAMES` is the single source of truth for the gate-name
// vocabulary (imported, never re-declared). A cell value is an ordered,
// DUPLICATE-FREE list of those names. An EMPTY array is valid — it is the
// explicit "run nothing for this cell" override (distinct from an omitted cell,
// which inherits the base table). `.strict()` at every level so a typo'd cell
// key (`lowww:`) or stray field fails at parse rather than being silently
// ignored.

/** Ordered, duplicate-free list of gate names for a single policy cell. */
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
 * The policy-overlay: base-tier gate sequences plus an optional `boundary`
 * sub-policy. Every key optional — a consumer overrides only the cells it
 * cares about; omitted cells fall through to the base table.
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
 * Validated `.exarchos.yml` `verification:` block — the per-cell policy
 * overlay. The resolver (R2 follow-on) and `ResolvedProjectConfig.verification`
 * share this single overlay-shape type; it is NOT a copy of the base table.
 */
export type VerificationPolicyOverlay = z.infer<typeof VerificationPolicyConfig>;

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
  verification: VerificationConfig.optional(),
  invariants: InvariantsConfigSchema.optional(),
  storage: StorageConfigSchema.optional(),
}).strict();

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// ─── Unified `.exarchos.yml` schema (#1479 dual-reader reconciliation) ──────
//
// The same `.exarchos.yml` is read by two paths that historically used
// disjoint, both-`.strict()` schemas:
//   - `loadExarchosConfig` (config/load-exarchos-config.ts) → ExarchosConfigSchema
//     (test/typecheck/install/qualityHints/handoffLint/cli/invariants)
//   - the architecture invariants loader's `readInvariantsConfig` → a hand-
//     rolled lenient slice of the `invariants:` block.
// Because each schema rejected the other's keys, a file valid for one reader
// threw for the other, and a typo'd key silently kept its invariants block
// alive on the lenient path. The unified schema is the merge of both
// concern-schemas: a key valid in EITHER is accepted; a key valid in NEITHER
// (a genuine typo) is still rejected. Both readers now share this one schema,
// so they reach the same verdict on any given file. The shared `invariants`
// block is identical in both source schemas, so the merge is conflict-free.
export const FullExarchosConfigSchema = ExarchosConfigSchema.merge(
  ProjectConfigSchema,
).strict();

export type FullExarchosConfig = z.infer<typeof FullExarchosConfigSchema>;
