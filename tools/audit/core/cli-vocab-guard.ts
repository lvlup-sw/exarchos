// `cli:vocab-guard`: a CI gate against CLI vocabulary drift, the CLI sibling of
// `npm run skills:guard`. A gate, not code review, enforces vocabulary consistency.
//
// It walks the Commander tree that `buildCli(ctx)` builds. Flags come from each action's Zod
// schema, from explicit `.option(...)` calls, and from registry `cli.alias` and `cli.flags`
// aliases. The built tree is the one place where they all meet. A text grep over the source
// gives false positives on doc comments and on the internal `format` field.
//
// It checks each command name, command alias and long flag against the banned set. It prints
// every violation with its command path and canonical replacement, and returns exit 1.
//
// It runs under Bun, because `buildCli` pulls in `bun:sqlite`. That module resolves only under
// Bun or the Vitest alias shim.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCli } from '../../../src/adapters/cli/cli.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { Command } from 'commander';

/** A banned verb (command name or command alias) → its canonical replacement + rationale. */
interface BannedVerb {
  readonly token: string;
  readonly canonical: string;
  readonly rationale: string;
}

/** A banned flag (long option) → its canonical replacement + rationale. */
interface BannedFlag {
  readonly token: string;
  readonly canonical: string;
  readonly rationale: string;
}

/**
 * Banned command names and aliases. Use `get` and not `info`, `list` and not `ls`, and one
 * explicit destructive action in place of `rm`, `del` or `remove`.
 */
const BANNED_VERBS: readonly BannedVerb[] = [
  {
    token: 'info',
    canonical: 'get',
    rationale: 'Cloudflare vocabulary rule: read a single resource with `get`, not `info`.',
  },
  {
    token: 'ls',
    canonical: 'list',
    rationale: 'Cloudflare vocabulary rule: enumerate resources with `list`, not the terse shell alias `ls`.',
  },
  {
    token: 'rm',
    canonical: 'delete (explicit composite action)',
    rationale: 'Destructive actions are explicit, non-interactive composite actions — never a terse `rm` shell alias.',
  },
  {
    token: 'del',
    canonical: 'delete (explicit composite action)',
    rationale: 'Destructive actions are explicit, non-interactive composite actions — never a terse `del` shell alias.',
  },
  {
    token: 'remove',
    canonical: 'delete (explicit composite action)',
    rationale: 'Use one canonical destructive verb; avoid `remove`/`del`/`rm` synonyms that fragment the vocabulary.',
  },
] as const;

/**
 * Banned long flags. Use `--json` and not `--format` or `--output`. Use `--force` and not a
 * `--skip-confirmation*` or `--skip-prompt*` flag.
 */
const BANNED_FLAGS: readonly BannedFlag[] = [
  {
    token: '--format',
    canonical: '--json',
    rationale:
      'Cloudflare vocabulary rule: select machine-readable output with the canonical `--json` flag, not a redundant `--format=json` carrier.',
  },
  {
    token: '--output',
    canonical: '--json',
    rationale: 'Output-carrier selection is `--json`; avoid `--output`/`--format` aliases for the JSON contract.',
  },
  {
    token: '--skip-confirmation',
    canonical: '--force',
    rationale: 'Cloudflare vocabulary rule: bypass a guard with `--force`, not a `--skip-confirmation*` alias.',
  },
  {
    token: '--skip-confirmations',
    canonical: '--force',
    rationale: 'Cloudflare vocabulary rule: bypass a guard with `--force`, not a `--skip-confirmation*` alias.',
  },
  {
    token: '--skip-prompt',
    canonical: '--force',
    rationale: 'Cloudflare vocabulary rule: bypass a guard with `--force`, not a `--skip-prompt*` alias.',
  },
  {
    token: '--skip-prompts',
    canonical: '--force',
    rationale: 'Cloudflare vocabulary rule: bypass a guard with `--force`, not a `--skip-prompt*` alias.',
  },
] as const;

/**
 * Banned tokens that the rendered surface keeps, keyed by `<command-path>::<token>`.
 * The same token on any other command still fails.
 *
 * `vw ls` is the noun-shaped alias of the pipeline action. It is debt to rename to `list`.
 * `doctor` and `onboard` emit `--format <table|json>` from a `format` schema field that their
 * parity tests pin. It is debt to fold into `--json`.
 * `vw export --output` and `export --output` take a destination file path, not an output
 * format, so they are not debt. The guard sees only the token string.
 */
const KNOWN_EXCEPTIONS: ReadonlySet<string> = new Set([
  'exarchos vw ls::ls',
  'exarchos doctor::--format',
  'exarchos onboard::--format',
  'exarchos orch doctor::--format',
  'exarchos orch onboard::--format',
  'exarchos vw export::--output',
  'exarchos export::--output',
]);

export interface SurfaceVerb {
  /** Full command path, for example `exarchos vw ls`. */
  readonly path: string;
  /** The token under test (command name OR a single alias). */
  readonly token: string;
}

export interface SurfaceFlag {
  /** Full command path that declares the flag. */
  readonly path: string;
  /** The long-flag token, for example `--format`. */
  readonly token: string;
}

export interface CliSurface {
  readonly verbs: readonly SurfaceVerb[];
  readonly flags: readonly SurfaceFlag[];
}

/**
 * Walks a built Commander program and collects each command name, command alias and long
 * flag as a `{path, token}` record. It skips the root name, because `exarchos` is not a verb.
 */
export function extractCliSurface(program: Command): CliSurface {
  const verbs: SurfaceVerb[] = [];
  const flags: SurfaceFlag[] = [];

  const walk = (cmd: Command, prefix: string): void => {
    const name = cmd.name();
    const path = prefix ? `${prefix} ${name}` : name;

    if (prefix) {
      verbs.push({ path, token: name });
    }
    for (const alias of cmd.aliases()) {
      verbs.push({ path: `${prefix} ${alias}`.trim(), token: alias });
    }
    for (const opt of cmd.options) {
      if (opt.long) {
        flags.push({ path, token: opt.long });
      }
    }
    for (const sub of cmd.commands) {
      walk(sub, path);
    }
  };

  walk(program, '');
  return { verbs, flags };
}

export interface VocabViolation {
  readonly kind: 'verb' | 'flag';
  readonly path: string;
  readonly token: string;
  readonly canonical: string;
  readonly rationale: string;
}

const BANNED_VERB_MAP = new Map(BANNED_VERBS.map((b) => [b.token, b]));
const BANNED_FLAG_MAP = new Map(BANNED_FLAGS.map((b) => [b.token, b]));

/** Returns every banned token in `surface` whose `<path>::<token>` key is not in `exceptions`. */
export function findVocabViolations(
  surface: CliSurface,
  exceptions: ReadonlySet<string> = KNOWN_EXCEPTIONS,
): VocabViolation[] {
  const violations: VocabViolation[] = [];

  for (const { path, token } of surface.verbs) {
    const banned = BANNED_VERB_MAP.get(token);
    if (banned && !exceptions.has(`${path}::${token}`)) {
      violations.push({
        kind: 'verb',
        path,
        token,
        canonical: banned.canonical,
        rationale: banned.rationale,
      });
    }
  }

  for (const { path, token } of surface.flags) {
    const banned = BANNED_FLAG_MAP.get(token);
    if (banned && !exceptions.has(`${path}::${token}`)) {
      violations.push({
        kind: 'flag',
        path,
        token,
        canonical: banned.canonical,
        rationale: banned.rationale,
      });
    }
  }

  return violations;
}

/**
 * Builds the live CLI surface and returns its violations. Command-tree construction does
 * no backend work, so a minimal dispatch context is enough.
 */
export function findLiveCliViolations(): VocabViolation[] {
  const ctx: DispatchContext = {
    stateDir: '/tmp/exarchos-vocab-guard',
    eventStore: {} as DispatchContext['eventStore'],
    enableTelemetry: false,
  };
  const program = buildCli(ctx);
  return findVocabViolations(extractCliSurface(program));
}

function formatViolation(v: VocabViolation): string {
  return [
    `  ✗ [${v.kind}] \`${v.token}\` at \`${v.path}\``,
    `      use \`${v.canonical}\` instead — ${v.rationale}`,
  ].join('\n');
}

export function runGuard(): number {
  const violations = findLiveCliViolations();
  if (violations.length === 0) {
    process.stdout.write('cli:vocab-guard — OK (CLI surface uses canonical vocabulary)\n');
    return 0;
  }
  process.stderr.write(
    `cli:vocab-guard — ${violations.length} banned CLI vocabulary token(s) found:\n`,
  );
  for (const v of violations) {
    process.stderr.write(`${formatViolation(v)}\n`);
  }
  process.stderr.write(
    '\nVocabulary is enforced mechanically (R-A / Principle 6). Rename the token to its\n' +
      'canonical form, or — if this is tracked legacy surface debt — add it to\n' +
      'KNOWN_EXCEPTIONS in scripts/cli-vocab-guard.ts with a follow-up reference.\n',
  );
  return 1;
}

/**
 * An absolute path with symlinks resolved where possible. For a path that does not exist,
 * it returns the plain resolved path, so an odd `argv[1]` reads as not the entry point.
 */
function canonicalPath(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * True when this module is the process entry point. It compares resolved paths, not a filename,
 * so a rename cannot leave a CI step that prints nothing and exits 0. Under Bun, `argv[1]` is the
 * absolute realpath, and `import.meta.url` is the same path.
 * `entrypoint-predicates.selftest.test.ts` measures this. Node keeps a symlink in `argv[1]`,
 * so {@link canonicalPath} resolves both sides.
 *
 * The guard sets `process.exitCode`, because `process.exit` can cut stdout before it drains.
 */
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exitCode = runGuard();
}
