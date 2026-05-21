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
const InvariantsConfigSchema = z
  .object({
    devCatalog: z.enum(['enabled', 'disabled']).optional(),
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

export const ExarchosConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
    qualityHints: QualityHintsSchema,
    handoffLint: HandoffLintConfigSchema.optional(),
    cli: CliConfigSchema.optional(),
    invariants: InvariantsConfigSchema.optional(),
  })
  .strict();

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;
