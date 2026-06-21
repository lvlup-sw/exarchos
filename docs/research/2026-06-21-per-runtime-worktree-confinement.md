# Per-runtime native worktree write-confinement (#1301 follow-up, INV-4)

**Date:** 2026-06-21
**Workflow:** `discover-per-runtime-worktree-confinement` (discovery)
**Predecessor:** `docs/rca/2026-06-21-worktree-isolation-write-leak.md` (#1301) + PR #1568
**Question:** the #1301 fix shipped an agnostic relative-path contract (prevention) + merge-time
backstop (detection) on every runtime, plus a Claude-only `PreToolUse` deny-hook (by-construction
hardening). Can the Claude-only hardening be matched on the other tier-1 runtimes via each one's
**native** confinement seam — turning the logged INV-4 gap into real per-runtime enforcement?

## Headline verdict

**The gap is closeable on every tier-1 runtime — none needs to stay a pure logged-gap.** But the
mechanisms differ in *kind* and *strength*, so the honest framing is a **tiered guarantee**, not
one uniform mechanism (which is exactly what INV-4 asks for: the same guarantee realized through
each runtime's native seam). Two runtimes (Codex, Cursor) offer **stronger** confinement than
Claude's hook — OS-kernel sandboxes scopable to the worktree.

## Enforcement-strength tiers

1. **Kernel-enforced OS sandbox (strongest — physical "cannot write outside"):** writes outside
   the worktree fail at the syscall layer, and this also confines *spawned shell commands* (the
   universal hole below). Available: **Codex, Cursor**. Preview/partial: Copilot.
2. **In-process deny-hook (= the Claude class we already shipped):** gates the model's *tool
   calls* by resolved path; a fail-closed command hook denies an out-of-worktree write. Does
   **not** confine arbitrary syscalls from a `bash`/shell tool. Available: **Claude (done),
   Copilot, Codex, OpenCode**.
3. **Advisory / heuristic (not a guarantee):** approval prompts, additive cwd-allowlists,
   instruction prose. Present on all; this is the floor, not the target.

**The universal hole:** on every runtime, a `bash`/shell tool can write via redirection
(`echo > /repo/x`, `cp`, `python -c`) and bypass the *file-tool* permission/hook layer. Only the
Tier-1 OS sandbox closes it (it confines the spawned subprocess too). In-process hooks must
additionally gate/deny `bash`, or accept shell-write as residual (as the Claude fix already
documents).

**The universal lever:** every runtime keys confinement off the **launch cwd / working
directory**. Spawning the agent with `cwd = <worktree>` is the shared foundation that makes both
the OS sandbox and the relative-path contract land correctly. exarchos already does this via
`setup-worktree` + the dispatch contract.

## Per-runtime matrix

| Runtime | Best verdict | Native seam | Worktree-scopable? | Strength | Key caveat |
|---|---|---|---|---|---|
| **Claude** | `hook-deny` (shipped) | `PreToolUse` deny-hook → `exarchos verify-worktree-boundary` | Yes (cwd=worktree) | Tier 2 | shell-write residual |
| **Codex** | `native-scopable` | `--sandbox workspace-write --cd <worktree>` (Seatbelt / bubblewrap+seccomp); `[permissions]` deny-parent/allow-child; TOML pins `sandbox_mode` | **Yes** | **Tier 1** | Linux needs bubblewrap+userns; `apply_patch` ignores `--add-dir` → use `--cd` |
| **Cursor** | `native-scopable` | `cursor-agent --sandbox enabled --workspace <worktree>` (Seatbelt/Landlock); CLI `Write(glob)` deny/allow; `beforeShellExecution` deny-hook | **Yes** (worktree = workspace root) | **Tier 1** | Linux kernel ≥6.2+Landlock else degrades to prompts; **no `beforeFileEdit` deny hook** |
| **Copilot CLI** | `hook-deny` (+ preview sandbox) | `preToolUse` fail-closed command hook (root-owned **policy** hook can't be disabled) → reuse our guard; local sandbox (MXC=Seatbelt/bubblewrap) | Yes via hook; sandbox preview/shell-only | Tier 2 (Tier 1 preview) | native cwd-allowlist is heuristic + additive-only (no deny-path); sandbox is public-preview |
| **OpenCode** | `permission-glob` + `hook-deny` | per-agent `permission.edit` glob→deny/allow + `external_directory`; `tool.execute.before` plugin `throw`s | Yes (in-process) | Tier 2 | **core explicitly is NOT a sandbox** (SECURITY.md); must also deny/scope `bash`; glob deny→allow historically buggy (pin version) |

## Per-runtime detail + wiring approach

### Codex — Tier 1 (OS sandbox), strongest
- **Mechanism:** `sandbox_mode = "workspace-write"` confines writes to the workspace (= launch
  cwd) + temp, enforced by Seatbelt (macOS) / bubblewrap+seccomp (Linux, Landlock fallback). The
  sandbox **also confines spawned commands** (git, test runners). Protected: the worktree's
  `.git` pointer *and its resolved gitdir* are read-only.
- **Worktree scoping:** launch `codex exec --sandbox workspace-write --cd /repo/.worktrees/task-1`.
  The parent `/repo` is read-only by construction. **Do not** keep `--cd /repo` and try
  `--add-dir <worktree>` — `apply_patch` ignores `--add-dir` (issue #24214); collapse the root
  with `--cd`. Optional hard floor: `exclude_slash_tmp` / `exclude_tmpdir_env_var`.
  Most-explicit alternative (Codex ≥0.138, beta): a `[permissions]` profile with `deny` on the
  parent + `write` on the nested worktree (more-specific-path-wins).
- **exarchos wiring:** `codex.ts` already emits `sandbox_mode` from capabilities (implementer →
  `workspace-write`). The **missing piece is the launch**: the orchestrator/`setup-worktree` must
  spawn `codex exec` with `--cd <worktree>` (cwd=worktree). Custom-agent TOML can *pin*
  `sandbox_mode` (a hard, non-widenable constraint) but not the writable root — the root is the
  launch cwd. So: keep the TOML `sandbox_mode`, add `--cd <worktree>` at dispatch.
- **Defense-in-depth:** Codex also has a Claude-modeled `PreToolUse` deny-hook (apply_patch
  coverage fixed in 0.123.0) → our `exarchos verify-worktree-boundary` guard could wire here too.

### Cursor — Tier 1 (OS sandbox)
- **Mechanism:** since Cursor 2.0, agent tool execution runs in a kernel sandbox (Seatbelt /
  Landlock+seccomp) with write confined to the **workspace root** + `/tmp`.
- **Worktree scoping:** launch `cursor-agent -p --force --sandbox enabled --workspace
  /repo/.worktrees/task-1`. The workspace *is* the worktree → kernel-denied writes elsewhere.
  Defense-in-depth: a `<worktree>/.cursor/cli.json` with `permissions.deny: ["Write(/**)"]` +
  `allow: ["Write(<worktree>/**)"]` (deny beats allow; absolute globs supported) — but this gates
  only the `Write` *tool*, not shell. A `beforeShellExecution` deny-hook covers shell (the only
  hook that can deny; **there is no `beforeFileEdit` deny hook**).
- **exarchos wiring:** `cursor.ts` currently treats `isolation:worktree` as advisory and renders
  no confinement. Add: emit `.cursor/cli.json` Write-deny/allow globs scoped to the worktree, and
  have the orchestrator launch `cursor-agent` with `--sandbox enabled --workspace <worktree>`.
- **Caveats:** Linux needs kernel ≥6.2 + Landlock (else degrades to approval prompts — verify
  `CURSOR_SANDBOX_LANDLOCK_STATUS=fully_enforced`); Cursor's own docs call the in-product modes
  "best-effort." `sandbox.json` path fields only *add* writable roots (can't shrink below the
  workspace) — so confine by making the worktree the workspace, not by sub-scoping the repo.

### Copilot CLI — Tier 2 (in-process deny-hook), reuses our guard
- **Mechanism:** `preToolUse` hook fires before each tool with `{ cwd, toolName, toolArgs }`;
  returns `{ "permissionDecision": "deny", "permissionDecisionReason": "…" }`. **Command hooks
  are fail-closed** (crash/non-zero → deny). **Root-owned policy hooks**
  (`/etc/github-copilot/policy.d/*.json`) cannot be disabled by the agent or `disableAllHooks` —
  the hardening sweet spot.
- **Worktree scoping:** the `toolArgs` shape is close enough to Claude's that
  `exarchos verify-worktree-boundary` can be **reused** (resolve path, deny outside cwd). The
  native cwd-allowlist (`--add-dir`) is heuristic + additive-only (no deny-path), so it is *not*
  a substitute. Kernel option: the local sandbox (MXC = Seatbelt/bubblewrap) — but public-preview,
  shell-only, enabled via `settings.json`/slash command (no headless flag documented).
- **exarchos wiring:** `copilot.ts` renders no hooks today. Add: emit a `preToolUse` hook (ideally
  a policy hook) wired to `exarchos verify-worktree-boundary`. Launch with cwd=worktree and
  `--no-ask-user`; pair with `--deny-tool=write` re-allow-nothing-above-worktree if desired.
- **Caveat:** in-process (respects the deny); shell-escape theoretically possible. GitHub's own
  issue #892 confirms the native path model doesn't hard-enforce this.

### OpenCode — Tier 2 (permission-glob + plugin hook); core is explicitly not a sandbox
- **Mechanism:** per-agent `permission.edit` accepts glob→`allow|deny|ask` (the `edit` key covers
  `edit`/`write`/`apply_patch`), plus `external_directory` for "outside the working dir." And a
  `tool.execute.before` plugin can resolve `output.args.filePath` and **`throw`** to block.
- **Worktree scoping:** per-agent block, e.g. `edit: { "*": "deny", "<worktree>/**": "allow" }` +
  `external_directory` scoped to the worktree + **`bash` denied/allowlisted** (else shell is the
  hole). Launch `opencode run --dir /repo/.worktrees/task-1 --agent <name>`.
- **exarchos wiring:** `opencode.ts` renders no permission block today. Add: emit the agent
  `permission.edit`/`external_directory` globs scoped to the worktree, and optionally ship a
  `tool.execute.before` plugin that calls the same boundary logic (defense-in-depth, catches bash).
- **Caveats:** OpenCode `SECURITY.md` states it is **not a sandbox** ("permission system is a UX
  feature, not security isolation"); true OS confinement is only a third-party plugin
  (`opencode-sandbox`, Seatbelt/bwrap, **fail-open**, no Windows). Path-scoped `edit` deny→allow
  was historically mis-evaluated (catch-all won); verified fixed on recent `dev` — **pin a version
  + add a test**. Last-match-wins, so rule *order* matters (deny `*` first, allow worktree after).

## Cross-cutting design recommendation for exarchos

Model the guarantee as **one runtime-agnostic spec intent, lowered to each runtime's native
seam** — the same pattern exarchos already uses for `posture` → capabilities → per-adapter tools.

1. **Keep the two agnostic layers as the floor (shipped):** relative-path contract (prevention) +
   merge-time backstop (detection). These hold even where a runtime offers nothing better.
2. **Reuse `exarchos verify-worktree-boundary` as the cross-runtime in-process guard.** Its
   PreToolUse JSON contract already fits **Claude** and **Copilot** (`preToolUse`), and **Codex**
   (Claude-modeled `PreToolUse`). One binary, three hook wirings — high leverage, low cost.
3. **Add OS-sandbox lowering where it exists (Tier 1):** `codex.ts` → ensure `--cd <worktree>` at
   launch (sandbox_mode already emitted); `cursor.ts` → `--sandbox enabled --workspace <worktree>`
   + `.cursor/cli.json` Write globs.
4. **Add the in-process seam where that's all there is (Tier 2):** `opencode.ts` → per-agent
   `permission.edit`/`external_directory` globs (+ optional plugin); `copilot.ts` → `preToolUse`
   policy hook.
5. **Make the launch cwd = worktree explicit in `setup-worktree`/dispatch for every runtime** —
   the universal lever all of the above depend on.
6. **Per-runtime support-level honesty:** upgrade each adapter's `isolation:worktree` from blanket
   `advisory` to its real tier (`native`/`hook`/`advisory`) and keep the parity regression test
   green by asserting each runtime emits its declared seam. Where a strength gap remains
   (shell-escape on Tier 2; preview-only sandbox on Copilot), **log it** — don't claim Tier 1.

## INV-4 verdict

The original "Claude-only" gap was real but not intrinsic — it reflected effort, not capability.
Every tier-1 runtime exposes at least an in-process deny seam, and two expose a *stronger*
kernel sandbox. So the INV-4-correct end state is **achievable**: the worktree boundary can be a
genuine per-runtime guarantee, tiered by each host's strongest available seam, with residual gaps
(shell-write on Tier 2; preview status on Copilot's sandbox) explicitly logged rather than faked.

## Risks / things to kill-probe before implementing
- **Shell-write residual** on Tier-2 runtimes — decide per runtime whether to also deny/scope
  `bash` (breaks legitimate test/build commands) or accept it + rely on the merge backstop.
- **Linux sandbox prerequisites** — Codex (bubblewrap+userns) and Cursor (kernel ≥6.2+Landlock)
  degrade silently to prompts/refuse where unavailable; CI/container envs must verify enforcement
  at runtime, not assume it.
- **Version pinning** — OpenCode glob precedence, Codex permission profiles (beta), Copilot
  sandbox (preview), Cursor CLI (beta) are all fast-moving; each needs a version-pinned probe test.
- **The worktree `.git` pointer** — every sandbox/permission rule must keep the worktree's own git
  plumbing (resolved gitdir under `/repo/.git/worktrees/...`) usable while denying the parent
  working tree. Codex protects it read-only automatically; others need an explicit carve.

## Escalation

This discovery **feeds implementation** (it recommends concrete per-adapter wiring), so per the
discovery-skill contract the next step is `/exarchos:ideate` (or a `/exarchos:debug` extension of
#1301) to design + build the per-runtime lowering, referencing this report as input. Suggested
first slice (highest leverage, lowest risk): **reuse `verify-worktree-boundary` for Copilot's
`preToolUse`** and **add `--cd <worktree>` for Codex** — two runtimes upgraded with minimal new code.
