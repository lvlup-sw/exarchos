/**
 * Single core function that materializes the *effective* invariant catalog
 * for a given SDLC context (DR-7).
 *
 * The effective catalog is the merged + override-clamped + projected view of
 * every invariant layer (dev / sdlc / user) relevant to one `(phase,
 * workflowType, touchedFiles)` key. It is exposed by exactly ONE core
 * function so that the two facades that surface it produce a byte-identical
 * payload (INV-2):
 *
 *   - NOW: a CLI / `exarchos_view` export verb (INV-5c) — see
 *     `views/effective-catalog.ts` and the `invariants_effective` view action.
 *   - LATER: an MCP Resource (`resources/exarchos-invariants/effective`) once
 *     #1275 lands. Until then the facade simply re-exposes this function's
 *     output; see the SEAM comment at the view facade.
 *
 * Pure composition (INV-1): no caching, no mutable state. Every call re-loads
 * and re-folds from source so the payload can never drift from the catalog
 * files or `.exarchos.yml`.
 *
 * ## Pipeline
 *
 *   load every registered file source (`resolveCatalogSources` — collapses the
 *     former hardcoded dev catalog + the user `catalogs` list into one
 *     tier-tagged loop; `devCatalog: 'enabled'` desugars to a `tier: dev`
 *     source)
 *     + sdlc layer (default-on, plugin-shipped SDLC-* baseline — #1467;
 *       compiled into the binary, no gate, no file-IO)
 *   → mergeCatalogs (tags each layer's integrity-class)
 *   → applyOverrides (clamp each override to its invariant's floor)
 *   → drop honored-disabled entries (the final filter — see note below)
 *   → projectCatalog (filter to the (phase, workflowType, touchedFiles) key)
 *
 * ### Honored-disable filter
 *
 * `applyOverrides` does NOT itself drop entries whose `enabled:false`
 * override is honored — for a `disable`/`none` floor it leaves the entry in
 * place and relies on the caller to apply the final filter. This function IS
 * that caller: it drops an entry when its resolved override is `enabled:false`
 * AND its floor permits a full disable (`disable` | `none`). Entries whose
 * floor is `advisory`/`immutable` are NOT dropped — `applyOverrides` already
 * clamped (advisory) or ignored (immutable) the disable, so they stay.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExarchosConfigInput } from '../config/exarchos-config-schema.js';
import { loadInvariants, type InvariantEntry } from './invariants-loader.js';
import { loadSdlcCatalog } from './sdlc-catalog.js';
import { resolveCatalogSources } from './catalog-sources.js';
import {
  mergeCatalogs,
  applyOverrides,
  resolveFloor,
  isReservedUserId,
  type InvariantOverride,
} from './catalog-merge.js';
import { projectCatalog } from './project-catalog.js';

/** Context for resolving the effective catalog (DR-7). */
export interface ResolveEffectiveCatalogContext {
  /**
   * Repository root. The built-in dev catalog is read from
   * `<repoRoot>/.exarchos/invariants.md`. Defaults to the repo root
   * derived from this module's location (four levels up from
   * `src/architecture/`), mirroring `vocabulary-lint.ts`.
   */
  repoRoot?: string | undefined;
  /**
   * Resolved `.exarchos.yml` config. Drives which catalogs are registered
   * (`invariants.catalogs`, tier-tagged) and the per-invariant `overrides`.
   * When omitted, nothing is registered, so no dev or user catalog is
   * surfaced and there are no overrides.
   */
  config?: ExarchosConfigInput | undefined;
  /** SDLC phase to project for — e.g. `'ideate' | 'plan' | 'delegate'`. */
  phase: string;
  /** Workflow kind to project for — e.g. `'feature' | 'debug' | 'discovery'`. */
  workflowType: string;
  /** Files the current task touches (delegate-phase projection narrowing). */
  touchedFiles?: string[] | undefined;
}

/** Result of `resolveEffectiveCatalog`: projected entries plus merge/override warnings. */
export interface ResolveEffectiveCatalogResult {
  entries: InvariantEntry[];
  warnings: string[];
}

/**
 * Resolve the repository root from this module's location.
 *
 * `src/architecture/resolve-effective-catalog.ts` → repo root is four
 * levels up (mirrors `vocabulary-lint.ts`).
 */
function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..');
}

/**
 * Materialize the effective invariant catalog for one SDLC context (DR-7).
 *
 * Pure composition — see the module header for the pipeline and the
 * honored-disable filter contract.
 */
export function resolveEffectiveCatalog(
  ctx: ResolveEffectiveCatalogContext,
): ResolveEffectiveCatalogResult {
  const repoRoot = ctx.repoRoot ?? defaultRepoRoot();
  const config = ctx.config;

  // Degradation log for the EXTERNAL layers (dev catalog on disk, consumer
  // `catalogs`). A load/parse failure in those is folded here (never thrown)
  // so the gate, the view facade, and any future Resource degrade uniformly
  // and surface the failure loudly as an advisory rather than aborting the
  // whole resolution (INV-1 / DR-9). The built-in sdlc layer is compiled-in and
  // validated at build time, so it deliberately fails fast at module load
  // instead (see Layer 2).
  const loadWarnings: string[] = [];

  // ── Layers 1 + 3 collapsed: registered file sources, tagged by tier ──
  //
  // The dev catalog is no longer a hardcoded-path special case, and no longer
  // a boolean special case either (DR-31): it is just another registered
  // source, discovered by `resolveCatalogSources` and tagged `tier: 'dev'`.
  // User catalogs are tagged `tier: 'user'`. Both load through the SAME
  // `loadInvariants` path, and we hand that loader the caller's REAL config
  // plus the root we resolved registrations against — so its own
  // registration gate re-derives the same answer from the same authority.
  //
  // What used to be here: a synthesized `{ invariants: { devCatalog:
  // 'enabled' } }` passed in place of the real config, purely to satisfy the
  // loader's retired boolean gate for every source. That was DR-31 site 3 —
  // a bypass that made the loader's gate unobservable through this path.
  // Registration IS the opt-in now, so there is nothing to defeat.
  //
  // DR-9 degradation is uniform across both tiers: a missing or malformed
  // source folds into `loadWarnings` (naming the offending file) and the
  // remaining layers proceed. The reserved-namespace pre-filter is keyed off
  // the source `tier` — a `dev`-tier source legitimately carries `INV-*` ids;
  // a `user`-tier source claiming `INV-*` / `SDLC-*` is dropped per-entry with
  // a warning rather than aborting the whole resolution.
  const sources = resolveCatalogSources(config);
  const dev: InvariantEntry[] = [];
  const user: InvariantEntry[] = [];
  for (const source of sources) {
    const layerLabel = source.tier === 'dev' ? 'Dev' : 'User';
    const resolved = path.isAbsolute(source.path)
      ? source.path
      : path.join(repoRoot, source.path);
    // A configured-but-missing path is almost always a typo or a rename; a
    // silent skip would invisibly disable the intended checks. Warn (naming
    // the path) and degrade like any other DR-9 skip.
    if (!fs.existsSync(resolved)) {
      loadWarnings.push(
        `${layerLabel} invariant catalog '${source.path}' was not found at ` +
          `'${resolved}' and was skipped; evaluated remaining layers only.`,
      );
      continue;
    }
    let loaded: InvariantEntry[];
    try {
      // `config ?? {}` — never let an absent config fall through to the
      // loader's disk walk-up. The loop only runs for sources that came from
      // this same config, so an undefined config yields no sources at all;
      // pinning `{}` keeps that true by construction rather than by luck.
      loaded = loadInvariants(resolved, { configRoot: repoRoot }, config ?? {});
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      loadWarnings.push(
        `${layerLabel} invariant catalog '${source.path}' failed to load and ` +
          `was skipped; evaluated remaining layers only. Reason: ${reason}`,
      );
      continue;
    }
    if (source.tier === 'dev') {
      // Dev-tier sources own the `INV-*` namespace — no reserved-id filter.
      dev.push(...loaded);
      continue;
    }
    // User-tier: reserved-namespace ids (`INV-*` / `SDLC-*`) belong to built-in
    // layers. Pre-filter them so the violation degrades to a per-entry warning
    // and the catalog's valid entries still apply (DR-9) rather than letting
    // `mergeCatalogs` throw and abort the whole gate.
    for (const entry of loaded) {
      if (isReservedUserId(entry.id)) {
        loadWarnings.push(
          `User invariant catalog '${source.path}' entry '${entry.id}' uses a ` +
            `reserved id namespace (INV-*, SDLC-*) and was skipped; those ` +
            `prefixes are reserved for built-in invariants — rename it.`,
        );
        continue;
      }
      user.push(entry);
    }
  }

  // ── Layer 2: sdlc catalog (default-on, plugin-shipped) ──
  // The consumer-facing SDLC-* baseline (#1467). Inline-authored and compiled
  // into the binary (the server ships as a single-file binary; docs/ is not in
  // the plugin package), so it is present for every consumer with ZERO file-IO
  // and NO `devCatalog`-style gate — sdlc ships enabled. The override mechanism
  // (per-invariant floor = advisory for `integrity-class: sdlc`) is the
  // consumer's escape hatch, not a master switch.
  //
  // Unlike the disk/consumer layers, the sdlc catalog is compiled into the
  // binary and validated at build time (`sdlc-catalog.test.ts`). It is parsed
  // once at MODULE load (`sdlc-catalog.ts`), so it fails fast at server start
  // by design: a parse failure can only mean a corrupted binary, which must
  // surface loudly at boot — not silently drop the consumer's primary
  // governance mid-review (that would be a worse INV-1 violation than a clean
  // boot failure). A runtime try/catch here would be dead code anyway: the
  // throw happens at import time, before this line can run.
  const sdlc: InvariantEntry[] = loadSdlcCatalog();

  // ── Merge + override-clamp ──
  const merged = mergeCatalogs({ dev, sdlc, user });
  const overrides: Record<string, InvariantOverride> =
    config?.invariants?.overrides ?? {};
  const { entries: clamped, warnings: overrideWarnings } = applyOverrides(
    merged,
    overrides,
  );
  const warnings = [...loadWarnings, ...overrideWarnings];

  // ── Final honored-disable filter ──
  // `applyOverrides` leaves disabled entries in place; drop those whose
  // override is `enabled:false` AND whose floor permits a full disable.
  const survived = clamped.filter((entry) => {
    const override = overrides[entry.id];
    if (override?.enabled !== false) return true;
    const floor = resolveFloor(entry);
    // Drop only when the floor permits disabling outright.
    return !(floor === 'disable' || floor === 'none');
  });

  // ── Project to the (phase, workflowType, touchedFiles) key ──
  const entries = projectCatalog(survived, {
    phase: ctx.phase,
    workflowType: ctx.workflowType,
    touchedFiles: ctx.touchedFiles,
  });

  return { entries, warnings };
}
