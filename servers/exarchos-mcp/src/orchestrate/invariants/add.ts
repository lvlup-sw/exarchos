/**
 * `invariants_add` handler (P2, T8/T9/T11).
 *
 * Validates one authored entry against `InvariantEntryV3Schema` (including the
 * sandbox-safe `.strict()` enforcement DSL — INV-4), then either:
 *
 *   - `dryRun` (DEFAULT, INV-5c): renders the entry as YAML + a file diff and
 *     writes NOTHING; or
 *   - `dryRun:false`: auto-assigns the next free id in the target namespace
 *     (`U-N` for user tier, `INV-N` for dev), appends the entry to the target
 *     catalog's `invariants:` list, wires the catalog into `.exarchos.yml` if
 *     unregistered, and emits `invariant.authored` (+ `catalog.registered` on
 *     first registration — INV-1).
 *
 * A ZodError (or the `UnknownCheckKindError` thrown by the combinator-DSL
 * preprocess) is mapped to the INV-5b carrier shape
 * `{ validTargets, expectedShape, suggestedFix }` so the agent can self-correct.
 *
 * Pure-by-default: fs side effects flow through injected `ScaffoldDeps`.
 */
import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import { z } from 'zod';
import { parseDocument, stringify as stringifyYaml, isSeq } from 'yaml';
import type { YAMLSeq } from 'yaml';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import {
  InvariantEntryV3Schema,
  UnknownCheckKindError,
} from '../../architecture/invariant-schema.js';
// DR-6 — the catalog's primary-key rule has ONE authority, in the loader. The
// write path enforces the reader's predicate rather than a second copy of it.
import {
  findDuplicateInvariantId,
  duplicateInvariantIdMessage,
} from '../../architecture/invariants-loader.js';
// Catalog file shape + the resolvable-denominator id scan, shared with
// `invariants_amend` so the two writers cannot disagree about either.
import {
  splitCatalog,
  readCatalogIds,
  catalogUnreadableResult,
} from './catalog-file.js';
import type { ScaffoldDeps } from './scaffold.js';
import { wireCatalogRegistration } from './exarchos-yml-writer.js';
import { assertDevTierAllowed } from './reserved-tier-guard.js';

const CONFIG_FILENAME = '.exarchos.yml';
const NEXT_ACTIONS = ['doctor', 'view invariants_effective'] as const;

export interface HandleAddArgs {
  /** Repo root the catalog + `.exarchos.yml` resolve against. */
  readonly repoRoot: string;
  /** The authored entry (without an `id` — auto-assigned on commit). */
  readonly entry: Record<string, unknown>;
  /** Repo-relative path of the target catalog. Defaults per tier. */
  readonly catalog?: string | undefined;
  /** Target tier — drives namespace (`U-N` user, `INV-N` dev). Default user. */
  readonly tier?: 'dev' | 'user' | undefined;
  /** Explicit id override (rare — normally auto-assigned). */
  readonly id?: string | undefined;
  /** Dry-run (default true, INV-5c): render + diff, write nothing. */
  readonly dryRun?: boolean;
  /**
   * Opt-in to author into exarchos's reserved `dev` namespace from a non-exarchos
   * repo. Almost always a mistake outside the exarchos repo itself (#1489).
   */
  readonly allowReservedTier?: boolean | undefined;
}

const DEFAULT_PATH: Record<'dev' | 'user', string> = {
  user: '.exarchos/invariants.md',
  dev: '.exarchos/invariants.md',
};

const NAMESPACE_PREFIX: Record<'dev' | 'user', string> = {
  user: 'U',
  dev: 'INV',
};

/**
 * Allocate the next free id in a namespace. Scans `existingIds` for the
 * `${prefix}-${n}` form and returns `${prefix}-${max+1}` (1 when none exist).
 * Gaps are never reused — monotonic allocation keeps ids stable across edits.
 */
export function allocateNextId(existingIds: readonly string[], prefix: string): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `${prefix}-${max + 1}`;
}


/**
 * Append a validated entry to a catalog file's `invariants:` sequence,
 * preserving BOTH the markdown body AND the frontmatter's YAML comments.
 *
 * Catalog files come in two shapes:
 *
 *   (a) **markdown-with-frontmatter** — the dev catalog (`.exarchos/invariants.md`):
 *       `---\n<frontmatter>\n---\n<markdown body>`. Running `parseDocument` on
 *       the WHOLE file and `.toString()`-ing it throws ("Document with errors
 *       cannot be stringified") and would silently destroy the prose body, so
 *       we split off the frontmatter, mutate ONLY that document, then reassemble
 *       `---\n${doc}---\n${body}` with the body byte-for-byte unchanged.
 *
 *   (b) **bare-YAML** — a user could register a `.yml` catalog with no fences
 *       and no body. Here `parseDocument(contents).toString()` is correct (no
 *       body to lose), so we keep the original round-trip.
 *
 * Both shapes preserve comments by mutating a CST-backed `Document` rather than
 * going through `parse` + `stringify` (which discards comments).
 */
export function appendEntryToCatalog(
  contents: string,
  validated: unknown,
): string {
  const { frontmatter, body } = splitCatalog(contents);

  if (body !== undefined) {
    // Fenced markdown-with-frontmatter: mutate ONLY the frontmatter document
    // (the text BETWEEN the fences). This is the whole reason we use the
    // Document API rather than js-yaml — it preserves the frontmatter's
    // comments.
    const fmDoc = parseDocument(frontmatter);
    appendToInvariantsSeq(fmDoc, validated);
    // `fmDoc.toString()` already ends with a trailing newline, so the closing
    // fence lands on its own line. `body` is the verbatim post-fence text, so
    // we reproduce the original separation exactly (no added/dropped blanks).
    return `---\n${fmDoc.toString()}---\n${body}`;
  }

  // Bare-YAML catalog (no fences, no body) — the original parseDocument +
  // toString round-trip is correct here (nothing to lose).
  const doc = parseDocument(frontmatter);
  appendToInvariantsSeq(doc, validated);
  return doc.toString();
}

/**
 * Append `validated` to the `invariants:` sequence of `doc`, normalizing a
 * missing/null/non-sequence `invariants` node to an empty `YAMLSeq` first:
 * calling `.add` on a scalar/map node (e.g. a malformed `invariants: {}` or
 * `invariants: foo`) would throw a raw TypeError. Reset such a node to an empty
 * sequence so the append always lands on a real list (robustness — #1487
 * review).
 */
function appendToInvariantsSeq(doc: ReturnType<typeof parseDocument>, validated: unknown): void {
  let list = doc.get('invariants', true) as unknown;
  if (!isSeq(list)) {
    // `doc.set('invariants', [])` would store a plain JS array (no `.add`);
    // `createNode` yields a real YAMLSeq the append can land on.
    const seq = doc.createNode([]);
    doc.set('invariants', seq);
    list = doc.get('invariants', true) as unknown;
  }
  (list as YAMLSeq).add(validated);
}

/**
 * INV-5b carrier-shape refusal for a primary-key collision. Names the offending
 * id, the ids already in use, and points the agent at `invariants_amend` — the
 * verb that actually does what a caller re-using an existing id is usually
 * trying to do (task 068).
 */
function duplicateIdResult(
  id: string,
  relCatalog: string,
  tier: 'dev' | 'user',
  existingIds: readonly string[],
): ToolResult {
  return {
    success: false,
    error: {
      code: 'DUPLICATE_INVARIANT_ID',
      // The loader's own sentence — one message regardless of which path
      // (read or write) refused.
      message:
        `${duplicateInvariantIdMessage(id)}. Catalog '${relCatalog}' resolved ` +
        `${existingIds.length} existing entr${existingIds.length === 1 ? 'y' : 'ies'} ` +
        `and one already carries this id; appending a second would author a ` +
        `file the invariants loader refuses to read. To CHANGE the existing ` +
        `entry use invariants_amend; to add a NEW entry omit 'id' and let it ` +
        `be auto-assigned.`,
      expectedShape: {
        id: `an id not already in ${relCatalog}, or omit it entirely`,
      },
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: {
          action: 'invariants_amend',
          id,
          catalog: relCatalog,
          tier,
          note:
            'Amending edits the existing entry in place (identity and unnamed ' +
            'fields survive). To append a brand-new entry instead, re-run ' +
            "invariants_add without 'id'.",
        },
      },
    },
  };
}

/**
 * Map a validation failure (ZodError or UnknownCheckKindError) to the INV-5b
 * carrier shape so the agent can self-correct rather than re-guess.
 *
 * Shared with `invariants_amend`: an amendment is re-validated against the
 * SAME `InvariantEntryV3Schema`, so it must fail with the same carrier shape.
 * `action` is echoed into `suggestedFix.params.action` so the offered fix is
 * re-invokable against the verb the caller actually used.
 */
export function validationErrorResult(
  err: unknown,
  action: 'invariants_add' | 'invariants_amend' = 'invariants_add',
): ToolResult {
  if (err instanceof UnknownCheckKindError) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: err.message,
        expectedShape: {
          enforcement: {
            mode: 'check',
            check: { kind: 'grep | structural | heuristic', pattern: 'string' },
          },
        },
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action,
            note: "Use a known leaf kind (grep | structural | heuristic). The enforcement DSL is declarative-only (INV-4) — there is no shell/exec kind.",
          },
        },
      },
    };
  }

  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `Invariant entry failed validation: ${issues
          .map((i) => `${i.path || '(root)'}: ${i.message}`)
          .join('; ')}`,
        validTargets: issues.map((i) => i.path).filter((p) => p.length > 0),
        expectedShape: {
          dimension: 'string',
          axis: 'substrate | authoring',
          'cost-of-load': 'always-load | reference-only | archivable',
          'applies-to': ['glob'],
          summary: 'string',
          references: ['string'],
          enforcement:
            "{ mode: 'audit', 'audit-prompt': string } | { mode: 'check', check: <combinator-tree> }",
        },
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: {
            action,
            note: 'Correct the fields above and re-run with dryRun:true to preview.',
          },
        },
      },
    };
  }

  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

/**
 * `invariants_add` handler. See module header for the dry-run/commit contract.
 */
export async function handleAdd(
  args: HandleAddArgs,
  ctx: DispatchContext,
  deps: ScaffoldDeps,
): Promise<ToolResult> {
  const tier = args.tier ?? 'user';

  // Reject authoring into exarchos's reserved `dev` namespace from a consumer
  // repo BEFORE reading/validating anything, and regardless of dryRun — so a
  // dry-run preview never even renders a dev-tier entry (#1489).
  const reserved = assertDevTierAllowed(
    {
      tier,
      repoRoot: args.repoRoot,
      allowReservedTier: args.allowReservedTier,
      action: 'invariants_add',
    },
    deps,
  );
  if (reserved) return reserved;

  const relCatalog = args.catalog ?? DEFAULT_PATH[tier];
  const catalogAbs = toPosix(path.join(args.repoRoot, relCatalog));
  const dryRun = args.dryRun === undefined ? true : args.dryRun;

  // Read the target catalog (must exist — scaffold first if not).
  if (!deps.exists(catalogAbs)) {
    return {
      success: false,
      error: {
        code: 'CATALOG_NOT_FOUND',
        message: `Target catalog '${relCatalog}' does not exist. Run invariants_scaffold first to create it.`,
        suggestedFix: {
          tool: 'exarchos_orchestrate',
          params: { action: 'invariants_scaffold', path: relCatalog, tier },
        },
      },
    };
  }
  const catalogContents = deps.read(catalogAbs);

  // Resolve the ids already in use. This is the DENOMINATOR of the uniqueness
  // check below, so an unresolvable list is refused rather than treated as
  // "zero ids in use, therefore no collisions" (task 068 / DR-24).
  const scan = readCatalogIds(catalogContents);
  if (!scan.resolved) {
    return catalogUnreadableResult(relCatalog, tier, scan.reason);
  }
  const existingIds = scan.ids;

  // Allocate the id (or honor an explicit override) and validate the entry.
  const id = args.id ?? allocateNextId(existingIds, NAMESPACE_PREFIX[tier]);

  // Write-time primary-key enforcement, at least as strong as read-time.
  // `args.id` was previously honored with no membership test, so authoring an
  // id already in the catalog returned success and produced a file the loader
  // then refused to read. The predicate is the LOADER's own
  // (`findDuplicateInvariantId`), applied to the id list this write WOULD
  // produce — literally "would the reader reject the document I am about to
  // author?" — so reader and writer cannot disagree.
  const collision = findDuplicateInvariantId([...existingIds, id]);
  if (collision !== undefined) {
    return duplicateIdResult(collision, relCatalog, tier, existingIds);
  }

  let validated;
  try {
    validated = InvariantEntryV3Schema.parse({ ...args.entry, id });
  } catch (err) {
    return validationErrorResult(err);
  }

  // Render the validated entry as a YAML list fragment (one entry).
  const renderedEntry = stringifyYaml([validated]);

  if (dryRun) {
    const diff = renderDiff(relCatalog, renderedEntry);
    return {
      success: true,
      data: {
        committed: false,
        id,
        tier,
        catalog: relCatalog,
        renderedEntry,
        diff,
        next_actions: [...NEXT_ACTIONS],
      },
    };
  }

  // ── Commit path ──
  // Append the validated entry to the catalog's `invariants:` list. The catalog
  // may be a markdown-with-frontmatter file (the dev catalog has a prose body
  // that a naive whole-file parseDocument round-trip would destroy) or a bare
  // YAML file; `appendEntryToCatalog` handles both shapes while preserving the
  // body AND the frontmatter's YAML comments (#1487 review — HIGH).
  deps.write(catalogAbs, appendEntryToCatalog(catalogContents, validated));

  // Wire the catalog into `.exarchos.yml` if unregistered (INV-1 first-time
  // registration emits catalog.registered).
  const ymlPath = toPosix(path.join(args.repoRoot, CONFIG_FILENAME));
  const registration = wireCatalogRegistration(
    ymlPath,
    { path: relCatalog, tier },
    deps,
  );

  // Emit events (best-effort telemetry — never fail the authored write).
  const emitted: string[] = [];
  try {
    await ctx.eventStore.append(`invariants/${tier}`, {
      type: 'invariant.authored' as const,
      data: {
        id,
        catalog: relCatalog,
        tier,
        dimension: validated.dimension,
        mode: validated.enforcement?.mode,
      },
    });
    emitted.push('invariant.authored');

    if (registration.wrote) {
      await ctx.eventStore.append(`invariants/${tier}`, {
        type: 'catalog.registered' as const,
        data: { path: relCatalog, tier },
      });
      emitted.push('catalog.registered');
    }
  } catch {
    /* best-effort: the authored write already landed */
  }

  return {
    success: true,
    data: {
      committed: true,
      id,
      tier,
      catalog: relCatalog,
      registration,
      events: emitted,
      next_actions: [...NEXT_ACTIONS],
    },
  };
}

/**
 * Render a minimal append diff for the dry-run preview: the rendered entry
 * shown as added lines under the target catalog's `invariants:` list.
 */
function renderDiff(relCatalog: string, renderedEntry: string): string {
  const added = renderedEntry
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => `+${l}`)
    .join('\n');
  return `--- a/${relCatalog}\n+++ b/${relCatalog}\n@@ invariants: (append) @@\n${added}`;
}
