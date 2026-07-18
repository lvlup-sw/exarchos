/**
 * Launcher spawn/teardown typed contract (DR-13, #1644).
 *
 * The launcher is spawn-bounded: *set up, exec, tear down, no daemon* (INV-5c).
 * This module is the typed envelope of everything the launcher is responsible
 * for, pinned to the only two moments it exists:
 *
 *   - **Spawn** — the {@link LaunchEnvelopeSchema} envelope
 *     (`workspaceRef`, `rehydrationDoc`, `posture`) is validated fail-closed,
 *     the materialized worktree's tree-hash is verified against the envelope's
 *     workspaceRef fingerprint ({@link verifyLaunchWorkspace} — a mismatch
 *     REFUSES the spawn with a structured error; no session ever spawns
 *     against an unverified workspace), and the spawn-boundary lifecycle event
 *     `worktree.created` is emitted on the launch's workflow stream.
 *   - **Teardown** — {@link finalizeLaunchWorkspace} re-validates the envelope
 *     (the contract is checked at BOTH boundaries), observes the worktree's
 *     final `{treeHash, dirty}` state (never destructively — the probe is a
 *     pure read), and emits the paired `worktree.finalized` terminal.
 *
 * No mid-session responsibility accrues here (INV-5c / INV-12): the launcher
 * owns *lifecycle*, not counter-watching, forced termination, or
 * filesystem-write confinement. Anything mid-session belongs to the
 * dispatch/MCP seam (DR-14's context-rot counter consumes this envelope there).
 *
 * ## Tree-hash verification reuses the DR-16 fingerprint machinery
 *
 * `workspaceRef` embeds the exact `StateFingerprintSchema` shape
 * (`{treeHash, projectionSequence}`, #1645) plus the `commit`, so fail-closed
 * verification is a delegation to {@link detectStateFingerprintDrift} — the
 * SAME drift detector the INV-13 crash-recovery precheck uses. One fingerprint
 * vocabulary, one comparison seam; no parallel hash-comparison machinery.
 *
 * ## Intent-fidelity field audit (2026-07-06 scope addition — design note)
 *
 * The spawn envelope is the dispatch-time compiler's chokepoint: the one place
 * strategic intent is compiled into a tactical session's starting context.
 * Every envelope field, its type class, and its CONSUMING seam:
 *
 * | Field                          | Class        | Consuming seam |
 * |--------------------------------|--------------|----------------|
 * | `workspaceRef.commit`          | typed (ref)  | worktree-create seam: `runLifecycle` threads it as the `git worktree add` start-point (`CreateLauncherWorktreeInput.startPoint`), pinning the materialized workspace to the exact commit the dispatcher compiled against. Recorded on `worktree.created.commit`. |
 * | `workspaceRef.treeHash`        | typed (hash) | spawn-boundary fail-closed gate: {@link verifyLaunchWorkspace} → {@link detectStateFingerprintDrift} (DR-16). Recorded on `worktree.created.treeHash`; re-observed at teardown as `worktree.finalized.treeHash`. |
 * | `workspaceRef.projectionSequence` | typed (seq) | DR-16 causal anchor: recorded on `worktree.created.projectionSequence` so crash-recovery / audit can correlate the spawn against the stream's fold position; DR-14 (task 013) reads it as the rehydration doc's staleness anchor at the dispatch seam. |
 * | `rehydrationDoc`               | PROSE (load-bearing) | spawn-time orientation-injection seam: `runLifecycle` defaults the injection content to this doc (`OrientationInjectionDeps.content` → `applyOrientationChannel`), so the compiled session context reaches the child's native channel. AUDIT FLAG: this is the envelope's one load-bearing prose field — nominated for typing (structured rehydration doc) in the follow-on audit; typed fields are compiled intent, prose is where intent silently decays. |
 * | `posture`                      | typed (enum) | capability posture seam (INV-11): the `AgentPosture` the spawned session's capability bundle resolves under (`capabilities/resolver.ts` posture handshake). The launcher RECORDS it on `worktree.created.posture` for audit — it does not enforce it (lifecycle, not writes). |
 *
 * Every field traces to a consuming seam; no field rides the envelope as
 * unconsumed freight.
 */

import { z } from 'zod';
import type { EventStore } from '../event-store/store.js';
import {
  StateFingerprintSchema,
  detectStateFingerprintDrift,
  type StateFingerprintDriftVerdict,
} from '../event-store/schemas.js';
import { withStateRetry } from '../workflow/state-retry.js';
import {
  defaultGitRunner,
  type GitRunner,
} from '../orchestrate/worktree/manager.js';
import { AgentPosture } from '../agents/spec.js';

// ============================================================
// Lifecycle event types (contract boundary)
// ============================================================

/** Spawn-boundary contract lifecycle event (already registered; launcher shape). */
export const WORKTREE_CREATED = 'worktree.created';
/** Teardown-boundary contract lifecycle terminal (registered by DR-13). */
export const WORKTREE_FINALIZED = 'worktree.finalized';

// ============================================================
// Envelope schema (validated at spawn AND teardown)
// ============================================================

/**
 * The workspace reference: the commit the workspace is materialized at PLUS the
 * DR-16 state fingerprint (`{treeHash, projectionSequence}` — the exact
 * {@link StateFingerprintSchema} shape, spread so the two stay structurally
 * identical). Strict: an unknown field is rejected, not stripped — the envelope
 * is a contract, and silent freight is how intent decays.
 */
export const LaunchWorkspaceRefSchema = z.strictObject({
  commit: z
    .string()
    .min(1)
    .describe('Commit-ish the workspace is materialized at (git worktree add start-point)'),
  ...StateFingerprintSchema.shape,
});

export type LaunchWorkspaceRef = z.infer<typeof LaunchWorkspaceRefSchema>;

/**
 * DR-13 spawn/teardown envelope — everything the launcher is responsible for.
 * Strict at every level: an unknown field anywhere in the envelope is a
 * validation REJECTION (fail-closed), never a silent strip.
 */
export const LaunchEnvelopeSchema = z.strictObject({
  workspaceRef: LaunchWorkspaceRefSchema,
  rehydrationDoc: z
    .string()
    .min(1)
    .describe('Compiled session-starting context injected at spawn (orientation seam)'),
  posture: AgentPosture.describe(
    'INV-11 trust posture the spawned session resolves capabilities under',
  ),
});

export type LaunchEnvelope = z.infer<typeof LaunchEnvelopeSchema>;

/**
 * Self-correcting `expectedShape` payload for a structured
 * `LAUNCH_ENVELOPE_INVALID` error (INV-5b): the documented envelope shape an
 * agent can repair against without parsing prose.
 */
export const LAUNCH_ENVELOPE_EXPECTED_SHAPE = {
  workspaceRef: {
    commit: 'string (non-empty commit-ish)',
    treeHash: 'string (non-empty git tree-hash)',
    projectionSequence: 'number (int >= 0)',
  },
  rehydrationDoc: 'string (non-empty)',
  posture: "'read-only' | 'task-isolated' | 'shared-mutating'",
} as const;

/** Outcome of {@link parseLaunchEnvelope}. */
export type LaunchEnvelopeParse =
  | { readonly ok: true; readonly envelope: LaunchEnvelope }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validate an untrusted spawn envelope at the contract boundary. Structured:
 * a failure carries one `path: message` line per Zod issue so the refusal is
 * self-correcting, never a prose dump.
 */
export function parseLaunchEnvelope(input: unknown): LaunchEnvelopeParse {
  const parsed = LaunchEnvelopeSchema.safeParse(input);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '<envelope>'}: ${issue.message}`,
    ),
  };
}

// ============================================================
// Workspace observation probe (tree-hash + dirty)
// ============================================================

/** What the workspace probe observed. `null` = unprobeable (e.g. non-git target). */
export interface WorkspaceObservation {
  /** `git rev-parse HEAD^{tree}` of the worktree, or `null` when unprobeable. */
  readonly treeHash: string | null;
  /** Whether uncommitted work is present, or `null` when unprobeable. */
  readonly dirty: boolean | null;
}

/** Injectable workspace-observation seam — deterministic in tests, git in production. */
export type WorkspaceProbe = (worktreePath: string) => WorkspaceObservation;

/**
 * Build a {@link WorkspaceProbe} over a {@link GitRunner} (the single git seam
 * the WLM already routes through — no scattered `execFile`). Pure reads only:
 * `rev-parse HEAD^{tree}` for the committed tree-hash, `status --porcelain`
 * for the dirty flag. Any git failure observes `null` — the caller decides the
 * fail-closed consequence.
 */
export function makeGitWorkspaceProbe(gitRunner: GitRunner = defaultGitRunner): WorkspaceProbe {
  return (worktreePath) => {
    const tree = gitRunner.run(['rev-parse', 'HEAD^{tree}'], worktreePath);
    const treeHash =
      tree.status === 0 && tree.stdout.trim().length > 0 ? tree.stdout.trim() : null;
    if (treeHash === null) {
      // Not a probeable git worktree — dirty is unknowable too.
      return { treeHash: null, dirty: null };
    }
    const status = gitRunner.run(['status', '--porcelain'], worktreePath);
    const dirty = status.status === 0 ? status.stdout.trim().length > 0 : null;
    return { treeHash, dirty };
  };
}

/** The production workspace probe (real git via {@link defaultGitRunner}). */
export const defaultWorkspaceProbe: WorkspaceProbe = makeGitWorkspaceProbe();

// ============================================================
// Fail-closed tree-hash verification (spawn boundary)
// ============================================================

/** Outcome of {@link verifyLaunchWorkspace} — refusal reasons are a closed set. */
export type LaunchWorkspaceVerification =
  | { readonly ok: true; readonly treeHash: string }
  | {
      readonly ok: false;
      readonly reason: 'tree-hash-mismatch';
      readonly expectedTreeHash: string;
      readonly observedTreeHash: string;
    }
  | { readonly ok: false; readonly reason: 'unverifiable'; readonly detail: string };

/** Injectable seams for {@link verifyLaunchWorkspace} / {@link finalizeLaunchWorkspace}. */
export interface LaunchContractDeps {
  /** Workspace probe; defaults to {@link defaultWorkspaceProbe}. */
  readonly probe?: WorkspaceProbe;
}

/**
 * Fail-closed spawn-boundary verification: probe the materialized worktree's
 * tree-hash and compare it against the envelope's workspaceRef fingerprint via
 * the DR-16 {@link detectStateFingerprintDrift} detector (the workspaceRef IS
 * a {@link StateFingerprintSchema} + commit, so the drift verdict comes from
 * the same machinery the INV-13 crash-recovery precheck uses — no parallel
 * comparison path). Every non-`match` verdict — drift OR an unprobeable tree —
 * REFUSES the spawn: no session runs against an unverified workspace.
 */
export function verifyLaunchWorkspace(
  envelope: LaunchEnvelope,
  worktreePath: string,
  deps: LaunchContractDeps = {},
): LaunchWorkspaceVerification {
  const probe = deps.probe ?? defaultWorkspaceProbe;
  const observed = probe(worktreePath);
  if (observed.treeHash === null) {
    return {
      ok: false,
      reason: 'unverifiable',
      detail: `worktree at '${worktreePath}' has no probeable tree-hash (non-git target or rev-parse failure)`,
    };
  }
  const verdict: StateFingerprintDriftVerdict = detectStateFingerprintDrift(
    { data: { stateFingerprint: envelope.workspaceRef } },
    observed.treeHash,
  );
  if (verdict.status === 'drift') {
    return {
      ok: false,
      reason: 'tree-hash-mismatch',
      expectedTreeHash: verdict.recorded.treeHash,
      observedTreeHash: verdict.observedTreeHash,
    };
  }
  if (verdict.status === 'unfingerprinted') {
    // Unreachable for a parsed envelope (workspaceRef always carries the
    // fingerprint) — but an unverifiable fingerprint still fails CLOSED.
    return {
      ok: false,
      reason: 'unverifiable',
      detail: 'workspaceRef carried no parseable state fingerprint',
    };
  }
  return { ok: true, treeHash: verdict.recorded.treeHash };
}

// ============================================================
// Contract binding + lifecycle event emission
// ============================================================

/**
 * The validated contract a launch carries from spawn through teardown: the
 * parsed envelope, the workflow stream its lifecycle events land on, and the
 * (injectable) workspace probe. Built by `runLifecycle` AFTER envelope
 * validation + tree-hash verification pass; threaded into the teardown seam via
 * `LifecycleTeardownContext.contract`.
 */
export interface LaunchContractBinding {
  readonly envelope: LaunchEnvelope;
  /** Stream the contract lifecycle events land on (the launch's workflow stream). */
  readonly streamId: string;
  /** Workspace probe; defaults to {@link defaultWorkspaceProbe}. */
  readonly probe?: WorkspaceProbe;
}

/** Identity of the launch worktree the contract events describe. */
export interface LaunchWorktreeIdentity {
  /** Canonical `worktrees@v1` key of the launch worktree. */
  readonly worktreeId: string;
  /** On-disk path of the launch worktree. */
  readonly worktreePath: string;
}

/**
 * Emit the spawn-boundary `worktree.created` lifecycle event (launcher shape:
 * `path`/`worktreeId`/`treeHash`/`commit`/`projectionSequence`/`posture`) on
 * the contract stream. Idempotency-keyed by `worktreeId` — one launch worktree
 * maps to one spawn, so a crash-resume re-emission collapses to the original
 * row. Call ONLY after {@link verifyLaunchWorkspace} passed: the recorded
 * `treeHash` is by construction the VERIFIED hash.
 */
export async function emitLaunchWorktreeCreated(
  eventStore: EventStore,
  binding: LaunchContractBinding,
  identity: LaunchWorktreeIdentity,
): Promise<void> {
  await withStateRetry(() =>
    eventStore.append(
      binding.streamId,
      {
        type: WORKTREE_CREATED,
        data: {
          path: identity.worktreePath,
          worktreeId: identity.worktreeId,
          treeHash: binding.envelope.workspaceRef.treeHash,
          commit: binding.envelope.workspaceRef.commit,
          projectionSequence: binding.envelope.workspaceRef.projectionSequence,
          posture: binding.envelope.posture,
        },
      },
      { idempotencyKey: `${WORKTREE_CREATED}:${identity.worktreeId}` },
    ),
  );
}

/** Outcome of {@link finalizeLaunchWorkspace}. */
export interface FinalizeLaunchOutcome {
  /**
   * True iff the `worktree.finalized` terminal is durably present after this
   * call (freshly appended, or collapsed onto an earlier append by the
   * idempotency key). False only when the emission was REFUSED.
   */
  readonly emitted: boolean;
  /** Present iff the emission was refused (the envelope failed re-validation). */
  readonly reason?: 'invalid-envelope';
  /** Observed tree-hash at teardown (`null` when unprobeable / not emitted). */
  readonly treeHash: string | null;
  /** Observed dirty flag at teardown (`null` when unprobeable / not emitted). */
  readonly dirty: boolean | null;
}

/**
 * Teardown-boundary finalize: re-validate the envelope (the contract is
 * validated at BOTH boundaries — a hand-built malformed binding never emits),
 * observe the worktree's final `{treeHash, dirty}` state via the pure-read
 * probe (never destructive; WIP is reported, never discarded — INV-14), and
 * emit the `worktree.finalized` terminal on the contract stream. Idempotency-
 * keyed by `worktreeId` so a teardown path AND a signal path collapse to one
 * persisted row. Never throws on the probe path — teardown must always
 * complete.
 */
export async function finalizeLaunchWorkspace(
  eventStore: EventStore,
  binding: LaunchContractBinding,
  identity: LaunchWorktreeIdentity & { readonly exitCode: number | null },
  deps: LaunchContractDeps = {},
): Promise<FinalizeLaunchOutcome> {
  const revalidated = parseLaunchEnvelope(binding.envelope);
  if (!revalidated.ok) {
    return { emitted: false, reason: 'invalid-envelope', treeHash: null, dirty: null };
  }
  const probe = deps.probe ?? binding.probe ?? defaultWorkspaceProbe;
  // Never throws on the probe path (see docstring): teardown must always
  // complete. The production makeGitWorkspaceProbe maps git failures to the
  // unprobeable observation internally, but the probe/GitRunner seam is
  // injectable and the teardown caller (teardown.ts step (1b)) awaits this
  // OUTSIDE any try/catch, ahead of the safety gates and reservation release —
  // so a throwing probe maps to the SAME unprobeable arm a non-git target
  // would, making the guarantee true by construction.
  let observed: WorkspaceObservation;
  try {
    observed = probe(identity.worktreePath);
  } catch {
    observed = { treeHash: null, dirty: null };
  }
  await withStateRetry(() =>
    eventStore.append(
      binding.streamId,
      {
        type: WORKTREE_FINALIZED,
        data: {
          path: identity.worktreePath,
          worktreeId: identity.worktreeId,
          treeHash: observed.treeHash,
          dirty: observed.dirty,
          exitCode: identity.exitCode,
        },
      },
      { idempotencyKey: `${WORKTREE_FINALIZED}:${identity.worktreeId}` },
    ),
  );
  return { emitted: true, treeHash: observed.treeHash, dirty: observed.dirty };
}
