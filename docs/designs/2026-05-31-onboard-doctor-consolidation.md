# Design Spike — Onboarding Consolidation: `onboard` + `doctor`

**Status:** Spike (design exploration; two top-level forks already decided — see §4)
**Date:** 2026-05-31
**Milestone:** v2.10.2 (new — onboarding consolidation)
**Author:** Reed
**Depends on:** Universal layered toolchain resolver — Bundle B (#1508 + #1507), `docs/plans/2026-05-31-toolchain-registry-consolidation.md`

---

## 1. Problem

Since v2.10.0 GA the *configuration* surface grew sharply, and the v2.10.1
toolchain-registry consolidation (`docs/plans/2026-05-31-toolchain-registry-consolidation.md`)
will grow it again — adding user `toolchains:` declarations (tier 3) and task-runner
detection (tier 4) on top of the existing `.exarchos.yml` keys. Meanwhile the *onboarding*
surface that is supposed to set all of this up has fragmented into **four** entry points
with overlapping responsibility and no single "make my repo ready" command:

| Verb / handler | Surface | Responsibility today | Overlap |
|---|---|---|---|
| `exarchos init` | CLI + `exarchos_orchestrate.init` | Detect runtime(s) + VCS; write per-runtime MCP config (`~/.claude.json` etc.); seed `.exarchos.yml` (idempotent, never overwrites); emit `init.executed` | Writes config + registers MCP — overlaps `install-skills`' MCP registration |
| `exarchos install-skills` | CLI-only bridge → root `src/install-skills.ts` | Install skills bundle to `~/.claude/skills/` (local-copy fast path, else `npx skills add …`); then `registerExarchosInClaudeJson()` | Registers MCP in `~/.claude.json` — same write `init` does |
| `exarchos doctor` | CLI + `exarchos_orchestrate.doctor` | 11 parallel read-only checks (node version, sqlite health, state dir, env, git, agent config, MCP registration, plugin hash/version, remote-mcp stub, invariants catalog); emit `diagnostic.executed`. **Report-only — never fixes** | Diagnoses exactly the things `init`/`install-skills` produce, but can't repair them |
| `new-project` | internal handler `orchestrate/new-project.ts` (not a public verb) | Scaffold a *new* repo: dir, `.claude/settings.json`, `.exarchos.yml` from template, optional `CLAUDE.md.template` + `applyLanguageCustomizations` (npm→dotnet **string-rewrite**, the #1508 residue), `.gitignore` | Generates the same artifacts `init` does, via a parallel code path |

Consequences:

- **No holistic entry point.** A human or agent adopting Exarchos must *know* to run
  `init`, then `install-skills`, then `doctor`, in order — and `new-project` is reachable
  only through scaffolding workflows. The "how do I get started" answer is a sequence, not
  a command.
- **Duplicated writers.** MCP registration in `~/.claude.json` is written by both `init`
  and `install-skills`. Config/`.exarchos.yml` generation exists in both `init`
  (`seedExarchosConfig`) and `new-project` (template + `applyLanguageCustomizations`).
- **Diagnosis without repair.** `doctor` enumerates 11 failure modes but every fix is
  manual; there is no "make it right" path that consumes the same check results.
- **npm-as-canonical residue.** `new-project`'s `applyLanguageCustomizations` derives
  non-npm commands by string-rewriting `npm run …` (#1508) — an INV-6 violation that the
  layered resolver makes unnecessary.

The config surface is *correctly* getting richer (toolchains, invariants catalogs,
quality hints, handoff lint). The onboarding surface should get **simpler and holistic**
in inverse proportion: the richer the configuration, the more valuable a single command
that derives and reconciles all of it.

## 2. Goal

Collapse the four onboarding entry points into **two holistic verbs**:

- **`onboard`** — one idempotent command that brings a repo (existing *or* greenfield)
  to a fully-configured, skills-installed, MCP-registered, ready-to-run state. It
  *detects → derives the desired state → reconciles → verifies*.
- **`doctor`** — diagnosis of that same desired state, plus a `--fix` that delegates to
  the **same reconciler `onboard` uses**. `doctor` tells you what's wrong; `onboard`
  (and `doctor --fix`) make it right.

Everything else (`init`, `install-skills`, `new-project`) is **removed** (§4, Decision A/B),
their logic folded into the shared reconciler.

## 3. Current-surface inventory (detail)

Grounding for the consolidation — file references for the implementer:

- **`init`** — registry `servers/exarchos-mcp/src/registry.ts:2373` (schema:
  `{ runtime?, vcs?, nonInteractive?, forceOverwrite?, format? }`); CLI adapter
  `servers/exarchos-mcp/src/adapters/cli.ts:858`; handler
  `servers/exarchos-mcp/src/orchestrate/init/index.ts`; writers under
  `orchestrate/init/writers/{claude-code,copilot,cursor,codex,opencode,mcp-json-writer}.ts`;
  config seed `orchestrate/init/seed-exarchos-config.ts` (idempotent — never overwrites).
- **`doctor`** — registry `registry.ts:2250` (schema: `{ timeoutMs?, format? }`); CLI
  `cli.ts:660`; handler `orchestrate/doctor/index.ts`; 11 checks under
  `orchestrate/doctor/checks/*.ts`; each returns Pass/Warn/Fail/Skip + an optional `fix`
  *hint string* that nothing consumes programmatically.
- **`install-skills`** — CLI-only bridge `cli.ts:1018` → root `src/install-skills.ts`
  (≈660 lines): local-copy fast path from `skills/<runtime>/` → runtime skills dir, else
  `npx skills add github:lvlup-sw/exarchos …`; then `registerExarchosInClaudeJson()`.
  **Not** in the registry; no MCP parity.
- **`new-project`** — `orchestrate/new-project.ts`; internal only;
  `applyLanguageCustomizations` does the npm→dotnet string-rewrite (#1508).
- **Config schema** — `servers/exarchos-mcp/src/config/exarchos-config-schema.ts`,
  top-level keys: `test`, `typecheck`, `install` (safe-command strings),
  `qualityHints`, `handoffLint`, `cli`, `invariants` (`devCatalog` / `catalogs` /
  `overrides` / `enforcement`). `.strict()`.

## 4. Decisions (locked this spike)

> **Decision A — Hard replace in v2.10.2.** `onboard` is the only onboarding path.
> `init` and `install-skills` are removed; `onboard` composes their internals.
> *(Selected over "compose + deprecate" and "compose + keep".)*

> **Decision B — Fold `new-project` into `onboard`.** No separate greenfield verb.
> `onboard` adopts an existing repo; `onboard --new <name>` scaffolds a fresh one.
> `new-project` is retired; `applyLanguageCustomizations`' string-rewrite dies with it.

Derived decisions (consistent with the above and with house architecture):

- **Decision C — Runtime resolution, never gen-time.** `onboard` resolves toolchain
  commands at run time via the layered resolver, never bakes them into shipped artifacts
  (the gen-time→runtime principle; INV-4). It is a *consumer* of Bundle B's resolver.
- **Decision D — One reconciler, two callers (INV-2 facade-equivalence).** Extract a pure
  **desired-state reconciler** — `detect → DesiredState → diff(actual) → Plan → apply` —
  in shared core. `onboard` runs the full plan; `doctor` runs `detect → diff` and reports;
  `doctor --fix` runs `apply` over the diff. No third code path; doctor's existing 11
  checks become the *diff* surface.
- **Decision E — Idempotent + non-destructive by default.** Re-running `onboard` reconciles
  drift without clobbering hand edits (preserve `seedExarchosConfig`'s never-overwrite
  posture; `--force` to overwrite; `--dry-run` to print the plan).

## 5. Target design

### 5.1 `onboard`

```
exarchos onboard [--new <name>] [--runtime <id>…] [--vcs <id>]
                 [--dry-run] [--force] [--non-interactive] [--format table|json]

modes:
  (default)        adopt Exarchos into the current existing repo
  --new <name>     scaffold a fresh repo at <name>, then adopt it

pipeline (idempotent, each step is a reconcile not a blind write):
  1. DETECT      toolchain (layered resolver: override > .exarchos.yml > user
                 toolchains: > task-runner > registry), runtime(s), VCS, agent host
  2. CONFIG      reconcile .exarchos.yml (+ .exarchos/ dir, invariants catalog when
                 devCatalog) — derive test/typecheck/install from the resolver, NOT
                 a string-rewrite; never overwrite hand edits unless --force
  3. GENERATE    per-runtime artifacts via existing init writers (.claude/, MCP
                 registration in ~/.claude.json, settings.json, CLAUDE.md stanza),
                 optional hooks (e.g. SessionStart binding — #1485)
  4. INSTALL     skills bundle (install-skills' local-copy fast path / npx fallback)
                 + project deps (package-manager-detector, from Bundle B)
  5. VERIFY      run doctor's diff in-process; report residual Fails; exit non-zero
                 if any blocking check still fails
```

`--new` is the only difference between greenfield and adopt: it creates the directory and
seeds an initial scaffold first (the salvageable parts of `new-project`), then runs the
identical 1–5 pipeline. There is no second scaffolding code path.

### 5.2 `doctor`

```
exarchos doctor [--fix] [--timeout-ms N] [--format table|json]

  (default)   run the 11 checks (= reconciler diff), report Pass/Warn/Fail/Skip + fix hint
  --fix       apply the reconciler over the diff (same apply() onboard step 2–4 calls),
              re-run the checks, report what remains
```

`doctor --fix` and `onboard` (on an already-initialized repo) converge to the same end
state by construction — they call the same `apply`. The distinction is *scope of intent*:
`doctor --fix` repairs detected drift; `onboard` asserts the full desired state.

### 5.3 Shared reconciler (the INV-2 facade)

```
core/onboarding/reconcile.ts  (pure, harness-neutral)
  detectDesiredState(repoRoot, opts): DesiredState     // leans on Bundle B resolver
  diff(desired, actualProbes): ReconcilePlan           // = doctor's 11 checks, structured
  apply(plan, opts): ReconcileResult                   // composes init writers + skills install

consumers (thin):
  onboard  →  detect → diff → apply(full)  → verify(diff)
  doctor   →  detect → diff → report
  doctor --fix → detect → diff → apply(diff) → re-diff → report
```

This is the load-bearing architectural move: today's `doctor` checks emit *fix-hint strings
nobody consumes*; promoting those to a structured `ReconcilePlan` that `apply` executes is
what lets one engine serve both verbs.

## 6. Surface & parity

- **CLI:** `onboard`, `doctor` (with `--fix`). Remove `init`, `install-skills` verbs and
  the internal `new-project`.
- **MCP / `exarchos_orchestrate`:** today exposes `init` and `doctor` actions (DR-7 / #1254
  parity). Replace the `init` action with an `onboard` action; keep `doctor` (+ a `fix`
  arg). **Caveat (open, §9):** the *skills/deps install* step (step 4) shells out to `npx`
  and writes to `~/.claude/` — that may stay CLI-side and be a no-op/advisory over the MCP
  arm. Split the reconciler so steps 1–3 + 5 are MCP-parity-able and step 4 is CLI-gated;
  this keeps the *core* identical (INV-2) while honoring what each surface can actually do.

## 7. Migration / breaking-change handling

Decision A removes verbs in a patch line, which is a real break. Recommended courtesy
(compatible with "hard replace"): keep one-release **error stubs** for `init` /
`install-skills` that do nothing but print `renamed → use 'exarchos onboard'` and exit
non-zero, rather than "command not found". Removed entirely at v3.0 (the planned breaking
release, which already carries `OptionWithLegacy` machinery for flag renames). Update:
bootstrap scripts (`scripts/get-exarchos.*`), docs/guides, any skill that references
`init`/`install-skills`, and `dogfood`/`doctor` references.

## 8. Invariants applied

- **INV-2 facade-equivalence** — single reconciler core; `onboard` / `doctor` / `doctor
  --fix` are thin consumers (Decision D).
- **INV-4 platform-agnosticity** — desired state derived at runtime; per-runtime writers
  stay the single source for harness artifacts; no baked toolchain (Decision C).
- **INV-6 workload-agnosticism** — commands come from the layered resolver, never an
  npm-rewrite; retiring `applyLanguageCustomizations` closes the #1508 residue.
- **INV-1 event-sourcing-integrity** — reconcile `init.executed` + `diagnostic.executed`
  into an `onboard.executed` (or retain both) event contract; widen atomically with schema
  + parity tests if the event shape changes.

## 9. Open questions (resolve during the spike → plan)

1. **MCP parity scope of step 4.** Can/should the skills+deps install run over the MCP arm,
   or is it CLI-only with an advisory result on MCP? (Leaning CLI-only; §6.)
2. **Interactive wizard.** Agent-first ⇒ flags-first/non-interactive by default. Does a
   `--interactive` human wizard land now, or wait for the v3.0 `IInteractionService` /
   TTY-fallback infra (#1087)? (Leaning: ship non-interactive now; wizard rides #1087.)
3. **Hook installation.** Should `onboard` install the SessionStart binding hook (#1485) by
   default, opt-in, or leave to a separate step? Interacts with the SessionEnd decision.
4. **Event contract.** New `onboard.executed` event vs. emitting the existing
   `init.executed` + `diagnostic.executed` pair. (INV-1: decide before implementation.)
5. **Semver.** A verb-removing break in v2.10.2 vs. cutting it as a minor. Decision A says
   patch; flag explicitly in the release notes. (Owner call — already chosen patch.)
6. **`onboard` ⊇ `doctor`?** `onboard` ends with a verify (= doctor diff). Is standalone
   `doctor` still a distinct verb (yes — read-only diagnosis is a separate intent) or an
   `onboard --check`? (Leaning: keep `doctor` as its own verb per the two-verb goal.)

## 10. Dependencies & sequencing

`onboard` is a *consumer* of the layered toolchain resolver, so it sequences **after**
Bundle B (#1508 + #1507) lands — otherwise step 1 (DETECT) and step 2 (CONFIG) would be
built on the old enumerated detection and re-introduce the npm-rewrite this design deletes.
Order: Bundle B (v2.10.1) → this consolidation (v2.10.2).

Related/verified issues: #1508 (new-project npm-rewrite residue — *folded away* here),
#1507 (`.slnx` detection — improves DETECT), #1485 (SessionStart hook — candidate GENERATE
step), #1470 (INV-6 workload-agnosticism, closed in v2.10.0 — this closes more of the
residue), #1483 (observe-only hook templating + workload-agnostic verification, merged —
established the runtime-resolution posture this design extends). The layered resolver is
Bundle B (#1508 + #1507); there is no separate resolver-epic issue.

## 11. Success criteria

1. `exarchos onboard` takes a fresh clone (or `--new`) to fully-configured + skills-installed
   + MCP-registered + green `doctor` in one command, idempotently re-runnable.
2. `init`, `install-skills`, `new-project` are gone (error stubs only); zero duplicated
   writer logic — config/MCP/skills writes flow through one reconciler.
3. `doctor --fix` repairs every check that exposes a fix, via the same `apply` `onboard` uses.
4. No `applyLanguageCustomizations`-style string-rewrite remains; commands derive from the
   layered resolver (INV-6).
5. CLI + MCP parity preserved for the config/generate/verify portions; skills-install split
   documented; events reconciled; tests + typecheck + invariant lint green; docs + bootstrap
   scripts updated.

## 12. Out of scope (this consolidation)

- Bundle B itself (the resolver this depends on) — separate plan.
- The v3.0 `IInteractionService` / wizard infra (#1087) — `--interactive` rides it later.
- Remote-MCP onboarding (future axis, #1081).
- Widening the `--new` language set beyond what the registry already supports.

## 13. Spike deliverables (before promotion to a TDD plan)

- This document + a v2.10.2 milestone + a tracking issue.
- Resolution of the §9 open questions (esp. MCP parity scope and the event contract).
- A characterization pass over current `init` / `doctor` / `install-skills` / `new-project`
  outputs (Feathers-style) to guard the fold — mirrors Bundle B's T0.
