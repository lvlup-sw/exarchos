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
 *
 * The source scan asks what an append MEANS, not how it is spelled. It reads
 * through the exported `ADMISSION_EVENT_TYPES` constant, through an aliased
 * import of it, and through an event object hoisted into a `const` — the forms
 * this codebase actually writes emitters in. Matching the raw string literal
 * alone, as it once did, made the idiomatic emitter the one shape the detector
 * could not see.
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

/**
 * One `.append(...)` call site, with its event discriminant already RESOLVED.
 *
 * `discriminant` is the value the `type:` property evaluates to — after aliases,
 * imported constant members and hoisted event bindings have been followed, not
 * the characters that happen to appear at the call. `undefined` means a `type:`
 * was present but did not reduce to a string, which is a reportable gap rather
 * than a "no".
 */
export interface EvidenceAppendSite {
  /** 1-based line of the `.append(` call in the scanned source. */
  readonly line: number;
  /** The resolved event-type discriminant, or `undefined` when unresolvable. */
  readonly discriminant: string | undefined;
}

/** Inputs a scanner needs beyond the source text. */
export interface EvidenceScanOptions {
  /** Reported in parse diagnostics only; never affects the answer. */
  readonly fileName?: string;
  /**
   * Dotted access paths (`ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED`) mapped to
   * their compile-time value, so a discriminant written as the exported constant
   * resolves to the same answer as the raw literal.
   */
  readonly knownConstants: ReadonlyMap<string, string>;
}

/**
 * The append-site scanner port.
 *
 * Required, not defaulted, for the reason `architecture/effect-ledger.ts` states
 * for its own lexer port: only the compiler can be trusted about TypeScript's
 * grammar, and `typescript` is a devDependency while this is shipped `src/`. The
 * implementation lives in `test-helpers/evidence-emission-scanner.ts`.
 */
export type EvidenceEmissionScanner = (
  source: string,
  options: EvidenceScanOptions,
) => readonly EvidenceAppendSite[];

/**
 * The discriminant vocabulary a scanner may need to resolve, DERIVED from the
 * live constant table rather than transcribed. Adding an admission event type
 * extends this automatically.
 */
export const EVIDENCE_DISCRIMINANT_CONSTANTS: ReadonlyMap<string, string> = Object.freeze(
  new Map(
    Object.entries(ADMISSION_EVENT_TYPES).map(
      ([member, value]) => [`ADMISSION_EVENT_TYPES.${member}`, value] as const,
    ),
  ),
);

/**
 * Modules that append an event whose discriminant is a RUNTIME value — a
 * parameter, a widening cast, a property of an argument — so no static scan can
 * say which event they produce.
 *
 * They are acknowledged rather than skipped: "the census could not read this"
 * and "this is not an emitter" are different answers, and collapsing them is the
 * defect this detector was repaired for. Each of these appends a caller-supplied
 * type into a non-admission stream, so none is a live evidence emitter today —
 * but that is a fact about the callers, which is exactly why it is written down
 * instead of assumed.
 *
 * SHRINK-ONLY, and mechanically so: a member that becomes resolvable is a
 * `STALE_UNRESOLVED_ACKNOWLEDGEMENT`, so the set cannot outlive the gap it
 * covers. Narrow the emitted `type` to a literal union and delete the row.
 *
 * It grew ONCE, in the other direction, and only because the scanner had been
 * under-reporting: an append whose event object or `type` could not be read was
 * DROPPED rather than recorded unresolved, and `findProperty` never implemented
 * the spread following its own doc-comment promised. So
 * `append(id, buildEvent(r))` and `append(id, { ...base, data })` — both
 * ordinary — made a module look like it appended nothing at all. The six
 * additions below are emitters this set could not previously see, not new debt;
 * none of them references the admission evidence type. The shrink-only rule
 * governs the set from here, and a widened DENOMINATOR is the one thing it was
 * never protecting against.
 */
export const ACKNOWLEDGED_UNRESOLVED_MODULES: ReadonlySet<string> = Object.freeze(
  new Set([
    'core/onboarding/event-ctx.ts',
    'evals/run-evals-cli.ts',
    'event-store/store.ts',
    'event-store/tools.ts',
    'orchestrate/mutation-adequacy.ts',
    'orchestrate/prepare-delegation.ts',
    'orchestrate/worktree/manager.ts',
    'orchestrate/worktree/merge-serializer.ts',
    'storage/sidecar-merger.ts',
    'storage/sidecar-scheduler.ts',
    'task-store/event-sourced-task-store.ts',
    'vcs/mutation-owner.ts',
    'workflow/cancel.ts',
  ]),
);

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

/** An `.append(...)` site the scan could not read, located for a human. */
export interface UnresolvedDiscriminantSite {
  readonly module: string;
  readonly line: number;
}

export interface OwnershipCensusModel {
  readonly emitterSites: readonly EvidenceEmitterSite[];
  readonly enforceableGates: readonly EnforceableGate[];
  readonly registry: GateProviderRegistry;
  readonly durability: DurabilityWitness;
  /**
   * Append sites whose event discriminant did not reduce to a string. Omitted
   * (not empty) by callers that did not scan for them, which also suspends the
   * stale-acknowledgement arm — an absent scan is not evidence of a shrink.
   */
  readonly unresolvedDiscriminants?: readonly UnresolvedDiscriminantSite[];
  /** Override for {@link ACKNOWLEDGED_UNRESOLVED_MODULES} (kill fixtures). */
  readonly acknowledgedUnresolvedModules?: ReadonlySet<string>;
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
    }
  /**
   * An `.append(...)` site whose event discriminant the scan could not reduce to
   * a string, in a module that has not acknowledged the gap. Reported rather
   * than skipped: an unreadable emitter is exactly the one that could be
   * appending evidence, so silence here would be the census being green about
   * what it cannot see.
   */
  | {
      readonly code: 'UNRESOLVED_EVIDENCE_DISCRIMINANT';
      readonly module: string;
      readonly line: number;
      readonly message: string;
    }
  /** An acknowledged module whose appends now all resolve — delete the row. */
  | {
      readonly code: 'STALE_UNRESOLVED_ACKNOWLEDGEMENT';
      readonly module: string;
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

  const unresolved = model.unresolvedDiscriminants ?? [];
  const acknowledged = model.acknowledgedUnresolvedModules ?? ACKNOWLEDGED_UNRESOLVED_MODULES;
  for (const site of unresolved) {
    if (acknowledged.has(site.module)) continue;
    diagnostics.push({
      code: 'UNRESOLVED_EVIDENCE_DISCRIMINANT',
      module: site.module,
      line: site.line,
      message:
        `Module "${site.module}" appends an event at line ${site.line} whose \`type\` ` +
        `discriminant does not reduce to a string. The census cannot tell whether it ` +
        `produces "${EVIDENCE_EVENT_TYPE}"; write the discriminant as a literal or as a ` +
        `member of an exported constant table so ownership stays decidable.`,
    });
  }

  // The other half of the two-way conformance: an acknowledgement that covers
  // nothing is a claim the tree no longer supports, and keeping it would let the
  // set survive the gap it was written for.
  if (model.unresolvedDiscriminants !== undefined) {
    const stillUnresolved = new Set(unresolved.map((site) => site.module));
    for (const module of acknowledged) {
      if (stillUnresolved.has(module)) continue;
      diagnostics.push({
        code: 'STALE_UNRESOLVED_ACKNOWLEDGEMENT',
        module,
        message:
          `Module "${module}" is acknowledged as having an unresolvable event ` +
          `discriminant, but every append in it now resolves. Delete the row — the ` +
          `acknowledgement set is shrink-only.`,
      });
    }
  }

  return Object.freeze({ ok: diagnostics.length === 0, diagnostics });
}

// ─── Static collector: evidence emission sites ──────────────────────────────

/**
 * True when any `.append(...)` in `source` constructs an event whose RESOLVED
 * discriminant is the admission-evidence type.
 *
 * The question this asks is what the emitted event MEANS, not how the emitter
 * spelled it. `type: 'admission.evidence-recorded'`, `type:
 * ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED` (the idiom every other admission
 * consumer uses), an aliased import of that table, and an event object hoisted
 * into a `const` above the call all resolve to the same answer — the earlier
 * text match saw only the first, so an emitter written the ordinary way was
 * invisible to the census policing it.
 *
 * A `.query(...)` filter that merely references the type is not an append, so it
 * is excluded by construction rather than by a second filter.
 */
export function sourceEmitsEvidence(
  source: string,
  scan: EvidenceEmissionScanner,
  fileName?: string,
): boolean {
  return scanAppendSites(source, scan, fileName).some(
    (site) => site.discriminant === EVIDENCE_EVENT_TYPE,
  );
}

function scanAppendSites(
  source: string,
  scan: EvidenceEmissionScanner,
  fileName?: string,
): readonly EvidenceAppendSite[] {
  return scan(source, {
    ...(fileName === undefined ? {} : { fileName }),
    knownConstants: EVIDENCE_DISCRIMINANT_CONSTANTS,
  });
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
        // The suffixes `tsconfig.json` itself excludes from the emit, plus
        // declarations. A file the build never emits cannot be a shipped
        // emitter, so this is a build property rather than a named subtree.
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.bench.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        files.push(full);
      }
    }
  };
  await walk(root);
  return files.sort();
}

/** What one scan of a source tree found. */
export interface EmitterScanResult {
  readonly sites: readonly EvidenceEmitterSite[];
  readonly unresolvedDiscriminants: readonly UnresolvedDiscriminantSite[];
}

/**
 * Scan every non-test TypeScript module under `sourceRoot`, enumerating the
 * modules that directly append admission evidence and the append sites whose
 * discriminant could not be resolved. Exactly one emitter — the canonical
 * durable runner — is expected; anything else is an alternate emitter.
 */
export async function scanEvidenceEmitters(
  sourceRoot: string,
  scan: EvidenceEmissionScanner,
): Promise<EmitterScanResult> {
  const files = await collectTypeScriptSources(sourceRoot);
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, 'utf8') })),
  );
  const sites: EvidenceEmitterSite[] = [];
  const unresolved: UnresolvedDiscriminantSite[] = [];
  for (const { file, source } of sources) {
    const module = relative(sourceRoot, file).replaceAll('\\', '/');
    const appendSites = scanAppendSites(source, scan, module);
    for (const site of appendSites) {
      if (site.discriminant === undefined) {
        unresolved.push({ module, line: site.line });
      }
    }
    if (!appendSites.some((site) => site.discriminant === EVIDENCE_EVENT_TYPE)) {
      continue;
    }
    sites.push({
      module,
      canonical: module === CANONICAL_EVIDENCE_EMITTER_MODULE,
    });
  }
  return Object.freeze({
    sites: Object.freeze(sites),
    unresolvedDiscriminants: Object.freeze(unresolved),
  });
}

/** {@link scanEvidenceEmitters}, emitter sites only. */
export async function scanEvidenceEmitterSites(
  sourceRoot: string,
  scan: EvidenceEmissionScanner,
): Promise<readonly EvidenceEmitterSite[]> {
  return (await scanEvidenceEmitters(sourceRoot, scan)).sites;
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
  scan: EvidenceEmissionScanner,
  registry: GateProviderRegistry = BUILTIN_GATE_PROVIDER_REGISTRY,
): Promise<OwnershipCensusResult> {
  const [emitters, durability] = await Promise.all([
    scanEvidenceEmitters(sourceRoot, scan),
    witnessRunnerDurability(),
  ]);
  return runOwnershipCensus({
    emitterSites: emitters.sites,
    enforceableGates: collectEnforceableGates(),
    registry,
    durability,
    unresolvedDiscriminants: emitters.unresolvedDiscriminants,
  });
}
