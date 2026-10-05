import { z } from 'zod';

/**
 * The command allowlist for `.exarchos.yml`. It is equal to `SAFE_COMMAND_PATTERN` in `config/test-runtime-resolver.ts`.
 * It accepts a plain space but rejects control whitespace. A newline can split a shell command if a consumer later runs it through a shell.
 */
const SAFE_COMMAND_REGEX = /^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/;

const safeCommand = z
  .string()
  .trim()
  .min(1, 'must not be empty or whitespace-only')
  .regex(SAFE_COMMAND_REGEX, 'contains disallowed shell metacharacters');

/**
 * `outputTokenThreshold` is a fraction in (0, 1]. The telemetry projection multiplies it by `OUTPUT_TOKENS_PER_TURN_CAP`.
 * Above that token count, `next_actions` shows an `output_tokens_high` checkpoint hint. The default fraction is 0.8.
 */
const QualityHintsSchema = z
  .object({
    outputTokenThreshold: z.number().gt(0).lte(1).optional(),
  })
  .strict()
  .optional();

/**
 * `followPollIntervalMs` replaces the 250ms default poll interval of the CLI `--follow` loop in `src/cli/follow-loop.ts`.
 * It has no effect on MCP `tasks/get`, where the client sets the poll interval.
 */
const CliConfigSchema = z
  .object({
    followPollIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A per-invariant override. It changes `severity` or `enabled` without an edit to the catalog.
 * The strict object turns a typo in a key into a validation error.
 */
const InvariantOverrideSchema = z
  .object({
    severity: z.enum(['blocking', 'advisory']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

/**
 * The object form of a catalog registration. It carries a source `tier` of `dev` or `user`.
 * The retired `devCatalog: 'enabled'` alias becomes a registration with `tier: dev`.
 */
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
 * One entry in `invariants.catalogs`: a bare string path or a `{ path, tier? }` object.
 * `resolveCatalogSources` converts both forms into a `CatalogSource`. A bare string gets `tier: user`.
 */
export type CatalogRegistration = z.infer<typeof CatalogRegistrationSchema>;

/**
 * The repo-root-relative path for the retired `invariants.devCatalog: 'enabled'` alias.
 * The constant stays on the config side. Catalog discovery must not know about a privileged path.
 */
export const DEV_CATALOG_PATH = '.exarchos/invariants.md';

/** Stable machine-readable code for the retired `invariants.devCatalog` key. */
export const DEV_CATALOG_DEPRECATION_CODE = 'DEPRECATED_INVARIANTS_DEV_CATALOG';

/**
 * A typed `.exarchos.yml` deprecation. A consumer can branch on `code` and show `replacement` as an edit, with no match on prose.
 */
export interface ConfigDeprecation {
  /** Stable identifier for the deprecation. A consumer can branch on it. */
  readonly code: typeof DEV_CATALOG_DEPRECATION_CODE;
  /** Dotted path of the deprecated key as it appears in `.exarchos.yml`. */
  readonly key: 'invariants.devCatalog';
  /** The `catalogs:` registration the key was desugared into, if any. */
  readonly replacement: { readonly path: string; readonly tier: 'dev' } | null;
  /** Operator-facing explanation, including the concrete replacement edit. */
  readonly message: string;
}

/**
 * Collects typed deprecations from a raw `.exarchos.yml` document.
 * It must run before the parse, because `InvariantsConfigSchema` removes `devCatalog`.
 * It is a diagnostic, not a validator. It returns `[]` for malformed input and for a document with no deprecated key.
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
     * @deprecated Register the catalog instead: `catalogs: [{ path: .exarchos/invariants.md, tier: dev }]`.
     * The key stays as an alias, because the strict schema makes `loadExarchosConfig` throw on an unknown key.
     * `desugarDevCatalogAlias` removes it, so the parsed output type does not have it.
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

/** The shape of the `invariants:` block before the alias conversion. It can still hold `devCatalog`. */
type InvariantsConfigBase = z.infer<typeof InvariantsConfigBaseSchema>;

/** The shape after the alias conversion. Registration is the only opt-in. */
export type InvariantsConfig = Omit<InvariantsConfigBase, 'devCatalog'>;

/**
 * Converts the retired `invariants.devCatalog` alias into a plain registration, and removes the key.
 * `'enabled'` adds `{ path: DEV_CATALOG_PATH, tier: 'dev' }`, unless that exact registration is already present. `'disabled'` adds nothing.
 * This runs at the parse boundary, so `resolveCatalogSources` reads only the `catalogs:` list.
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
 * The canonical `invariants:` block schema. `ProjectConfigSchema` uses it under its own `invariants:` key.
 * The strict `loadExarchosConfig` and the lenient `readInvariantsConfig` both validate through it, so both convert the alias the same way.
 */
export const InvariantsConfigSchema =
  InvariantsConfigBaseSchema.transform(desugarDevCatalogAlias);

/**
 * The handoff lint switch for `handleCheckpoint`. By default a lint finding is a warning, and the checkpoint event is still appended.
 * With `hardFail: true`, the call returns `INVALID_INPUT` before it appends an event.
 */
const HandoffLintConfigSchema = z
  .object({
    hardFail: z.boolean().optional(),
  })
  .strict();

/**
 * A detection marker for a user toolchain: a root filename or a `*.ext` glob.
 * `resolveTestRuntime` matches user toolchains before the built-in registry, so a user entry overrides a built-in one for the same marker.
 */
const toolchainMarker = z
  .string()
  .regex(
    /^(\*\.[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)$/,
    'must be a root filename or a `*.ext` glob',
  );

/**
 * The commands of one user toolchain. `contract` is not a toolchain key, because contracts are keyed on schema artifacts.
 */
const ToolchainCommandsConfigSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
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

/**
 * The default `ownership.firstParty` globs: the first-party source trees that the import-boundary lint and ownership-aware gates scan.
 * Ownership has no opt-in, so an absent block gets these globs. The default is not empty, because an empty scope silently turns off every ownership-aware check.
 * The default is on the field and on the block, so `ownership` absent and `ownership: {}` give the same globs.
 */
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
 * The top-level `contract:` block: the codegen and breaking-diff commands for one schema boundary.
 * The resolver prefers it to the artifact-keyed defaults.
 */
const ContractCommandConfigSchema = z
  .object({
    codegen: safeCommand.optional(),
    diff: safeCommand.optional(),
  })
  .strict();

/**
 * Storage tuning. `synchronous` sets the SQLite `PRAGMA synchronous` value.
 * `'normal'` survives a process crash, but an OS crash or power loss can lose the last commits. The intent and result recovery model accepts that loss.
 * `'full'` does an fsync on each commit. It survives power loss but writes more slowly.
 */
export const StorageConfigSchema = z
  .object({
    synchronous: z.enum(['normal', 'full']).optional(),
  })
  .strict();

export type StorageConfig = z.infer<typeof StorageConfigSchema>;

/**
 * `synthesis.documentLeg` tunes the `document` readiness leg of synthesis.
 * `severity` selects whether a doc-bearing change with no doc change blocks synthesis or only warns.
 * `surfaceGlobs` names the doc-bearing paths. `docGlobs` names the documentation paths.
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
 * `escalation` tunes the escalation policy of the review and shepherd fix loops.
 * `maxIterations` is the number of auto-fixes that a loop can do on a mechanical finding before it escalates to the user.
 * The default is `DEFAULT_MAX_ITERATIONS`. A call-site override takes precedence over this value.
 */
export const EscalationConfigSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
  })
  .strict();

export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;

/**
 * `feedback.upstream` is an endpoint that receives each `feedback.recorded` payload after the local event write.
 * The POST is best-effort. With no endpoint, feedback stays local and needs no network.
 * The URL check makes a bad endpoint fail at config load, not silently at POST time.
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
 * The input shape of `.exarchos.yml`, before the parse applies the defaults. Every field is optional.
 * Use it for partial config literals. A partial literal typed as `ExarchosConfig` does not compile, because defaulted blocks are required there.
 */
export type ExarchosConfigInput = z.input<typeof ExarchosConfigSchema>;
