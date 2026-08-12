# Discovery: Hooks-as-Tier-1-Harness-Support & Invariants Dev-Catalog Onboarding

- **Date:** 2026-05-24
- **Workflow:** `discover-hooks-and-invariants-onboarding`
- **Milestone:** v2.10.0 GA (preliminary scoping)
- **Status:** Discovery complete — no code changes. Two candidate work items assessed. **See [Round 2](#round-2--sharpened-directives-2026-05-24) for the maintainer's sharpened directives and verification verdicts.**

## Why this exists

Two questions were raised for possible inclusion in v2.10.0 GA:

1. **Hooks templating.** "How does the system integrate with Hooks in specific agent
   harnesses today? I expect a clean slate — the only linkage between CLI/MCP and the
   harness is skills. I want to extend our *tier-1 harness support* convention from the
   skill-templating layer to **Hooks**, so we can force the harness to orchestrate through
   Exarchos."
2. **Invariants dev-catalog onboarding.** "We landed the invariants catalog and opened it to
   dev customization. How is it configured for *this* repo, and is there an onboarding path —
   how do I bootstrap a fresh repository?"

Both starting assumptions turned out to be wrong in instructive ways. The findings below
correct them and reframe each into an actionable v2.10.0 scope decision.

---

## Thread 1 — Hooks & the skill-templating layer

### Headline: it is **not** a clean slate, but the gap you intuited is real

The premise "the only linkage is skills" is **false**. Exarchos already ships six Claude Code
hooks in [`hooks/hooks.json`](../../hooks/hooks.json):

| Hook event | Matcher | Command | Timeout |
|---|---|---|---|
| `PreToolUse` | `mcp__(plugin_exarchos_)?exarchos__.*` | `exarchos guard` | 5s |
| `TaskCompleted` | — | `exarchos task-gate` | 120s |
| `TeammateIdle` | — | `exarchos teammate-gate` | 120s |
| `SubagentStart` | — | `exarchos subagent-context` | 5s |
| `SubagentStop` | `exarchos-implementer\|exarchos-fixer` | `exarchos subagent-stop` | 10s |
| `SessionEnd` | `auto` | `exarchos session-end` | 30s |

These are live, tested, and CI-guarded (`src/hooks-validation.test.ts`,
`src/plugin-validation.test.ts`). The `PreToolUse` guard already does exactly what you
described as the goal — it intercepts *every* Exarchos MCP tool call and runs `exarchos guard`
before the tool executes, "forcing" the harness through Exarchos's phase guardrails.

So the orchestration-enforcement mechanism you want **already exists for Claude**. What does
*not* exist is the thing your phrasing actually points at:

> **The hooks are hand-authored, Claude-only, and live entirely outside the per-runtime
> skill-templating pipeline.**

### How "tier-1 harness support" actually works today

"Tier-1" is a real term in the code, but it lives in the **MCP agent-adapter layer**, not the
skill renderer:

- `servers/exarchos-mcp/src/agents/adapters/types.ts:35` —
  `RUNTIMES = ['claude', 'codex', 'opencode', 'cursor', 'copilot']`. `generic` is explicitly
  *not* tier-1 (it's the degraded fallback target).
- The skill renderer (`src/build-skills.ts`, `buildAllSkills()`) renders one
  `skills-src/<name>/SKILL.md` per runtime YAML, substituting `{{TOKEN}}` placeholders and
  eliding `<!-- requires:cap -->` blocks the runtime doesn't support.

Crucially, each `runtimes/<name>.yaml` already declares a **`hasHooks` capability** in
`CapabilitiesSchema` (`src/runtimes/types.ts:27`). It is `true` only for `claude`; every other
runtime is `false`. `runtimes/generic.yaml` even comments: *"hasHooks: false → any hook-driven
flows must be degraded to inline checks or documented as manual steps."* And the seven canonical
placeholders already include `SUBAGENT_COMPLETION_HOOK` and `SUBAGENT_RESULT_API`
(`src/runtimes/types.ts:104`) — the vocabulary for cross-runtime hook/poll differences is
half-built but is only used in *prose*, never to emit a hook artifact.

In other words: the renderer **knows** which runtimes support hooks, but it has no pass that
*emits* per-runtime hook config. `hooks/hooks.json` is a static, Claude-shaped file checked in
by hand, auto-loaded by the Claude Code plugin format (it is deliberately *not* declared in
`.claude-plugin/plugin.json` — see the assertion `expect(plugin.hooks).toBeUndefined()` in
`src/plugin-validation.test.ts:21`).

### Two different "hooks" — don't conflate them

There is a second, unrelated hooks system: `servers/exarchos-mcp/src/hooks/config-hooks.ts` is
an **Exarchos-internal** fire-and-forget runner for user shell callbacks on *workflow* events
(`config.hooks.on[event.type]`). It is not a harness surface. Keep it out of scope for this
thread.

### What's genuinely missing (and already deferred on-record)

[`docs/research/2026-05-14-entireio-cli-harness-strategy.md`](2026-05-14-entireio-cli-harness-strategy.md)
"Lesson E" already names the real gap and its disposition:

- **Harness-control hooks** (Exarchos → harness): ✅ exist for Claude (`PreToolUse` guard etc.).
- **Lifecycle-observer hooks** (harness → Exarchos: session start/stop, compaction, tool-use
  error): ❌ none. Recommendation on record: **"Defer. Lifecycle-hook installation is a
  v2.10/v2.11 axis."** It also explicitly rejects programmatic `~/.claude/settings.json`
  mutation: *"Direct config-file mutation is what plugins exist to avoid."*

Note `PreCompact` and `SessionStart` hooks were intentionally *removed* in the T-40 rehydration
refactor (auto-resume → user-invoked `/checkpoint` + `/rehydrate`). Re-introducing
lifecycle hooks would partly reverse that decision — worth a deliberate ADR, not a drive-by.

### Verdict & recommended scope for v2.10.0

Reframe the work item. It is **not** "add hooks" (Claude has them) and **not** "the only
linkage is skills" (false). The defensible v2.10.0 slice is:

> **Promote hooks to a first-class, per-runtime templated artifact in the build pipeline**,
> so `hasHooks` stops being a prose-only flag and starts driving generated output — with
> Claude as the only `hasHooks: true` producer today and a clean degradation story for the
> other four tier-1 runtimes.

Concrete extension points (all additive, all in the existing pipeline):

1. Add an optional `hooks:` section to `RuntimeMapSchema` (`src/runtimes/types.ts`), guarded
   for consistency against `capabilities.hasHooks`.
2. Add a `buildAllHooks()` pass (sibling to `buildAllSkills()` in `src/build-skills.ts`) that
   renders a `hooks-src/` source tree per runtime, substituting `{{MCP_PREFIX}}` etc. For
   `hasHooks: false` runtimes it emits nothing (or a documented "manual steps" note).
3. Land the Claude render output at the well-known `hooks/hooks.json` plugin path so it stays
   auto-loaded.
4. Add a `hooks:guard` CI check mirroring `skills:guard` — re-render and fail on
   `git diff hooks/`. Extend `scripts/validate-plugin.sh` (which already checks for the 6 hook
   types at line ~168).

What to **defer** to v2.11 (and gate behind an ADR): lifecycle-observer hooks and any
`settings.json` mutation. Those are a different, riskier axis and are already deferred on record.

---

## Thread 2 — Invariants dev-catalog onboarding

### Headline: this repo is opted in; a fresh repo has a real onboarding cliff

**This repo's config** ([`.exarchos.yml:45-46`](../../.exarchos.yml)):

```yaml
invariants:
  devCatalog: enabled
```

The comment block above it is explicit: the loader defaults to **disabled even inside the
Exarchos repo**; the 27 dev-catalog entries surface at `/ideate` Phase 0 *only because this
committed file declares the flag*. Verified against the schema
(`servers/exarchos-mcp/src/config/exarchos-config-schema.ts:95` — two-state
`enum(['enabled','disabled'])`, default off, no auto-detect) and the loader
(`servers/exarchos-mcp/src/architecture/invariants-loader.ts:472` —
`if (devCatalog !== 'enabled') return []`).

### How resolution works — three layers

`resolveEffectiveCatalog` (`servers/exarchos-mcp/src/architecture/resolve-effective-catalog.ts`)
merges, in order:

1. **Dev catalog** (gated by `devCatalog`) — read from `docs/architecture/invariants.md`
   (Markdown + YAML frontmatter, schema v3). 27 entries: `INV-1..INV-15`, `INV-5a..d`,
   `DIM-1..DIM-8`. Off by default.
2. **SDLC catalog** (default-**on**, no gate) — compiled inline in
   `servers/exarchos-mcp/src/architecture/sdlc-catalog.ts`. `SDLC-1..SDLC-5` (phase
   observability, TDD discipline, review-gate honesty, branch/PR discipline, recovery posture).
   Every consumer gets these for free.
3. **User catalogs** (paths in `config.invariants.catalogs`) — external Markdown; `INV-*`/`SDLC-*`
   id namespaces are reserved and filtered to warnings.

Surfaced via `exarchos_view { action: "invariants_effective", phase, workflowType, repoRoot? }`
(`servers/exarchos-mcp/src/views/effective-catalog.ts`).

### The `design-invariants` skill is gone

`.claude/skills/design-invariants/` **no longer exists** — retired in T-23, with a permanent
guard test (`servers/exarchos-mcp/src/architecture/skill-retirement.test.ts`). Its three jobs
were redistributed: audit → `check_invariant_conformance` gate; vocabulary →
`docs/architecture/invariants.md`; prose → `docs/architecture/invariants/references/`. Phase-0
anchoring now lives directly in the brainstorming/ideate skill body. (The project memory note
pointing at `.claude/skills/design-invariants/` is stale and should be updated.)

### The onboarding cliff

There are **two unconnected bootstrap paths**, and neither is wired into `exarchos init`:

- **YAML catalog path** — documented in
  [`docs/guides/authoring-invariants.md`](../guides/authoring-invariants.md): hand-author a
  catalog file, register it under `invariants.catalogs` in `.exarchos.yml`. Explicit by design,
  no auto-detection.
- **Skill scaffolder path** — `axiom:scaffold-invariants` runs a 5-question interview and emits
  a `.claude/skills/<project>-design-invariants/` skill that pairs with `axiom:design`. This is
  a *different artifact* (an ideation-pairing skill), not a dev/user catalog.

Gaps found:

1. `exarchos init` seeds only `test`/`typecheck`/`install` in `.exarchos.yml`
   (`servers/exarchos-mcp/src/verbs/init/seed-exarchos-config.ts`) — **no `invariants:`
   stanza at all**. A fresh repo gets zero invariants config and must hand-edit.
2. The two bootstrap docs/paths have **no cross-reference** — a consumer reading the authoring
   guide never learns the scaffolder exists, and vice-versa.
3. `axiom:scaffold-invariants/SKILL.md` still references the **retired**
   `.claude/skills/design-invariants/` archetype (stale pointer; works only because templates
   are self-contained).
4. No `exarchos doctor` / pre-commit validation for user catalog files (loader degrades to a
   warning, so typos fail silently-ish).
5. No starter/example catalog shipped with the plugin.
6. Reading inconsistency: `invariants_effective` uses `loadExarchosConfig` (strict full-file
   validation) while `loadInvariants` uses a lenient `readInvariantsConfig` extractor — same
   file, different validation semantics. A valid-`invariants` / invalid-other-key file behaves
   differently across the two paths.
7. MCP Resource seam `exarchos://invariants/effective` (`#1286`) noted but unimplemented.

### How to bootstrap a fresh repo *today*

1. SDLC baseline (`SDLC-1..5`) is already on — nothing to do.
2. Author a catalog file (e.g. `.exarchos/invariants.yml`, schema v3).
3. Register it manually in `.exarchos.yml` under `invariants.catalogs` (+ optional
   `enforcement.review: blocking`). **`exarchos init` will not do this.**
4. Tune severities via `invariants.overrides`.
5. Verify with `exarchos_view invariants_effective` before relying on the gate.
6. *(Optional, ideation pairing)* run `/axiom:scaffold-invariants`.
7. *(Exarchos contributors only)* add `invariants.devCatalog: enabled`.

### Verdict & recommended scope for v2.10.0

The catalog *engine* is shipped and solid; the GA-worthy gap is **onboarding ergonomics**. A
small, high-leverage slice:

> **Teach `exarchos init` to seed a commented `invariants:` stanza** (a disabled `devCatalog`
> line + a stubbed `catalogs:` example), **cross-link the two bootstrap docs**, **fix the stale
> `design-invariants` archetype pointer** in `axiom:scaffold-invariants`, and **reconcile the
> two config-reading paths** (gap #6) so validation is consistent.

Defer to a later milestone: the `#1286` MCP Resource and any `exarchos doctor` catalog linter
(nice-to-have, not GA-blocking).

---

## Recommendation summary for v2.10.0 GA

| Thread | Premise was… | Reality | GA-worthy slice | Defer |
|---|---|---|---|---|
| Hooks | "only linkage is skills" | False — 6 Claude hooks ship; but they're hand-authored & off the templating pipeline | Make hooks a per-runtime **templated artifact** driven by `hasHooks`; add `hooks:guard` | Lifecycle-observer hooks + `settings.json` mutation → v2.11 + ADR |
| Invariants | "is there onboarding?" | Engine shipped & this repo opted-in; **no init seeding, two disconnected paths, stale pointer** | `init` seeds `invariants:` stanza; cross-link docs; fix archetype pointer; reconcile dual config readers | `#1286` Resource; `exarchos doctor` linter |

Neither item is a code change yet — both are scoped, evidence-backed candidates. If either is
approved for build, escalate to `/exarchos:ideate` referencing this report as design input.

The hooks-templating item warrants an ADR first (it partially reverses the T-40 hook-removal
decision and touches the plugin auto-load contract); the invariants-onboarding item is a
straightforward ergonomics PR.

---

# Round 2 — Sharpened directives (2026-05-24)

After reviewing Round 1, the maintainer issued three sharper directives. Round 2 captures them,
the verification work done against each, and the cross-cutting decision they force.

## Directive A — Replace the enforcement hooks with templated lifecycle *observers*

> "Our current hand-authored hooks are stale functionality. We really only want the
> lifecycle-observer hooks, but integrated with the per-runtime skill-templating pipeline."

This **inverts** Round 1's "keep what we have" framing. The six hooks split into two kinds:

| Hook | `exarchos` subcommand | Kind | Disposition |
|---|---|---|---|
| `PreToolUse` (guard) | `guard` | **enforcement** (blocks tool exec) | **retire** |
| `TaskCompleted` | `task-gate` | **enforcement** (gates) | **retire** |
| `TeammateIdle` | `teammate-gate` | **enforcement** (verify) | **retire** |
| `SubagentStart` | `subagent-context` | **control** (injects context) | **retire** |
| `SubagentStop` | `subagent-stop` | observer-ish (cleanup) | re-cast as observer |
| `SessionEnd` | `session-end` | **observer** (cleanup) | keep as observer |

**Blast radius of retiring the enforcement hooks** (verified):
- The hook dispatch set is `HOOK_COMMANDS = {guard, task-gate, teammate-gate, subagent-context,
  session-end}` in `servers/exarchos-mcp/src/agents/adapters/hooks.ts:12`, routed through a
  lightweight path that skips backend init. Their handlers live in
  `servers/exarchos-mcp/src/cli-commands/` (`guard.ts`, `gates.ts`, `session-end.ts`,
  `subagent-context.ts`). Retiring the hooks orphans these handlers — they remain manually
  invokable but are no longer auto-fired.
- **The real behavior loss is `guard`.** The `PreToolUse` matcher
  `mcp__(plugin_exarchos_)?exarchos__.*` is the only thing that *forces* the harness through
  Exarchos's phase guardrails today. Dropping it means orchestration enforcement becomes
  advisory (the MCP tools still validate internally, but nothing pre-empts an out-of-phase
  call at the harness boundary). The maintainer is explicitly accepting this — the new posture
  is **observe, don't enforce** at the hook layer.
- Note `subagent-stop` appears in `hooks/hooks.json` (`SubagentStop`) but is **not** in the
  `HOOK_COMMANDS` set — a pre-existing inconsistency to resolve when this is rebuilt.

**What "lifecycle observer + per-runtime templating" means concretely.** The end state is the
`buildAllHooks()` pipeline from Round 1, but the *source content* is observer hooks only —
fire-and-report signals on harness lifecycle events (session start/stop, subagent start/stop,
compaction, tool-use error) that let Exarchos record provenance/telemetry without blocking. The
`hasHooks` capability (`src/runtimes/types.ts:27`, `true` only for `claude`) gates which runtimes
get a generated `hooks.json`; others degrade to documented manual steps. This is still
ADR-worthy because it (a) removes the `guard` enforcement contract and (b) re-introduces
lifecycle events (`SessionStart`/`PreCompact`-class) that T-40 deliberately removed — but now as
*observers*, not auto-resume drivers, which is a cleaner justification than Round 1 assumed.

## Directive B — Verify the dev catalog is content-complete → **VERDICT: INCOMPLETE**

> "Invariant catalog should be fully content-complete for exarchos devCatalog. Verify this."

Audited `docs/architecture/invariants.md` (schema-version 3) against its validating schema
(`servers/exarchos-mcp/src/architecture/invariant-schema.ts:176`) and the pinning tests. The
catalog is **structurally sound** (27 entries — 18 INV-* + 8 DIM-* + `basileus-boundary`; all
required fields present; no TODO/TBD/stub text) but is **not content-complete**:

1. **Four broken `references:` targets** (HIGH — these point at files/dirs that do not exist):
   - INV-7 → `servers/exarchos-mcp/src/event-store/stream-lock-manager.ts` (the
     `StreamLockManager` class actually lives in `atomic-appender.ts:302`, never extracted).
   - INV-8 and INV-13 → `servers/exarchos-mcp/src/dispatch/with-session.ts` (no such file;
     `withSession` is a method on `AtomicAppender`).
   - INV-9 → `servers/exarchos-mcp/src/hsm/` (no such dir; HSM lives in
     `workflow/hsm-definitions.ts`).
   - **No test guards filesystem existence of reference paths** — `dev-catalog-content.test.ts`
     checks frontmatter content only. These rotted silently.
2. **Six substrate entries missing recommended citations** (MEDIUM): INV-2, INV-3, INV-4,
   INV-5a, INV-5b, INV-5c have zero citations; the schema doc (`invariants.md:746`) recommends
   ≥3 for substrate-axis. The test pins only ≥2 references and explicitly defers the ≥3 target.
3. **All 8 DIM-* entries are axiom-coupled** — see Directive C; this is the dominant
   completeness blocker, not a citation nit.

So "make it content-complete" is a real, bounded work item: fix 4 reference paths, backfill 6
citation sets, and resolve the DIM-*/axiom question below.

## Directive C — Functionally retire axiom everywhere → **load-bearing, ordered plan exists**

> "axiom should be functionally retired across skills/references/everywhere."

Axiom is **not** a passive mention; it is wired into config resolution, the review orchestrator,
the invariants loader, and ~10 tests. Full inventory is in the audit, but the load-bearing
coupling and three retirement traps are:

**Load-bearing surfaces:**
- `.exarchos.yml:32` `plugins.axiom.enabled: true` + Zod `PluginsConfig` (`config/yaml-schema.ts:115`,
  `.strict()`) + resolver defaults (`config/resolve.ts:54,129,283,309`).
- Review path: `verbs/team/prepare-review.ts:71` returns `pluginStatus.axiom`; `commands/review.md`
  invokes `Skill({skill:"axiom:audit"})`; `skills-src/quality-review/references/axiom-integration.md`
  is a whole Tier-3 integration spec.
- Invariants loader: `axiomOverlap` field + **referential-integrity check**
  (`invariants-loader.ts:508`) that throws if an INV-* `axiom_overlap: DIM-N` points at a missing
  DIM-* entry. 11 INV-* entries carry `axiom_overlap`.

**Three retirement traps (order matters):**
1. **Deleting the `plugins.axiom` key re-enables axiom** — resolver defaults to `true` when absent
   (`resolve.ts:283`). Must set `enabled: false`, not delete.
2. **Removing `axiom` from the strict Zod schema before the yml → runtime crash** on any config
   still carrying the key. Remove from yml first, schema second.
3. **Removing DIM-* entries before stripping `axiom_overlap` fields → loader throws** for all 11
   INV-* entries at load time, breaking `/ideate` Phase 0, `invariants_effective`, and the
   conformance gate.

The audit produced a full **8-phase ordered checklist** (disable → skills/commands + regenerate →
config schema/resolver → loader+catalog → tests → `CLAUDE.md:55` instruction → reconcile the
active v3-content plan `docs/plans/2026-05-24-invariants-dev-catalog-v3-content.md` → historical
docs). Reproduce it verbatim when this becomes a build item.

## The cross-cutting decision: what happens to DIM-1..DIM-8?

Directives B and C collide at the DIM-* entries. They are simultaneously (a) "axiom dimension
pointers" whose summaries name `/axiom:critique`, `/axiom:harden`, etc. as the canonical check,
and (b) catalog entries that 11 INV-* entries reference via `axiom_overlap`. "Content-complete +
axiom-retired" is impossible without picking one:

- **Option 1 — Excise DIM-*.** Remove all 8 DIM-* entries and all 11 `axiom_overlap` fields and
  the `axiomOverlap` loader machinery + tests. Cleanest decoupling; loses the dimension
  vocabulary entirely. Catalog drops to 19 entries.
- **Option 2 — Adopt DIM-* as native Exarchos vocabulary.** Keep the entries but strip
  "axiom-owned / see /axiom:X" prose, rename `axiom_overlap` → a neutral field (e.g.
  `dimension_overlap`), and either point the "canonical check" at an Exarchos-internal gate or
  drop it. Preserves the topology/observability/contracts/etc. taxonomy; more edits, keeps
  referential integrity meaningful.

**Recommendation: Option 2** if the DIM taxonomy is still wanted for ideation routing
(the brainstorming skill uses it as a selection table); **Option 1** if the taxonomy was only
ever an axiom bridge. This is the single decision that unblocks both directives — it should be
made before any code/catalog edits.

## Directive D (implied) — `exarchos init` / `doctor` scaffolding → **integration points exist**

> "we need an exarchos init command or similar integration with exarchos doctor/install-skills/etc
> to scaffold a new config."

Verified — the scaffolding spine already exists; it just doesn't know about invariants:

- **`init` exists.** `handleInit` (`servers/exarchos-mcp/src/verbs/doctor/index.ts`) fans out
  per-runtime config writers (`ClaudeCodeWriter`, `CursorWriter`, `CodexWriter`, `CopilotWriter`,
  `OpenCodeWriter`) + VCS detection, and **already seeds `.exarchos.yml`** via
  `seedExarchosConfig` (`init/seed-exarchos-config.ts:198`). Today it writes only
  `test`/`typecheck`/`install` and is idempotent (never overwrites).
- **`doctor` exists.** An MCP orchestrate action (`orchestrate/doctor/` with `probes.ts` and
  `checks/`, registered `registry.ts:2224`) — the natural home for a catalog-validation check.

**Integration point: extend `seed-exarchos-config.ts`** to emit a commented `invariants:` stanza
(a `devCatalog: disabled` line for consumers + a stubbed `catalogs:` example) alongside the
existing fields. Add a `doctor` check that validates any user catalog files and warns on the
dual-config-reader inconsistency (Round 1 gap #6). No new command needed — both surfaces are live.

## Round 2 recommendation summary

| Directive | Verdict | Build shape | Gate |
|---|---|---|---|
| A — observer hooks via templating | Pivot accepted; `guard` enforcement consciously dropped | `buildAllHooks()` pass + observer-only `hooks-src/`; retire 4 enforcement hooks + orphaned CLI handlers | **ADR** (drops enforcement contract; re-adds lifecycle events) |
| B — catalog content-complete | **INCOMPLETE** — 4 broken refs, 6 missing citation sets, DIM coupling | fix paths, backfill citations, add a ref-path existence test | depends on C decision |
| C — retire axiom | load-bearing; 8-phase ordered plan | follow the checklist; mind the 3 traps | the DIM-* decision (Option 1 vs 2) |
| D — init/doctor scaffold | integration points exist | extend `seed-exarchos-config.ts` + add `doctor` catalog check | none — straightforward PR |

**Sequencing:** make the DIM-* decision first → it unblocks B and the catalog half of C. C-config
and C-skills can proceed in parallel. D is independent and shippable now. A is the largest and
should be its own ADR + PR stack, decoupled from B/C/D.
