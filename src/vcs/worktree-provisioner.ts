/**
 * Owner-backed worktree provisioner. It sends the branch and worktree creation
 * of the `setup_worktree` action through the typed {@link VcsMutationOwner}.
 *
 * The owner records a durable intent (`vcs.requested`) before the git mutation
 * and a terminal event after it. Thus an interrupted run leaves an intent that
 * a reconciler can find. The worktree path is the idempotency key, so a
 * duplicate request replays the recorded outcome. A retry after an interrupt
 * records the missing terminal. If `worktree add` fails after the owner
 * creates the branch, the owner deletes that branch.
 *
 * The setup-worktree handler gets this provisioner through an injected seam,
 * so unit tests can use an in-memory fake.
 */

import { join } from 'node:path';
import { capabilitiesForPosture } from '../workflow/capabilities/posture-mapping.js';
import { isError, isSuccess, type EffectOutcome } from '../dispatch/core/effect-carrier.js';
import { EventStore } from '../events/store.js';
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
 * The result that the setup-worktree handler maps to its "Branch created" and
 * "Worktree created" report checks. A `false` flag means that the target
 * already existed, so the report reads "already exists".
 */
export interface WorktreeProvisionOutcome {
  readonly ok: boolean;
  /** True when this call created the branch. False when it already existed. */
  readonly branchCreated: boolean;
  /** True when this call added the worktree. False when it already existed. */
  readonly worktreeCreated: boolean;
  /** Present when `ok` is `false`: the structured failure detail for the report. */
  readonly failureDetail?: string;
}

/** The injectable branch+worktree provisioning seam. */
export interface WorktreeProvisioner {
  provision(request: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome>;
}

/**
 * Maps a {@link VcsMutationOwner.createWorktree} carrier to a provisioning
 * outcome. The production provisioner and the integration tests share it.
 *
 * - Success: `ok`, with flags that show what this call created.
 * - Error: not `ok`, with the failure message.
 * - Dry run: not `ok`. The caller did not have the shared-mutating capability.
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
 * Default ledger location, inside `.git`, so that git does not track the
 * VCS-mutation event log. `setup_worktree` runs from the main checkout, where
 * `.git` is a directory.
 */
export function defaultVcsLedgerDir(repoRoot: string): string {
  return join(repoRoot, '.git', 'exarchos', 'vcs-mutations');
}

/**
 * Builds the production provisioner. Each call opens the VCS-mutation
 * `EventStore`, creates the branch and worktree through {@link VcsMutationOwner},
 * and closes the store.
 *
 * The calls use a dedicated stream, so their fencing and idempotency stay apart
 * from other VCS mutations. The idempotency key is the worktree path. The epoch
 * is a constant 1, because `setup_worktree` has no owner takeover, so it never
 * fences itself out.
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
          stream: 'vcs-worktree-setup',
          ...(options.gitRunner !== undefined ? { gitRunner: options.gitRunner } : {}),
        });
        const outcome = await owner.createWorktree({
          repoRoot: request.repoRoot,
          worktreePath: request.worktreePath,
          branch: request.branch,
          base: request.base,
          idempotencyKey: `worktree-setup:${request.worktreePath}`,
          epoch: 1,
        });
        return mapWorktreeOutcome(outcome);
      } finally {
        store.close();
      }
    },
  };
}
