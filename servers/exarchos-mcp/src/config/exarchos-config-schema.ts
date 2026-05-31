import { z } from 'zod';

/**
 * Schema for `.exarchos.yml` (Stage 2 of the test-runtime resolver).
 *
 * Mirrors the SAFE_COMMAND_PATTERN allowlist used by
 * `orchestrate/detect-test-commands.ts` and `config/test-runtime-resolver.ts`.
 * Any field omitted from the file falls back to detection (Stage 3).
 */
// Intentionally allow plain space (` `) but reject control whitespace
// (`\n`, `\t`, `\r`, etc.) — newlines can split shell commands when a
// downstream consumer ever moves to a shell-aware execution path.
const SAFE_COMMAND_REGEX = /^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/;

const safeCommand = z
  .string()
  .trim()
  .min(1, 'must not be empty or whitespace-only')
  .regex(SAFE_COMMAND_REGEX, 'contains disallowed shell metacharacters');

// #1262 — quality-hint thresholds.
//
// `qualityHints.outputTokenThreshold` is a fraction in (0, 1] that the
// telemetry projection multiplies by the per-turn output-token cap (see
// `capabilities/resolver.ts` `OUTPUT_TOKENS_PER_TURN_CAP`) to derive the
// absolute token count above which an `output_tokens_high` checkpoint hint
// is surfaced via `next_actions`. Default fraction is 0.8 when the field
// is omitted; the config schema is `.strict()` so unknown fields are
// rejected, hence the explicit nested key.
const QualityHintsSchema = z
  .object({
    outputTokenThreshold: z.number().gt(0).lte(1).optional(),
  })
  .strict()
  .optional();

// #1273 — CLI `--follow` polling cadence.
//
// `cli.followPollIntervalMs` overrides the default 250ms cadence used by
// the CLI `view workflow_status --follow` and `view shepherd_status
// --follow` in-process polling loop (see
// `src/cli/follow-loop.ts`). Operators tune this for fast tests (e.g.
// `10`) or quieter shell output (e.g. `1000`). The MCP arm (C2) consumes
// the same `EventSourcedTaskStore` over `tasks/get`, where polling
// cadence is driven by the client and not affected by this config.
const CliConfigSchema = z
  .object({
    followPollIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

// invariants-catalog-v2 (#1441 / spec 2026-05-20) — dev-invariants gating.
//
// `invariants.devCatalog` toggles whether the architecture-invariants
// loader (`servers/exarchos-mcp/src/architecture/invariants-loader.ts`)
// surfaces dev-internal entries. Default-disabled: when the block is
// omitted, `loadInvariants` returns `[]` regardless of scope.
//
// Two-state enum (`enabled | disabled`) rather than a `boolean` so the
// committed `.exarchos.yml` reads as a declarative statement of intent
// — "surface dev-internal invariants to me" — rather than a magic flag.
// Default-disabled even inside the Exarchos repo: contributors get the
// catalog because the repo's own committed `.exarchos.yml` sets the
// flag to `enabled`, not because the loader detected anything.
//
// Spec: docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §1.1 + §4.0
//
// Exported so `ProjectConfigSchema` (yaml-schema.ts) can compose the
// identical block under its own `invariants:` key without duplicating
// the shape (PR #1459 CodeRabbit finding 2 — single source of truth).
// invariants-projection-extensibility (T-18 / DR-6) — additive keys.
//
// Beyond the dev-catalog toggle, operators can extend the invariants
// surface declaratively in `.exarchos.yml`:
//
//   - `catalogs`: paths to user-authored invariant catalog files, merged
//     on top of the built-in catalog.
//   - `overrides`: per-invariant-id tuning — flip `severity`
//     (`blocking | advisory`) or `enabled` without editing the catalog.
//   - `enforcement`: which phase treats invariant findings as gating;
//     `review: blocking` makes the review phase fail on a finding,
//     `advisory` surfaces it without gating.
//
// All three are optional and additive: omitting them preserves the
// pre-T-18 behaviour. The schema stays `.strict()` so typos in the new
// keys (or in nested override keys) surface as validation errors rather
// than silently-ignored fields.
const InvariantOverrideSchema = z
  .object({
    severity: z.enum(['blocking', 'advisory']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

// invariants-catalog-wizard (P1, T1) — a catalog registration.
//
// The dev-catalog migration (design §4.2) collapses Layers 1 + 3 of
// `resolveEffectiveCatalog` onto one registered-catalog pattern. A
// registration is either:
//
//   - a bare string path — the legacy form; its `tier` defaults to `user`
//     when normalized by `resolveCatalogSources` (catalog-sources.ts); or
//   - a `{ path, tier? }` object — the explicit form that carries the source
//     `tier` (`dev | user`). `tier: dev` is what the `devCatalog: 'enabled'`
//     sugar desugars to.
//
// `.strict()` so a typo'd key (or a tier outside `dev | user`) surfaces as a
// validation error rather than a silently-ignored field.
const CatalogRegistrationObjectSchema = z
  .object({
    path: z.string(),
    tier: z.enum(['dev', 'user']).optional(),
  })
  .strict();

const CatalogRegistrationSchema = z.union([
  z.string(),
  CatalogRegistrationObjectSchema,
]);

/**
 * A single entry in `invariants.catalogs`: either a bare string path (legacy,
 * `tier` defaults to `user`) or a `{ path, tier? }` object. Consumed by
 * `resolveCatalogSources` (architecture/catalog-sources.ts) which normalizes
 * both forms into a `CatalogSource`.
 */
export type CatalogRegistration = z.infer<typeof CatalogRegistrationSchema>;

export const InvariantsConfigSchema = z
  .object({
    devCatalog: z.enum(['enabled', 'disabled']).optional(),
    catalogs: z.array(CatalogRegistrationSchema).optional(),
    overrides: z.record(z.string(), InvariantOverrideSchema).optional(),
    enforcement: z
      .object({
        review: z.enum(['blocking', 'advisory']),
      })
      .strict()
      .optional(),
  })
  .strict();

// #1244 — markdown-aware handoff lint switch.
//
// `handleCheckpoint` runs a prose-lint over the dispatch handoff payload
// (DR-1244). By default the lint is advisory: findings surface as a
// soft warning on the response envelope and the checkpoint event is
// still appended. Setting `handoffLint.hardFail: true` flips the gate
// to a blocking rejection — `INVALID_INPUT` is returned BEFORE any
// event is appended, so retries don't duplicate.
//
// The opt-in default keeps backward compatibility for existing
// `.exarchos.yml` files: configs that don't declare `handoffLint`
// continue to soft-warn, which is the v2.10 default behaviour.
const HandoffLintConfigSchema = z
  .object({
    hardFail: z.boolean().optional(),
  })
  .strict();

// User-extensible toolchains (#1508 / layered resolver tier 3).
//
// Lets a repo teach Exarchos about ANY toolchain — including ones with zero
// built-in support — declaratively, with no code change. Each entry maps
// detection markers (root filename or `*.ext` glob) to first-class commands.
// User entries are matched BEFORE the built-in registry (resolveTestRuntime),
// so they also override a built-in toolchain for the same marker.
const toolchainMarker = z
  .string()
  .regex(
    /^(\*\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/,
    'must be a root filename or a `*.ext` glob',
  );

const ToolchainCommandsConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
  })
  .strict();

const ToolchainConfigSchema = z
  .object({
    id: z.string().trim().min(1),
    projectType: z.string().trim().min(1).optional(),
    markers: z.array(toolchainMarker).min(1),
    commands: ToolchainCommandsConfigSchema,
  })
  .strict();

/** A single `.exarchos.yml` `toolchains:` entry. */
export type ToolchainConfig = z.infer<typeof ToolchainConfigSchema>;

export const ExarchosConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
    toolchains: z.array(ToolchainConfigSchema).optional(),
    qualityHints: QualityHintsSchema,
    handoffLint: HandoffLintConfigSchema.optional(),
    cli: CliConfigSchema.optional(),
    invariants: InvariantsConfigSchema.optional(),
  })
  .strict();

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;
