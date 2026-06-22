# Mining `treehouse` for Worktree + Merge-Orchestration Patterns

**Date:** 2026-06-21
**Workflow:** `treehouse-worktree-mining` (discovery)
**Trigger:** Empirically analyze [`kunchenguid/treehouse`](https://github.com/kunchenguid/treehouse) (v1.7.0) to decide whether to build a *holistic worktree-management library/service* internally in Exarchos. Follow-up to closed epic [#1302](https://github.com/lvlup-sw/exarchos/issues/1302) (merge-orchestrator hardening, shipped in [PR #1571](https://github.com/lvlup-sw/exarchos/pull/1571)).
**Reads against:** [`docs/research/2026-05-08-1119-merge-orchestrator-audit.md`](2026-05-08-1119-merge-orchestrator-audit.md) — canonical framing *"Exarchos is a single-machine event-sourced process manager with cooperative agents."*
**Method:** Full source read of treehouse (`internal/pool`, `internal/git`, `internal/process`, `internal/hooks`, lock primitives, `cmd/return`, README/AGENTS/CHANGELOG) + a mapped survey of Exarchos's worktree + merge surface.

---

## 1. Executive summary

Treehouse is a daemonless Go CLI that manages a **pool of reusable, pre-warmed git worktrees** so each agent gets instant isolation without re-cloning or losing build cache. It is small (~10 source files), cross-platform, and well-engineered around a single tight loop: *acquire an idle clean worktree → work → terminate stragglers → reset → return to pool.*

**The headline finding is a split verdict:**

- **Do NOT adopt treehouse's *model* (the pool) wholesale, and do NOT vendor the binary.** Its central value proposition — long-lived *reused, detached-HEAD* worktrees — structurally collides with two facts about Exarchos: (a) Claude Code's **native `isolation: worktree`** now creates its own `.claude/worktrees/agent-*` and ignores any worktree Exarchos pre-creates ([memory: CC-native-isolation-overrides-setup_worktree, #1568]); and (b) Exarchos's substrate is a **SQLite event store with projections-as-cache**, whereas treehouse deliberately uses a JSON file + `flock` and *no event log* ("no state to get corrupted"). The pool model and the JSON-flock substrate are both correct *for treehouse* and wrong-shape *for Exarchos*.

- **DO mine treehouse's *mechanisms*.** Five of its primitives map directly onto open, painful Exarchos gaps and are essentially absent today: **process-cwd in-use detection**, **PID+start-time owner reservation with heal-on-read**, the **safe-prune safety ladder + orphan classification**, **cross-platform process/lock seams**, and **protected-process termination**. These are algorithm-level patterns that re-host cleanly onto Exarchos's event-sourced substrate.

- **The "holistic library" is worth building — but scope it as a *lifecycle + safety manager, not a pool*,** and converge it with the **v2.12 process-lifecycle verbs** (`ps`/`wait`/`describe`) the merge audit already committed to. Treehouse's process-introspection is, almost exactly, the missing implementation those verbs need.

**One-line recommendation:** *Build an internal, event-sourced `WorktreeManager` that consolidates today's scattered worktree surface and harvests treehouse's safety mechanisms — but reject its pool model and its JSON+flock substrate. Treat treehouse as a reference implementation and, optionally, as an external power-user path for humans driving manual multi-agent sessions outside the orchestrator.*

---

## 2. What treehouse actually is (empirical)

### 2.1 The model

A **per-repo pool** of N worktrees under `~/.treehouse/<repo>-<hash>/<n>/<repo>` (`max_trees`, default 16). `treehouse` (alias `get`) finds an idle, clean, unused worktree, resets it to the latest default branch, and drops you into a subshell. On `exit`/`return` it kills lingering processes, detaches + resets the worktree, and returns it to the pool **with dependencies and build cache intact** — that reuse is the entire point.

```
get → fetch → scan pool for (not in-use ∧ not dirty) → reuse+reset OR create new (if < max) → reserve owner → run post_create hook → subshell
return → [confirm if dirty] → detach HEAD → kill lingering (protected) procs → reset → clear reservation
```

### 2.2 The mechanisms (this is the harvestable part)

| Mechanism | Where | What it does |
|---|---|---|
| **Detached-HEAD worktrees** | `git.go:AddWorktree` (`worktree add --detach`), `ResetWorktree` | Worktrees never hold a *branch name*, so git's "a branch can only be checked out in one worktree" rule can never bite. Reset to whichever of local/`origin` default is further ahead (`branchRef` prefers `origin` on divergence). |
| **Process-cwd in-use detection** | `process/detect.go:FindProcessesInWorktree` | Enumerates *all* processes (gopsutil), resolves each process's `cwd` (+ symlink canonicalization for macOS `/private/var`), and flags the worktree in-use if any cwd is inside it. **No cooperative signaling required.** |
| **Owner reservation (crash-safe)** | `pool.go:reserveOwner/ownerAlive`, `state.go:WorktreeEntry` | Short-lived reservation = `OwnerPID` + `OwnerStartedAt` (process *create-time*). `ownerAlive` validates PID **and** start-time, defeating PID reuse. Persisted only while a lifecycle op runs. |
| **Heal-on-read** | `pool.go:healState` | Every state read drops entries whose path is gone and clears reservations whose owner is dead. Self-healing replaces a daemon/GC. |
| **Untracked-aware dirty check** | `git.go:IsDirty` | `git status --porcelain --untracked-files=all` — treats untracked files as dirty **even when `status.showUntrackedFiles` hides them**. Defends against config-hidden drift. |
| **Safe-prune ladder + orphan class** | `pool/prune.go` | Skips in-use → dirty → unmerged (`merge-base --is-ancestor HEAD <ref>`); **fails closed** on `origin unreachable (cannot verify)`; classifies backing-repo-missing **orphans** (reads the `.git` gitdir pointer, stats it) and refuses to delete them without `--prune-orphans --yes`, marking each "content could not be verified". Dry-run is the default. |
| **Plan → reserve → re-verify → commit** | `prune.go:planPrune`/`executePrune`, `pool.go:Destroy` | TOCTOU defense: snapshot+plan under lock, run hooks *outside* lock, re-acquire lock and re-check `sameDestroyReservation` + a *final* safety check before deletion. |
| **Protected-process termination** | `process/terminate.go:filterProtectedProcesses` | Walks the **parent chain of the current process** and protects the whole ancestry, so `return` (running inside the worktree subshell) never SIGKILLs itself or its parent shell. SIGTERM → grace → SIGKILL on unix; `TerminateProcess` on windows. |
| **Cross-platform seams** | `lock_{unix,windows}.go`, `process/terminate_{unix,windows}.go`, `updater/sysproc_*.go` | Build-tag split: `flock` vs `LockFileEx`; gopsutil for portable process introspection. CI matrix runs ubuntu + macOS + windows. |
| **User-only lifecycle hooks** | `hooks/hooks.go`, README | `post_create`/`pre_destroy` shell hooks **read from user-level config only** — repo-level hooks are ignored *for safety* (a cloned repo can't run code on you). Hook failures are logged, never abort the operation. |
| **Pool identity by remote URL** | CHANGELOG v1.2.1 | Pool hash keyed on remote URL (falls back for local repos) so clones of the same repo share a pool. |

### 2.3 The bug history is itself a source

Treehouse has already *paid for* a set of worktree-automation bugs Exarchos can pre-empt:

| treehouse fix | Lesson for Exarchos |
|---|---|
| #19 **"detach worktrees before pool reuse"** | The branch-name-collision footgun (git refuses `worktree add` at a branch already checked out elsewhere). This is the *same class* as Exarchos's `worktree.baseRef` pain ([#1512]) and sibling-collision guard ([#1356]). Detaching idle worktrees is the clean escape. |
| #17 **"safely clean up lingering worktree processes"** | Naive process termination kills your own session. `filterProtectedProcesses` is the fix — **critical** given Exarchos's "shell cwd drifts into agent worktree" hazard ([memory]). |
| #24/#26/#28 **safe prune → global prune → orphan classification** | Worktree GC is *non-trivial*; it took 3 iterations to get the safety ladder right. Don't underestimate it. |
| #22 **user lifecycle hooks** | Hooks belong at user scope, not repo scope. |
| v1.2.1 **remote-URL pool hash** | Worktree-store identity needs a stable key independent of cwd. |

---

## 3. Architecture-fit analysis

### 3.1 Three structural clashes (why the *model* doesn't port)

**Clash A — Pool/reuse vs. per-task named branch + CC native isolation.**
Treehouse: worktree ≠ task; a small pool of *reused, detached-HEAD* worktrees is recycled across sessions. Exarchos: worktree = task; each task gets a *fresh* worktree with a *named work branch* that is later merged and discarded. More decisively, Exarchos now dispatches through Claude Code's **native `isolation: worktree`**, which creates its own `.claude/worktrees/agent-*` based on `HEAD` and **ignores any worktree Exarchos pre-creates** ([memory: CC-native-isolation-overrides-setup_worktree]; `#1568` even denies writes outside it). A pool manager fundamentally wants to *own* worktree creation and hand one to the worker — exactly the seam CC native isolation has taken away. The reuse-to-preserve-build-cache value prop is therefore largely **unreachable** for orchestrator-dispatched agents (they get a fresh CC-managed worktree regardless).

**Clash B — JSON+flock substrate vs. event store.**
Treehouse's design decision "**No daemon — no state to get corrupted**" leans on a single `treehouse-state.json` guarded by `flock`/`LockFileEx`. Exarchos's [#1302 audit] is explicit and load-bearing: the event store is the WAL/source of truth, **state is a projection (cache, not authority)**, concurrency is OCC via `expectedSequence` + idempotency keys, and `INV-1` mandates stores-as-projections. Copying treehouse's JSON-file-as-authority would *reintroduce* the second-source-of-truth smell the merge audit spent S-1..S-3 removing. **Mine the algorithms; reject the substrate.**

**Clash C — Daemonless inline CLI vs. cooperative agent runtime.**
Treehouse's heal-on-read works because the human runs discrete commands. Exarchos's worktrees are touched by *concurrent cooperative agents* plus the orchestrator's own shell, whose cwd can drift into an agent worktree on background-completion ([memory: shell-cwd-drifts-to-agent-worktree]). This makes process-cwd detection a **double-edged sword** (see §5).

### 3.2 Where the model *does* fit

- **Single-machine, local-execution, git-native** — both systems share the foundational assumptions. None of treehouse's git semantics are distributed-systems-shaped, so they transfer cleanly.
- **Power-user / human-driven sessions** — for a developer manually fanning out N agents *outside* the orchestrator, treehouse's pool is genuinely good and complements (does not compete with) Exarchos. This is consistent with the "extensibility & power-user envelope" design value.
- **The v2.12 process-lifecycle verbs** — the merge audit (S-6, R-5) deliberately rejected per-feature supervisors in favor of *generic* `ps`/`wait`/`describe` verbs that query liveness signals. **Treehouse's `FindProcessesInWorktree` is a working, cross-platform implementation of the introspection those verbs need.** This is the cleanest convergence in the whole analysis.

---

## 4. Mineable patterns catalog (ranked by Exarchos value)

Each pattern is mapped to a concrete open gap. "Substrate note" = how to re-host it event-sourced instead of JSON+flock.

### P1 — Process-cwd in-use detection → liveness substrate for v2.12 verbs + isolation-boundary hardening. **(Highest value.)**
`FindProcessesInWorktree` answers "is anyone *actually working* in this worktree right now?" without cooperative signaling. Exarchos has **no** process-based in-use check today.
- **Fixes/feeds:** the v2.12 `ps`/`wait`/`describe` surface (audit R-5); a structural guard before mutating/merging a worktree a sibling agent is live in (`#1301` boundary leak, OPEN; `#1220`).
- **Substrate note:** expose as a read-only projection helper (`exarchos_view ps`-style) that folds live process scan + `worktree.*` events; do not persist process state.
- **Caveat:** must ship with P5's protected-process logic and a way to exclude the orchestrator's own (drifted) shell — see §5.

### P2 — PID + start-time owner reservation with heal-on-read → crash-safe worktree ownership.
`reserveOwner`/`ownerAlive`/`healState` give a reservation that survives crashes (dead owner → auto-cleared) and resists PID reuse (start-time check).
- **Fixes:** the stash-collision-across-worktrees and stale-worktree-after-external-push hazards ([memory]) are ownership/TOCTOU failures this directly addresses; gives a principled answer to "who owns this `.claude/worktrees/agent-*` right now?"
- **Substrate note:** model as `worktree.reserved` / `worktree.released` events with `{ownerPid, ownerStartedAt}`; the "reservation" is a projection, `healState` becomes a reconcile pass. Aligns with `INV-1`.

### P3 — Safe-prune ladder + orphan classification → the worktree GC Exarchos entirely lacks.
**Critical clarification:** Exarchos's existing `/exarchos:prune` (`prune-stale-workflows.ts`) prunes **stale *workflows* from the pipeline** (topology-gated; the `topology_not_loaded` block, `#1545`). It does **not** touch worktree disk. Exarchos has **zero worktree-disk GC** — abandoned `.claude/worktrees/agent-*`, locked worktrees from crashed `/delegate` runs ([memory: delegate-inline-crash-resilient]), and orphans accumulate unbounded.
- **Adopt:** the full ladder — skip in-use → skip dirty (untracked-aware) → skip unmerged (`merge-base --is-ancestor`) → classify backing-repo-missing **orphans**, **fail-closed** on origin-unreachable, dry-run default, grouped scannable skip reasons, plan→reserve→re-verify→commit.
- **Substrate note:** emit `worktree.pruned` / `worktree.orphan_detected`; otherwise the algorithm ports almost verbatim.

### P4 — Cross-platform process/lock seams → close the Windows gap.
Build-tag split (`flock` vs `LockFileEx`, gopsutil) + a 3-OS CI matrix. Exarchos has **no Windows CI for the MCP server** and has shipped Windows bugs ([memory: windows-ci-gap]; `#1085`; the still-data-blocked Windows ancestry RCA `#1402`).
- **Adopt:** the *discipline* (isolate platform syscalls behind seams; cross-compile-check) more than the Go code. For the Node/TS port, the equivalent is `proper-lockfile`-style advisory locks + a portable process library, and a Windows CI lane.

### P5 — Protected-process termination → safe reclamation of hung agent worktrees.
`filterProtectedProcesses` walks the current process's parent chain and protects the whole ancestry before SIGTERM→grace→SIGKILL.
- **Why it matters here specifically:** Exarchos's orchestrator shell can have its cwd re-rooted into an agent worktree on background completion ([memory: shell-cwd-drifts-to-agent-worktree]). **Any** process-based detection or termination Exarchos adds *must* carry this ancestry-protection or it risks killing its own session. Treehouse hands us the exact algorithm.

### P6 — Detached-HEAD-on-idle + untracked-aware dirty + remote-URL identity. **(Smaller, still useful.)**
- *Detach idle worktrees* (treehouse #19) — relevant to the `baseRef` collision class even though Exarchos keeps named branches *during* a task; the idle/returned state can detach.
- *`--untracked-files=all`* — a one-line hardening for the merge **drift preflight** (`pure/merge-preflight.ts`).
- *Stable worktree-store identity* independent of cwd.

---

## 5. Anti-patterns — what NOT to copy

1. **Do not copy the JSON-file-as-authority substrate.** It violates `INV-1` and re-creates the dual-write the merge audit removed. Worktree state must be a projection over `worktree.*` events.
2. **Do not adopt the pool/reuse model for orchestrator-dispatched agents.** CC native isolation owns worktree creation; a pool underneath it is fighting the runtime. (A pool may still make sense for a *human power-user* path — keep that separate.)
3. **Do not ship process-cwd detection without ancestry protection (P5) and an orchestrator-self exclusion.** The cwd-drift hazard means the orchestrator's own shell will falsely register as "in-use" and could be killed. This is the single biggest correctness trap in the whole port.
4. **Do not reuse `reset --hard` for *recovery*.** Treehouse uses `ResetWorktree` = `checkout --detach --force` + `reset --hard` + `clean -fd` — correct *there* because it resets an *idle, already-returned, known-clean* worktree to a fresh base. Exarchos's *merge recovery* path is the opposite context and correctly uses `merge --abort` + `reset --keep` after PR #1571 (audit H-1). Keep the two contexts firmly distinct; don't let treehouse's `--hard` leak into the recovery ladder.
5. **Do not bolt a worktree supervisor onto the merge orchestrator.** Per audit S-6/R-5, liveness is a *generic* runtime concern (v2.12 verbs), not a per-feature checker. Route P1 there.

---

## 6. The "holistic library/service" decision

**Recommendation: build it — internal, in-process (TS), event-sourced — and scope it as a *Worktree Lifecycle & Safety Manager*, not a pool, not a service/daemon.**

Today the worktree surface is scattered across `setup-worktree.ts`, `worktree-baseref.ts`, `dispatch-guard.ts`, and the *absent* GC. A cohesive `WorktreeManager` would consolidate them and add the missing safety floor. Concretely it owns:

- **Lifecycle:** create/reset/release/teardown, base-ref resolution (already INV-4-correct via integration-branch derivation), sibling-collision guard (`#1356`).
- **Ownership & liveness (new, from P1/P2/P5):** reservation, heal/reconcile, process-cwd in-use detection with ancestry protection — surfaced through the v2.12 `ps`/`wait` verbs rather than a bespoke API.
- **GC (new, from P3):** the safe-prune ladder + orphan classification for worktree disk — a *separate command* from the existing workflow-prune, clearly named (`exarchos_view`/an orchestrate verb like `prune_worktrees`), to avoid the conflation in §4-P3.
- **All state as `worktree.*` events + a projection.** No JSON authority, no flock-as-source-of-truth, no daemon.

**Why internal-in-process over vendoring treehouse or a sidecar service:**
- Language/runtime fit: Exarchos is TS/Node; treehouse is Go. A subprocess adds a build/release axis and a second binary to ship through the installer.
- Substrate fit: only an in-process module can make worktree lifecycle first-class events in the existing store.
- Design philosophy: "agent-first CLI, compose-don't-reinvent, basileus-forward." A holistic *module* composes with the runtime; a *service/daemon* contradicts the daemonless single-machine framing both projects share.

**Invariant alignment:** `INV-1` (state-as-projection) — satisfied by event-sourcing the lifecycle; `INV-3` (basileus-forward) — keep the `agent`/remote-execution verbs reserved for basileus, this manager is strictly local; `INV-4` (platform-agnosticity) — worktree semantics are git-domain and runtime-agnostic, but P4 (Windows) must be honored or INV-4 leaks; `INV-11` capability posture — GC/teardown verbs are `shared-mutating` and must gate at the resolver like `merge_orchestrate` does post-`#1305`.

---

## 7. Proposed increments (inputs to `/exarchos:ideate`)

Ordered to deliver safety-floor value first and to converge with the v2.12 trajectory:

1. **Spike: process-cwd liveness primitive + protected-process safety (P1+P5).** Land as the substrate behind the planned v2.12 `ps`/`wait` verbs. Acceptance: detects a live agent in a worktree on linux/mac/windows; never reports/kills the orchestrator's own ancestry. *This is the keystone — most other increments lean on it.*
2. **Worktree GC: `prune_worktrees` with the full safety ladder + orphan classification (P3).** Dry-run default; fail-closed on origin-unreachable; distinct from workflow-prune. Closes the unbounded-`.claude/worktrees/agent-*` accumulation gap.
3. **Event-sourced ownership + reconcile (P2).** `worktree.reserved/released` + heal-as-reconcile; retire any ad-hoc ownership assumptions; target the stash-collision / stale-worktree hazards.
4. **Consolidate the scattered surface into `WorktreeManager` (refactor).** Fold setup-worktree / baseref / dispatch-guard behind one module; no behavior change beyond cohesion.
5. **Hardening one-liners (P6):** `--untracked-files=all` in the merge drift preflight; detach idle/returned worktrees; stable worktree-store identity.
6. **Windows CI lane (P4).** Without it, INV-4 claims for the worktree surface are unverified (cf. `#1085`, `#1402`).

A reasonable first `/ideate` scope is increments **1–2** (the safety floor), explicitly *not* a pool.

---

## 8. Conclusion

Treehouse is the right thing to study and the wrong thing to adopt as-is. Its pool model and JSON+flock substrate are excellent for a daemonless human-facing Go CLI and structurally wrong for Exarchos's event-sourced, CC-native-isolation, cooperative-agent runtime. But underneath the model sits a set of **proven, cross-platform safety mechanisms** — process-cwd liveness, crash-safe reservation, a battle-tested prune safety ladder with orphan classification, and protected-process termination — that map almost one-to-one onto Exarchos's *open* worktree gaps and onto the *generic process-lifecycle verbs the merge audit already committed to building.*

So: **yes to a holistic internal worktree manager; no to a pool and no to vendoring.** Harvest the mechanisms, re-host them on the event store, and let treehouse stand as the reference implementation (and an optional power-user path). The single most important safety rule in the port is non-negotiable: any process detection or termination Exarchos ships must protect its own process ancestry, because the orchestrator's shell can drift into the very worktrees it inspects.

---

## Appendix A — Treehouse source index (v1.7.0)

| Area | File | Key symbols |
|---|---|---|
| Pool core | `internal/pool/pool.go` | `Acquire`, `Release`, `Destroy`, `healState`, `ownerAlive`, `reserveOwner`, `worktreeInUse` |
| State + lock | `internal/pool/state.go`, `lock_{unix,windows}.go` | `WorktreeEntry`, `WithStateLock`, `flock`/`LockFileEx` |
| Prune/GC | `internal/pool/prune.go` | `analyzeIdleWorktree`, `finalPruneSafetyCheck`, `backingRepositoryMissing`, plan/reserve/commit |
| Git | `internal/git/git.go` | `AddWorktree --detach`, `branchRef`, `ResetWorktree`, `IsDirty`, `IsHeadMergedIntoRef`, `DefaultBranchMergeRef` |
| Process | `internal/process/detect.go`, `terminate.go` | `FindProcessesInWorktree`, `StartedAt`, `TerminateWorktreeProcesses`, `filterProtectedProcesses` |
| Hooks | `internal/hooks/hooks.go` | user-scope `post_create`/`pre_destroy`, fail-soft |
| Return UX | `cmd/return_cmd.go` | detach → kill-protected → release |

## Appendix B — Exarchos surface touched (for the eventual refactor)

`servers/exarchos-mcp/src/orchestrate/`: `setup-worktree.ts`, `worktree-baseref.ts`, `dispatch-guard.ts`, `merge-orchestrate.ts`, `execute-merge.ts`, `pure/{execute-merge,merge-preflight}.ts`, `local-git-merge.ts`, `git-exec-default.ts`, `merge-keys.ts`, `prune-stale-workflows.ts` (workflow-prune — *not* worktree-prune).

## Appendix C — Source pointers

- Audit (canonical framing): [`docs/research/2026-05-08-1119-merge-orchestrator-audit.md`](2026-05-08-1119-merge-orchestrator-audit.md)
- Epic [#1302](https://github.com/lvlup-sw/exarchos/issues/1302) · PR [#1571](https://github.com/lvlup-sw/exarchos/pull/1571)
- Related issues: `#1512` (baseRef), `#1356` (sibling collision), `#1301`/`#1220` (isolation boundary), `#1568` (CC native isolation hook), `#1085`/`#1402` (Windows), `#1545` (workflow-prune topology block)
- External: [`kunchenguid/treehouse`](https://github.com/kunchenguid/treehouse) @ v1.7.0; prior art cited in the audit — `max-sixty/worktrunk` PR #1623, `kaeawc/auto-worktree` #176.
