import { z } from 'zod';

/**
 * Schema for `.exarchos.yml` (Stage 2 of the test-runtime resolver).
 *
 * Mirrors the SAFE_COMMAND_PATTERN allowlist used by
 * `config/test-runtime-resolver.ts`.
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
//     `tier` (`dev | user`). `tier: dev` is what the retired
//     `devCatalog: 'enabled'` alias desugars to (see below).
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

/**
 * The repo-root-relative path the retired `invariants.devCatalog: 'enabled'`
 * alias desugars to.
 *
 * Reintroduced here by T-43. T-42 deleted the identically-named constant from
 * `architecture/catalog-sources.ts` because catalog DISCOVERY must no longer
 * know about a privileged path — and it still must not. This constant lives on
 * the CONFIG side, where its only job is to spell out the registration a
 * legacy `.exarchos.yml` is rewritten into. Discovery reads the rewritten
 * `catalogs:` list and nothing else.
 */
export const DEV_CATALOG_PATH = '.exarchos/invariants.md';

/** Stable machine-readable code for the retired `invariants.devCatalog` key. */
export const DEV_CATALOG_DEPRECATION_CODE = 'DEPRECATED_INVARIANTS_DEV_CATALOG';

/**
 * A typed `.exarchos.yml` deprecation (DR-31 / T-43).
 *
 * Typed — not a bare string — so a consumer surface (doctor, CLI, MCP
 * envelope) can branch on `code` and render `replacement` as an actionable
 * edit, rather than regex-matching prose. `collectConfigDeprecations` produces
 * these from the RAW pre-parse document, because the parse step desugars the
 * deprecated keys away.
 */
export interface ConfigDeprecation {
  /** Stable identifier for the deprecation; safe to branch on. */
  readonly code: typeof DEV_CATALOG_DEPRECATION_CODE;
  /** Dotted path of the deprecated key as it appears in `.exarchos.yml`. */
  readonly key: 'invariants.devCatalog';
  /** The `catalogs:` registration the key was desugared into, if any. */
  readonly replacement: { readonly path: string; readonly tier: 'dev' } | null;
  /** Operator-facing explanation, including the concrete replacement edit. */
  readonly message: string;
}

/**
 * Collect typed deprecations from a RAW (pre-parse) `.exarchos.yml` document.
 *
 * Must run on the raw document: `InvariantsConfigSchema` strips `devCatalog`
 * during parse, so a post-parse config can never report it. Returns `[]` for
 * any document that does not carry a deprecated key, including malformed
 * input — this is a diagnostic, not a validator.
 */
export function collectConfigDeprecations(document: unknown): ConfigDeprecation[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return [];
  }
  const invariants = (document as { invariants?: unknown }).invariants;
  if (typeof invariants !== 'object' || invariants === null || Array.isArray(invariants)) {
    return [];
  }
  const devCatalog = (invariants as { devCatalog?: unknown }).devCatalog;
  if (devCatalog !== 'enabled' && devCatalog !== 'disabled') return [];

  const replacement =
    devCatalog === 'enabled' ? ({ path: DEV_CATALOG_PATH, tier: 'dev' } as const) : null;

  return [
    {
      code: DEV_CATALOG_DEPRECATION_CODE,
      key: 'invariants.devCatalog',
      replacement,
      message:
        `\`invariants.devCatalog: ${devCatalog}\` is deprecated and has no ` +
        `independent effect (DR-31). ` +
        (replacement === null
          ? 'Delete the key; a catalog loads only when it is registered in ' +
            '`invariants.catalogs`.'
          : 'Delete the key and register the catalog explicitly instead: ' +
            `\`invariants.catalogs: [{ path: ${replacement.path}, tier: ${replacement.tier} }]\`.`),
    },
  ];
}

export const InvariantsConfigBaseSchema = z
  .object({
    /**
     * @deprecated DR-31 / T-43. The repo-only `devCatalog` boolean is retired.
     * Register the catalog explicitly instead:
     * `catalogs: [{ path: .exarchos/invariants.md, tier: dev }]`.
     *
     * The key is RETAINED here strictly as a deprecated ALIAS so an existing
     * `.exarchos.yml` keeps loading across the upgrade — the schema is
     * `.strict()` and `loadExarchosConfig` THROWS on an unknown key, so
     * deleting it outright would hard-fail config load for every consumer who
     * ever wrote it. It is desugared away by `desugarDevCatalogAlias` below
     * and is therefore ABSENT from the parsed output type: no production
     * reader can gate on the boolean, by construction.
     */
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

/** Pre-desugar shape of the `invariants:` block (may still carry the alias). */
type InvariantsConfigBase = z.infer<typeof InvariantsConfigBaseSchema>;

/** Post-desugar shape: the alias is gone; registration is the only opt-in. */
export type InvariantsConfig = Omit<InvariantsConfigBase, 'devCatalog'>;

/**
 * DR-31 / T-43 — desugar the retired `invariants.devCatalog` alias.
 *
 * `devCatalog: 'enabled'` is rewritten into the ordinary registration it was
 * always sugar for — `{ path: '.exarchos/invariants.md', tier: 'dev' }` — and
 * the key is dropped from the output entirely. `devCatalog: 'disabled'` is
 * dropped with no registration (it was only ever the default restated).
 *
 * ## Why this is NOT the repo-only loading mode DR-31 retires
 *
 * The branch this restores used to live in `resolveCatalogSources`
 * (DR-31 site 2), where it made catalog DISCOVERY read the boolean directly —
 * one concern with two configuration authorities. Here it runs at the
 * `.exarchos.yml` PARSE boundary, before discovery exists, and its output is
 * an ordinary `catalogs:` entry a consumer can type by hand, verbatim. So:
 *
 *   - discovery (`resolveCatalogSources`) has exactly ONE authority — the
 *     `catalogs:` list — and cannot see the alias at all;
 *   - the alias is a legacy SPELLING normalized away at the file boundary,
 *     not a loading mode: there is no resolution a `devCatalog` config reaches
 *     that the desugared `catalogs:` config does not reach identically.
 *
 * The `(path, tier: 'dev')` dedupe is carried over from the retired branch so
 * a config carrying BOTH the alias and the explicit registration (which is
 * what this repo shipped before T-43) resolves ONE dev source, not two.
 */
function desugarDevCatalogAlias(block: InvariantsConfigBase): InvariantsConfig {
  const { devCatalog, ...rest } = block;
  if (devCatalog !== 'enabled') return rest;

  const catalogs = rest.catalogs ?? [];
  const alreadyRegistered = catalogs.some(
    (registration) =>
      typeof registration !== 'string' &&
      registration.path === DEV_CATALOG_PATH &&
      registration.tier === 'dev',
  );
  if (alreadyRegistered) return { ...rest, catalogs };

  return {
    ...rest,
    catalogs: [...catalogs, { path: DEV_CATALOG_PATH, tier: 'dev' as const }],
  };
}

/**
 * The canonical `invariants:` block schema.
 *
 * Exported so `ProjectConfigSchema` (yaml-schema.ts) can compose the identical
 * block under its own `invariants:` key without duplicating the shape (PR
 * #1459 CodeRabbit finding 2 — single source of truth). Both `.exarchos.yml`
 * readers — the strict `loadExarchosConfig` and the lenient
 * `readInvariantsConfig` (architecture/invariants-loader.ts) — validate
 * through this one schema, so the alias desugars identically on both paths.
 */
export const InvariantsConfigSchema =
  InvariantsConfigBaseSchema.transform(desugarDevCatalogAlias);

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
    // verification-ladder slice 1 (task 016): mutation + lint are per-toolchain
    // commands the layered resolver honors (task 017). `contract` is NOT a
    // per-toolchain key — contracts are keyed on schema artifacts, resolved
    // separately (task 022) — so it is intentionally absent from this strict
    // object.
    mutation: safeCommand.optional(),
    lint: safeCommand.optional(),
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

// Ownership manifest (verification-ladder slice 1, task 024).
//
// `ownership.firstParty` is the set of globs identifying trees that are
// first-party (authored-here) source. It is the scope the import-boundary
// lint (SIV-3 Layer A, task 027) and ownership-aware gates restrict
// themselves to — third-party / vendored / generated trees fall outside it.
//
// Unlike `invariants`, this block carries a parse-time DEFAULT rather than
// staying `undefined`. The distinction is deliberate: an absent `invariants`
// block must read as "operator never opted in" (so the loader can treat
// `undefined === disabled`), but ownership has no opt-in semantics — every
// repo has a first-party scope, so a missing block should resolve to a sane
// default (`src/**` + `servers/*/src/**`, covering this monorepo's own source
// trees) rather than an empty scope that would silently disable every
// ownership-aware check. The default lives on `firstParty` AND on the block
// itself so both `ownership` absent and `ownership: {}` (block present, field
// absent) resolve to the same globs.
//
// `.strict()` so a field typo (`firstparty:`) surfaces as a validation error
// rather than silently defaulting underneath the misspelled key.
const DEFAULT_FIRST_PARTY_GLOBS: readonly string[] = ['src/**', 'servers/*/src/**'];

const OwnershipConfigSchema = z
  .object({
    firstParty: z
      .array(z.string().trim().min(1))
      .default([...DEFAULT_FIRST_PARTY_GLOBS]),
  })
  .strict()
  .default({ firstParty: [...DEFAULT_FIRST_PARTY_GLOBS] });

/** Validated `.exarchos.yml` `ownership:` block (firstParty globs + default). */
export type OwnershipConfig = z.infer<typeof OwnershipConfigSchema>;

/**
 * Top-level structured `contract:` block — a single schema-boundary's codegen
 * + breaking-diff commands. Verification-ladder slice 1 (task 017): contracts
 * are keyed on schema artifacts, so the direct `.exarchos.yml` `contract:` is
 * the explicit per-repo declaration the resolver honors above artifact-keyed
 * defaults.
 */
const ContractCommandConfigSchema = z
  .object({
    codegen: safeCommand.optional(),
    diff: safeCommand.optional(),
  })
  .strict();

/**
 * Storage substrate tuning (DR-4). `synchronous` selects the SQLite
 * `PRAGMA synchronous` durability posture: `'normal'` (the default — durable
 * across a process crash, but the last committed transaction(s) can be lost
 * on OS crash / power loss; consistent with the INV-13 intent/result recovery
 * model) or `'full'` (fsync on every commit — power-loss durable, lower write
 * throughput).
 */
export const StorageConfigSchema = z
  .object({
    synchronous: z.enum(['normal', 'full']).optional(),
  })
  .strict();

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/**
 * `synthesis.documentLeg` (DR-2, #1594) — tunes the SYNTHESIZE-kind `document`
 * readiness leg. `severity` selects whether an uncovered doc-bearing change
 * blocks synthesis (`'blocking'`) or merely warns (`'advisory'`, the default —
 * a safe rollout). `surfaceGlobs` declares which changed paths count as a
 * doc-bearing surface (default empty ⇒ the leg auto-waives, so it is opt-in and
 * never overfit to one repo's layout); `docGlobs` declares what counts as a
 * documentation change (default `docs/**` + any `*.md`).
 */
export const SynthesisConfigSchema = z
  .object({
    documentLeg: z
      .object({
        severity: z.enum(['advisory', 'blocking']).optional(),
        surfaceGlobs: z.array(z.string()).optional(),
        docGlobs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SynthesisConfig = z.infer<typeof SynthesisConfigSchema>;

/**
 * `escalation` (DR-3, #1595) — tunes the shared escalation policy consumed by
 * the review and shepherd fix-loops. `maxIterations` is
 * the per-loop auto-fix bound: how many times a loop may auto-fix a mechanical
 * finding before escalating to the user. Resolves to a uniform default of `5`
 * (see `DEFAULT_MAX_ITERATIONS` in `verbs/review/escalation-policy.ts`); a
 * project raises or lowers the bound here. A per-loop call-site override takes
 * precedence over this config value.
 */
export const EscalationConfigSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
  })
  .strict();

export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;

/**
 * `feedback` (#1319) — the agent→runtime friction back-channel.
 *
 * `upstream` is an optional HTTPS endpoint the `exarchos_workflow.feedback`
 * handler POSTs each `feedback.recorded` payload to, best-effort, AFTER the
 * local event write. Omitting it (the default) keeps feedback fully local —
 * the local write always succeeds without network access (INV-15 / offline-
 * first); the POST is a pure additive federation hop. Per INV-3 the endpoint
 * lives here in `.exarchos.yml`, not in a sibling config file.
 *
 * Validated as a URL so a typo'd endpoint fails at config-load rather than
 * silently swallowing every report at POST time.
 */
export const FeedbackConfigSchema = z
  .object({
    upstream: z.string().url().optional(),
  })
  .strict();

export type FeedbackConfig = z.infer<typeof FeedbackConfigSchema>;

export const ExarchosConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
    // verification-ladder slice 1 (task 017): top-level direct verification
    // commands, resolved per-field at tier 2 (config direct) by the layered
    // resolver. `contract` is structured ({ codegen, diff }).
    mutation: safeCommand.optional(),
    lint: safeCommand.optional(),
    contract: ContractCommandConfigSchema.optional(),
    toolchains: z.array(ToolchainConfigSchema).optional(),
    ownership: OwnershipConfigSchema,
    qualityHints: QualityHintsSchema,
    handoffLint: HandoffLintConfigSchema.optional(),
    cli: CliConfigSchema.optional(),
    invariants: InvariantsConfigSchema.optional(),
    storage: StorageConfigSchema.optional(),
    synthesis: SynthesisConfigSchema.optional(),
    escalation: EscalationConfigSchema.optional(),
    feedback: FeedbackConfigSchema.optional(),
  })
  .strict();

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;

/**
 * The PRE-parse (input) shape of `.exarchos.yml` — every field optional,
 * schema defaults (e.g. `ownership`) not yet applied. Use this type when
 * CONSTRUCTING partial config literals (an invariants-only view, a test
 * fixture); `ExarchosConfig` is the POST-parse shape where defaulted blocks
 * are present and required. PR #1535 CI fix: partial literals typed as the
 * output shape fail to compile once any block carries a parse-time default.
 */
export type ExarchosConfigInput = z.input<typeof ExarchosConfigSchema>;
