import { z } from 'zod';

/**
 * The command allowlist for `.exarchos.yml`. It is equal to `SAFE_COMMAND_PATTERN` in `config/test-runtime-resolver.ts`.
 * It accepts a plain space but rejects control whitespace. A newline can split a shell command if a consumer later runs it through a shell.
 */
const SAFE_COMMAND_REGEX = /^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/;

/** A command of `.exarchos.yml`: a trimmed string that is not empty and holds only the characters of the safe-command class. */
export const safeCommand = z
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
 * The repo-root-relative path for the retired `invariants.devCatalog: 'enabled'` alias.
 * The constant stays on the config side. Catalog discovery must not know about a privileged path.
 */
export const DEV_CATALOG_PATH = '.exarchos/invariants.md';

/** Stable machine-readable code for the retired `invariants.devCatalog` key. */
export const DEV_CATALOG_DEPRECATION_CODE = 'DEPRECATED_INVARIANTS_DEV_CATALOG';

/** Stable machine-readable code for a retired mutation command key. */
export const MUTATION_COMMAND_RETIRED_CODE = 'RETIRED_MUTATION_COMMAND';

/** Stable machine-readable code for a retired mutation review setting. */
export const MUTATION_REVIEW_RETIRED_CODE = 'RETIRED_MUTATION_REVIEW';

/** The name of the retired mutation review. No producer writes it, so a setting that names it has no effect. */
export const RETIRED_MUTATION_REVIEW = 'mutation-adequacy';

/** Stable machine-readable code for the retired `vcs` key. */
export const VCS_KEY_RETIRED_CODE = 'RETIRED_VCS_KEY';

/** Stable machine-readable code for the retired `feedback` block. */
export const FEEDBACK_UPSTREAM_RETIRED_CODE = 'RETIRED_FEEDBACK_UPSTREAM';

/**
 * A typed `.exarchos.yml` deprecation. A consumer can branch on `code` and show `replacement` as an edit, with no match on prose.
 */
export interface DevCatalogDeprecation {
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
 * A migration finding for a mutation command key. Exarchos runs no mutation testing, so the loader removes the key and has no replacement for it.
 */
export interface MutationCommandDeprecation {
  readonly code: typeof MUTATION_COMMAND_RETIRED_CODE;
  /** The top-level `mutation` key, or the `commands.mutation` key of one `toolchains:` entry. */
  readonly key: 'mutation' | `toolchains[${number}].commands.mutation`;
  readonly replacement: null;
  readonly message: string;
}

/**
 * A migration finding for a mutation review setting. No producer writes the `mutation-adequacy` review, so the loader removes the setting.
 * A required review that nothing can write blocks its transition, so the loader removes it from `workflow.required-reviews` too.
 */
export interface MutationReviewDeprecation {
  readonly code: typeof MUTATION_REVIEW_RETIRED_CODE;
  readonly key: 'review.mutation-enforcement' | 'review.gates.mutation-adequacy' | 'workflow.required-reviews.mutation-adequacy';
  readonly replacement: null;
  readonly message: string;
}

/**
 * A migration finding for the top-level `vcs` key. Exarchos reads and writes no pull request and builds no
 * VCS provider, so no code reads the key. The loader removes it and has no replacement for it.
 */
export interface VcsKeyDeprecation {
  readonly code: typeof VCS_KEY_RETIRED_CODE;
  readonly key: 'vcs';
  readonly replacement: null;
  readonly message: string;
}

/**
 * A migration finding for the `feedback` block. Feedback stays in the local event store, so the loader removes the block and has no replacement for it.
 */
export interface FeedbackUpstreamDeprecation {
  readonly code: typeof FEEDBACK_UPSTREAM_RETIRED_CODE;
  readonly key: 'feedback';
  readonly replacement: null;
  readonly message: string;
}

/** One typed `.exarchos.yml` deprecation. The loader reports it and removes the key from the parsed config. */
export type ConfigDeprecation =
  | DevCatalogDeprecation
  | MutationCommandDeprecation
  | MutationReviewDeprecation
  | VcsKeyDeprecation
  | FeedbackUpstreamDeprecation;

/** True when `value` is a plain object, not null and not an array. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The migration finding for one mutation command key. */
function mutationCommandFinding(key: MutationCommandDeprecation['key']): MutationCommandDeprecation {
  return {
    code: MUTATION_COMMAND_RETIRED_CODE,
    key,
    replacement: null,
    message:
      `\`${key}\` is retired. Exarchos runs no mutation testing, so the loader ignores the key. ` +
      'Delete the key from .exarchos.yml.',
  };
}

/** Collects one finding for the top-level `mutation` key and one for each `toolchains:` entry with a `commands.mutation` key. */
function collectMutationCommandFindings(document: Record<string, unknown>): MutationCommandDeprecation[] {
  const findings: MutationCommandDeprecation[] = [];
  if ('mutation' in document) findings.push(mutationCommandFinding('mutation'));
  const toolchains = document.toolchains;
  if (!Array.isArray(toolchains)) return findings;
  toolchains.forEach((entry: unknown, index) => {
    if (!isPlainRecord(entry)) return;
    const commands = entry.commands;
    if (isPlainRecord(commands) && 'mutation' in commands) {
      findings.push(mutationCommandFinding(`toolchains[${index}].commands.mutation`));
    }
  });
  return findings;
}

/** The migration finding for one mutation review setting. */
function mutationReviewFinding(key: MutationReviewDeprecation['key']): MutationReviewDeprecation {
  return {
    code: MUTATION_REVIEW_RETIRED_CODE,
    key,
    replacement: null,
    message:
      `\`${key}\` is retired. Exarchos runs no mutation testing and writes no \`${RETIRED_MUTATION_REVIEW}\` review, ` +
      'so the loader ignores the setting. Delete it from .exarchos.yml.',
  };
}

/** Collects one finding for each mutation review setting of the `review` and `workflow` blocks. */
function collectMutationReviewFindings(document: Record<string, unknown>): MutationReviewDeprecation[] {
  const findings: MutationReviewDeprecation[] = [];
  const review = document.review;
  if (isPlainRecord(review) && 'mutation-enforcement' in review) findings.push(mutationReviewFinding('review.mutation-enforcement'));
  if (isPlainRecord(review) && isPlainRecord(review.gates) && RETIRED_MUTATION_REVIEW in review.gates) {
    findings.push(mutationReviewFinding('review.gates.mutation-adequacy'));
  }
  const workflow = document.workflow;
  const required = isPlainRecord(workflow) ? workflow['required-reviews'] : undefined;
  if (Array.isArray(required) && required.includes(RETIRED_MUTATION_REVIEW)) {
    findings.push(mutationReviewFinding('workflow.required-reviews.mutation-adequacy'));
  }
  return findings;
}

/**
 * Removes the retired mutation settings from a parsed `review` block: `mutation-enforcement` and the `mutation-adequacy` gate.
 * The schema still accepts them, so an existing `.exarchos.yml` keeps loading.
 */
export function withoutRetiredMutationReview<T extends { readonly 'mutation-enforcement'?: unknown; readonly gates?: Readonly<Record<string, unknown>> | undefined }>(
  block: T,
): Omit<T, 'mutation-enforcement'> {
  const { 'mutation-enforcement': enforcement, ...rest } = block;
  if (rest.gates === undefined || !(RETIRED_MUTATION_REVIEW in rest.gates)) return rest;
  const { [RETIRED_MUTATION_REVIEW]: retired, ...gates } = rest.gates;
  return { ...rest, gates };
}

/** Removes the retired `mutation-adequacy` review from a parsed `workflow.required-reviews` list. */
export function withoutRetiredRequiredReview<T extends { readonly 'required-reviews'?: readonly string[] | undefined }>(block: T): T {
  const required = block['required-reviews'];
  if (required === undefined || !required.includes(RETIRED_MUTATION_REVIEW)) return block;
  return { ...block, 'required-reviews': required.filter((name) => name !== RETIRED_MUTATION_REVIEW) };
}

/** Collects the finding for the retired top-level `vcs` key, if the document holds it. */
function collectVcsKeyFindings(document: Record<string, unknown>): VcsKeyDeprecation[] {
  if (!('vcs' in document)) return [];
  return [
    {
      code: VCS_KEY_RETIRED_CODE,
      key: 'vcs',
      replacement: null,
      message:
        '`vcs` is retired. Exarchos reads and writes no pull request, so the loader ignores the key. ' +
        'Delete the key from .exarchos.yml.',
    },
  ];
}

/**
 * Removes the retired `vcs` key from a parsed document. The schema still accepts the key, so an existing `.exarchos.yml` keeps loading.
 */
export function withoutRetiredVcsKey<T extends { readonly vcs?: unknown }>(document: T): Omit<T, 'vcs'> {
  const { vcs, ...rest } = document;
  return rest;
}

/**
 * Removes the retired `mutation` key from a parsed block. The schema still accepts the key, so an existing `.exarchos.yml` keeps loading.
 */
export function withoutRetiredMutationCommand<T extends { readonly mutation?: unknown }>(
  block: T,
): Omit<T, 'mutation'> {
  const { mutation, ...rest } = block;
  return rest;
}

/** The finding for the retired `feedback` block, if the document holds it. */
function collectFeedbackUpstreamFindings(document: Record<string, unknown>): FeedbackUpstreamDeprecation[] {
  if (!('feedback' in document)) return [];
  return [{
    code: FEEDBACK_UPSTREAM_RETIRED_CODE,
    key: 'feedback',
    replacement: null,
    message:
      '`feedback` is retired. Feedback stays in the local event store and Exarchos sends no report to a remote service, ' +
      'so the loader ignores the key. Delete the key from .exarchos.yml.',
  }];
}

/**
 * Removes the retired top-level keys from a parsed document: `mutation` and `feedback`.
 * The schema still accepts both keys, so an existing `.exarchos.yml` keeps loading.
 */
export function withoutRetiredTopLevelKeys<T extends { readonly mutation?: unknown; readonly feedback?: unknown }>(
  block: T,
): Omit<T, 'mutation' | 'feedback'> {
  const { mutation, feedback, ...rest } = block;
  return rest;
}

/**
 * Collects typed deprecations from a raw `.exarchos.yml` document.
 * It must run before the parse, because the schema removes `invariants.devCatalog`, each `mutation` key, the `vcs` key and the `feedback` block.
 * It is a diagnostic, not a validator. It returns `[]` for malformed input and for a document with no deprecated key.
 */
export function collectConfigDeprecations(document: unknown): ConfigDeprecation[] {
  if (!isPlainRecord(document)) return [];
  return [
    ...collectDevCatalogFindings(document),
    ...collectMutationCommandFindings(document),
    ...collectMutationReviewFindings(document),
    ...collectVcsKeyFindings(document),
    ...collectFeedbackUpstreamFindings(document),
  ];
}

/** Collects the finding for the retired `invariants.devCatalog` key, if the document holds it. */
function collectDevCatalogFindings(document: Record<string, unknown>): DevCatalogDeprecation[] {
  const invariants = document.invariants;
  if (!isPlainRecord(invariants)) return [];
  const devCatalog = invariants.devCatalog;
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
    /** Retired. The schema accepts the key, and the transform removes it. `collectConfigDeprecations` reports it. */
    mutation: safeCommand.optional(),
    lint: safeCommand.optional(),
  })
  .strict()
  .transform(withoutRetiredMutationCommand);

const ToolchainConfigSchema = z
  .object({
    id: z.string().trim().min(1),
    projectType: z.string().trim().min(1).optional(),
    markers: z.array(toolchainMarker).min(1),
    commands: ToolchainCommandsConfigSchema,
  })
  .strict();

/**
 * The default `ownership.firstParty` globs: the first-party source trees that the import-boundary lint and ownership-aware gates scan.
 * Ownership has no opt-in, so an absent block gets these globs. The default is not empty, because an empty scope silently turns off every ownership-aware check.
 * The default is on the field and on the block, so `ownership` absent and `ownership: {}` give the same globs.
 */
export const DEFAULT_FIRST_PARTY_GLOBS: readonly string[] = ['src/**', 'servers/*/src/**'];

const OwnershipConfigSchema = z
  .object({
    firstParty: z
      .array(z.string().trim().min(1))
      .default([...DEFAULT_FIRST_PARTY_GLOBS]),
  })
  .strict()
  .default({ firstParty: [...DEFAULT_FIRST_PARTY_GLOBS] });

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

/**
 * The retired `feedback` block. Older releases sent each report to the `feedback.upstream` URL.
 * The schema still accepts the block, so an existing file keeps loading. The parse removes it, and `collectConfigDeprecations` reports it.
 */
export const FeedbackConfigSchema = z
  .object({
    upstream: z.string().url().optional(),
  })
  .strict();

/**
 * The keys of `.exarchos.yml` that the test runtime reads, before the transform removes the retired `mutation` and `feedback` keys.
 * `FullExarchosConfigSchema` merges this object, so it stays a plain object schema.
 */
export const ExarchosConfigBaseSchema = z
  .object({
    test: safeCommand.optional(),
    typecheck: safeCommand.optional(),
    install: safeCommand.optional(),
    /** Retired. The schema accepts the key, and the transform removes it. `collectConfigDeprecations` reports it. */
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
    /** Retired. The schema accepts the key, and the transform removes it. `collectConfigDeprecations` reports it. */
    feedback: FeedbackConfigSchema.optional(),
  })
  .strict();

/** The test-runtime keys of `.exarchos.yml`. The parse removes the retired `mutation` and `feedback` keys. */
export const ExarchosConfigSchema = ExarchosConfigBaseSchema.transform(withoutRetiredTopLevelKeys);

export type ExarchosConfig = z.infer<typeof ExarchosConfigSchema>;

/**
 * The input shape of `.exarchos.yml`, before the parse applies the defaults. Every field is optional.
 * Use it for partial config literals. A partial literal typed as `ExarchosConfig` does not compile, because defaulted blocks are required there.
 */
export type ExarchosConfigInput = z.input<typeof ExarchosConfigSchema>;
