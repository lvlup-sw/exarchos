// servers/exarchos-mcp/scripts/cli-vocab-guard.ts
//
// `cli:vocab-guard` — mechanical CI gate against CLI vocabulary drift (T4 / #1317).
//
// WHY THIS EXISTS
// ───────────────
// Per the Trevin Chow "agent-native CLI" evaluation, section R-A / Principle 6
// (`docs/research/2026-05-08-trevin-agent-native-cli-evaluation.md`) and
// Cloudflare's Wrangler rebuild: cross-CLI vocabulary consistency must be
// enforced **mechanically by a gate, not by code review** — "manually enforcing
// consistency through reviews is Swiss cheese." This guard is the CLI sibling of
// `npm run skills:guard` (which fails CI on skill-vocabulary drift).
//
// HOW IT WORKS
// ────────────
// It walks the *actual rendered Commander surface* produced by `buildCli(ctx)` —
// not a hand-maintained list, and not a raw text grep over source (which
// false-positives on doc comments and the internal `format` presentation field).
// Exarchos flags are schema-driven: they auto-emit from each action's Zod schema
// via `addFlagsFromSchema` in `schema-to-flags.ts`, plus explicit `.option(...)`
// calls and registry `cli.alias` / `cli.flags` aliases. Walking the built tree is
// the one place all of those converge into the surface an agent actually sees.
//
// It then checks every command name, command alias, and long flag against the
// banned set below and exits non-zero on the first violation, printing the
// offending token, its command path, and the canonical replacement.
//
// The guard is intentionally a `bun run` script (not a zero-dep node `.mjs` like
// the `grep-gates` scripts) because resolving `buildCli` pulls in `bun:sqlite`
// transitively — that virtual module resolves only under Bun (the compiled
// binary's runtime) or Vitest's alias shim. Bun is already a CI dependency in the
// MCP jobs, so `bun run scripts/cli-vocab-guard.ts` is the natural invocation.

import { buildCli } from '../src/adapters/cli.js';
import type { DispatchContext } from '../src/core/dispatch.js';
import type { Command } from 'commander';

// ─── Canonical vocabulary (R-A / Principle 6) ────────────────────────────────
//
// The contract these bans protect, sourced from the research doc's
// "Cloudflare's banned-vocabulary list" table:
//   - `get`  not `info`                      (read a single resource)
//   - `list` not `ls`                        (enumerate resources)
//   - `--force` not `--skip-confirmations`   (bypass a destructive prompt)
//   - `--json` not `--format=json`           (select machine-readable output)
// plus the obvious destructive-verb anti-aliases (`rm`/`del`/`remove`) that an
// agent-native CLI surfaces as explicit composite actions, never as terse shells.

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

// ─── Known, tracked exceptions (legacy surface debt) ──────────────────────────
//
// Two banned tokens are already present on the rendered surface and are woven
// through parity contracts and pinning tests, so they cannot be excised within
// the scope of T4 (#1317) without a sprawling CLI rewrite. They are excepted
// here — keyed by their exact `<command-path>::<token>` so the exception is
// surgical: any *new* `ls`/`--format` drift to a different command still fails.
// Each exception names a follow-up so the debt is visible, not silently blessed.
//
//   1. `exarchos vw ls`     — pipeline action's INV-5c noun-shaped alias. The
//      research doc (Principle 6) flags this as an intentional gray area:
//      "`list` not `ls` — varies; ... noun-shaped per INV-5c (Aspire verbs),
//      which is intentional." Tracked for rename to `list` as a follow-up.
//   2. `exarchos doctor --format`, `exarchos onboard --format` — these commands
//      auto-emit `--format <table|json>` from their handler's `format` schema
//      field, alongside the canonical `--json`. The `format` field is load-
//      bearing in HandleDoctorArgs/HandleOnboardArgs and their parity tests.
//      Tracked for collapse onto `--json` as a follow-up.
const KNOWN_EXCEPTIONS: ReadonlySet<string> = new Set([
  'exarchos vw ls::ls',
  'exarchos doctor::--format',
  'exarchos onboard::--format',
  'exarchos orch doctor::--format',
  'exarchos orch onboard::--format',
]);

// ─── Surface extraction ───────────────────────────────────────────────────────

export interface SurfaceVerb {
  /** Full command path, e.g. `exarchos vw ls`. */
  readonly path: string;
  /** The token under test (command name OR a single alias). */
  readonly token: string;
}

export interface SurfaceFlag {
  /** Full command path that declares the flag. */
  readonly path: string;
  /** The long-flag token, e.g. `--format`. */
  readonly token: string;
}

export interface CliSurface {
  readonly verbs: readonly SurfaceVerb[];
  readonly flags: readonly SurfaceFlag[];
}

/**
 * Walk a built Commander program and collect every command name, command alias,
 * and long flag as `{path, token}` records. Exported for testability.
 */
export function extractCliSurface(program: Command): CliSurface {
  const verbs: SurfaceVerb[] = [];
  const flags: SurfaceFlag[] = [];

  const walk = (cmd: Command, prefix: string): void => {
    const name = cmd.name();
    const path = prefix ? `${prefix} ${name}` : name;

    // Command name itself (skip the program root — `exarchos` is not a verb).
    if (prefix) {
      verbs.push({ path, token: name });
    }
    // Aliases (e.g. `wf` → `workflow`).
    for (const alias of cmd.aliases()) {
      verbs.push({ path: `${prefix} ${alias}`.trim(), token: alias });
    }
    // Long flags.
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

// ─── Violation detection ──────────────────────────────────────────────────────

export interface VocabViolation {
  readonly kind: 'verb' | 'flag';
  readonly path: string;
  readonly token: string;
  readonly canonical: string;
  readonly rationale: string;
}

const BANNED_VERB_MAP = new Map(BANNED_VERBS.map((b) => [b.token, b]));
const BANNED_FLAG_MAP = new Map(BANNED_FLAGS.map((b) => [b.token, b]));

/**
 * Given an extracted surface, return every banned-token violation that is not a
 * tracked exception. Pure — exported so the test can drive it directly.
 */
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
 * Build the live CLI surface and return its violations. Wraps `buildCli` with a
 * minimal dispatch context (no backend work happens during command-tree
 * construction). Exported so the test can assert the live tree is clean.
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

// ─── CLI entrypoint ────────────────────────────────────────────────────────────

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

// Only run when executed directly (not when imported by the test).
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('cli-vocab-guard.ts') ||
    process.argv[1].endsWith('cli-vocab-guard.js'));

if (isDirectRun) {
  process.exit(runGuard());
}
