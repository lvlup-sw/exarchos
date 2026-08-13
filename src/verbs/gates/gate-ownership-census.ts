import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { ContentAddressedStore } from '../../storage/artifacts/content-addressed-store.js';
import { createInMemoryResolver } from '../../workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../dispatch/dispatch-context.js';
import { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { TOOL_REGISTRY } from '../../registry.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { ADMISSION_EVENT_TYPES } from '../../workflow/admission/types.js';
import { runGate } from './gate-runner.js';
import type { GateProviderRegistry } from './gate-provider-registry.js';
import { BUILTIN_GATE_PROVIDER_REGISTRY } from './gate-provider-registry.js';

/**
 * P01-05 — canonical evidence-production ownership census.
 *
 * Durable admission evidence must be minted by exactly one owner: the durable
 * gate runner. This module is the structural conformance harness that fails
 * closed on the three ways that ownership can be subverted:
 *
 *   1. an alternate direct emitter appends evidence outside the canonical runner;
 *   2. an enforceable gate has no provider in the single registry;
 *   3. the runner can return success without a durable evidence append.
 *
 * The census is deliberately over the *real* system — a source scan, the live
 * registry, and a behavioural probe of the real runner — so a regression trips
 * it rather than a hand-maintained mirror.
 */

/** Repo-relative module that is permitted to append admission evidence. */
export const CANONICAL_EVIDENCE_EMITTER_MODULE = 'verbs/gates/gate-runner.ts';

const EVIDENCE_EVENT_TYPE = ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED;

export interface EvidenceEmitterSite {
  /** Source module (relative to the scan root, forward-slashed). */
  readonly module: string;
  /** True only for the single canonical durable runner module. */
  readonly canonical: boolean;
}

export interface EnforceableGate {
  readonly gateClass: string;
  readonly actionName: string;
}

/**
 * Behavioural facts about the durable runner, collected by exercising the real
 * {@link runGate}. Both must hold for evidence production to be trustworthy.
 */
export interface DurabilityWitness {
  /** The runner returned a failure when the durable append threw. */
  readonly failsClosedOnAppendFailure: boolean;
  /** Every success carrier the runner produced referenced persisted evidence. */
  readonly successCarriesDurableEvidence: boolean;
}

export interface OwnershipCensusModel {
  readonly emitterSites: readonly EvidenceEmitterSite[];
  readonly enforceableGates: readonly EnforceableGate[];
  readonly registry: GateProviderRegistry;
  readonly durability: DurabilityWitness;
}

export type OwnershipCensusDiagnostic =
  | {
      readonly code: 'ALTERNATE_EVIDENCE_EMITTER';
      readonly module: string;
      readonly message: string;
    }
  | {
      readonly code: 'UNREGISTERED_GATE_PROVIDER';
      readonly gateClass: string;
      readonly actionName: string;
      readonly message: string;
    }
  | {
      readonly code: 'SUCCESS_WITHOUT_DURABLE_EVIDENCE';
      readonly message: string;
    };

export interface OwnershipCensusResult {
  readonly ok: boolean;
  readonly diagnostics: readonly OwnershipCensusDiagnostic[];
}

/**
 * Pure ownership verdict over an already-collected model.
 *
 * The three checks are independent and each contributes its own diagnostic, so
 * reverting any one of them leaves the corresponding violation undetected.
 */
export function runOwnershipCensus(
  model: OwnershipCensusModel,
): OwnershipCensusResult {
  const diagnostics: OwnershipCensusDiagnostic[] = [];

  for (const site of [...model.emitterSites].sort((a, b) =>
    a.module < b.module ? -1 : a.module > b.module ? 1 : 0,
  )) {
    if (!site.canonical) {
      diagnostics.push({
        code: 'ALTERNATE_EVIDENCE_EMITTER',
        module: site.module,
        message:
          `Module "${site.module}" appends "${EVIDENCE_EVENT_TYPE}" directly; ` +
          `admission evidence may only be produced by "${CANONICAL_EVIDENCE_EMITTER_MODULE}".`,
      });
    }
  }

  for (const gate of model.enforceableGates) {
    const resolution = model.registry.resolve(gate.gateClass);
    if (!resolution.success) {
      diagnostics.push({
        code: 'UNREGISTERED_GATE_PROVIDER',
        gateClass: gate.gateClass,
        actionName: gate.actionName,
        message:
          `Enforceable gate "${gate.gateClass}" (action "${gate.actionName}") ` +
          `resolves to no registered provider.`,
      });
    }
  }

  if (
    !model.durability.failsClosedOnAppendFailure ||
    !model.durability.successCarriesDurableEvidence
  ) {
    diagnostics.push({
      code: 'SUCCESS_WITHOUT_DURABLE_EVIDENCE',
      message:
        'The durable gate runner can report success without a persisted evidence ' +
        'record; evidence must be appended before any success carrier is returned.',
    });
  }

  return Object.freeze({ ok: diagnostics.length === 0, diagnostics });
}

// ─── Static collector: evidence emission sites ──────────────────────────────

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The event-object discriminant that an emitter constructs for the durable
 * append, e.g. `type: 'admission.evidence-recorded'`. Metadata surfaces use a
 * different key (`event: '...'`), map keys, or comparisons and are not matched.
 */
const EVIDENCE_TYPE_LITERAL = new RegExp(
  `type\\s*:\\s*['"\`]${escapeRegExp(EVIDENCE_EVENT_TYPE)}['"\`]`,
);

/**
 * Extract the balanced `( ... )` argument text starting at `openParen`, skipping
 * string/template/comment content so nested calls and quoted parens do not throw
 * off the depth count. Returns undefined when the parens never balance.
 */
function balancedCall(source: string, openParen: number): string | undefined {
  let depth = 0;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return undefined;
}

/**
 * True when `source` contains an `.append(...)` call whose argument list
 * constructs an admission-evidence event object. A `.query(...)` filter that
 * merely references the same type does not count as an emission.
 */
export function sourceEmitsEvidence(source: string): boolean {
  const appendCall = /\.append\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = appendCall.exec(source)) !== null) {
    const openParen = source.indexOf('(', match.index);
    if (openParen === -1) continue;
    const call = balancedCall(source, openParen);
    if (call !== undefined && EVIDENCE_TYPE_LITERAL.test(call)) return true;
  }
  return false;
}

async function collectTypeScriptSources(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        await walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/**
 * Scan every non-test TypeScript module under `sourceRoot` and enumerate the
 * modules that directly append admission evidence. Exactly one — the canonical
 * durable runner — is expected; anything else is an alternate emitter.
 */
export async function scanEvidenceEmitterSites(
  sourceRoot: string,
): Promise<readonly EvidenceEmitterSite[]> {
  const files = await collectTypeScriptSources(sourceRoot);
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })),
  );
  const sites: EvidenceEmitterSite[] = [];
  for (const { file, source } of sources) {
    if (!sourceEmitsEvidence(source)) continue;
    const module = relative(sourceRoot, file).replaceAll('\\', '/');
    sites.push({
      module,
      canonical: module === CANONICAL_EVIDENCE_EMITTER_MODULE,
    });
  }
  return Object.freeze(sites);
}

// ─── Static collector: enforceable gates ────────────────────────────────────

/**
 * Every orchestrate action that declares a shared mechanical `gateClass` is an
 * enforceable gate and must resolve to a registered provider.
 */
export function collectEnforceableGates(): readonly EnforceableGate[] {
  const orchestrate = TOOL_REGISTRY.find(
    (tool) => tool.name === 'exarchos_orchestrate',
  );
  if (orchestrate === undefined) return Object.freeze([]);
  const gates: EnforceableGate[] = [];
  for (const action of orchestrate.actions) {
    const gateClass = action.gate?.gateClass;
    if (gateClass !== undefined) {
      gates.push({ gateClass, actionName: action.name });
    }
  }
  return Object.freeze(gates);
}

// ─── Behavioural collector: durable runner witness ──────────────────────────

const WITNESS_TIME = '2026-08-03T00:00:00.000Z';

function witnessDispatchContext(sessionId: string): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId });
  const authorization = snapshotCallerAuthorization(
    identity,
    createInMemoryResolver([
      'fs:read',
      'fs:write',
      'shell:exec',
      'isolation:worktree',
      'mcp:exarchos',
    ]),
    () => WITNESS_TIME,
  );
  return mintDispatchContext(undefined, authorization);
}

function referencesPersistedEvidence(result: ToolResult): boolean {
  const data = result.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const references = (data as { readonly evidenceReferences?: unknown })
    .evidenceReferences;
  return Array.isArray(references) && references.length > 0;
}

/**
 * Exercise the real durable runner and report whether success is gated on a
 * persisted evidence append. Uses a throwaway on-disk event store so the probe
 * observes production persistence semantics, not a stub.
 */
export async function witnessRunnerDurability(): Promise<DurabilityWitness> {
  const root = await mkdtemp(join(tmpdir(), 'exarchos-ownership-census-'));
  const eventStore = new EventStore(join(root, 'events'));
  try {
    await eventStore.initialize();
    const artifactStore = new ContentAddressedStore(join(root, 'artifacts'));
    const request = {
      streamId: 'ownership-census-witness',
      gateClass: 'test-adequacy',
      phaseAttemptId: 'phase-attempt:census-witness',
      requirementId: 'requirement:ownership-census',
      subject: createEvidenceSubject(
        { kind: 'task', taskId: 'census-witness' },
        { commit: 'census0', diff: 'census-diff' },
      ),
      providerInput: { taskId: 'census-witness' },
    };
    const passingProvider = async (): Promise<ToolResult> => ({
      success: true,
      data: { passed: true },
    });

    const success = await runWithDispatchContext(
      witnessDispatchContext('census-success'),
      () =>
        runGate(request, {
          eventStore,
          artifactStore,
          executeProvider: passingProvider,
          clock: () => WITNESS_TIME,
        }),
    );
    const persisted = await eventStore.query(request.streamId, {
      type: EVIDENCE_EVENT_TYPE,
    });
    const successCarriesDurableEvidence =
      success.success === true &&
      referencesPersistedEvidence(success) &&
      persisted.length >= 1;

    const failingStore: Pick<EventStore, 'append' | 'query'> = {
      query: eventStore.query.bind(eventStore),
      append: async () => {
        throw new Error('census: durable store unavailable');
      },
    };
    const failClosed = await runWithDispatchContext(
      witnessDispatchContext('census-fail'),
      () =>
        runGate(request, {
          eventStore: failingStore,
          artifactStore,
          executeProvider: passingProvider,
          clock: () => WITNESS_TIME,
        }),
    );
    const failsClosedOnAppendFailure = failClosed.success === false;

    return Object.freeze({
      failsClosedOnAppendFailure,
      successCarriesDurableEvidence,
    });
  } finally {
    eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
}

// ─── Composed census over the real system ───────────────────────────────────

/**
 * Collect the full ownership model from the live system and return the verdict.
 * This is the callable the exit-proof harness drives against the real tree.
 */
export async function auditEvidenceOwnership(
  sourceRoot: string,
  registry: GateProviderRegistry = BUILTIN_GATE_PROVIDER_REGISTRY,
): Promise<OwnershipCensusResult> {
  const [emitterSites, durability] = await Promise.all([
    scanEvidenceEmitterSites(sourceRoot),
    witnessRunnerDurability(),
  ]);
  return runOwnershipCensus({
    emitterSites,
    enforceableGates: collectEnforceableGates(),
    registry,
    durability,
  });
}
