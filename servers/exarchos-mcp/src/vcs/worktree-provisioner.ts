/**
 * P04-05 follow-up — the owner-backed worktree provisioner.
 *
 * This is the production wiring that routes the real `setup_worktree` action's
 * branch+worktree creation through the single typed {@link VcsMutationOwner}.
 * Before this seam, `orchestrate/setup-worktree.ts` created a branch and a
 * worktree with two bare `execFileSync('git', …)` calls and recorded NO event —
 * the exact observed defect the work package exists to prevent: an interrupted
 * run left a worktree AND branch on disk with no corresponding `worktree.created`
 * event, an event-less orphan a reconciler could never find.
 *
 * Routing through the owner makes creation:
 *   - **atomic-with-event** — a durable INTENT (`vcs.requested`) is recorded
 *     before the git mutation and a TERMINAL (`vcs.executed`) after, so an
 *     interrupted run leaves a discoverable intent, never an event-less orphan;
 *   - **idempotent** — the idempotency key (the worktree path) makes a duplicate
 *     `setup_worktree` request replay the recorded outcome → exactly ONE worktree;
 *   - **convergent** — a retry after an interrupt re-runs the probe-before-mutate
 *     effect (which no-ops) and records the missing terminal;
 *   - **compensating** — a partial failure (branch minted, `worktree add` fails)
 *     deletes the minted branch so no orphaned on-disk state survives.
 *
 * The setup-worktree handler consumes this via an injected seam so unit tests
 * substitute an in-memory fake; production uses {@link createOwnerBackedWorktreeProvisioner}.
 */

import { join } from 'node:path';
import { capabilitiesForPosture } from '../capabilities/posture-mapping.js';
import { isError, isSuccess, type EffectOutcome } from '../core/effect-carrier.js';
import { EventStore } from '../event-store/store.js';
import {
  VcsMutationOwner,
  type VcsGitRunner,
  type WorktreeCreateResult,
} from './mutation-owner.js';

/** One branch+worktree provisioning request from the setup-worktree action. */
export interface WorktreeProvisionRequest {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly base: string;
}

/**
 * The provisioning result the setup-worktree handler maps to its two report
 * checks ("Branch created" / "Worktree created"). `branchCreated` /
 * `worktreeCreated` are `false` when the target already existed (an idempotent
 * no-op), so the report reads "already exists" — matching the legacy contract.
 */
export interface WorktreeProvisionOutcome {
  readonly ok: boolean;
  /** `true` = branch was minted this call; `false` = it already existed. */
  readonly branchCreated: boolean;
  /** `true` = worktree was added this call; `false` = it already existed. */
  readonly worktreeCreated: boolean;
  /** Present when `ok` is `false`: the structured failure detail for the report. */
  readonly failureDetail?: string;
}

/** The injectable branch+worktree provisioning seam. */
export interface WorktreeProvisioner {
  provision(request: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome>;
}

/**
 * Map a {@link VcsMutationOwner.createWorktree} carrier to the provisioning
 * outcome the setup-worktree handler consumes. Exported so the production
 * provisioner and integration tests share ONE mapping (no drift):
 *   - success   → ok, with `branchCreated`/`worktreeCreated` reflecting whether
 *                 each was minted this call (false = idempotent no-op / replay);
 *   - error     → not-ok, carrying the failure message for the report;
 *   - dry-run   → not-ok (the caller lacked shared-mutating capability and the
 *                 owner degraded to a no-mutation plan — a typed non-provision).
 */
export function mapWorktreeOutcome(
  outcome: EffectOutcome<WorktreeCreateResult>,
): WorktreeProvisionOutcome {
  if (isSuccess(outcome)) {
    return {
      ok: true,
      branchCreated: outcome.value.createdBranch,
      worktreeCreated: outcome.value.createdWorktree,
    };
  }
  if (isError(outcome)) {
    return {
      ok: false,
      branchCreated: false,
      worktreeCreated: false,
      failureDetail: outcome.error.message,
    };
  }
  return {
    ok: false,
    branchCreated: false,
    worktreeCreated: false,
    failureDetail:
      'VCS mutation degraded to dry-run (caller lacks shared-mutating capability)',
  };
}

export interface OwnerBackedProvisionerOptions {
  /** Injectable git runner (default: real git via the portable spawn primitive). */
  readonly gitRunner?: VcsGitRunner;
  /** Ledger directory resolver (default: `<repoRoot>/.git/exarchos/vcs-mutations`). */
  readonly ledgerDir?: (repoRoot: string) => string;
}

/**
 * The default ledger location: inside `.git` so the VCS-mutation event log is
 * durable, repo-local, and never tracked. `setup_worktree` runs from the
 * orchestrator's main checkout, where `.git` is a directory.
 */
export function defaultVcsLedgerDir(repoRoot: string): string {
  return join(repoRoot, '.git', 'exarchos', 'vcs-mutations');
}

/**
 * Build the production provisioner: each call opens the durable VCS-mutation
 * EventStore, routes branch+worktree creation through {@link VcsMutationOwner}
 * (shared-mutating capability — `setup_worktree` lands on the shared `.git`),
 * and closes the store. The idempotency key is the worktree path, so a duplicate
 * `setup_worktree` for the same task replays exactly ONE creation.
 */
export function createOwnerBackedWorktreeProvisioner(
  options: OwnerBackedProvisionerOptions = {},
): WorktreeProvisioner {
  const resolveLedgerDir = options.ledgerDir ?? defaultVcsLedgerDir;
  return {
    async provision(request: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome> {
      const store = new EventStore(resolveLedgerDir(request.repoRoot));
      await store.initialize();
      try {
        const owner = new VcsMutationOwner({
          eventStore: store,
          capabilities: capabilitiesForPosture('shared-mutating'),
          // A dedicated stream isolates setup_worktree's fencing/idempotency
          // from other VCS mutations sharing the default stream.
          stream: 'vcs-worktree-setup',
          ...(options.gitRunner !== undefined ? { gitRunner: options.gitRunner } : {}),
        });
        const outcome = await owner.createWorktree({
          repoRoot: request.repoRoot,
          worktreePath: request.worktreePath,
          branch: request.branch,
          base: request.base,
          // Path-keyed: a duplicate setup_worktree for the same worktree replays.
          idempotencyKey: `worktree-setup:${request.worktreePath}`,
          // setup_worktree has no owner-takeover model; a single constant epoch
          // on a dedicated stream never fences itself out.
          epoch: 1,
        });
        return mapWorktreeOutcome(outcome);
      } finally {
        store.close();
      }
    },
  };
}
