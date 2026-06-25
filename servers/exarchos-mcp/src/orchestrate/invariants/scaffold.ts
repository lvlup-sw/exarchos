/**
 * `invariants_scaffold` handler (P2, T6).
 *
 * Creates a v3-shaped starter invariant catalog file for a tier and
 * idempotently registers it in `.exarchos.yml`. Mirrors the
 * `seedExarchosConfig` contract:
 *
 *   - NEVER overwrites an existing catalog file (`reason: 'already-exists'`).
 *   - Idempotent `.exarchos.yml` registration (comment-preserving via the
 *     shared `wireCatalogRegistration` writer — see exarchos-yml-writer.ts).
 *   - Pure-by-default: all fs side effects flow through injected `ScaffoldDeps`
 *     hooks so the handler is exercisable without touching disk.
 *
 * The starter file is emitted with one COMMENTED worked-example entry so the
 * author un-comments and edits rather than facing a blank file. The example is
 * `mode: audit` (pure judgment, always portable — INV-6) and tier-namespaced
 * (`U-1` for user, `INV-1` for dev).
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';

import type { ToolResult } from '../../format.js';
import { wireCatalogRegistration } from './exarchos-yml-writer.js';
import type { YmlWriterDeps } from './exarchos-yml-writer.js';
import { assertDevTierAllowed } from './reserved-tier-guard.js';

const CONFIG_FILENAME = '.exarchos.yml';

/** Injected fs hooks (tests substitute in-memory implementations). */
export interface ScaffoldDeps {
  exists: (p: string) => boolean;
  read: (p: string) => string;
  write: (p: string, contents: string) => void;
}

export interface HandleScaffoldArgs {
  /** Repo root the target path + `.exarchos.yml` resolve against. */
  readonly repoRoot: string;
  /** Repo-relative path of the catalog file to create. Defaults per tier. */
  readonly path?: string;
  /** Privilege tier of the catalog. Defaults to `user`. */
  readonly tier?: 'dev' | 'user';
  /**
   * Opt-in to author into exarchos's reserved `dev` namespace from a non-exarchos
   * repo. Almost always a mistake outside the exarchos repo itself (#1489).
   */
  readonly allowReservedTier?: boolean;
}

/** Result of the catalog-file write step. */
export interface CatalogWriteResult {
  readonly wrote: boolean;
  readonly path: string;
  readonly reason: 'created' | 'already-exists';
}

/** Default repo-relative starter path per tier. */
const DEFAULT_PATH: Record<'dev' | 'user', string> = {
  user: '.exarchos/invariants.md',
  dev: '.exarchos/invariants.md',
};

/**
 * Build the v3-shaped starter catalog body. The body is wrapped in a proper
 * YAML frontmatter block (`---` … `---`) so `loadInvariants` (which parses via
 * `gray-matter`) can read it. The frontmatter declares `schema-version: 3` and
 * a valid-but-empty `invariants: []` list; the single worked example is left
 * commented out so the file parses cleanly until the author opts in by
 * un-commenting + editing.
 *
 * gray-matter only recognises a frontmatter block when the opening `---` is the
 * very first line of the file, so the human-guidance comments live INSIDE the
 * frontmatter as YAML comments (lines beginning with `#`) — they are ignored by
 * the YAML parser but stay visible to the author editing the file.
 */
export function renderStarterCatalog(tier: 'dev' | 'user'): string {
  const exampleId = tier === 'dev' ? 'INV-1' : 'U-1';
  return `---
# Invariant catalog (${tier} tier) — authored via \`exarchos invariants scaffold\`.
#
# Each entry expresses one architectural rule. Author new entries with
# \`exarchos invariants add\` (validates the entry shape before writing), or
# un-comment + edit the worked example below. Validate the resolved catalog
# with \`exarchos doctor\` (invariants-catalog check) and inspect it with the
# \`invariants_effective\` view. Authoring guide:
# docs/guides/authoring-invariants.md.
#
# Consumers always use the \`user\` tier (\`U-N\` ids) — this catalog is your
# project's own. The \`dev\` tier (\`INV-N\`) is exarchos-internal: it is
# exarchos's own reserved substrate namespace and collides with its built-in
# \`INV-*\` if reused from a consumer repo.
#
# Worked example (un-comment to start). \`mode: audit\` is pure judgment — an
# LLM evaluates the prompt against the diff; always portable (INV-6). For a
# declarative grep/structural check, use \`mode: check\` with a combinator tree
# (see the authoring guide).
schema-version: 3
invariants: []
#   - id: ${exampleId}
#     dimension: example-dimension
#     axis: authoring
#     cost-of-load: reference-only
#     applies-to:
#       - "src/**/*.ts"
#     summary: One-sentence statement of the rule this invariant enforces.
#     references:
#       - docs/architecture/some-design.md
#     severity:
#       default: advisory
#     integrity-class: ${tier}
#     enforcement:
#       mode: audit
#       audit-prompt: >-
#         Does the diff violate <the rule>? Cite the offending file + line.
---
`;
}

/**
 * Resolve the catalog target path from args, applying the per-tier default
 * when `path` is omitted.
 */
function resolveTargetPath(args: HandleScaffoldArgs): { tier: 'dev' | 'user'; relPath: string } {
  const tier = args.tier ?? 'user';
  const relPath = args.path ?? DEFAULT_PATH[tier];
  return { tier, relPath };
}

/**
 * Write the starter catalog file if absent. Idempotent: an existing file is
 * never overwritten (`reason: 'already-exists'`).
 */
function writeStarterCatalog(
  absPath: string,
  tier: 'dev' | 'user',
  deps: ScaffoldDeps,
): CatalogWriteResult {
  if (deps.exists(absPath)) {
    return { wrote: false, path: absPath, reason: 'already-exists' };
  }
  deps.write(absPath, renderStarterCatalog(tier));
  return { wrote: true, path: absPath, reason: 'created' };
}

/**
 * `invariants_scaffold` handler. Creates the starter catalog and registers it
 * in `.exarchos.yml`, returning a structured envelope with `next_actions`
 * (INV-12: `doctor`, `view invariants_effective`).
 */
export async function handleScaffold(
  args: HandleScaffoldArgs,
  deps: ScaffoldDeps,
): Promise<ToolResult> {
  const { tier, relPath } = resolveTargetPath(args);

  // Reject authoring into exarchos's reserved `dev` namespace from a consumer
  // repo BEFORE any fs write (#1489). Redirects to `tier: user`.
  const reserved = assertDevTierAllowed(
    {
      tier,
      repoRoot: args.repoRoot,
      allowReservedTier: args.allowReservedTier,
      action: 'invariants_scaffold',
    },
    deps,
  );
  if (reserved) return reserved;

  const catalogAbs = toPosix(path.join(args.repoRoot, relPath));

  const catalog = writeStarterCatalog(catalogAbs, tier, deps);

  // Reuse the shared comment-preserving `.exarchos.yml` writer.
  const ymlPath = toPosix(path.join(args.repoRoot, CONFIG_FILENAME));
  const ymlDeps: YmlWriterDeps = {
    exists: deps.exists,
    read: deps.read,
    write: deps.write,
  };
  const registration = wireCatalogRegistration(
    ymlPath,
    { path: relPath, tier },
    ymlDeps,
  );

  return {
    success: true,
    data: {
      catalog,
      registration,
      tier,
      next_actions: ['doctor', 'view invariants_effective'],
    },
  };
}
