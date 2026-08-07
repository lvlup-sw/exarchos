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
 * Split a catalog file into its YAML frontmatter and (optional) markdown body.
 *
 * Catalog files are EITHER markdown-with-frontmatter (`---\n<yaml>\n---\n<body>`
 * — the dev catalog) OR bare YAML (no fences, no body — a user could register a
 * `.yml`). We do the split ourselves rather than via gray-matter's `.matter`
 * field: gray-matter v4 caches by input string and only populates `.matter` on
 * the FIRST parse of a given string, returning `undefined` for it on a cache
 * hit. Both `readExistingIds` and `appendEntryToCatalog` parse the same file
 * contents, so depending on `.matter` is a latent crash. A direct fence scan is
 * deterministic and cache-free.
 *
 * Returns `{ frontmatter, body }` where `body` is `undefined` for the bare-YAML
 * shape (no fences) and the verbatim post-fence text (including its leading
 * newline) for the fenced shape.
 */
function splitCatalog(contents: string): {
  frontmatter: string;
  body: string | undefined;
} {
  // Frontmatter must open at the very start with a `---` line. Match the
  // opening fence, the frontmatter block, the closing `---` line, then the rest.
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(
    contents,
  );
  if (match) {
    return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
  }
  return { frontmatter: contents, body: undefined };
}

/**
 * Outcome of scanning a catalog for the ids already in use.
 *
 * The discriminant is the point. The previous `readExistingIds` returned a bare
 * `string[]` and collapsed EVERY failure — absent `invariants:` key, a renamed
 * key, a null/map/scalar node, an entry with no readable id — into `[]`. An
 * empty id list is indistinguishable from "no collisions", so a moved or
 * renamed catalog read as a clean uniqueness check and every id looked free.
 * That is a vacuous denominator, and a uniqueness guard resting on one proves
 * nothing (task 068 / DR-24).
 *
 * `resolved: true` with `ids: []` is a DIFFERENT and legitimate state: a
 * freshly scaffolded catalog really is `invariants: []`. The tooth is
 * resolvability, not cardinality — making zero entries fatal outright would
 * make it impossible to author a catalog's first entry.
 */
export type CatalogIdScan =
  | { readonly resolved: true; readonly ids: readonly string[] }
  | { readonly resolved: false; readonly reason: string };

/**
 * Read the ids already in use in a catalog file's `invariants:` list.
 *
 * Fail-closed: resolves ONLY when the frontmatter parses, `invariants` is
 * present AND is a sequence, and every element carries a string `id`. Anything
 * else is unresolved — we cannot prove an id is free against entries we could
 * not read.
 */
export function readCatalogIds(catalogContents: string): CatalogIdScan {
  const { frontmatter } = splitCatalog(catalogContents);

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(frontmatter);
  } catch (err) {
    return {
      resolved: false,
      reason: `catalog frontmatter did not parse as YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (doc.errors.length > 0) {
    return {
      resolved: false,
      reason: `catalog frontmatter did not parse as YAML: ${doc.errors[0]?.message ?? 'unknown error'}`,
    };
  }

  const list = doc.get('invariants', true) as unknown;
  if (list === undefined || list === null) {
    return {
      resolved: false,
      reason:
        "catalog has no readable 'invariants:' list — the key is absent, null, or renamed. " +
        'A uniqueness check cannot run against entries it could not resolve.',
    };
  }
  if (!isSeq(list)) {
    return {
      resolved: false,
      reason:
        "catalog's 'invariants:' is not a YAML sequence. A uniqueness check " +
        'cannot run against entries it could not resolve.',
    };
  }

  const raw = list.toJSON() as unknown;
  if (!Array.isArray(raw)) {
    return {
      resolved: false,
      reason: "catalog's 'invariants:' did not project to an array",
    };
  }

  const ids: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return {
        resolved: false,
        reason: `catalog entry at index ${index} is not an object — its id cannot be read`,
      };
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      return {
        resolved: false,
        reason: `catalog entry at index ${index} carries no readable string id — a uniqueness check against it would be vacuous`,
      };
    }
    ids.push(id);
  }

  return { resolved: true, ids };
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
 * INV-5b carrier-shape refusal for a catalog whose id list did not RESOLVE.
 * Shared by `invariants_add` and `invariants_amend`: neither may proceed on a
 * denominator it could not read (task 068 / DR-24).
 */
function catalogUnreadableResult(
  relCatalog: string,
  tier: 'dev' | 'user',
  reason: string,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'CATALOG_UNREADABLE',
      message:
        `Cannot resolve the existing entries of catalog '${relCatalog}': ${reason} ` +
        `Refusing to write: an unresolved entry list would make the id-uniqueness ` +
        `check vacuous, so a moved or renamed catalog would read as "no collisions".`,
      expectedShape: {
        invariants: '[ { id: string, ... } ]  # a YAML sequence of entries',
      },
      suggestedFix: {
        tool: 'exarchos_orchestrate',
        params: {
          action: 'doctor',
          note:
            `Check that '${relCatalog}' is the intended catalog and that its ` +
            "frontmatter declares an 'invariants:' sequence whose entries each " +
            'carry a string id. Run invariants_scaffold to create a fresh one.',
          tier,
        },
      },
    },
  };
}

/**
 * Map a validation failure (ZodError or UnknownCheckKindError) to the INV-5b
 * carrier shape so the agent can self-correct rather than re-guess.
 */
function validationErrorResult(err: unknown): ToolResult {
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
            action: 'invariants_add',
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
            action: 'invariants_add',
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
