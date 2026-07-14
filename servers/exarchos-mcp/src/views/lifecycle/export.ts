// ─── Lifecycle verb: `export` — diagnostic zip bundle (DR-6) ──────────────────
//
// The last worktree-lifecycle verb: writes a portable diagnostic bundle of ONE
// workflow to a zip on disk (a path OUTSIDE `.exarchos/` — a non-idempotent
// external side effect). The bundle carries
//
//   • events.jsonl   — the workflow's domain event stream, one JSON event/line
//                       (the export's OWN `export.*` bookkeeping events are
//                       excluded so the bundle is a stable function of the
//                       domain log);
//   • state.json      — `fold(events.jsonl)` via the canonical
//                        `workflowStateProjection`, so REPLAYING events.jsonl
//                        reconstructs state.json byte-for-byte (round-trip);
//   • metadata.json   — deterministic bundle manifest (featureId / eventCount /
//                        phase / workflowType / artifacts + missingArtifacts);
//   • artifacts/       — every referenced artifact FILE that exists on disk;
//                        references that do NOT exist are tolerated and listed
//                        in `missingArtifacts` (metadata + the executed event).
//
// TWO-EVENT SPLIT (INV-13) + IDEMPOTENCY (INV-8). The write is journaled as a
// `export.requested` INTENT (resolved destination path) BEFORE the zip is
// written and a `export.executed` RESULT (contentHash / eventCount /
// missingArtifacts) AFTER. Both carry a logical `idempotencyKey`; the STORAGE
// idempotency key is DERIVED from it (`export.requested:<K>` / `export.executed
// :<K>`) so a crash-retry of the SAME logical export collapses onto one intent
// while a fresh invocation mints a distinct key and a NEW pair.
//
// CRASH PRECHECK. On invocation the handler scans for a `export.requested` with
// no paired `export.executed` (a crash between the two events). When found it
// REUSES that intent's key + destination and COMPLETES it rather than minting a
// new intent — re-emitting `export.requested` with the same storage key is a
// no-op cache-hit (never a duplicate intent), the on-disk zip is compared
// against the freshly-built bundle's `contentHash` (deterministic bytes) and the
// write is skipped when it already matches, then `export.executed` is emitted.
//
// COLD-PROBE SIDE-EFFECT-FREE (RCA 2026-05-30). `export` on an unknown /
// never-`init`'d featureId returns `workflowExists:false`, writes NO zip and
// emits ZERO events (existence is answered from the event log alone).
//
// WINDOWS / INV-16. Zip ENTRY names are built with `path.posix`; filesystem
// paths with `path.join`; the zip is written to a temp sibling and atomically
// renamed, and every stream/file handle is closed before the rename — so a
// temp-dir removal on NTFS is never blocked by an open handle.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ZipFile } from 'yazl';

import type { DispatchContext } from '../../core/dispatch.js';
import type { ToolResult } from '../../format.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { workflowStateProjection, type WorkflowStateView } from '../workflow-state-projection.js';
import { EnvelopeSchema } from '../../schemas/envelope.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Bundle manifest version — bumps if the entry layout changes. */
const EXPORT_FORMAT_VERSION = 1;

/** The two bookkeeping event types excluded from the exported domain stream. */
const EXPORT_EVENT_TYPES = new Set<string>(['export.requested', 'export.executed']);

/**
 * Fixed entry mtime so the produced zip is byte-DETERMINISTIC for identical
 * bundle content — the load-bearing precondition for the INV-13 crash precheck
 * (compare a freshly-built bundle's contentHash against the on-disk zip). Epoch
 * (UTC) keeps the extended-timestamp extra field timezone-independent.
 */
const FIXED_ZIP_MTIME = new Date(0);
const FIXED_ZIP_MODE = 0o100644;

// ─── Local input helpers (kept private — never user-facing flags) ─────────────

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function invalidInput(message: string, expectedShape?: Record<string, unknown>): ToolResult {
  return {
    success: false,
    error: { code: 'INVALID_INPUT', message, ...(expectedShape ? { expectedShape } : {}) },
  };
}

/** True for a value that is a URL (scheme://...) rather than a filesystem path. */
function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ─── Pure bundle construction (the round-trip core) ───────────────────────────

interface IncludedArtifact {
  readonly entryName: string;
  readonly bytes: Buffer;
}

/**
 * Resolve the referenced-artifact set against `baseDir`: split into artifact
 * FILES that exist on disk (included, as `artifacts/<key>/<basename>` entries)
 * and referenced paths that do NOT exist (tolerated — listed in
 * `missingArtifacts`). URL-valued artifacts (e.g. a `pr` link) are neither
 * included nor treated as missing. Deterministic: both lists are sorted.
 */
function collectArtifacts(
  artifacts: WorkflowStateView['artifacts'] | undefined,
  baseDir: string,
): { included: IncludedArtifact[]; missing: string[] } {
  const included: IncludedArtifact[] = [];
  const missing: string[] = [];

  const candidates: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(artifacts ?? {})) {
    if (typeof value === 'string') {
      candidates.push({ key, value });
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'string') candidates.push({ key: `${key}-${i}`, value: v });
      });
    }
  }

  for (const { key, value } of candidates) {
    if (isUrl(value)) continue; // e.g. a `pr` URL is not a filesystem artifact
    const abs = path.isAbsolute(value) ? value : path.join(baseDir, value);
    let bytes: Buffer | undefined;
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) bytes = fs.readFileSync(abs);
    } catch {
      // ENOENT / unreadable → tolerated as missing
    }
    if (bytes) {
      // Entry name uses path.posix (INV-16: zip entries are always posix).
      const entryName = path.posix.join('artifacts', key, path.posix.basename(value));
      included.push({ entryName, bytes });
    } else {
      missing.push(value);
    }
  }

  included.sort((a, b) => (a.entryName < b.entryName ? -1 : a.entryName > b.entryName ? 1 : 0));
  missing.sort();
  return { included, missing };
}

export interface ExportBundle {
  /** entry name (posix) → raw bytes. */
  readonly entries: ReadonlyMap<string, Buffer>;
  /** count of domain events in the exported extract (== `state.json` fold input). */
  readonly eventCount: number;
  /** referenced artifact paths that did not exist on disk (tolerated). */
  readonly missingArtifacts: readonly string[];
  /** `fold(domainEvents)` — exactly what `state.json` serializes. */
  readonly state: WorkflowStateView;
}

/**
 * Build the logical bundle from the workflow's DOMAIN events (the export's own
 * `export.*` events are filtered out by the caller). `state.json` is
 * `fold(domainEvents)` via the SAME projection a replay uses, so
 * `replay(events.jsonl) === state.json` holds by construction.
 */
export function buildExportBundle(
  featureId: string,
  domainEvents: readonly WorkflowEvent[],
  baseDir: string,
): ExportBundle {
  let view = workflowStateProjection.init();
  for (const event of domainEvents) view = workflowStateProjection.apply(view, event);
  const state = view;

  const eventsJsonl =
    domainEvents.length > 0 ? domainEvents.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  const stateJson = JSON.stringify(state, null, 2) + '\n';

  const { included, missing } = collectArtifacts(state.artifacts, baseDir);

  const metadata = {
    featureId,
    eventCount: domainEvents.length,
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    phase: state.phase,
    workflowType: state.workflowType,
    lastEventAt: domainEvents.length > 0 ? domainEvents[domainEvents.length - 1].timestamp : null,
    artifacts: included.map((a) => a.entryName),
    missingArtifacts: missing,
  };
  const metadataJson = JSON.stringify(metadata, null, 2) + '\n';

  const entries = new Map<string, Buffer>();
  entries.set('events.jsonl', Buffer.from(eventsJsonl, 'utf8'));
  entries.set('state.json', Buffer.from(stateJson, 'utf8'));
  entries.set('metadata.json', Buffer.from(metadataJson, 'utf8'));
  for (const a of included) entries.set(a.entryName, a.bytes);

  return { entries, eventCount: domainEvents.length, missingArtifacts: missing, state };
}

/**
 * Serialize the bundle to a DETERMINISTIC zip (fixed mtime + STORE mode + sorted
 * entry order) so identical content yields byte-identical bytes. Closes the
 * output stream before resolving (INV-16 — no lingering handle).
 */
export function zipBundle(entries: ReadonlyMap<string, Buffer>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));

    const names = [...entries.keys()].sort();
    for (const name of names) {
      zip.addBuffer(entries.get(name)!, name, {
        mtime: FIXED_ZIP_MTIME,
        mode: FIXED_ZIP_MODE,
        compress: false,
      });
    }
    zip.end();
  });
}

// ─── Output-path resolution + validation ──────────────────────────────────────

interface OutputPathValidation {
  readonly ok: boolean;
  readonly reason?: string;
  readonly suggestion?: string;
}

/** Resolve `output` (default `./<featureId>-export.zip`) to an absolute path. */
function resolveOutputPath(output: string | undefined, featureId: string, baseDir: string): string {
  const raw = output ?? `${featureId}-export.zip`;
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
}

/**
 * Validate the destination BEFORE any event is emitted (the invalid-path path
 * must be side-effect-free). Rejects an empty path, a directory-intent path
 * (trailing separator or an existing directory), and a path whose parent cannot
 * be created. Creating the parent directory for a valid path is expected setup,
 * not a workflow mutation.
 */
function validateAndPrepareOutputPath(outputPath: string, featureId: string): OutputPathValidation {
  if (!outputPath) {
    return { ok: false, reason: 'output path is empty', suggestion: `${featureId}-export.zip` };
  }
  if (/[\\/]$/.test(outputPath)) {
    return {
      ok: false,
      reason: 'output path is a directory (trailing separator); it must name a zip FILE',
      suggestion: path.posix.join(outputPath.replace(/[\\/]+$/, ''), `${featureId}-export.zip`),
    };
  }
  try {
    const st = fs.statSync(outputPath);
    if (st.isDirectory()) {
      return {
        ok: false,
        reason: 'output path is an existing directory; it must name a zip FILE',
        suggestion: path.join(outputPath, `${featureId}-export.zip`),
      };
    }
  } catch {
    // ENOENT is the happy path — the file does not exist yet.
  }
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `cannot create the destination directory: ${err instanceof Error ? err.message : String(err)}`,
      suggestion: `${featureId}-export.zip`,
    };
  }
  return { ok: true };
}

/** Atomic write: temp sibling → close handle → rename (INV-16 handle safety). */
async function writeZipAtomic(outputPath: string, zipBytes: Buffer): Promise<void> {
  const dir = path.dirname(outputPath);
  const tmp = path.join(dir, `.${path.basename(outputPath)}.tmp-${randomUUID()}`);
  try {
    await fsp.writeFile(tmp, zipBytes); // opens + fully closes the handle on resolve
    await fsp.rename(tmp, outputPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ─── Crash precheck ───────────────────────────────────────────────────────────

interface DanglingIntent {
  readonly idempotencyKey: string;
  readonly outputPath: string;
}

/**
 * The most-recent `export.requested` whose logical `idempotencyKey` has no
 * paired `export.executed` — a crash between the INV-13 pair. `undefined` when
 * every request is completed (the fresh-invocation path).
 */
function findDanglingIntent(events: readonly WorkflowEvent[]): DanglingIntent | undefined {
  const executedKeys = new Set<string>();
  for (const e of events) {
    if (e.type === 'export.executed') {
      const k = (e.data as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
      if (typeof k === 'string') executedKeys.add(k);
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'export.requested') continue;
    const data = e.data as { idempotencyKey?: unknown; outputPath?: unknown } | undefined;
    const key = data?.idempotencyKey;
    const outputPath = data?.outputPath;
    if (typeof key === 'string' && typeof outputPath === 'string' && !executedKeys.has(key)) {
      return { idempotencyKey: key, outputPath };
    }
  }
  return undefined;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * `export` — write a diagnostic zip bundle of one workflow (DR-6). Emits the
 * INV-13 `export.requested` → `export.executed` pair around the write, derives
 * the storage idempotency key from a logical key (INV-8), completes a crashed
 * pair without duplicating the intent, and is cold-probe safe on an unknown
 * featureId.
 */
export async function handleViewExport(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const featureId = optionalString(args.featureId);
  if (!featureId) {
    return invalidInput('export requires featureId: string', { featureId: 'string' });
  }

  const { eventStore } = ctx;
  const baseDir = ctx.cwd ?? process.cwd();

  // Existence is answered from the event log ALONE (RCA 2026-05-30). A cold
  // probe of an unknown / never-`init`'d featureId returns workflowExists:false
  // and writes NOTHING (no zip) + emits ZERO events — the CB-2 no-phantom-stream
  // guarantee.
  const events = await eventStore.query(featureId);
  if (events.length === 0) {
    return {
      success: true,
      data: { featureId, workflowExists: false, exported: false },
      _meta: { workflowExists: false },
    };
  }

  // Crash precheck: a `export.requested` with no paired `export.executed` means
  // a prior invocation crashed mid-flight. Complete THAT intent (reuse its key +
  // destination) rather than minting a new one.
  const dangling = findDanglingIntent(events);
  const idempotencyKey = dangling?.idempotencyKey ?? randomUUID();
  const outputPath = dangling
    ? dangling.outputPath
    : resolveOutputPath(optionalString(args.output), featureId, baseDir);
  const recovered = dangling !== undefined;

  // Validate the destination BEFORE any append (side-effect-free on rejection).
  const validation = validateAndPrepareOutputPath(outputPath, featureId);
  if (!validation.ok) {
    return {
      success: false,
      error: {
        code: 'INVALID_OUTPUT_PATH',
        message: `export: invalid output path "${outputPath}" — ${validation.reason}`,
        suggestedFix: {
          tool: 'exarchos_view',
          params: { action: 'export', featureId, output: validation.suggestion },
        },
      },
    };
  }

  // Build the bundle from DOMAIN events only (exclude the export's own
  // bookkeeping) so the bundle — and its contentHash — is a stable function of
  // the domain log across a crash-retry.
  const domainEvents = events.filter((e) => !EXPORT_EVENT_TYPES.has(e.type));
  const bundle = buildExportBundle(featureId, domainEvents, baseDir);
  const zipBytes = await zipBundle(bundle.entries);
  const contentHash = sha256(zipBytes);

  // INV-13 INTENT — journaled BEFORE the write. On a crash-retry the reused
  // storage key makes this a cache-hit (no duplicate intent). INV-8: the storage
  // key is DERIVED from the logical key, and distinct from the executed key so
  // both events persist.
  await eventStore.append(
    featureId,
    { type: 'export.requested', data: { featureId, outputPath, idempotencyKey } },
    { idempotencyKey: `export.requested:${idempotencyKey}` },
  );

  // Idempotent write: skip when the on-disk zip already matches (crash-recovery
  // where the write completed but the executed event never landed).
  let existingHash: string | undefined;
  try {
    existingHash = sha256(await fsp.readFile(outputPath));
  } catch {
    existingHash = undefined;
  }
  const bundleRewritten = existingHash !== contentHash;
  if (bundleRewritten) {
    await writeZipAtomic(outputPath, zipBytes);
  }

  // INV-13 RESULT — journaled AFTER the write, carrying the bundle's contentHash
  // (the crash precheck's disk comparator), eventCount, and missingArtifacts.
  await eventStore.append(
    featureId,
    {
      type: 'export.executed',
      data: {
        featureId,
        outputPath,
        contentHash,
        eventCount: bundle.eventCount,
        ...(bundle.missingArtifacts.length > 0 ? { missingArtifacts: [...bundle.missingArtifacts] } : {}),
        idempotencyKey,
      },
    },
    { idempotencyKey: `export.executed:${idempotencyKey}` },
  );

  return {
    success: true,
    data: {
      featureId,
      workflowExists: true,
      exported: true,
      outputPath,
      contentHash,
      eventCount: bundle.eventCount,
      missingArtifacts: [...bundle.missingArtifacts],
      idempotencyKey,
      recovered,
      bundleRewritten,
    },
    _meta: { workflowExists: true },
  };
}

// ─── Typed output schema (DR-1 — typed `data`, not a bare unknown envelope) ────
//
// Same derivation discipline as `inspect`: the MCP adapter `safeParse`s the REAL
// handler output against this schema, so a STRICTER shape than the handler emits
// breaks production. Declared in strip+passthrough mode; fields absent on the
// cold-probe branch are `.optional()` so BOTH the exported and cold-probe shapes
// validate against one schema.

const ExportData = z
  .object({
    featureId: z.string(),
    workflowExists: z.boolean(),
    exported: z.boolean(),
    outputPath: z.string().optional(),
    contentHash: z.string().optional(),
    eventCount: z.number().optional(),
    missingArtifacts: z.array(z.string()).optional(),
    idempotencyKey: z.string().optional(),
    recovered: z.boolean().optional(),
    bundleRewritten: z.boolean().optional(),
  })
  .passthrough();

/** `export` success — the bundle-write result (or the cold-probe shape). */
export const ExportOutputSchema = EnvelopeSchema(ExportData);
