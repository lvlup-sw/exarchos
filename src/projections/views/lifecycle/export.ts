/**
 * Lifecycle verb `export`: write a diagnostic zip bundle of one workflow to a path outside `.exarchos/`.
 *
 * The bundle holds `events.jsonl` (the domain events, without the `export.*` events), `state.json`
 * (the fold of those events, so a replay reproduces it), `metadata.json`, and each artifact file
 * that exists inside the base directory. A missing artifact goes into `missingArtifacts`.
 *
 * The write sits between an `export.requested` intent and an `export.executed` result. Both storage
 * idempotency keys derive from one logical key. A retry after a crash completes the open intent,
 * and skips the write when the zip on disk already matches. An unknown featureId gets no zip and no event.
 *
 * Zip entry names use `path.posix`, and file paths use `path.join`. Each handle closes before the
 * atomic rename, so an open handle cannot block a temp-dir removal on Windows.
 */
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ZipFile } from 'yazl';

import type { DispatchContext } from '../../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../../format.js';
import type { WorkflowEvent } from '../../../events/schemas.js';
import { workflowStateProjection, type WorkflowStateView } from '../workflow-state-projection.js';
import { EnvelopeSchema } from '../../../contract/schemas/envelope.js';
import { atomicReplace } from '../../../utils/atomic-write.js';

/** Bundle manifest version — bumps if the entry layout changes. */
const EXPORT_FORMAT_VERSION = 1;

/** The two bookkeeping event types excluded from the exported domain stream. */
const EXPORT_EVENT_TYPES = new Set<string>(['export.requested', 'export.executed']);

/**
 * Fixed entry mtime, so identical bundle content gives identical zip bytes. The crash precheck
 * compares content hashes and depends on this. The epoch keeps the extended-timestamp field
 * independent of the time zone.
 */
const FIXED_ZIP_MTIME = new Date(0);
const FIXED_ZIP_MODE = 0o100644;

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

/**
 * True when `abs` is strictly inside `baseDir`. `baseDir` itself is not an artifact file, so it fails.
 *
 * An artifact reference is workflow data, not a trusted path. Without this check, a traversal
 * (`../../etc/passwd`) or an absolute path (`/etc/passwd`) can put any readable file into the zip.
 * The relative path of an escaping target starts with `..` or is absolute.
 */
function isContainedIn(abs: string, baseDir: string): boolean {
  const rel = path.relative(baseDir, abs);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface IncludedArtifact {
  readonly entryName: string;
  readonly bytes: Buffer;
}

/**
 * Split the referenced artifacts into files inside `baseDir`, as `artifacts/<key>/<basename>`
 * entries, and missing paths. A URL value, for example a `pr` link, is in neither list. Both lists are sorted.
 *
 * `path.resolve` collapses `..` and accepts an absolute value, so one containment check covers both
 * escape routes before any file read. A path outside `baseDir`, or a file that cannot be read, counts
 * as missing. The entry basename comes from the platform path, because `path.posix.basename` does not split on `\`.
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
    if (isUrl(value)) continue;
    const abs = path.resolve(baseDir, value);
    let bytes: Buffer | undefined;
    if (isContainedIn(abs, baseDir)) {
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) bytes = fs.readFileSync(abs);
      } catch {
      }
    }
    if (bytes) {
      const entryName = path.posix.join('artifacts', key, path.basename(abs));
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
    lastEventAt: domainEvents.length > 0 ? (domainEvents[domainEvents.length - 1]?.timestamp ?? null) : null,
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
 * Serialize the bundle to a deterministic zip: fixed mtime, STORE mode and sorted entries.
 * Identical content gives identical bytes. The promise resolves after the output stream ends.
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

interface DanglingIntent {
  readonly idempotencyKey: string;
  readonly outputPath: string;
}

/**
 * The latest `export.requested` whose logical `idempotencyKey` has no `export.executed`, which
 * means a crash between the two events. `undefined` when each request has its result.
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
    if (e === undefined) continue;
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

/**
 * Write a diagnostic zip bundle of one workflow.
 *
 * An unknown featureId returns `workflowExists: false`, with no zip and no event, because the
 * event log alone answers existence. An open intent from a crashed run completes with its own key
 * and destination. The destination check runs before any append, so a rejection has no side effect.
 *
 * The bundle uses domain events only, so its `contentHash` stays the same across a retry. The intent
 * and result storage keys differ, so both events persist, and a repeated intent is a cache hit. The
 * zip write is skipped when the file on disk already has the same hash.
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

  const events = await eventStore.query(featureId);
  if (events.length === 0) {
    return {
      success: true,
      data: { featureId, workflowExists: false, exported: false },
      _meta: { workflowExists: false },
    };
  }

  const dangling = findDanglingIntent(events);
  const idempotencyKey = dangling?.idempotencyKey ?? randomUUID();
  const outputPath = dangling
    ? dangling.outputPath
    : resolveOutputPath(optionalString(args.output), featureId, baseDir);
  const recovered = dangling !== undefined;

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

  const domainEvents = events.filter((e) => !EXPORT_EVENT_TYPES.has(e.type));
  const bundle = buildExportBundle(featureId, domainEvents, baseDir);
  const zipBytes = await zipBundle(bundle.entries);
  const contentHash = sha256(zipBytes);

  await eventStore.append(
    featureId,
    { type: 'export.requested', data: { featureId, outputPath, idempotencyKey } },
    { idempotencyKey: `export.requested:${idempotencyKey}` },
  );

  let existingHash: string | undefined;
  try {
    existingHash = sha256(await fsp.readFile(outputPath));
  } catch {
    existingHash = undefined;
  }
  const bundleRewritten = existingHash !== contentHash;
  if (bundleRewritten) {
    await atomicReplace(outputPath, zipBytes);
  }

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

/**
 * Typed `data` of the `export` result. The MCP adapter parses the real handler output with this
 * schema, so a stricter shape than the handler emits breaks production. The fields that the
 * cold-probe result omits are optional, so both shapes pass.
 */
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
