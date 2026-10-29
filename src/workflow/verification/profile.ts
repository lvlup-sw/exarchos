/**
 * The verification profile: each term that a gate runs or classifies with.
 * prepare resolves the profile at the checkout and pins it once for each capsule.
 * Each command is a resolved argv with its source, or an unresolved term with a reason.
 *
 * Each constraint is a pattern, an enum, a bound or a discriminated union, and no constraint is a refinement.
 * Thus the JSON Schema projection of the capsule carries each rule. Each object is closed, and each array has a maximum.
 * The module imports zod only, so each layer can read it.
 */

import { z } from 'zod';

/** Returns the listed names as a tuple of literal types, so one list can feed each closed enum. */
function closedNames<const Names extends readonly [string, ...string[]]>(...names: Names): Names {
  return names;
}

/**
 * The forms in which a probe command takes its test files.
 * `after-separator` puts the files after `--`, `as-arguments` puts them after the argv, and `none` runs the argv with no file.
 */
export const PROBE_FILE_FORMS = closedNames('after-separator', 'as-arguments', 'none');

/** The report formats of an integration suite. `exit-code` reads only the exit code of the run. */
export const SUITE_REPORT_FORMATS = closedNames('exit-code', 'vitest-json');

/** The layers that a resolved term comes from, highest first. */
export const PROFILE_SOURCES = closedNames('config', 'toolchain-config', 'task-runner', 'detection');

/** The adapters of a boundary check. The adapter selects the report reader that the registry defines. */
export const BOUNDARY_ADAPTERS = closedNames('dependency-cruiser', 'semgrep-taint');

/** The one discriminant with which each gate names a term that the profile does not resolve. */
export const PROFILE_UNRESOLVED = 'profile-unresolved';

/** The maximum number of tokens in one argv. */
const MAX_ARGV_TOKENS = 64;

/** The maximum length of one reason. A longer reason does not fit the capsule. */
const MAX_REASON_LENGTH = 320;

/** The maximum number of globs or support segments in one term. */
const MAX_PATHS = 64;

/** The maximum number of red exit codes in one term. */
const MAX_EXIT_CODES = 16;

/** The maximum number of static-analysis checks. */
const MAX_CHECKS = 16;

/** The maximum number of toolchain ids in the provenance term. */
const MAX_TOOLCHAINS = 16;

/** The maximum number of boundary checks. */
const MAX_BOUNDARY_CHECKS = 4;

/**
 * One argv token in the safe-command class of `.exarchos.yml`. It holds no shell metacharacter and no control character.
 * The class is equal to `SAFE_COMMAND_REGEX` of `src/config/exarchos-config-schema.ts`.
 */
const ArgvTokenSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/, 'an argv token contains a disallowed shell metacharacter');

/**
 * A relative path or glob: no leading slash, no drive letter, no `..` segment and no control character.
 * It is a pattern, not a refinement, so the JSON Schema projection carries the same rule.
 */
const RelativePathSchema = z
  .string()
  .regex(
    /^(?![\\/])(?![A-Za-z]:)(?!(?:.*[\\/])?\.\.(?:[\\/]|$))[^\u0000-\u001f]+$/,
    'a path is relative and holds no ".." segment',
  );

/** One directory name that marks test support. It holds no separator, and it is not `.` or `..`. */
const SupportSegmentSchema = z
  .string()
  .regex(/^(?!\.\.?$)[^\\/\u0000-\u001f]+$/, 'a support segment is one directory name');

/** The name of one static-analysis check, such as `lint` or `typecheck`. */
const CheckNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'a check name starts with a letter or a digit and holds no space');

/** The layer of a resolved term. */
const ProfileSourceSchema = z.enum(PROFILE_SOURCES);

/** The reason of an unresolved term. It names the term and the key that resolves it. */
const ReasonSchema = z.string().min(1).max(MAX_REASON_LENGTH);

/** A term that the profile does not resolve. The gate that needs it fails closed with {@link PROFILE_UNRESOLVED}. */
const UnresolvedTermSchema = z
  .object({ state: z.literal('unresolved'), reason: ReasonSchema })
  .strict();

/** A resolved command: the argv that a gate spawns, with no shell and no later tokenizer. */
const ResolvedCommandSchema = z
  .object({
    state: z.literal('resolved'),
    argv: z.array(ArgvTokenSchema).min(1).max(MAX_ARGV_TOKENS),
    source: ProfileSourceSchema,
  })
  .strict();

/** A command term: a resolved argv, or an unresolved term with its reason. */
const CommandTermSchema = z.discriminatedUnion('state', [ResolvedCommandSchema, UnresolvedTermSchema]);

/** One list of globs, with at least one glob. */
const GlobListSchema = z.array(RelativePathSchema).min(1).max(MAX_PATHS);

/**
 * The exit codes that read as red. Each code is from 1 to 255, so exit 0 can never be red.
 * A code that is not 0 and not in the list gives no verdict.
 */
const FailureExitCodesSchema = z
  .object({
    codes: z.array(z.number().int().min(1).max(255)).min(1).max(MAX_EXIT_CODES),
    source: ProfileSourceSchema,
  })
  .strict();

/**
 * The globs that classify the changed files of a diff as tests. A configured empty list is an unresolved term.
 * `replacedSeeds` holds the test-name globs of the seeds that a configured list replaces.
 * It exists only in a root where more than one toolchain matches.
 */
const TestGlobsTermSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('resolved'),
      globs: GlobListSchema,
      source: ProfileSourceSchema,
      replacedSeeds: GlobListSchema.optional(),
    })
    .strict(),
  UnresolvedTermSchema,
]);

/** The directory names that mark test support. The probe does not revert a test-support file. */
const TestSupportTermSchema = z
  .object({
    segments: z.array(SupportSegmentSchema).max(MAX_PATHS),
    source: ProfileSourceSchema,
  })
  .strict();

/**
 * The command of the kill probe, the form in which it takes the test files, and its red exit codes.
 * `globs` names the test files that the command runs. A probe with no `globs` runs each file of the test globs.
 */
const ProbeTermSchema = z
  .object({
    command: CommandTermSchema,
    files: z.enum(PROBE_FILE_FORMS),
    failureExitCodes: FailureExitCodesSchema,
    globs: GlobListSchema.optional(),
  })
  .strict();

/** One static-analysis check: its name and its command. */
const StaticAnalysisCheckSchema = z
  .object({ name: CheckNameSchema, command: CommandTermSchema })
  .strict();

/** The static-analysis checks, run in their order. A profile with no check is an unresolved term. */
const StaticAnalysisTermSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('resolved'),
      checks: z.array(StaticAnalysisCheckSchema).min(1).max(MAX_CHECKS),
      source: ProfileSourceSchema,
    })
    .strict(),
  UnresolvedTermSchema,
]);

/** The command of the integration suite, the format of its report, and its red exit codes. */
const IntegrationTermSchema = z
  .object({
    command: CommandTermSchema,
    report: z.enum(SUITE_REPORT_FORMATS),
    failureExitCodes: FailureExitCodesSchema,
  })
  .strict();

/** The commands of contract drift. */
const ContractTermSchema = z
  .object({
    codegen: CommandTermSchema,
    diff: CommandTermSchema,
    typecheck: CommandTermSchema,
  })
  .strict();

/**
 * One boundary check. `command` is the argv that the leg runs before its scan roots.
 * `config` is the relative path of the config file of the adapter.
 */
const BoundaryCheckSchema = z
  .object({
    adapter: z.enum(BOUNDARY_ADAPTERS),
    command: ResolvedCommandSchema,
    config: RelativePathSchema,
  })
  .strict();

/** The `ownership.firstParty` globs. A resolved term with no glob gives the visible skip of the boundary check. */
const FirstPartyTermSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('resolved'),
      globs: z.array(RelativePathSchema).max(MAX_PATHS),
      source: ProfileSourceSchema,
    })
    .strict(),
  UnresolvedTermSchema,
]);

/**
 * The verification profile of one capsule. `toolchains` is provenance only, and no gate reads it.
 * Each other term is what a gate runs or classifies with.
 */
export const VerificationProfileSchema = z
  .object({
    toolchains: z.array(z.string().min(1)).max(MAX_TOOLCHAINS),
    tests: z
      .object({
        globs: TestGlobsTermSchema,
        support: TestSupportTermSchema,
        probe: ProbeTermSchema,
      })
      .strict(),
    staticAnalysis: StaticAnalysisTermSchema,
    integration: IntegrationTermSchema,
    contract: ContractTermSchema,
    boundaryChecks: z.array(BoundaryCheckSchema).max(MAX_BOUNDARY_CHECKS),
    firstParty: FirstPartyTermSchema,
  })
  .strict();

/** The verification profile, as {@link VerificationProfileSchema} parses it. */
export type VerificationProfile = z.infer<typeof VerificationProfileSchema>;

/** A pinned profile and the version of the capsule that pins it. It is the value of the dispatch context. */
export interface PinnedVerificationProfile {
  readonly capsuleVersion: number;
  readonly profile: VerificationProfile;
}
