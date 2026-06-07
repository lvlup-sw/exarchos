# lvlup-sw Fleet — CLAUDE.md Best-Practices Audit & Refactor Plan

- **Date:** 2026-06-06
- **Author:** Claude (Opus 4.8), parallel sub-agent audit
- **Scope:** All 13 git repos under `~/Documents/code/lvlup-sw/`, audited against the same best-practices rubric established for the exarchos `CLAUDE.md` refactor (see `docs/research/2026-06-06-claude-md-best-practices-refactor.md`).
- **Deliverable:** This plan. **No files in sibling repos were edited.** Each section is ready to execute (several need a small verification step first, flagged ⚠️).

---

## 0. Rubric (recap)

Target ≤200 lines / ~2,500 tokens, shorter better · **lead with commands** · include only non-derivable, non-rotting, project-specific facts · cut tree dumps / version-PR-issue stamps / roadmaps / past-decision rationale / restated linter rules / self-evident advice · **point-don't-paste** to `docs/` · tooling = **policy not catalog** (tool APIs belong in MCP server instructions) · CLAUDE.md is advisory context, so bloat trains Claude to ignore the *whole* file · 100%-rules → hooks, conditional → `.claude/rules/*.md` with `paths:`, reference → skills · **Claude Code reads `CLAUDE.md`, not `AGENTS.md`.**

---

## 1. Fleet verdict at a glance

| Repo | Owner | Today | Verdict | Target | Priority |
|---|---|---|---|---|---|
| **basileus** | lvlup-sw | CLAUDE.md 554 ln | **Refactor (cut ~80%)** | ~80–90 ln | **P0** |
| **ares-elite-platform** | lvlup-sw | root 389 + web 666 + 39 worktree copies | **Refactor 2 files, add 1** | root ~135 / web ~60 / black-gate ~30 | **P0** |
| **valkyrie** | lvlup-sw | AGENTS.md 141, no CLAUDE.md | **Add thin wrapper** | ~24 ln | **P1** |
| **strategos** | lvlup-sw | AGENTS.md 65, no CLAUDE.md | **Add thin wrapper** | ~22 ln | **P1** |
| **bifrost** | lvlup-sw | none | **Add** | ~40 ln | **P1** |
| **bronze-age** | lvlup-sw | none | **Add** | ~45 ln | **P1** |
| **dynatoi** | lvlup-sw | none (root) | **Add** ⚠️ verify cmds | ~90–120 ln | **P1** |
| **axiom** | lvlup-sw | CLAUDE.md 27, stale | **Trim + correct** | ~32 ln | **P2** |
| **srcPortfolio** | **personal (rsalus)** | CLAUDE.md 41, good | **Trim (advisory)** | ~30 ln | **P2** |
| **build / lvlup-build** | lvlup-sw | none | **Skip** (README carries it; defer past refactor branch) | — | P3 |
| **patents / patent-watcher** | (no origin) | none | **Skip** (Phase-1 stub; revisit at Phase 2) | — | — |
| **future-planning** | personal | none | **Skip** (markdown notes vault, not software) | — | — |
| **valkyrie-detacticalize** | — | not a git repo | **Skip** (worktree/copy of valkyrie) | — | — |

**Net:** 2 heavy refactors, 5 additions, 2 small trims, 4 declines. Declining 4 is deliberate — an empty/boilerplate CLAUDE.md is itself an anti-pattern.

---

## 2. Cross-cutting themes (fix once, apply everywhere)

1. **The TUnit / Microsoft.Testing.Platform trap (the single highest-value fact fleet-wide).** Every .NET 10 repo (basileus, bifrost, bronze-age, dynatoi, valkyrie, strategos) runs tests on TUnit + Microsoft.Testing.Platform, where test projects are `OutputType=Exe`. An agent's reflexive `dotnet test` is wrong; the form is `dotnet run --project <X>.Tests`. **Caveat:** several repos set `TestingPlatformDotnetTestSupport=true`, which *re-enables* `dotnet test` — so the exact incantation **must be verified per repo** before being written into the lead section (a wrong test command in the top section is the worst failure mode). Consider capturing this as a shared note.
2. **AGENTS.md is a scanner contract, not Claude onboarding.** strategos/valkyrie/ares AGENTS.md files carry `Scan Preferences` / `Severity Threshold` blocks consumed by a CodeRabbit-style harness (and `.coderabbit.yaml` exists). **Do not symlink `CLAUDE.md → AGENTS.md`** — it would load scanner config as guidance and block adding the Commands/MCP content Claude needs. Use a thin `@AGENTS.md`-import wrapper instead, and slim the AGENTS.md trees in a later pass.
3. **Stale hand-maintained trees & status stamps everywhere.** basileus (missing inference-gateway/e2b-sidecar), valkyrie (missing Knowledge/Generators/MonoGame.*), strategos, ares (Black Gate location contradiction) all have drifted file-tree dumps. Plus rotting status: ares "Current Status", AGENTS.md "Known Tech Debt", valkyrie "Performance Targets (Actual)", srcPortfolio "Workflow → PR #1". **Cut all of these.**
4. **Under-documented MCP tooling.** valkyrie ships a local HTTP MCP server (`127.0.0.1:5150`) documented nowhere; dynatoi has 3 servers with cold-start ordering semantics buried in wrapper-script comments; ares has the `aspire` MCP + a "no `aspire publish/deploy/do`" policy buried at L201. Surface these as **policy** in CLAUDE.md.
5. **Plugin-self-doc pattern.** axiom (like exarchos) is itself a plugin; its CLAUDE.md should orient agents *authoring* the plugin (test gate, skill layout, CI rules), not act as a user-facing README.

---

## 3. P0 — Heavy refactors

### 3.1 basileus (554 → ~80–90 lines)

**Cut (≈ −450 lines):**
- Project Structure ASCII tree (19–49) — derivable + already stale.
- Layer Responsibilities per-class inventories (176–252) and Domain Assemblies (254–319) → `docs/adrs/system-index.md` + `platform-architecture.md`.
- Key Design Patterns 6 code blocks (320–425) → a skill or `docs/`; the *rules* already live in `rules/coding-standards-dotnet.md` (triple-duplicated).
- Code Style (450–476), Common Patterns (523–554), Configuration tech/analyzer lists (432–448) — derivable / restate `.editorconfig`+`.globalconfig`.
- Rotting stamps: L262 "7 ExecutionProfile records (…)", L433–441 version pins (Aspire 13.0, Polly 8.6), L248 "~125ms boot", L516 archived-doc pointer.

**Keep (the gold):** the 7 numbered architecture-boundary rules (481–487, enforced by `Basileus.Architecture.Tests`), the three-tier security invariant, CPM rule, Result<T>/guard-clause convention (one line), the verified Documentation pointer list.

**Restructure:** move **Commands to the top** (currently buried at L51), trimmed to ~25 lines.

**⚠️ Open Qs before executing:**
- **Hard conflict:** CLAUDE.md L84/87–89 use `dotnet test --filter`, but `rules/dotnet-testing.md:48,63` says "DO NOT use --filter." Resolve which is correct under TUnit/MTP.
- Which `rules/` dir does Claude actually load? (`settings.json` wires only `worktree`.) De-dupe the two `dotnet-testing.md` files; add `paths:` frontmatter to the survivor.
- **AGENTS.md (65 ln) is stale + contradictory:** 11 `Agentic.*` paths (repo renamed to `Basileus.*`) and a Magentic-One/Specialist-agents claim that contradicts the shipped ExecutionProfiles architecture. **Decision:** rewrite AGENTS.md to fix drift + drop the contradiction; do **not** `@import` it as-is. Confirm its scanner consumer first.

**New Tooling section (~6 ln, policy):** always pass `basileus.slnx` explicitly; run via the Aspire AppHost; `worktree.baseRef: head`; playwright-cli for UI.

### 3.2 ares-elite-platform (root 389 → ~135; web 666 → ~60; + black-gate ~30)

**Reframe:** this is **not** 42-file sprawl — 39 of those are gitignored `.worktrees/` copies. The real problem is **2 oversized files**:
- **Root (389):** cut Directory Structure tree (19–71), Current Status (378–389, rotting), Environment Variables catalog (288–312 → per-app `.env.example`), "Future: Unified Deployment" roadmap (237–245), schema-sync block (168–193, duplicates `.claude/rules/schema-sync.md`). Keep ports table, `--legacy-peer-deps` gotcha, the "no `aspire publish/deploy/do`" policy. Move path-scoped "When Working On…" guidance (342–375) into `.claude/rules/*.md` with `paths:` frontmatter.
- **`apps/ares-elite-web/CLAUDE.md` (666):** rewrite to ~60 lines mirroring the **exemplary `apps/aegis-api/CLAUDE.md` (51 ln)**. **Preserve verbatim** the PR-#225 *identityLinks derive-on-read* contract (appears 3×; highest-signal fact in the tree), the schema-sync `getShape()/.extend()` pattern, and the "rep-not-set"/FHIR-ID pitfalls. Delete the tutorial (dir listings, type dumps, queryClient config, "Common Tasks", "Performance Considerations", References URLs).
- **Create `apps/black-gate/CLAUDE.md` (~30):** the BFF (most security-sensitive app) has zero scoped guidance — Bun/Elysia commands, Better-Auth/Turso, `personFhirId`-only-stored-identity constraint.

**⚠️ Fixes:** Black Gate location contradiction (frontend doc + root Status say "nested in frontend"; truth is `apps/black-gate/`); dead pointer aegis L38 → `docs/development/code-styling-guide.md` (missing).

**New Tooling section (~6 ln):** aspire MCP is project-scoped (`.mcp.json`); **deploy via `azd up` per-app, not `aspire publish/deploy/do`**; SessionEnd teardown hook.

---

## 4. P1 — Interop wrappers & warranted additions

### 4.1 valkyrie — add thin `CLAUDE.md` (~24 ln)
`@AGENTS.md` import + the content AGENTS.md lacks: TUnit commands (`cd src/Valkyrie && dotnet …`, solution `Valkyrie.slnx`); **the undocumented `valkyrie` HTTP MCP server** (`127.0.0.1:5150`, from `.claude/settings.json`) as policy ("start + health-gate before MCP work"); zero-allocation-hot-path core constraint; `s_camelCase` private-static convention; `valkyrie-design-invariants` skill (pairs with `/axiom:design`). ⚠️ AGENTS.md tree (L26–62) is provably stale — either trim it or add a one-line "slnx is authoritative" correction in the wrapper. ⚠️ Confirm how the MCP server is launched before writing "start it."

### 4.2 strategos — add thin `CLAUDE.md` (~22 ln)
`@AGENTS.md` import + missing Commands (`cd src && dotnet build|test`, `dotnet format analyzers …`, docs `cd docs && npm run dev`); the **RS0016/RS0017 public-API-drift build-break** gotcha (from CONTRIBUTING, not in AGENTS.md); `Result<T>` convention; Wolverine+Marten are external runtime deps; `strategos-design-invariants` skill. No MCP configured → no MCP section.

### 4.3 bifrost — add `CLAUDE.md` (~40 ln)
TUnit/MTP test invocation (README's `dotnet test` is **misleading**); .NET 10 **preview** SDK (`allowPrerelease`); **`IsAotCompatible=true`** on shipping projects (keep new code trim/AOT-safe); CPM; MinVer tag versioning; solution at `src/Bifrost.sln`; 80% coverage gate (`scripts/ci/coverage-gate.sh`). No tooling section (no MCP).

### 4.4 bronze-age — add `CLAUDE.md` (~45 ln)
**Dual-nature repo:** lead with "identify which half a task touches" — CODE (`src/`, .NET 10 MonoGame on the internal Valkyrie engine, `.slnx`) vs PROSE (`bible/` canon, `writing-pipeline/` 6-pass) vs SPECS (`docs/`). TUnit commands; warnings-as-errors; external `LevelUp.Valkyrie.*` NuGet dep (engine lives in another repo — point, don't paste). ⚠️ Confirm the runnable game client's launch command.

### 4.5 dynatoi — add root `CLAUDE.md` (~90–120 ln) — strongest "add" case
Non-derivable build/test (TUnit/MTP, `net10.0` pinned, warnings-as-errors); **3 MCP servers (`aspire`, `combat-host`, `dynatoi-game`) cold-start policy** — Claude fetches the tool list once at session start, so the AppHost must be healthy *before* the session or the unified tools are absent all session; `aspire start` is not idempotent; the standalone `Dynatoi.References.Mcp.Server` is **retired (#26)** — use combat-host. Point to the rich `.claude/skills/dynatoi-local/SKILL.md` as the run/debug SoT (don't re-paste). Hand off `content/` (writers' room, has its own CLAUDE.md). ⚠️ **Verify before writing:** exact TUnit run command (MTP support may re-enable `dotnet test`); the `kg/tools/` Python interpreter/deps (no `pyproject`/`requirements` committed — real gap).

---

## 5. P2 — Small trims

### 5.1 axiom (27 → ~32 ln) — trim + **correct factual errors**
The current file is a user-README and **lies about counts**: lists 6 skills (repo has **9** invokable: audit, critique, harden, distill, verify, scan, humanize, design, scaffold-invariants) and "7 dimensions" (there are **8**, DIM-8 = Prose Quality). Reframe as plugin-authoring orientation: lead with `npm run test:run` (skills are Markdown, **no build step**); the test gate; the **no-"exarchos"-in-CLAUDE.md CI rule** (`plugin-structure.test.ts`); vendored content stays under `vendor/` not `skills/`; `vendor/skill-creator/` is auto-synced (don't hand-edit); lockfile-version-sync CI check; release on `v*` tag. Replace skill/dimension catalogs with pointers to `skills/*/SKILL.md` + `references/dimensions.md`.

### 5.2 srcPortfolio (41 → ~30 ln) — **personal repo, advisory only**
Origin is `rsalus/srcPortfolio` (personal). Add the missing build commands (`npm run dev/build/preview` — only `test:run` is present); **delete `## Workflow`** (branch + PR #1 + featureId stamp); de-stamp `## Tests` (drop "132 tests"); trim brand non-negotiables to the top 2–3 + pointer to `DESIGN.md`; **keep the Tailwind-v4 JIT gotcha verbatim** (best line in the file); add one line on the `worker/resume/` Cloudflare Worker. Flag to Reed before changing (personal ownership).

---

## 6. Declines (with rationale — not creating these)

- **build / lvlup-build** — README already documents the props/targets-only meta-package thoroughly; the only non-obvious fact (deliverable = MSBuild content in `src/Lvlup.Build/build/`, no tests) is a 1-liner. Defer past the in-flight `refactor-namespace-migration` branch; lean skip.
- **patents / patent-watcher** — Phase-1 walking skeleton (`index.ts` is a placeholder). A CLAUDE.md now would document intentions that rot immediately. Revisit when Phase-2 real clients land. (Do fix the README `bun run pack` / `bun test` vs `vitest run` discrepancies at source.)
- **future-planning** — personal markdown notes vault, no build system. A CLAUDE.md would be pure bloat.
- **valkyrie-detacticalize** — not a separate git repo (worktree/copy of valkyrie); folds into valkyrie's plan.

---

## 7. Suggested execution order & method

1. **P0 first** (basileus, ares) — biggest bloat/correctness wins; both have ⚠️ open questions to resolve before writing.
2. **P1 .NET additions as a batch** (bifrost, bronze-age, dynatoi, + valkyrie/strategos wrappers) — they share the TUnit verification step; do it once, apply across.
3. **P2 last** (axiom factual fixes, srcPortfolio with Reed's sign-off).

**Method options per repo:**
- **Direct edit** for the small/clear ones (wrappers, axiom, srcPortfolio).
- **Dogfood Exarchos** for the heavy refactors: `/exarchos:refactor` or `/exarchos:oneshot` in each target repo, referencing the relevant section of this plan as the design input — gives diff/review gates and an audit trail. (Each repo already has `.claude/` and is worked by exarchos agents.)

**Verification owed before writing any .NET lead section:** run one test project both ways (`dotnet test` vs `dotnet run --project *.Tests`) per repo and document the working form. Resolve basileus's `--filter` conflict and dynatoi's Python-deps gap. Fix ares's two stale pointers/location contradiction.
