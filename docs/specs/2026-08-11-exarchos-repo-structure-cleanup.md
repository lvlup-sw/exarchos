# Spec: Exarchos repository structure cleanup (six-directory top level, layer-expressed core, one authoring root)

**Date:** 2026-08-11 · **Feature:** `exarchos-repo-structure-cleanup` · **Depth:** deep · **Revision:** 2 (post plan-review)
**Inputs:** measured structural map of the working tree at `355ffd63` (3,317 tracked files), re-verified 2026-08-11 after a 3-voter adversarial panel refuted revision 1; `docs/system-design.html` (canonical layer architecture, L1–L9); `.exarchos/invariants.md` (registered dev catalog); reference pattern `docs/2026-08-11-repo-structure-refactor.md` (sibling repo, revision 2).

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

> **Revision 2 note.** Revision 1 was refuted **3/3** by an independent panel (`claude-opus-5`, `gpt-5.6-sol`, `gemini-3.1-pro-preview`), each provisioned with the artifact and the repository but not the authoring transcript. Roughly 25 HIGH gaps were raised, most verified to file:line. **Two load-bearing premises were destroyed, not dented:**
>
> 1. **The sole-authority choice for layering was impossible.** `layer-boundaries-seam.ts`'s `layerOf()` returns the **first path segment only** and `detectLayerEdges` discards `targetLayer === sourceLayer`, so `adapters/mcp → adapters/cli` is structurally inexpressible; `isRootFile()` additionally excludes `registry.ts` (4,636 LOC) from the graph entirely.
> 2. **The authoring/rendered split rested on a false model.** `commands/`, `rules/` and `binding/` are **hand-authored with no renderer**; `agents/*.md` are **generated** from `ALL_AGENT_SPECS` in `src/agents/definitions.ts:612`; and `skills/` and `hooks/` are **not purely generated** — they carry 21 and 2 live non-generated files respectively.
>
> Revision 1 also asserted two measured facts that are false, and contradicted itself on the phase boundary, the layer count, the red-baseline rule and the parallel groups. Every correction is recorded in `### Corrected findings` so the same errors are not reintroduced.

## Constraints

An invariants catalog **is** registered (`.exarchos.yml: invariants.catalogs → { path: .exarchos/invariants.md, tier: dev }`), so the anchors below are surfaced per `@skills/ideate/references/constraint-anchoring.md`.

**Always-load anchors:**

- **INV-2** (contract-client-equivalence) — *The MCP wire projection of the compiled contract is the invocation surface; the CLI is a CLIENT of that same contract, equal to the wire BY CONSTRUCTION rather than by hand-coordination.* This is load-bearing for naming: the author explicitly rejected framing MCP as "an adapter like CLI". MCP is the wire contract; the CLI is presentation over it. Any tree that puts `mcp/` and `cli/` on equal footing without stating the direction of the dependency misstates the architecture.
- **INV-1** (event-sourcing-integrity) — *The append-only event log is the source of truth; every read-model is a left-fold over events.* Regrouping `event-store/` and `projections/` must not introduce a side database or a cache that outlives a fold.
- **INV-6** (workload-agnosticism) — *The runtime makes no assumption about which workload is executing.* Directory names must not encode workflow types.
- **INV-15** (single-machine-frame) — *Single-machine event-sourced process manager with cooperative agents — concurrent, not distributed.* A layer split must not be read as a service split.

**Reference-only, pulled deliberately:**

- **INV-4** (platform-agnosticity) — *Authored content is emitted ONCE as a standard-conformant artifact wherever a standard converged; each harness reads it natively.* Governs the authoring/rendered split (DR-4) and forbids re-solving per-harness variance by hand.
- **INV-16** (os-portability) — *Paths that are stored or compared are POSIX-normalized; built with `path.join`, never separator concat.* A refactor whose principal work is path movement, authored on Windows, is exactly where this invariant is violated silently.

**Author-stated constraints, recorded verbatim in effect:**

- **Greenfield, clean breaks permitted.** The author has sanctioned changing external contract pins (`plugin.json`, `manifest.json`) and increasing scope to reach the optimal end state rather than the cheapest one.
- **The docs exodus is future work using symlinks.** The stated grievance is *the number of markdown artifacts stored in the repository*, not the `docs/` path itself. The default artifact directory stays `docs/specs/`.
- **The hard-coded artifact path is a code smell to fix, not a folder to move.** Named by the author directly; it becomes DR-6.
- **Product markdown is the product.** `skills/`, `commands/`, `rules/`, `agents/`, `binding/` are shipped artifacts and are out of scope for the markdown reduction — their *organization* is in scope.

**Citing these anchors in the work they govern.** The comment-hygiene spec forbids `INV-<n>`
in **code comments**, and this refactor's most comment-worthy changes are exactly the ones an
author would reach for an invariant number to explain — task 040's layer census and task 041's
one-way `adapters/mcp ↛ adapters/cli` rule both encode INV-2. The rule governs code comments
only; the invariants catalog stays citable from documentation. So `docs/ARCHITECTURE.md` names
INV-2 and explains the direction, and the census source states the constraint in words —
"the contract is the invocation surface; the CLI is a client of it, so the dependency runs one
way" — without the ordinal. Implementers need this stated up front, because the natural
phrasing at the point of authoring is the forbidden one.

### Measured findings

Every number below was verified against the tree at `355ffd63`. They are stated here so a later revision cannot silently reintroduce a corrected error.

| Claim | Verified value |
|---|---|
| Tracked files | 3,317 |
| Non-dot top-level directories | 24 (plus 7 classified dot-directories) |
| Tracked markdown | 1,009 files — 669 under `docs/`, 340 elsewhere |
| Product markdown (shipped in `package.json files[]`) | `commands/` 18, `skills/` 216, `command-aliases/` 16, `agents/` 4, `rules/` 1, `hooks/` — **`skills-src/` and `binding/` are NOT in `files[]`** |
| Test files | 1,141 (34% of the repo) — 928 under `servers/`, 77 `scripts/`, 61 `src/`, 33 `test/`, 13 `benchmarks/`, 13 `tests/`, 10 `docs/`, 6 elsewhere |
| Test roots | **Five**: `test/`, `tests/`, `servers/exarchos-mcp/test/`, `servers/exarchos-mcp/tests/`, `servers/exarchos-mcp/src/__tests__/` |
| Core size | `servers/exarchos-mcp/` = 1,673 files (50.4% of the repo); `src/` = 1,609 |
| `orchestrate/` | 387 files — **83 non-test files flat at the top of the directory**; 47k src LOC + 80k test LOC |
| Manifest/lockfile pairs | **Four**: root; `servers/exarchos-mcp/`; `servers/exarchos-mcp/evals-pkg/` (named in `ci.yml`'s `prompts:` paths-filter); `documentation/` |
| Authored vs generated | **Not a clean tree split.** Authored-with-no-renderer: `commands/` (18), `rules/` (1), `binding/` (1). Generated from TypeScript: `agents/*.md` ← `src/agents/definitions.ts:612`. Generated from markdown: `skills/<runtime>/` ← `skills-src/`. Generated from `commands/*.md` + `COMMAND_TO_SKILL`: `command-aliases/` ← `src/build-command-aliases.ts:40`. Generated from JSON: `hooks/<runtime>/HOOKS.md` ← `hooks-src/hooks.json` |
| Non-generated files inside "generated" trees | `skills/` holds **21**: `test-fixtures/` (13), `trigger-tests/` (5), `validate-all-skills.sh`, `validate-frontmatter.sh`, `validate-frontmatter.test.sh`. `hooks/` holds **2**: `pre-push.ship-gate.sample` (shipped git hook) and `pre-push.test.ts` (collected by root `vitest.config.ts`'s `hooks/**/*.test.ts`) |
| Conformance suite | `src/architecture/` — 78 files (37 non-test, **13,785 LOC**; 41 test). **~26 outbound imports** into the core it governs: `event-store` 6, `config` 5, `registry.js` 4, `review` 3, `contract` 2, `orchestrate` 2, `schemas`, `sdk` |
| `layer-boundaries-seam.ts` | 1,152 LOC carrying **three** independent censuses: layering (~345 LOC, lines 85–430), `DECLARATION_SEAM` (~380), `SDK_SEAM_BOUNDARY` (~338). Layering governs **12 peripheral leaves** only (`utils`, `lib`, `shared`, `ndjson`, `schemas`, `topology`, `runtime`, `onramp`, `pruner`, `hooks`, `runbooks`, `stack`) — the tangled core is deliberately **ungoverned** |
| Layer census expressiveness | `layerOf()` = **first path segment only**; `detectLayerEdges` skips `targetLayer === sourceLayer`; `isRootFile()` returns `[]`. Sub-directory rules and root files are inexpressible today |
| Layering call sites | `layerOf`/`isRootFile`/`detectLayerEdges`/`scanLayerEdges`/`runLayerBoundaryCensus`/`LAYER_ALLOWED_IMPORTS` appear in **exactly two files** — the seam (22) and its own test (27). **Zero external consumers** |
| Layer enforcement, second authority | `.dependency-cruiser.cjs` `no-domain-core-to-io-adapters` is `severity: 'error'`, scoped `^servers/exarchos-mcp/src/(event-store\|workflow)/` → `adapters/`, executed by `runBoundaryLint` (`verbs/pure/static-analysis.ts:216`) |
| Import cycles | **Zero** — `scripts/audit/cycle-baseline.json` has an empty `entries[]` and fails closed |
| Dead-code ratchet | `scripts/audit/knip-allowlist.json` — **103 entries** |
| Dead declarations | `package.json → workspaces: ["packages/*"]` (no `packages/` exists); `files[] → CLAUDE.md.template` (does not exist) |
| Governance surfaces that fail open | `.github/CODEOWNERS` (**extensionless**) owns `servers/exarchos-mcp/`, `scripts/`, `skills/`, `commands/` — all moved. `scripts/audit/protected-suites.json` pins ~50 explicit test paths. `.exarchos/invariants.md` `references:` name **source and test** paths, asserted by `dev-catalog-ref-paths.test.ts` |
| Fixed-root consumers | `src/install-skills.ts:275,280,290,430,433,439` probes root-relative `skills/` and `command-aliases/`; `src/projection-containment.ts` inventories those roots plus agents and hooks |
| Plugin hook discovery | `.claude-plugin/packaging-policy.json:53` — `hooks/hooks.json` sits at the **well-known plugin path** and is auto-loaded; declaring it in `plugin.json` double-registers |
| Naming | 820 of 847 non-test sources already kebab-case; **zero** PascalCase, zero camelCase. The 27 outliers are conformant multi-segment fixture names |
| Docs are not all prose | `docs/evals/**` (114 files, 9 of them tests) holds executable Vitest graders collected by `vitest.config.ts`; `docs/assets/` (21) is binary |
| Runtime coupling to `docs/` | `rehydrate.ts` (`UNIFIED_SPEC_DIR='docs/specs/'`, `LEGACY_DESIGN_DIR='docs/designs/'`), `playbooks.ts`, `registry.ts`, `vocabulary-lint.ts`, `guard-inventory.ts`, `.exarchos.yml`, `ci.yml` (22 refs), `vitest.config.ts`, and `test/migration/__snapshots__/snapshots.test.ts.snap` (103 refs) |
| Worktrees and branches | **66** registered worktrees (**64** are `agent-*` under `.claude/worktrees/`); **408** local branches. `git worktree prune --dry-run` reports **nothing** — every registered directory still exists on disk. **No `taxonomy-v2` worktree exists**, contradicting the two named in revision 2's task 008 |
| Untracked top-level directories present on developer machines | `azd-templates/` (untracked, 0 files in `git ls-files`) and `event-taxonomy-and-dkg/`. Neither appears in DR-1's allow-list nor its deletion list, so the allow-list test as first drafted fails on a working machine while passing on a pristine clone |

### Corrected findings (revision 1 asserted these incorrectly)

| Revision 1 claimed | Verified reality |
|---|---|
| `skills-src/` and `binding/` ship in `package.json files[]` | Neither appears in `files[]`. The shipped set is `agents, commands, skills, command-aliases, rules, scripts, hooks` (+ `dist/`, `settings.json`, `.claude-plugin`, `AGENTS.md`) |
| `command-aliases/` is generated from `skills-src/` | Generated from `commands/*.md` + `COMMAND_TO_SKILL` (`src/build-command-aliases.ts:40`) |
| `agents/*.md` are authored agent specs to move into `content/` | They are **output** of `generate-agents.ts`, fanned from TypeScript `ALL_AGENT_SPECS` (`src/agents/definitions.ts:612`) |
| `skills/` and `hooks/` are generated trees | Both carry live non-generated files (21 and 2) — fixtures, validators, a shipped git hook, and a test the root vitest project collects |
| `.dependency-cruiser.cjs` is only a dogfooding demo | Its second rule is `severity: 'error'` over paths this refactor destroys; leaving it untouched makes it match zero and pass forever |
| `layer-boundaries-seam.ts` can express the layer chain after a "retarget" | Its edge model is first-segment-only and drops intra-layer edges; sub-directory rules require extending the model |
| The core is a nested workspace with one sibling manifest | There are **four** manifest/lockfile pairs; `evals-pkg` appears in no revision-1 task |
| "Phase 1 contains zero semantic edits" | At least 10 Phase 1 tasks are semantic (011, 024–027, 035, 037, 040–045) |
| "Nine layers", asserted by an equality test | The target tree lists **ten** layer directories plus `install/`; the test as written could never pass |
| Tasks 043 and 044 are parallel-safe | 044 declares a dependency on 043 |

Line counts and file counts in revision 1 not listed above were re-verified and are **correct**.

## Design & Rationale

### Problem Statement

Successive large refactors landed correct architecture and left the tree describing an earlier system. Four costs follow, each measured rather than asserted.

**The published architecture is invisible in the tree.** `docs/system-design.html` names nine layers — storage, event store, projections, workflow primitives, dispatch core, composite tools, lifecycle verbs, adapters, cooperative agents — and calls L2 and L5 "the load-bearing spine". None of that is expressed by a directory, and exactly one `dependency-cruiser` rule guards it. The DAG is genuinely clean (zero runtime cycles, fail-closed gate), so the architecture is real; it is simply not written down anywhere a contributor or a tool can act on it.

**Half the repository hides behind a name that contradicts the design.** `servers/exarchos-mcp/` holds 1,673 of 3,317 tracked files. The system design states the opposite of what the path says: MCP is *the invocation surface*, the compiled contract itself, and the CLI is a presentation client over it. Calling the whole product a "server" — and nesting it under a plural `servers/` that has exactly one member — files the spine as an implementation detail. Inside it, `orchestrate/` carries **83 non-test files flat**, one per verb (`check-*`, `assess-*`, `extract-*`, `gate-*`), with no grouping at all.

**Ten top-level directories express five instances of one pattern.** `skills-src`→`skills`, `hooks-src`→`hooks`, `binding-src`→`binding`, agent source→`agents`, `runtimes`→`embedded.ts`. The relationship is encoded in a `-src` filename suffix and enforced by three separate guards. A contributor cannot tell which trees are authored and which are rendered without reading `package.json`.

**Nothing states where a test goes.** 1,141 test files — 34% of the repository — spread across five roots, two of which (`test/`, `tests/`) differ by one character. `CLAUDE.md` mandates co-location; three of the five roots contradict it.

Layered on top: a `workspaces` glob pointing at a directory that does not exist, a shipped `files[]` entry that does not exist, 103 allowlisted dead-code findings, **66 registered worktrees and 408 local branches**, an "exceptionally stale" VitePress site, and 669 markdown files under `docs/`.

### Chosen Approach

**Express the published architecture in the tree, and make the tree enforce it.** Six top-level directories, each answering one question, with the nine layers becoming real directories under a single product root.

**Six directories.** `src/` (what is the product?), `content/` (what do we author?), `rendered/` (what do we generate from it?), `tests/` (how do we know it works?), `tools/` (what does the repo run on?), `docs/` (why is it like this?). Seven dot-directories remain as explicitly classified peers, and the gitignored-but-present set (`dist/`, `node_modules/`, `coverage/`, `.worktrees/`, `.serena/`) is named in the allow-list rather than pretended away.

**Name the spine for what the design says it is.** The core leaves `servers/exarchos-mcp/` and becomes `src/`, grouped by layer: `storage/ → events/ → projections/ → workflow/ → contract/ → dispatch/ → verbs/ → lifecycle/ → adapters/{mcp,cli}/ → runtime/`, plus `install/` as a stated non-layer peer. That is **ten layer directories plus one peer** — the published architecture names nine *layers*, and L5 is split across `contract/` and `dispatch/` because they are separable in this tree. The mapping between the eleven directories and the nine published layers is declared explicitly rather than assumed to be one-to-one. `orchestrate/`'s 83 flat verb files regroup by capability under `verbs/`.

**Author by capability; generate flat; and stop pretending the split is clean.** The authored/generated boundary is **per artifact kind, not per tree** — measurement shows `commands/`, `rules/` and `binding/` have no renderer at all, `agents/*.md` are generated from TypeScript, and `skills/` and `hooks/` each carry live non-generated files. `content/<domain>/` therefore holds only what a human edits; `rendered/` holds only what a generator emits; and the fixtures, validators and shipped hook sample that currently sit *inside* the generated trees are relocated to where they belong (`tests/`, `tools/`) instead of being swept into a tree declared never-hand-edited. Because three artifact kinds have no generator, the design either gives them one or leaves them authored-and-shipped — that decision is made explicitly in DR-4, not implied by a directory name.

**Extract the conformance suite as its own package.** `src/architecture/` is 78 files and 13,785 LOC of first-party structural enforcement — three censuses in one 1,152-LOC module alone. It becomes `tools/conformance/`, a real package with its own entry point, consumed by `tests/` and by the product's own static-analysis gate. This is the author's directive and it is well-founded: a conformance suite that lives *inside* the tree it governs cannot be reasoned about independently, and its 41 test files are indistinguishable from product tests. The honest cost is measured and stated: it currently has **~26 outbound imports** into the very core it inspects, so extraction requires inverting or parameterizing those edges — it is a dependency-inversion exercise, not a move.

**Fix the coupling the author named.** The artifact directory becomes configuration with `docs/specs/` as its default, so the future symlink-based docs exodus is a config change rather than a code change.

**Land in three phases:** an oracle-and-shrink phase, a structural phase, and a semantic-enforcement phase. Revision 1 claimed a two-phase split in which "Phase 1 contains zero semantic edits"; that claim was false — ten Phase 1 tasks changed behavior. The phases are redrawn so the claim is true of the phase that actually depends on it.

### Technical Design

**Target tree.**

```text
src/                        the product — one package, layered per docs/system-design.html
  storage/                    L1  SQLite/WAL substrate            <- storage/
  events/                     L2  append, idempotency, ordering   <- event-store/
  projections/                L3  pure folds, snapshots, reconcile
  workflow/                   L4  HSM, topology, phases, capabilities, pruner
  contract/                   L5a compiler, IR, bindings, reachability, oracle
  dispatch/                   L5b dispatch(verb, args, ctx), telemetry middleware
  verbs/                      L6  composite tools, grouped by capability
    gates/ review/ tasks/ team/ vcs/ doctor/ init/ invariants/     <- orchestrate/ (83 flat files)
    views/                                                          <- views/
  lifecycle/                  L7  ps, describe, wait, export       <- cli-commands/
  adapters/                   L8  mcp/ (the wire contract) + cli/ (presentation client)
  runtime/                    L9  harness on-ramps, agent posture, capability handshake
  install/                    NON-LAYER peer: shipped installer + runtime-selector CLI
                              (ten layer dirs + one declared peer; the 11 -> 9 published-layer
                               mapping is declared in docs/ARCHITECTURE.md, NOT assumed 1:1)
content/                    ONLY hand-authored agent-facing content — grouped by capability
  design/ delivery/ review/ synthesis/ continuity/ remediation/ governance/
    each holds its own {skills,commands,agents,rules}/ for that capability
  _shared/                    cross-domain references, SKILL_AUTHORING.md
  harness/                    runtimes/*.yaml, hooks-src/hooks.json, binding-src/binding.md
rendered/                   generated ONLY, guard-verified, never hand-edited — FLAT
  skills/<runtime>/<name>/  command-aliases/<runtime>/  agents/  hooks/<runtime>/  binding/
  commands/                   ONLY if DR-4 gives commands a generator; otherwise commands stay
                              authored under content/ and ship from there (they have none today)
tests/                      ALL tests, benchmarks, evals, fixtures — one tree
  unit/ integration/ process/ outcome/ e2e/ smoke/ migration/
  benchmarks/ evals/ support/
    support/skill-fixtures/   <- skills/test-fixtures/   (13 LIVE fixtures, not output)
    support/trigger-tests/    <- skills/trigger-tests/   (5 files, not output)
tools/                      repo automation + first-party enforcement
  conformance/                <- src/architecture/ (78 files, 13,785 LOC) as its OWN package
  audit/ eslint-rules/ renovate-config/ migrations/ release/
  skill-validators/           <- skills/validate-*.sh (3 files, not output)
  git-hooks/                  <- hooks/pre-push.ship-gate.sample + pre-push.test.ts
docs/                       VitePress skeleton + ARCHITECTURE.md + system-design.html + specs/
.github/ .claude/ .claude-plugin/ .codex/ .cursor/ .opencode/ .exarchos/   classified peers
hooks/hooks.json            STAYS AT THE PLUGIN ROOT — packaging-policy.json:53 requires it
```

**Why `hooks/hooks.json` does not move.** `.claude-plugin/packaging-policy.json:53` records that the file sits at a **well-known plugin path** which Claude Code auto-loads, and that declaring it in `plugin.json` instead makes every hook fire twice. The six-directory goal yields to that external contract: the plugin-root `hooks/hooks.json` is an explicitly classified exception, generated into place from `content/harness/`, while the per-runtime `HOOKS.md` variants render to `rendered/hooks/<runtime>/`. Revision 1 deleted root `hooks/` with no replacement discovery mechanism; that would have silently unhooked the plugin.

**The authored/generated boundary is per artifact kind, not per tree.** Measured: `commands/` (18), `rules/` (1) and `binding/` (1) have **no generator at all** and are shipped directly; `agents/*.md` are **generated** from TypeScript `ALL_AGENT_SPECS`; `command-aliases/` is generated from `commands/*.md`, not from skills. A design that maps whole directories to `content/` or `rendered/` therefore misfiles three artifact kinds in one direction and one in the other. DR-4 resolves each kind explicitly.

**Why `rendered/` stays committed.** `.claude-plugin/plugin.json` declares `"skills": "./skills/"` and `"commands": "./commands/"` **relative to the plugin root**, and the marketplace installs a plugin by cloning a git ref — there is no build step in a consumer's clone. Un-tracking the rendered tree breaks plugin distribution outright. The fix for the *confusion* is consolidation plus one guard, not deletion.

**Harness dot-directories cannot be consolidated.** `.codex/agents/`, `.cursor/agents/`, `.opencode/agents/` are harness-mandated filesystem conventions, not declared paths. They remain generated in place and are classified, not moved. `.github/agents/` is likewise a contract surface.

**The conformance package.** `tools/conformance/` gets its own `package.json`, entry point and test suite, consumed by `tests/` and by the product's own static-analysis gate. A conformance suite that lives *inside* the tree it governs cannot be reasoned about independently, and its 41 test files are today indistinguishable from product tests. The honest cost is measured: it has **~26 outbound imports** into the core it inspects (`event-store` 6, `config` 5, `registry.js` 4, `review` 3, `contract` 2, `orchestrate` 2, `schemas`, `sdk`), so extraction is a **dependency-inversion exercise, not a move** — census modules must take their inputs as parameters (source root, lexer port, rule table) instead of importing the subject. Where an edge cannot be inverted cheaply the module stays in `src/` as a stated exception: a partial extraction that is honest beats a circular package that type-checks by accident.

**The layer census gets a path-aware edge model.** Measured: `layerOf()` returns the first path segment, `detectLayerEdges` discards `targetLayer === sourceLayer`, and `isRootFile()` returns `[]` — so `adapters/mcp → adapters/cli` is inexpressible and `registry.ts` (4,636 LOC) contributes no edges. Under a longest-prefix match over **declared layer ids**, `adapters/mcp` and `adapters/cli` become distinct ids, and the intra-layer skip stops swallowing the edge and starts being correct. The change is ~50 LOC across two files with **zero external consumers** (the symbols appear only in the seam and its own test), and `STALE_LAYER_ALLOWANCE` — the phantom-cover tooth no external tool provides — is generic over layer ids and survives untouched.

**The MCP/CLI direction becomes a rule.** `adapters/cli/` may import `adapters/mcp/` and `contract/`; `adapters/mcp/` and `contract/` may not import `adapters/cli/`. This encodes INV-2 structurally — today it is prose plus a parity harness — and it is expressible only *after* the edge-model change above.

**Configurable artifact root (DR-6).** `.exarchos.yml` gains an `artifacts.specDir` key defaulting to `docs/specs/`. `rehydrate.ts` classification, `playbooks.ts` guidance and the `planArtifactExists` guard read the resolved value. Because the author plans to point this at a **symlink** to an external repository, resolution must POSIX-normalize (INV-16) and must never treat filesystem presence as an existence signal — existence remains `_meta.workflowExists` from the projection, per the state-source-integrity RCA.

**Enforcement authorities — one per rule class, and no guard left dangling.** The repository's own principle (`f0bac4a8`, "one authority per contract, bound mechanically") forbids a second mechanism for a rule that already has one. Revision 1 misapplied it: it read "don't add a second authority" as "don't touch `.dependency-cruiser.cjs`", which would have left a live `severity: 'error'` rule pointed at destroyed paths, matching zero and passing forever. **Retargeting an existing rule's paths is guard hygiene, not a second authority.**

| Rule class | Authority | Rationale |
|---|---|---|
| Layered one-way imports | **`tools/conformance/` layer census, with a path-aware edge model** | ~50 LOC across two files with zero external consumers; keeps `STALE_LAYER_ALLOWANCE`, which no external tool provides. See the option evaluation in Exploration. |
| The existing depcruise rule | **Retargeted, not abandoned** | `no-domain-core-to-io-adapters` is `severity: 'error'` over `(event-store\|workflow)/ → adapters/`, executed by `runBoundaryLint` (`static-analysis.ts:216`). Tasks 012/013/018/019 destroy those paths, so it is retargeted in the same change. |
| Runtime import cycles | **`cycle-gate.ts` + `import-cycles.ts`**, subject to the delta test | `depcruise` ships `depcruise-baseline` + `--ignore-known` (both verified present), but **no reporter reports "this rule matched nothing"** — there is no phantom-entry tooth. `import-cycles.ts` also carries an independent forbidden-runtime-edge registry, so it is not a candidate for wholesale deletion. |
| Top-level directory allow-list | **Bespoke filesystem test** (DR-1) | `allowed`/`not-in-allowed` is emitted **per dependency edge**, so a rogue directory containing no modules is invisible to it. A filesystem allow-list cannot be delegated to a graph tool. |
| Per-directory file-count / locality | **Bespoke filesystem test** (DR-9) | Quantitative aggregation; no surveyed tool expresses it. |
| Dead code / entry-point liveness | **`knip`** (DR-8) | Already in place with a ratchet. |
| Governance & packaging surfaces | **`tools/conformance/` liveness census** (DR-12) | `CODEOWNERS`, `files[]`, `manifest.json`, `protected-suites.json` and the invariants `references:` keys all fail **open** today. |
| Naming conventions | **No new authority** | Measured: 820/847 already kebab-case, zero PascalCase, zero camelCase. No defect to remediate. |

**Tooling evaluated and not adopted.** `vercel-labs/konsistent` is real, active (last push 2026-08-11) and Vercel-Labs-hosted, but it is a **per-file shape/export-shape asserter, not an import-graph analyzer**: no layering, no cycles, no per-directory aggregation, and its `paths`-must-satisfy model cannot express "anything not on this list is forbidden". It is pre-1.0 (`1.0.0-beta.6`) with foundational glob bugs fixed this month and no baseline mechanism. It solves none of the rule classes above and is **not adopted**; its genuine sweet spot (asserting a module family exports one public shape) is a **deferred trigger** for `verbs/*` drift after task 015. `@softarc/sheriff` and `eslint-plugin-boundaries` were rejected for the one-authority reason, with the honest caveat that either would add editor-time diagnostics a CI-time census cannot give. `ls-lint` was rejected as remediation for a defect that does not exist.

**Package-graph consequences.** The tree holds **four** manifest/lockfile pairs, not two: the root; `servers/exarchos-mcp/`; `servers/exarchos-mcp/evals-pkg/` (the opt-in promptfoo package, named in `ci.yml`'s `prompts:` paths-filter); and `documentation/` (VitePress). Collapsing the core removes one; `evals-pkg` is classified and retained or retired deliberately; `documentation/` reduces with its site; and `tools/conformance/` **adds one back by design**. The end state is "one product package plus explicitly-declared tool packages", not "one lockfile" — revision 1's `ExactlyOneLockfileExists` assertion was false by construction.

The nested `vitest.config.ts` is not a duplicate to delete: it sets `testTimeout`/`hookTimeout` 60000, `pool: 'forks'`, `src/**/*.type-test.ts` and `src/bench/**/*.bench.ts` includes, an `EXARCHOS_SMOKE_ONLY` conditional exclude, a `benchmark.outputJson` block, and a v8 `coverage` block with `reportOnFailure` + `json-summary` that **feeds the coverage ratchet**. The root `unit` tier is `tierTimeout(5000)`, and the root config's own comment states the nested 60s was already chosen for Windows and must not be scaled again. Collapsing the configs is a deliberate **timeout-and-coverage policy decision**, not a merge — which is why the build-graph work is a semantic task, not a structural one.

**Three-phase landing.** Revision 1 claimed "Phase 1 contains zero semantic edits"; that was false — ten of its Phase 1 tasks changed behavior, so the rename-detection argument its reviewability rested on did not hold. The phases are redrawn so the claim is true where it is load-bearing: **Phase 0** (oracles, the configurable artifact root, the shrink), **Phase 1** (pure movement — no semantic edits, rename-detected diffs, `tsc` plus the full suite as the oracle), **Phase 2** (enforcement, complexity and documentation — every semantic change lives here). Each phase lands as one merge commit, so recovery is a single revert.

### Integration Points

- `package.json` — `workspaces` (deleted), `files[]` (**all seven shipped directories move**: `agents, commands, skills, command-aliases, rules, scripts, hooks`), and 30+ scripts carrying literal paths (`lint`, `lint:inv6 skills-src/`, `lint:test-first-drift commands agents skills-src`, `build:*`, `test:*`, `docs:*`).
- `.claude-plugin/plugin.json` and `packaging-policy.json`, `manifest.json` (`components.core` installs `commands`, `skills`, **`scripts`**; `bundlePath`/`devEntryPoint`; ruleSets referencing `rules/rm-safety.md`); `generate-agents.ts` mutates `manifest.agents`.
- `.github/CODEOWNERS` — **extensionless**, owns `servers/exarchos-mcp/`, `scripts/`, `skills/`, `commands/`; a scan filtered by file extension cannot see it.
- `tsconfig.json`, `tsconfig.scripts.json`, root **and nested** `vitest.config.ts` (timeout tiers, `pool: 'forks'`, type-test/bench includes, `EXARCHOS_SMOKE_ONLY` exclude, `benchmark.outputJson`, the v8 coverage block feeding `check-coverage-ratchet.mjs` + `coverage-baseline.json`), `eslint.config.js`, `eslint.envelopes.config.js`, `knip.json` (two workspace blocks), `.dependency-cruiser.cjs`, `bunfig.toml`, `stryker.conf.mjs`.
- `servers/exarchos-mcp/evals-pkg/{package.json,package-lock.json,tsconfig.json}` — named in `ci.yml`'s `prompts:` paths-filter; classified, retained or retired deliberately.
- `scripts/audit/{knip-allowlist,cycle-baseline,protected-suites}.json` and `cycle-gate.ts` — `protected-suites.json` pins ~50 explicit test paths and `generatedFrom: servers/exarchos-mcp/src`.
- `.exarchos/invariants.md` `references:` keys — they name **source and test** paths (e.g. `event-store/atomic-appender.ts`, `storage/sqlite-backend.ts`, `test/process/multi-process-append.test.ts`), asserted by `dev-catalog-ref-paths.test.ts`.
- `src/install-skills.ts` (fixed root probes at `:275,280,290,430,433,439`), `src/projection-containment.ts` (inventories `skills`, `command-aliases`, agents, hooks), `src/build-command-aliases.ts` (reads `commands/<name>.md`), `src/build-skills.ts`, `src/skills-guard.ts`, `scripts/build-binary.ts`, `scripts/codegen-runtimes.ts`.
- `servers/exarchos-mcp/src/workflow/{rehydrate,playbooks,guards}.ts`, `registry.ts`, `architecture/vocabulary-lint.ts`, `scripts/guard-inventory.ts` — the `docs/` literals; plus `test/migration/__snapshots__/snapshots.test.ts.snap` (103 `docs/` refs).
- `.github/workflows/ci.yml` (22 `docs/` references + every path glob), `docs.yml`, `eval-gate.yml`, `benchmark-gate.yml`, `fresh-install-smoke.yml`, `release.yml`.
- `CLAUDE.md`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `ONBOARDING.md`, `.gitattributes`, `.npmignore`.
- `.exarchos.yml` — new `artifacts.specDir`; existing `mutation:` adapter path (`servers/exarchos-mcp/scripts/stryker-adapter.mjs`).
- **Deleted:** `servers/`, `skills-src/`, `hooks-src/`, `binding-src/`, `command-aliases/`, `test/`, `tests/`, `benchmarks/`, `evals/`, `eslint-rules/`, `renovate-config/`, `migrations/`, `documentation/` (reduced to a skeleton under `docs/`), the `packages/*` workspace glob, the `CLAUDE.md.template` entry, and the two stale worktrees. **Not deleted:** plugin-root `hooks/hooks.json`, and the 23 non-generated files currently inside `skills/` and `hooks/`.

### Exploration

**A — Layer-expressed single package with an extracted conformance package (chosen).** One `src/` whose subdirectories are the published layers, `content/`/`rendered/` splitting authored from generated **per artifact kind**, and `tools/conformance/` as its own package. Chosen because the constraint that matters is legibility plus enforcement, and this delivers both without paying for module resolution: the DAG is already clean, so what is missing is a written rule.

**B — Real npm workspaces per layer.** Rejected: nine-to-eleven publishable units for a product that ships as **one binary and one plugin**, each with an entry-point contract to keep honest — the sibling repo's DR-9 shows that contract is the highest-severity failure mode in exactly this refactor. The measured graph has zero cycles, so B pays maximal packaging cost to enforce a property nothing is violating.

**C — Rename and enforce in place.** Rejected as the primary plan: leaves `servers/exarchos-mcp/` holding half the repository behind a misleading name, 83 flat verb files, and five test roots. Retained as the documented fallback if Phase 1 proves unreviewable — C is a strict subset of A.

#### The layering-authority decision (the crux the panel exposed)

Revision 1 chose the in-house census as sole authority without checking whether it *could* express the rules. It cannot, today. The two live options were evaluated against measurement:

| | **A1 — extend the in-house census** (chosen) | **A2 — migrate layering to dependency-cruiser** |
|---|---|---|
| Code touched | `layerOf` → longest-prefix over declared ids (~10–15 LOC); thread the id set through 4 functions (~15–20); root-file policy (~10). **~50 LOC, 2 files** | Rule authoring in `.dependency-cruiser.cjs`; delete ~345 LOC of census |
| External consumers to migrate | **Zero** — the symbols appear only in the seam (22 refs) and its own test (27) | n/a |
| Sub-directory rules (`adapters/mcp ↛ adapters/cli`) | Works once ids are declared: the two become distinct ids, so the intra-layer skip becomes *correct* rather than lossy | Native — regex paths, no model change |
| Module resolution fidelity | Hand-rolled `resolveTarget`; does not resolve directory-index imports. **Measured exposure: 1 extensionless relative import in the whole core** (the codebase is uniformly NodeNext `.js`) | Real resolution via enhanced-resolve |
| Phantom-cover tooth (`STALE_LAYER_ALLOWANCE`) | **Kept free** — generic over layer ids | **Lost.** Every reporter was checked (`err, err-html, dot, ddot, archi, flat, d2, mermaid, text, json`); none reports "this rule matched nothing" |
| Net bespoke code | Unchanged | Rebuilds phantom detection over `--output-type json` — i.e. re-creates `cycle-gate.ts`'s pattern for a second rule class |
| Effect on the file | Layering is ~345 of 1,152 LOC; `DECLARATION_SEAM` and `SDK_SEAM_BOUNDARY` stay in-house either way | Leaves one census outsourced and two in-house — **less** coherent than today |

**A1 wins on the asymmetry:** ~50 LOC with no external consumers and both teeth kept, versus rewriting the rule model, losing the tooth, rebuilding it anyway, and retiring only 30% of the file. The correction revision 1 got wrong is orthogonal and is applied regardless: the **existing** depcruise rule is retargeted so it does not silently evaporate.

**The honest costs of A.** Centralizing tests moves 928 files under `servers/` alone, trading unit-test locality for one stated convention — the author chose this explicitly. Extracting `tools/conformance/` requires inverting ~26 outbound edges and may end partial. And the whole landing's reviewability rests on Phase 1 genuinely containing no semantic edits, which revision 1 claimed and did not deliver.

**The discover bridge was not taken** — the design questions were resolved by direct measurement of this tree.

### Alternatives considered

- **Option B — workspace-per-layer.** Rejected: nine manifests and an entry-point contract to protect a property no measurement shows being violated, for a product that ships as one binary.
- **Option C — enforce in place.** Rejected as the primary plan: leaves every locality defect standing. Retained as the documented fallback if Phase 1 proves unreviewable.
- **Un-tracking `rendered/`.** Rejected on evidence: the marketplace installs by cloning a git ref, so a consumer's clone has no build step.
- **`vercel-labs/konsistent` for structural enforcement.** Rejected for this rule set after evaluation: it is a per-file shape/export-shape asserter, not an import-graph analyzer — no layering, no cycles, no per-directory aggregation, and no "anything not on this list is forbidden" model. Also pre-1.0 (`1.0.0-beta.6`) with no baseline mechanism. Recorded as a **deferred trigger** for public-API/barrel drift, which is the problem it genuinely solves.
- **`@softarc/sheriff` / `eslint-plugin-boundaries` for layering.** Rejected: both are competent, and both would be a *second* authority over a property `layer-boundaries-seam.ts` already governs with a stronger ratchet. Honest caveat: either would add editor-time layer diagnostics that a CI-time census cannot provide, which is a real ergonomic loss accepted here.
- **`ls-lint` for naming.** Rejected as remediation: measurement shows no naming defect (820/847 kebab-case, zero PascalCase, zero camelCase). Reconsider only as drift insurance if the moves prove to introduce inconsistency.
- **Moving `docs/specs/` out of the repository now.** Rejected in favor of DR-6: the author's plan is symlink-based and future-dated, and a configurable root makes it a config change instead of a second refactor.

### Requirements (DR-N)

#### DR-1: The top level is six directories and every entry is classified

**Acceptance criteria:**
- The non-dot, non-ignored top level is exactly `src/`, `content/`, `rendered/`, `tests/`, `tools/`, `docs/`, plus the **explicitly classified plugin-root exception `hooks/hooks.json`** (see below). `servers/`, `skills-src/`, `hooks-src/`, `binding-src/`, `command-aliases/`, `test/`, `tests/` (old), `benchmarks/`, `evals/`, `eslint-rules/`, `renovate-config/`, `migrations/`, `agents/`, `commands/`, `skills/`, `binding/`, `runtimes/`, `documentation/` no longer exist at the top level.
- The allow-list test **enumerates the gitignored-but-present set explicitly** — `dist/`, `node_modules/`, `coverage/`, `.worktrees/`, `.serena/`, `.azurite/` — rather than failing on any built or developed tree. Given a developer runs `npm run build`, When the allow-list test runs, Then it passes. A test that only passes on a pristine clone is not an enforcement mechanism.
- **The enumerated set is derived from a real working tree, not from this list.** Measurement found two untracked top-level directories present today and named in neither the allow-list nor the deletion list: `azd-templates/` and `event-taxonomy-and-dkg/`. The test therefore keys on **tracked** entries for the forbidden-directory assertion and consults `.gitignore` plus an explicit untracked-scratch allowance for everything else, so an untracked scratch directory on one developer's machine is never a build failure for everyone. Each of the two is classified before this task closes: ignored-scratch, or tracked-and-placed.
- Given an unlisted entry appears at the top level, When the test runs, Then it fails **naming that entry**.
- `hooks/hooks.json` remains at the plugin root because `.claude-plugin/packaging-policy.json:53` requires it (auto-loaded from a well-known path; declaring it in `plugin.json` double-registers every hook). It is generated into place, classified in the allow-list, and covered by the hook-loading test in DR-4.
- Each of the six carries a `README.md` stating what belongs in it and what does not.
- The dot-directories are classified in `docs/ARCHITECTURE.md`, including **why harness dot-directories cannot be consolidated** (filesystem convention, not declared path).

#### DR-2: The product tree expresses the published layer architecture

**Acceptance criteria:**
- `servers/exarchos-mcp/src/` becomes `src/`, with `storage/`, `events/`, `projections/`, `workflow/`, `contract/`, `dispatch/`, `verbs/`, `lifecycle/`, `adapters/`, `runtime/` — **ten layer directories** — plus `install/` as a declared **non-layer peer**.
- The **11 directories → 9 published layers** mapping is declared explicitly in `docs/ARCHITECTURE.md` (L5 splits across `contract/` and `dispatch/`; `install/` is a peer, not a layer). The agreement test asserts **that declared mapping**, not directory-set equality with the nine layer names — revision 1's equality assertion could never have passed.
- `adapters/` splits into `adapters/mcp/` and `adapters/cli/`, and `docs/ARCHITECTURE.md` states the INV-2 direction: the contract is the invocation surface, the CLI is a client of it.
- `orchestrate/`'s 83 non-test flat files are grouped under `verbs/` by capability; **no directory in `src/` holds more than 25 non-test files at its own level**.
- The nested product workspace is dissolved. The end state is **one product package plus explicitly-declared tool packages** (`tools/conformance/`, and `evals-pkg` if retained) — not "exactly one lockfile", which is false by construction given four manifest pairs exist today.
- The `workspaces: ["packages/*"]` glob is deleted, not repointed.
- Every registered composite tool and action name is unchanged across the move, asserted against a snapshot: a dropped registration compiles cleanly.

#### DR-3: One enforcement authority per rule class, every rule proven to bite, and no guard left dangling

Revision 1 chose a sole authority that **cannot express the rules it was given**, and simultaneously forbade touching a live `severity: 'error'` rule whose paths this refactor destroys. Both errors are corrected here.

**Acceptance criteria:**
- **The layer census gains a path-aware edge model.** `layerOf()` resolves a module to the **longest matching declared layer id** rather than its first path segment; the declared-id set is threaded through `detectLayerEdges`, `scanLayerEdges` and `runLayerBoundaryCensus`; and the root-file exclusion is replaced by a stated policy so `registry.ts` is no longer invisible to layering.
- Given a module in `adapters/mcp/` imports `adapters/cli/`, When the census runs, Then it reports `FORBIDDEN_IMPORT` naming both module ends. This case is **structurally impossible** under the current first-segment model and is the acceptance test for the change.
- Both ratchet teeth survive: `FORBIDDEN_IMPORT` names both ends, and `STALE_LAYER_ALLOWANCE` still fails an allowance no live edge exercises. A phantom allowance must fail.
- The census's other two authorities — `DECLARATION_SEAM` and `SDK_SEAM_BOUNDARY` — are **preserved with their module paths migrated**, and each retains a vacuity check. Revision 1 scoped only the layer allowance table and would have silently dropped both.
- **The existing `.dependency-cruiser.cjs` rule is retargeted in the same change that destroys its paths.** `no-domain-core-to-io-adapters` is `severity: 'error'` over `^servers/exarchos-mcp/src/(event-store|workflow)/` → `adapters/` and is executed by `runBoundaryLint`. A test asserts it matches a **non-empty** module set after the move.
- Each declared rule is proven to fail against a **seeded violation naming that rule**, and to pass on the real tree.
- The cycle-gate overlap is resolved explicitly: either `cycle-gate.ts` demonstrates the no-mask property `depcruise --ignore-known` lacks — proven by a phantom baseline entry failing the gate — or the layering-cycle leg is replaced. **`import-cycles.ts` is not deleted wholesale**: it also implements an independent forbidden-runtime-edge registry with its own stale-rule ratchet, which is out of scope for replacement.
- The full-chain promotion is **incremental and ratcheted, not a big-bang**: the census governs 12 peripheral leaves today and the tangled core is deliberately ungoverned, so promoting layers admits them one at a time with `STALE_LAYER_ALLOWANCE` clean at each step.
- No enforcement tool is adopted for a defect this repository does not have (naming: 820/847 kebab-case, zero PascalCase).

#### DR-4: Authored and generated are separated per artifact kind, and nothing live is swept into a generated tree

Revision 1's premise was false in four distinct ways. This requirement resolves each artifact kind explicitly rather than mapping whole directories.

**Acceptance criteria:**
- **Each artifact kind is classified explicitly**, per measurement: `skills` (authored → rendered per runtime); `command-aliases` (generated from `commands/*.md` + `COMMAND_TO_SKILL`, **not** from skills); `agents` (**generated** from `ALL_AGENT_SPECS` in `src/agents/definitions.ts:612` — no markdown source exists to move); `hooks` (`hooks.json` authored → plugin root; `HOOKS.md` variants → rendered); `commands`, `rules`, `binding` (**authored, no generator today**).
- For `commands`, `rules` and `binding` the design makes a stated choice: either a generator is introduced, or they remain authored under `content/` and ship from there. **`rendered/commands/` must not be declared unless something emits it** — revision 1 repinned `plugin.json` at a path no renderer produces.
- `content/` contains only hand-authored content; `rendered/` contains only generator output. A test asserts every file under `rendered/` is reproducible by a re-render and that **no** file under `rendered/` is hand-edited.
- **The 23 live non-generated files inside the current generated trees are relocated, not swept**: `skills/test-fixtures/` (13) and `skills/trigger-tests/` (5) → `tests/support/`; `skills/validate-*.sh` (3) → `tools/`; `hooks/pre-push.ship-gate.sample` + `pre-push.test.ts` → `tools/git-hooks/`, with the root `vitest.config.ts` `hooks/**/*.test.ts` include retargeted in the same change. Given the re-render guard runs, Then none of these files is reported as drift.
- `content/` is grouped by **capability** (`design`, `delivery`, `review`, `synthesis`, `continuity`, `remediation`, `governance`, `_shared`, `harness`), each holding its own `{skills,commands,agents,rules}/`. The domain set is asserted against a declared list.
- **The renderer flattens.** `build-skills.ts` emits to `join(outDir, runtime, skillRel)` today; it is changed to route by artifact kind and emit a flat name, so `content/review/skills/mutation-adequacy/` renders to `rendered/skills/<runtime>/mutation-adequacy/SKILL.md`. Given two domains declare the same flattened name, Then the build fails naming both source paths.
- **Every fixed-root consumer is retargeted in the same change**: `src/install-skills.ts` (`:275,280,290,430,433,439`), `src/projection-containment.ts`, `src/build-command-aliases.ts`, `src/skills-guard.ts`.
- `skills:guard`, `hooks:guard` and `runtimes:guard` consolidate into one guard covering `rendered/` **and** the harness dot-directories **and** the plugin-root `hooks.json`.
- A fresh-clone install smoke test proves: every path declared in `plugin.json` and `manifest.json` resolves; a rendered skill is discovered at the flat location a harness expects; **and the plugin's hooks load exactly once** (the double-registration failure `packaging-policy.json` warns about).

#### DR-5: All tests live in one tree, and no test is lost

**Acceptance criteria:**
- The pre-refactor test inventory is captured as the first action of the workflow, against a **verified-green** tree, recording per-runner, per-file test IDs rather than aggregate counts.
- **Test identity is path-independent.** The oracle records a stable id — `(suite path within the file, test name, runner)` — plus an explicit **old→new relocation map** maintained by each move task. Revision 1 recorded per-file IDs whose paths every move invalidates, so strict comparison would report all 1,141 as missing and loose comparison would conflate duplicate test names across files. Reconciliation is `oracle − relocations`; an unexplained delta names the missing source and blocks.
- All 1,141 test files live under `tests/`, organized `unit/ integration/ process/ outcome/ e2e/ smoke/ migration/ benchmarks/ evals/ support/`. No `*.test.*` file remains under `src/`, `content/` or `tools/` **except** the conformance package's own suite, which travels with it (DR-12).
- Counts are stated unambiguously: the 1,141 **test files** comprise 928 under `servers/`, 77 `scripts/`, 61 `src/`, 33 `test/`, 13 `benchmarks/`, 13 `tests/`, 10 `docs/`, 6 elsewhere. The **directory** file counts (`benchmarks/` 86, `evals/` 31, `docs/evals/` 114) are *not* test counts — only 13, 0 and 9 of those are tests — so the moves relocate whole directories while the oracle tracks only tests.
- `vitest.config.ts` include globs, the `bun:sqlite` alias, `setupFiles`, and the **timeout-tier and coverage policy** inherited from the nested config are all resolved in the same change; `tests/` is typechecked by a real tsconfig include.
- `docs/evals/**/runs/**` captured artifacts keep their exclusion so their `process.exit` harness can never reach a worker.
- `CLAUDE.md` and `AGENTS.md` have the co-location rule **retired and replaced** in the same change.
- A test asserts the five old test roots no longer exist.

#### DR-6: The workflow artifact directory is configuration, not a hard-coded literal

**Acceptance criteria:**
- `.exarchos.yml` gains `artifacts.specDir`, defaulting to `docs/specs/`; the legacy classification prefix remains configurable alongside it.
- `rehydrate.ts` (`UNIFIED_SPEC_DIR`, `LEGACY_DESIGN_DIR`), `playbooks.ts` phase guidance and the `planArtifactExists` guard read the resolved value; no module retains a hard-coded artifact-path literal, asserted by a scan.
- Given `artifacts.specDir` points at a **symlinked** directory outside the repository, When a workflow is rehydrated, Then artifact classification resolves correctly And the stored path is POSIX-normalized (INV-16) And no code path uses filesystem presence as an existence signal — existence remains `_meta.workflowExists` from the projection.
- Given no `artifacts.specDir` is configured, When any workflow runs, Then behavior is byte-identical to today's `docs/specs/` default.
- In-flight workflows whose recorded artifact paths predate the change still resolve; a test covers a workflow initialized before and rehydrated after.

#### DR-7: Prose leaves the repository, and what remains is classified

**Acceptance criteria:**
- **The destination is named and the handoff is verifiable before anything is deleted.** The external documents repository, its symlink-mount-compatible layout, the transfer mechanism, and a content manifest with a per-file digest are recorded. Given the manifest, When reconciliation runs against the destination, Then every relocated file is present with a matching digest. Deletion here is gated on that reconciliation — revision 1 deleted hundreds of documents with no stated destination and no way to prove preservation.
- The prose subtrees of `docs/` (`designs/` 136, `plans/` 171, `research/` 67, `audits/` 41, `adrs/`, `rca/`, `guides/`, `references/`, `proposals/`, `bugs/`, `followups/`, `refactors/`, `runbooks/`, `contexts/`, `market/`, `migrations/`) are removed from this repository and preserved in the external documents repository, in a layout compatible with a future symlink mount.
- Non-prose content under `docs/` is **re-homed, not deleted**: `docs/evals/` graders and datasets → `tests/evals/`; `docs/schemas/` → `src/`; `docs/assets/` → wherever its live referents are.
- `docs/` retains only the VitePress skeleton (reduced from the stale `documentation/` site), `ARCHITECTURE.md`, `system-design.html`, and the workflow artifact directory.
- Before any prose file is removed, a **reference census** proves zero live references from code, tests, CI, `.exarchos.yml`, the invariants catalog `references:` keys, or `content/`. The `docs/architecture/invariants/references/*.md` targets and the paths `vocabulary-lint.ts` scans are specifically covered.
- Live links are the scope; dated historical records that reference removed paths are explicitly out of scope.
- **Measured 2026-08-11 (task 004) — the exodus cannot proceed as a bulk move.** Of the 16 prose subtrees, **12 carry live references and only 4 are clear**: `docs/audits` (41 files), `docs/bugs` (8), `docs/refactors` (1) and `docs/market` (1), for **51 of 466 files**. The blocked remainder is not marginal — `docs/designs` has 115 live referrers including **76 from source**, `docs/plans` 65, `docs/rca` 37, `docs/research` 29, `docs/guides` 21. Across the delete candidates there are **173 code referrers**. A referrer counts as live when a reader or a tool would follow it — source, config, snapshots, and instruction markdown outside `docs/`; a dated record under `docs/` mentioning a path is history and is out of scope, which is exactly why `docs/audits` clears despite carrying archival mentions. The consequence for tasks 037 and 037a is that the exodus is **per-subtree and reference-triaged**, not one move: each blocked subtree's live referrers are retargeted or retired before its files leave, and `tests/architecture/reference-census.test.ts` holds the cleared list as a ratchet so nothing is deleted against a stale measurement.
- A test asserts no tracked markdown exists outside `content/`, `rendered/`, `docs/`, the six `README.md` files and the classified root files.

#### DR-8: Dead code and dead declarations are eliminated

**Acceptance criteria:**
- The 103 entries in `scripts/audit/knip-allowlist.json` are each resolved as a deletion or a written justification carrying an owner and an expiry; the allowlist ends **empty or justified**, with no bare entries.
- The detector is **retargeted onto the new tree after the moves** so it is not stale on arrival, and re-run; findings introduced by the move are resolved, not allowlisted.
- Dead declarations are removed: `workspaces: ["packages/*"]`, the `CLAUDE.md.template` entry in `files[]`, and any other manifest entry that resolves to nothing. A test asserts every path in `package.json files[]` exists.
- **Worktrees and branches are inventoried, not pruned.** Removal is withdrawn on the author's
  instruction, and measurement supports it: of **67 worktrees, 66 carry commits absent from
  `origin/main`** — several 60 to 74 commits deep — and **387 of 408 local branches are
  unmerged**. One of them held the only copy of an unlanded `comment-prose` implementation,
  found incidentally while looking for something else; there is no cheap way to know which
  others are similar without reading them. The two worktrees an earlier revision named
  (`feat/taxonomy-v2-task-01{2,4}`) do not exist at all, and `git worktree prune` reports
  nothing because every registered directory is still on disk — so the tool this task would
  have leaned on cannot see the debt either.
  The ahead-count **overstates** unique work, because this repository squash-merges and the
  original commits never land on the base branch. That is the safe direction for an inventory
  and the wrong direction for a deletion warrant: it can only make a branch look more valuable
  than it is. `tools/audit/worktree-inventory.json` records the state; disposing of any of it
  is a separate human decision, out of scope here.
- Nothing referenced at runtime, by a test, by CI or by a governance control is deleted — every deletion is preceded by the DR-7 reference census.

#### DR-9: Complexity is reduced where measurement proves it, and locality is fixed

**Acceptance criteria:**
- The named hotspots are decomposed into cohesive modules: `registry.ts` (4,636), `sqlite-backend.ts` (3,009), `guard-inventory.ts` (2,751), `views/tools.ts` (2,286), `build-skills.ts` (2,245), `workflow/tools.ts` (2,062).
- **Declarative-breadth exemption, stated here:** `event-store/schemas.ts` (4,093) is a declarative Zod schema source and is **contents-unchanged**; a rename or a move is permitted. Any other file claiming the exemption must satisfy an explicitly-defined predicate, not an ad-hoc judgment.
- The locality defect is fixed as part of this requirement, not deferred: `verbs/` groups the former 83 flat files by capability, and the ≤25-files-per-directory-level assertion from DR-2 holds.
- No repo-wide LOC or export cap is introduced — the rule is scoped to the named files, because a blanket cap would silently expand this requirement into unscoped decomposition.
- Behavior is unchanged: no existing test is rewritten to accommodate a decomposition. Persisted event-type identifiers, their versions, and deterministic id/hash inputs are asserted **stable across the decomposition**; changing one deliberately is permitted and must be stated.
- The registered composite-tool and action names are **snapshotted and asserted unchanged** — a dropped registration compiles cleanly, so only a name snapshot catches it (INV-5d: four visible tools, each with an action discriminator).

#### DR-10: The repository's own documentation describes the system that exists

**Acceptance criteria:**
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` and `ONBOARDING.md` are **each** rewritten against the new tree — all five appear in a task's `Files:` list, and a test asserts none retains a path that no longer exists. Revision 1 required rewriting `CLAUDE.md` and `AGENTS.md` but scheduled only a single-rule edit to one of them.
- Every command shown in any of the five is executed by a smoke test; every rule stated is one that DR-1, DR-2, DR-3 or DR-12 actually enforces.
- `docs/ARCHITECTURE.md` states the six-directory contract, the **11 directories → 9 published layers** mapping, the one-way rule, the authored/generated classification per artifact kind with its committed-artifacts rationale, the plugin-root `hooks.json` exception, and the dot-directory classification.
- `docs/system-design.html`'s L1–L9 section is reconciled with the real directory names, so the design and the tree agree in both directions.
- Every one of the six top-level directories has a `README.md`, asserted by a test that enumerates directories rather than hard-coding a count.

#### DR-11: Failure modes, phase integrity, and dogfooding continuity

The refactor's dangerous failures are silent ones: a guard that matches nothing, an oracle captured against a red tree, a workflow that cannot find its own state, a Windows-only path bug.

**Acceptance criteria:**
- **Phase integrity.** Phase 1 contains **zero semantic edits**, verified mechanically rather than asserted: every changed file in the Phase 1 diff is a pure rename or a mechanical import-path rewrite, and `git diff -M --stat` reports rename detection above a stated threshold. Any task that changes behavior belongs to Phase 0 or Phase 2 by construction.
- **The baseline rule is unambiguous.** A red baseline **blocks**; there is no `accepted-red` escape. Revision 1 permitted one in task 001 while DR-11 forbade it — a contradiction that admitted the exact corrupt oracle the task existed to prevent. A genuinely red suite on `main` is fixed, or explicitly removed from the oracle's scope with a recorded reason, **before** task 002 — never during reconciliation.
- **Dogfooding continuity is proven during, not only after.** This repository runs its own workflow engine on itself while that engine's source moves. A **pinned pre-refactor binary** drives the workflow for the duration, so the tool doing the work is not the tree being changed. At each phase boundary, a workflow initialized before the phase rehydrates afterward with its recorded artifact paths resolving and its phase unchanged. The event store, `~/.claude/workflow-state/` and persisted stream identifiers are not migrated; any identifier that must change is stated with its consequence.
- **No guard passes vacuously.** For every guard touched — the retargeted `dependency-cruiser` rule, the layer census, `cycle-gate`, `knip`, the consolidated render guard, `vocabulary-lint`, `guard-inventory`, `lint:envelopes`, `lint:test-first-drift` — a test asserts its configured scope matches a **non-empty** set of tracked files, reconciled against the pre-refactor baseline. Given a guard is retargeted, When it would match zero files, Then the gate fails closed.
- **Windows/POSIX parity (INV-16).** A case-exactness gate asserts every declared entry point, `bin` target, `files[]` entry and config path resolves with **exact case** on disk — `tsc --noEmit` structurally cannot catch this and `core.ignorecase=true` masks it. Stored and compared paths are POSIX-normalized and built with `path.join`.
- **Depth-arithmetic detection.** The repo-root idiom is `path.resolve(__dirname, '../../../..')`, whose correct depth changes when a file moves. A stale value **still resolves to a real directory**, so "every literal resolves on disk" is structurally blind to it. The gate instead asserts each computed repo root **equals the actual repository root** (contains a known sentinel such as `.git` or the root `package.json`) — the only check that catches the failure this refactor is most likely to introduce.
- **Benchmark baselines are captured before any move**, with values, environment metadata, thresholds and a stated definition of "within noise". Revision 1 asserted "unchanged within noise" against a baseline it never recorded.
- **Clean-clone verification** on Linux and Windows at each phase boundary: `npm ci`, `npm run build`, `npm run typecheck`, the full suite, and every gate.
- **Rollback.** Each phase lands as one merge commit. The revert story is honest about what a revert does *not* undo: a regenerated lockfile, a repinned published plugin, and any released artifact each require their own restoration step, which is recorded.

#### DR-12: Governance, packaging and reference surfaces stay live across the move

Every control in this class fails **open**: a stale glob, a dead manifest entry, or a dangling reference produces silence rather than an error. They are one requirement because they share a failure mode and a fix.

**Acceptance criteria:**
- **`.github/CODEOWNERS` is updated in the same change as the moves it covers.** It owns `servers/exarchos-mcp/`, `scripts/`, `skills/` and `commands/` — all relocated. It is **extensionless**, so a scan filtered by file extension cannot see it; the census enumerates governance files by name, not by glob. A test asserts every CODEOWNERS pattern matches at least one tracked file, so ownership can never silently collapse to the `*` fallback.
- **Every `package.json files[]` entry and every `manifest.json` component resolves.** All seven shipped directories (`agents, commands, skills, command-aliases, rules, scripts, hooks`) are repointed or reclassified — revision 1 repointed three and silently dropped four from the published package. `manifest.json` installs `scripts` as a core component and is updated with it. The same test retires the dead `CLAUDE.md.template` entry.
- **`scripts/audit/protected-suites.json`** (~50 explicit test paths plus `generatedFrom: servers/exarchos-mcp/src`) is retargeted **in the same change as the test moves**. Revision 1 left it dangling across exactly the window in which every test file moved.
- **`.exarchos/invariants.md` `references:` keys are retargeted with the code they name.** They cite **source and test** paths (`event-store/atomic-appender.ts`, `storage/sqlite-backend.ts`, `test/process/multi-process-append.test.ts`), asserted by `dev-catalog-ref-paths.test.ts`. That test must not be red across the refactor, and the keys are updated again by **any later task that moves a cited file** — including the Phase 2 decomposition of `sqlite-backend.ts`, which revision 1 re-broke with no follow-up.
- **`knip.json`** entry points are retargeted in the change that invalidates them, not two phases later.
- The reference census gating deletion scans **markdown everywhere** (including `content/`, `commands/`, root instruction files) and **`*.snap`** snapshots — `test/migration/__snapshots__/snapshots.test.ts.snap` alone carries 103 `docs/` references. Revision 1's census scoped markdown to a directory that would not exist yet, so it could return a false zero.
- The conformance package owns this class as a single liveness census, run at every phase boundary.

### Risks

- **Guard evaporation (DR-3, DR-11, DR-12).** Every guard, manifest and reference registry here is configured with literal paths. One that silently matches zero files reports success forever. The panel found five such surfaces in revision 1 alone (`CODEOWNERS`, `files[]`, `manifest.json`, `protected-suites.json`, the invariants `references:` keys) — this is the highest-probability failure class and the reason liveness assertions are requirements, not conventions.
- **Test-move volume (DR-5).** 928 test files under `servers/` alone. The risk is not that a file breaks — `tsc` catches that — but that one is silently dropped by a stale include glob, or that the oracle itself becomes unusable because every path changed. Mitigated by path-independent test ids plus an explicit relocation map.
- **Reviewability of Phase 1.** Only reviewable if rename detection holds, which requires genuinely zero semantic edits. Revision 1 claimed this and had ten semantic tasks inside the phase; the phases are redrawn and the property is now machine-verified.
- **Conformance extraction may end partial (DR-12).** ~26 outbound edges must be inverted. A package that cannot be cleanly separated is worse than one that was never attempted, so the design permits a stated-exception residue rather than forcing a circular package.
- **Loss of unit-test locality (DR-5).** A real and permanent cost of the chosen centralization, accepted deliberately by the author.
- **Dogfooding during the refactor (DR-11).** The engine's own source moves while it runs the workflow. Mitigated by pinning a pre-refactor binary for the duration; without that, a mid-flight breakage is a self-inflicted outage of the tool doing the work.
- **Flatten collisions (DR-4).** Capability grouping plus a flattening renderer creates a namespace hazard that does not exist today. Mitigated by a build-time failure naming both source paths.
- **External contract break (DR-4, DR-12).** Repinning `plugin.json`/`manifest.json`, moving `scripts/`, and touching hook discovery are genuine external breaks; only a fresh-clone install smoke test that also asserts hooks load **once** can prove they landed.
- **Scope.** Twelve requirements across structure, enforcement, deletion, complexity and documentation is a large surface. The three-phase split is the primary control; Option C remains the documented fallback.

### Open Questions

- **Does `evals/` belong under `tests/` or under `src/`?** The eval *harness* (`src/evals/`, 66 files) is product code; the suites and datasets are fixtures. This design puts suites under `tests/evals/` and leaves the harness in `src/`. Resolved concretely in task 010.
- **Is `evals-pkg` retained or retired?** It is a fourth manifest/lockfile pair, opt-in, and named in `ci.yml`'s `prompts:` paths-filter. Revision 1 never mentioned it. Decided in task 011a.
- **Does the VitePress skeleton live under `docs/` or return as its own top-level directory when the site is rebuilt?** Deferred: the author has stated the site needs a full rewrite, so this design only guarantees it keeps building.
- **Do `commands`, `rules` and `binding` get a generator, or stay authored-and-shipped?** They have none today. Decided in task 022a before any repin depends on the answer.
- **Is `install/` a layer or a peer?** **Resolved** — a declared non-layer peer under `src/install/`, with the 11→9 mapping stated in `docs/ARCHITECTURE.md`.
- **Does `content/` need per-domain grouping beyond artifact type?** **Resolved** — capability-first grouping, with the renderer taught to flatten (DR-4).

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1 … DR-12).
**Excluded:** None. `.github/`'s layout is platform-mandated and is *updated* where it carries stale paths (notably `CODEOWNERS` and the workflow YAML) rather than restructured.

### Sequencing principle

**Oracle before mutation.** The test inventory, the guard-liveness baseline and the benchmark baseline are captured against a **verified-green** tree before anything moves. A red baseline blocks — there is no accepted-red escape.
**Census before deletion**, enforced as a hard task dependency rather than a stated intention.
**Shrink before moving**, so the structural diff is as small as it can be.
**Phase 0 completes before Phase 1 begins.** Revision 1 let Phase 1 start while the census and shrink were still running.
**Move before renaming; update the config with the move that breaks it, never after.**
**Retarget every guard, manifest and reference registry in the same change that invalidates it** — `CODEOWNERS`, `files[]`, `manifest.json`, `protected-suites.json`, `knip.json` and the invariants `references:` keys all fail open.
**Phase 1 contains zero semantic edits**, verified by rename detection over its own diff. Every behavior change lives in Phase 0 or Phase 2.

### Cross-spec sequencing — comment hygiene

[`docs/specs/2026-08-11-comment-hygiene-enforcement.md`](2026-08-11-comment-hygiene-enforcement.md)
targets paths this refactor moves or deletes: `scripts/`, `eslint-rules/`, `skills-src/`, and
every remediation target under `servers/exarchos-mcp/src/`. The two are sequenced, not
parallel, and the interleave is fixed here so neither dispatch has to rediscover it.

**Its Stage 1 lands before task 001 captures the oracle.** That stage is ten tasks of
path-independent logic — an extractor, a policy datum, a classifier, fixtures, an unregistered
ESLint rule — and it ships **no CI step, no manifest entry, no baseline file and no enabled
rule**. That constraint exists for this refactor's benefit: task 003's guard-liveness baseline
and task 002's test inventory are both corrupted by any concurrent guard or test addition, so
the comment work must be entirely on one side of that line.

One task in it is a hard precondition rather than a convenience. Its task 001 stops
`skills-src/plan/references/task-template.md` and
`skills-src/delegate/references/implementer-prompt.md` from stamping `Implements: DR-N` and a
task ordinal into every implementer prompt. **This refactor dispatches roughly 65 tasks through
those exact templates.** Dispatched before that fix, it manufactures thousands of fresh
planning-ordinal citations across the entire moved tree — growing the backlog at the moment the
tree is least able to absorb it, and confounding the before/after measurement that spec needs.

**Its Stage 2 lands after Phase 1.** Everything it produces after that point is path-keyed —
per-file debt budgets, coverage and lint baselines, manifest entries, CI steps — and would be
void the moment the moves land. Two of its requirements are actively dangerous if landed early:
its diff-scoped TSDoc gate fails any new undocumented export, which would **block this
refactor's decomposition wave outright**, and its per-file debt budget is keyed to paths tasks
012–019 destroy.

**Fold 1 — the decomposition wave absorbs the comment remediation.** Tasks 048, 049, 050 and
051 decompose `registry.ts`, `sqlite-backend.ts`, `views/tools.ts`, `workflow/tools.ts`,
`guard-inventory.ts` and `build-skills.ts` — roughly 19k LOC. Those same six files are the
named remediation targets of that spec's tasks 029 and 030. Each of the four decomposition
tasks therefore carries an added acceptance criterion: **no extracted module carries a planning
ordinal in a comment**, verified by running that spec's Stage 1 classifier over the decomposed
output. The rewrite happens once, while the author is already restructuring the module, instead
of twice.

**Fold 2 — this refactor hosts the comment tooling rather than moving it.** Task 036 (`tools/`
consolidation) is where the comment gate primaries land, so they are never created in
`scripts/` and relocated. Task 042 (retarget the audit configs and assert glob liveness) is
where the widened ESLint scope lands, because widening lint reach onto the new tree is
precisely that task's job; doing it twice would measure a baseline over six roots that no
longer exist.

**Observation, not gating.** That spec's classifier runs in observe mode over every PR this
refactor produces. This execution is a better natural experiment for its DR-3 before/after
measurement than a calendar window, and it costs nothing to collect.

### Phase boundary

**Phase 0** (tasks 001–009) — oracles, the one independent semantic change (DR-6), and the dead-code shrink. **Fully completes before Phase 1 begins.**
**Phase 1** (tasks 010–039) — pure structural movement, zero semantic edits. One merge commit; rename-detected diff.
**Phase 2** (tasks 040–058) — enforcement, complexity and documentation. Every semantic change lives here. One merge commit.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Top level is six directories and every entry is classified | 036, 039, 043, 055 |
| DR-2 | Product tree expresses the published layer architecture | 010, 011, 011a, 012, 013, 014, 015, 016, 017, 018, 019, 020, 044, 052 |
| DR-3 | One authority per rule class, every rule proven to bite | 003, 040, 040a, 041, 042 |
| DR-4 | Authored/generated separated per artifact kind | 021, 022, 022a, 023, 024, 025, 026, 027, 028 |
| DR-5 | All tests in one tree, no test lost | 001, 002, 029, 030, 031, 032, 033, 034, 035 |
| DR-6 | Artifact directory is configuration, not a literal | 005, 006 |
| DR-7 | Prose leaves the repository, remainder classified | 004, 037, 037a, 038, 039 |
| DR-8 | Dead code and dead declarations eliminated | 004, 007, 008, 009, 053 |
| DR-9 | Complexity reduced where measured, locality fixed | 015, 047, 048, 049, 050, 051, 052 |
| DR-10 | Repository documentation describes the system that exists | 035, 044, 054, 055 |
| DR-11 | Failure modes, phase integrity, dogfooding continuity | 001, 001a, 002, 006, 020, 027, 028, 042, 045, 046, 056 |
| DR-12 | Governance, packaging and reference surfaces stay live | 003, 018a, 026, 030, 036, 042, 057, 058 |

### Tasks

## Phase 0 — Oracles, the independent semantic change, and the shrink

### Task 001: Establish and verify a green baseline

Every later reconciliation compares against this run. The sibling repo's plan was blocked because its oracle was captured against a deterministically red tree; this task exists to make that failure impossible here.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5, DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tools/audit/baseline-green.json`
- `tests/architecture/baseline-green.test.ts`
**Tests:**
- `Baseline_OnCleanCheckout_EveryConfiguredSuiteIsGreen`
**Verification:** From a clean clone on both Linux and Windows: `npm ci`, `npm run typecheck`, `npm run test:all`, plus the nested workspace's suite. **A red suite blocks — there is no `accepted-red` escape** (revision 1 permitted one here while DR-11 forbade it). Any genuinely red suite on `main` is either fixed in this task, or explicitly removed from the oracle's scope with a recorded reason, and that decision is made **now**, never during a later reconciliation. **This task blocks 001a and 002.**

**Measured 2026-08-11 — "green" is environment-dependent, and this task must say which environment it means.** On a clean worktree at `2306dd2e3` with both dependency trees installed: the root suite is **fully green** (167/167 files, 1,690 tests) and both typechecks pass, but the nested `servers/exarchos-mcp` suite reports **26 failures across 9 files**, entirely within `merge-orchestrate` and `store.race`. The same tree is **green on CI**: the `CI Gate` run for `355ffd63` succeeded, as did the two runs before it.

So the failures are local-only, and the task as written cannot be executed as stated — it demands a green clean clone, and a clean clone is green in one environment and red in another. Resolving this **is** the task, and there are only two honest outcomes:

- **Pin the oracle's environment to CI** and state that the local delta is out of scope, recording the 26 by name so a later reconciliation cannot mistake them for damage this refactor caused; or
- **Fix the local-only failures first**, which makes the two environments agree and removes the ambiguity permanently.

What must not happen is capturing the oracle locally without deciding. The whole point of this task is that every later reconciliation compares against it: 26 tests recorded as failing in the baseline would be indistinguishable from 26 tests the refactor broke, and the guard-liveness and test-inventory oracles built on top of it inherit the same corruption. That is precisely the failure mode this task exists to make impossible.

**Resolved 2026-08-11 — the oracle is pinned to CI and the 26 are named.** `tools/audit/baseline-green.json` records the reference run (`CI Gate`, `355ffd63`, success), the locally-green root suite, and every excluded test by file and name. The exclusion states what voids it: any listed test failing **on CI** makes the failure real, and an unexplained failure outside the list blocks. `tests/architecture/baseline-green.test.ts` holds the enumeration honest — the headline count must equal the enumerated list, every excluded file must still exist, every excluded test name must still be present in its file, and no exclusion may sit outside the merge-orchestrate cluster the justification covers. An exclusion that outlives its subject is permanent cover for whatever moves in next.

The **Windows leg is recorded as outstanding rather than quietly dropped**. This capture is Linux plus CI; an oracle that silently covered one platform would let a Windows-only breakage read as a clean baseline.

**Collection finding — the Phase 0 oracle tests were uncollected by construction.** This task and tasks 002, 003 and 004 all author tests under `tests/architecture/`, which matched **no** project include: the root `unit` project collects `src/`, `scripts/`, `benchmarks/`, `hooks/`, `docs/evals/` and several `test/` subdirectories, and the only `tests/` glob anywhere is the outcome tier's `tests/outcome/**`. All four oracles would have passed by never running — the vacuous-guard class DR-11 names as the highest-probability failure in this workflow, reached here through the oracles themselves. `tests/architecture/**/*.test.ts` is added to the `unit` project's include in this task; it is a Phase 0 config change, so it does not disturb Phase 1's zero-semantic-edit property, and it moves the runner toward the target tree rather than away from it. Verified by the collected count rising rather than by inspection of the config.
**Dependencies:** None
**Parallelizable:** No

### Task 001a: Capture the benchmark baseline and pin the workflow binary

Two Phase 0 preconditions revision 1 asserted but never established: benchmark acceptance criteria with no recorded baseline, and dogfooding continuity with no mechanism.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks true, characterizationRequired false. SLAs: recorded per-operation p99 and wall-clock values become the envelope every later benchmark assertion compares against.
**Files:**
- `tools/audit/benchmark-baseline.json`
- `tools/audit/pinned-binary.md`
**Tests:**
- `BenchmarkBaseline_AtGreenTree_RecordsValuesEnvironmentAndNoiseBand`
**Verification:** Record every benchmark's value, the environment metadata (OS, core count, Node version), the threshold, and an explicit definition of "within noise" — later tasks assert against **this file**, not against an unstated intuition. Then pin the pre-refactor `exarchos` binary and record its version and path: it drives this workflow for the whole refactor, so the tool doing the work is never the tree being changed.

**Status 2026-08-11 — the baseline is captured; the pin is DEFERRED, blocked on a release.**

Nine benchmarks recorded at `b88df6f47` with environment metadata. The noise band is derived **per benchmark from its own measured relative margin of error**, doubled for a two-run comparison and floored at 5%, because the measured spread across these nine is roughly thirtyfold: `Append_100Events_Sequential` reports ±14.89% and genuinely cannot resolve a 10% change, while `Materialize_1000MixedEvents_PipelineView` at ±0.52% can. A single global percentage would wave through a real regression in the stable benchmarks and cry wolf on every run of the volatile ones. The file states its own limits — one run, one workstation, describing within-run rather than run-to-run variance — so a single breach prompts a re-measure rather than proving a regression.

A **prior baseline did exist**, contrary to an earlier framing: `benchmarks/baselines.json`, generated 2026-02-16 at `858a1b4`. It covered two benchmarks rather than nine and carried no environment metadata or noise definition, so it could not support the "unchanged within noise" claim it was cited for. It is acknowledged and left in place; retiring or repointing it belongs with task 042.

The **pin cannot be taken yet**. The installed build predates the WFQ-006 gate fix, so pinning it would drive every local gate through stale logic; and building from the working tree gives an unreleased binary that nobody else can reproduce, which is most of what a pin is for. It therefore depends on this branch merging and a release being cut — a release-cadence decision. Phase 0 is safe without it, since nothing here moves product source. **Phase 1 is where the pin becomes load-bearing**, because that is where the engine's own source relocates; entering Phase 1 unpinned means accepting that a bad move can disable the tool performing the move. The gate is recorded in `tools/audit/pinned-binary.md` and asserted by the accompanying test, so the gap stays visible rather than reading as done.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 002: Capture the test inventory oracle

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tools/audit/test-inventory-baseline.json`
- `tests/architecture/test-inventory.test.ts`
**Tests:**
- `TestInventory_AtBaseline_RecordsEveryDiscoveredTestId`
- `TestInventory_MissingFile_NamesTheMissingSource`
- `TestInventory_RelocatedFile_ReconcilesViaTheRelocationMap`
**Verification:** Record **path-independent** ids — `(suite path within the file, test name, runner)` — across all 1,141 test files, all five roots, and the `*.test.sh` bash suites, plus an initially-empty **old→new relocation map** that every move task appends to. Revision 1 recorded per-*file* ids whose paths every move invalidates: strict comparison would have reported all 1,141 missing, and loose comparison would have conflated duplicate test names. Reconciliation is `oracle − relocations`. The current root `unit` project include omits `.tsx` under some roots — capture with a corrected discovery glob or the gap is baked into the oracle.
**Dependencies:** 001
**Parallelizable:** No

### Task 003: Capture the guard-liveness baseline

Every guard in this repository is configured with literal path globs. This records what each one currently matches, so a post-move guard that silently matches zero files is detectable.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3, DR-11, DR-12
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/audit/guard-liveness-baseline.json`
- `tests/architecture/guard-liveness.test.ts`
**Tests:**
- `GuardLiveness_EveryConfiguredGuard_MatchesNonEmptyFileSet`
- `GuardLiveness_GuardMatchingZeroFiles_FailsClosed`
**Verification:** Enumerate every guard **and every fail-open governance surface**, recording each one's matched-file count: the two `dependency-cruiser` rules (including `no-domain-core-to-io-adapters`, whose literal `(event-store|workflow)/ → adapters/` regexes this refactor destroys), the layer census, `cycle-gate`, `knip` (both blocks), `skills:guard`, `hooks:guard`, `runtimes:guard`, `vocabulary-lint`, `guard-inventory`, `lint:envelopes`, `lint:inv6`, `lint:test-first-drift`, `desc:budget-guard`, `protected-suites.json`, **`.github/CODEOWNERS` (enumerated by name — it is extensionless and no extension-filtered glob can see it)**, `package.json files[]`, `manifest.json` components, and the `.exarchos/invariants.md` `references:` keys. The second test proves the assertion fails closed rather than reporting success on an empty match.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 004: Reference census over `docs/` and every deletion candidate

The sibling repo's revision 1 deleted 20 live fixtures and an active test oracle because it trusted an unverified map. Nothing here is deleted before this census exists.

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-7, DR-8
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/audit/reference-census.json`
- `tests/architecture/reference-census.test.ts`
**Tests:**
- `ReferenceCensus_EveryDeletionCandidate_HasZeroLiveReferences`
- `ReferenceCensus_LiveReferencedPath_IsExcludedFromDeletion`
**Verification:** Scan `**/*.{ts,tsx,mts,mjs,cjs,json,yml,yaml,sh,ps1,html}` **plus all markdown wherever it currently lives** (`skills-src/`, `commands/`, `rules/`, `agents/`, root instruction files — revision 1 scoped markdown to `content/`, which does not exist until task 021, so it could return a false zero) **plus `*.snap`** (`test/migration/__snapshots__/snapshots.test.ts.snap` alone carries 103 `docs/` references) **plus extensionless governance files enumerated by name** (`.github/CODEOWNERS`). Cover the `.exarchos/invariants.md` `references:` keys, the `docs/architecture/invariants/references/*.md` targets, `vocabulary-lint.ts`'s scanned prefixes, `ci.yml`'s 22 `docs/` references, `vitest.config.ts`'s `docs/evals/**` includes, and `.exarchos.yml`'s 7. The census output is the authority tasks 037/037a/038 execute against, and it is a **hard dependency** of every deletion task.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 005: Make the workflow artifact directory configurable

The author named this coupling directly as a code smell. It is semantic, self-contained, and independent of every structural move, so it lands in Phase 0 to keep Phase 1 purely mechanical.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-6
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "default resolution is byte-identical to the hard-coded literal for every artifact kind"; "classification is stable under any configured prefix".
**Files:**
- `servers/exarchos-mcp/src/config/artifacts.ts`
- `servers/exarchos-mcp/src/workflow/rehydrate.ts`
- `servers/exarchos-mcp/src/workflow/playbooks.ts`
- `servers/exarchos-mcp/src/workflow/guards.ts`
- `tests/unit/config/artifact-dir.test.ts`
**Tests:**
- `ArtifactDir_NoConfiguration_DefaultsToDocsSpecs`
- `ArtifactDir_ConfiguredPrefix_ClassifiesUnifiedSpecCorrectly`
- `ArtifactDir_LegacyDesignPrefix_StillClassifiesAsTwoArtifact`
- `PlanArtifactExistsGuard_ConfiguredPrefix_ResolvesAgainstIt`
**Verification:** Add `artifacts.specDir` (default `docs/specs/`) and the legacy design prefix to the `.exarchos.yml` schema. Replace `UNIFIED_SPEC_DIR` and `LEGACY_DESIGN_DIR` literals and the `planArtifactExists` guard's literal with resolved values. A scan test asserts no module retains a hard-coded artifact-path literal. Characterization first: capture current classification behavior across the existing corpus, then prove the default path is unchanged.

> **Corrected during execution (2026-08-11).** Two premises here were false against the tree.
> **(1) `planArtifactExists` holds no literal.** It is `makeArtifactGuard('plan', …)` over
> `isTypedArtifactReference` — `typeof value === 'string' && value.trim().length > 0`
> (`workflow/guards.ts:120`). It never touches a path, so it is directory-agnostic already and
> needed no change; the planned `PlanArtifactExistsGuard_ConfiguredPrefix_ResolvesAgainstIt`
> test was dropped rather than written against behaviour that does not exist.
> **(2) The scan test cannot be absolute.** ~10 agent-facing prose mentions live in tool
> descriptions and phase playbooks, which shape agent behaviour without gating it. The shipped
> test is two-tiered: functional uses (path construction, prefix comparison, directory
> constants) are held to a closed two-file allowlist; prose is pinned as a budget the docs move
> retires. The functional surface was 5 sites, not the broad coupling assumed here.
**Dependencies:** 001
**Parallelizable:** Yes

### Task 006: Cover symlink resolution, POSIX normalization, and existence semantics

The author's future docs exodus mounts the artifact directory as a **symlink**. That interacts with INV-16 and with the state-source-integrity rule, so it gets its own verification rather than riding task 005.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6, DR-11
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired false. Properties: "a stored path is POSIX-normalized for every input separator form".
**Files:**
- `tests/integration/config/artifact-dir-symlink.test.ts`
- `servers/exarchos-mcp/src/config/artifacts.ts`
**Tests:**
- `ArtifactDir_SymlinkedOutOfTree_ResolvesAndClassifies`
- `ArtifactDir_WindowsSeparators_IsStoredPosixNormalized`
- `ArtifactDir_MissingDirectory_DoesNotAffectWorkflowExistence`
- `Rehydrate_WorkflowInitializedBeforeChange_StillResolves`
**Verification:** Given `artifacts.specDir` points at a symlink outside the repository, classification resolves and the stored path is POSIX-normalized (INV-16). The third test is the load-bearing one: a missing artifact directory must **not** change `_meta.workflowExists`, because existence is the projection's answer and never a filesystem stat — the rule the state-source-integrity RCA exists to protect.
**Dependencies:** 005
**Parallelizable:** No

> **Corrected during execution (2026-08-11).** The stated file
> `tests/integration/config/artifact-dir-symlink.test.ts` is collected by **no vitest project**
> — the root config includes `tests/architecture/**` and `tests/outcome/**` but never
> `tests/integration/**` — so a test authored there passes by never executing. It also needs the
> MCP workspace's `bun:sqlite` alias to construct an `EventStore`. Shipped instead at
> `servers/exarchos-mcp/src/config/artifact-dir-symlink.test.ts`, co-located per the repo
> convention. **Any later task whose Files list names `tests/integration/**` inherits this bug.**
>
> `ArtifactDir_MissingDirectory_DoesNotAffectWorkflowExistence` needed teeth it did not have as
> specified: `handleRehydrate` never receives a repo root, so a missing directory is trivially
> invisible to it and the test would pass for the wrong reason. It now pins `process.cwd()` at
> an artifact-less repo. Kill-probe run: a mutant resolving `workflowExists` from `existsSync`
> fails three assertions, including both named cases.

### Task 007: Remove dead declarations

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-8
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `package.json`
- `tests/architecture/manifest-liveness.test.ts`
**Tests:**
- `Manifest_EveryFilesEntry_ExistsOnDisk`
- `Manifest_WorkspaceGlobs_MatchAtLeastOnePackage`
**Verification:** Delete the `workspaces: ["packages/*"]` glob (no `packages/` exists) and the `CLAUDE.md.template` entry from `files[]` (the file does not exist). The tests make both classes of dead declaration permanently detectable rather than fixing two instances.
**Dependencies:** 004
**Parallelizable:** Yes

### Task 008: Inventory worktrees and branches (no removal)

**Risk Tier:** low
**Test Layer:** integration
**Implements:** DR-8
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/audit/measure-worktree-inventory.mjs`
- `tools/audit/worktree-inventory.json`
- `tests/architecture/worktree-inventory.test.ts`
**Tests:**
- `WorktreeInventory_EveryRegisteredWorktree_IsRecorded`
- `WorktreeInventory_Disposition_IsInventoryOnly`
- `WorktreeInventory_AheadCount_CarriesTheSquashMergeCaveat`
**Verification:** **Corrected 2026-08-11 — the measured scale is two orders of magnitude off
the original framing, and in both directions.** `git worktree list` reports **66** entries, of
which **64** are `agent-*` worktrees under `.claude/worktrees/`, alongside **408** local
branches. The two this task named — `.worktrees/tax-task-012` and `.worktrees/tax-task-014`,
with branches `feat/taxonomy-v2-task-01{2,4}` — **do not exist**; `git worktree list` matches
no `taxonomy-v2` entry. `git worktree prune --dry-run` reports nothing prunable, because every
registered directory is still present on disk, so the plumbing command cannot find this debt.

**Removal is withdrawn on the author's instruction, and the measurement supports it.** Of the
**67** registered worktrees, **66 carry commits absent from `origin/main`**, several 60 to 74
deep, and **387 of 408** local branches are unmerged. One of them held the only copy of an
unlanded `comment-prose` implementation, found incidentally while looking for something else
(see `docs/specs/2026-08-11-comment-hygiene-enforcement.md`, task 003) — and there is no cheap
way to know which others are similar without reading them. An inventory is reversible; a prune
is not.

**The ahead-count overstates unique work and must not be read as a deletion warrant.** This
repository squash-merges, which rewrites history, so a fully-shipped branch still reports
commits ahead of the base. That bias runs in the safe direction for an inventory — it can only
make a branch look more valuable than it is — but separating shipped from unshipped needs a
patch-level comparison, which is deliberately not attempted here.

So this task records and stops: `tools/audit/worktree-inventory.json` holds every worktree, its
branch, whether its directory is present, and its divergence; the branch count is split merged
against unmerged. Nothing is deleted, moved, or written into any worktree. Disposing of any of
it is a separate human decision and is out of scope.
**Dependencies:** 004
**Parallelizable:** Yes

### Task 009: Sweep the knip allowlist to empty or justified

Sweeping **before** the move keeps the structural diff smaller; task 053 retargets and re-runs the detector afterward, because a config authored against the old tree is stale the moment the moves land.

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-8
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `scripts/audit/knip-allowlist.json`
- `tests/architecture/dead-code-allowlist.test.ts`
**Tests:**
- `DeadCodeAllowlist_EveryEntry_CarriesOwnerAndExpiry`
- `DeadCodeAllowlist_BareEntry_IsRejected`
**Verification:** Resolve each of the 103 entries as a deletion or a written justification carrying an owner and an expiry. Every deletion is gated on the task 004 census. The allowlist ends empty or fully justified; a bare entry fails the gate, so the ratchet cannot silently re-accumulate.
**Dependencies:** 004, 007
**Parallelizable:** No

> **Corrected during execution (2026-08-11).** The ledger was in better shape than assumed and
> the gate was in worse. All 103 entries already carried an owner, a deadline and a rationale,
> knip still flags every one (zero stale), and none had expired — so there was nothing to sweep
> in the sense meant here. The gate itself was **RED**: two comment-hygiene kill fixtures from
> the sibling overhaul landed on this branch with no exemption. Fixed; now 105 findings, all
> allowlisted.
>
> Both named tests were already covered in substance by `scripts/audit/knip-diff.test.ts`
> (schema conformance at `:112`, bare-entry rejection at `:108`), so the shipped
> `tests/architecture/dead-code-allowlist.test.ts` is additive: it checks what a
> `rationale.length > 0` schema cannot. **Residue:** 59 entries state no condition under which
> they could ever be removed, 45 of them saying only "forward-compat surface". Every one is an
> exported TYPE, so retiring them is a census-gated deletion sweep, not a rationale rewrite —
> padding the prose would move the measurement without moving the claim. Pinned at ≤59.

## Phase 1 — Structural movement and enforcement (zero semantic edits)

### Task 010: Author the authoritative layer mapping table

The core has ~60 subdirectories and the published architecture names nine layers. This task produces the mapping the subsequent move tasks execute, so no move task invents a placement.

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `docs/ARCHITECTURE.md`
- `tools/audit/layer-map.json`
- `tests/architecture/layer-map.test.ts`
**Tests:**
- `LayerMap_EveryCoreDirectory_MapsToALayerOrAStatedException`
**Verification:** Every one of the ~60 directories under `servers/exarchos-mcp/src/` maps to exactly one of `storage, events, projections, workflow, contract, dispatch, verbs, lifecycle, adapters, runtime, install` — or carries a **stated exception with a reason**. Directories with no obvious layer (`architecture/` → extracted to `tools/conformance/`, `ctk/`, `evals/`, `test-helpers/`, `parity/`, `runbooks/`) are resolved here explicitly. The **11 directories → 9 published layers** mapping is authored here (L5 splits into `contract`/`dispatch`; `install/` is a declared non-layer peer), because task 044 asserts *that* mapping rather than set equality. The open questions on `evals/` and `install/` resolve in this task.
**Dependencies:** 002, 003, 004, 005, 006, 007, 008, 009
**Parallelizable:** No

### Task 011: Unify the build graph — a deliberate timeout and coverage policy decision

Revision 1 called this a structural collapse and asserted `ExactlyOneLockfileExists`. Both were wrong: there are **four** manifest/lockfile pairs, and the nested `vitest.config.ts` carries policy the root config does not.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks true, characterizationRequired true. SLAs: full-suite wall clock within the task 001a envelope.
**Files:**
- `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `knip.json`, `bunfig.toml`, `stryker.conf.mjs`
- `tools/audit/coverage-baseline.json`
- `tests/architecture/build-graph.test.ts`
**Tests:**
- `BuildGraph_AfterUnification_DeclaredPackageSetMatchesTheManifestSet`
- `BuildGraph_BunSqliteAlias_ResolvesInEveryProject`
- `BuildGraph_CoreTestTier_RetainsItsDeclaredTimeoutPolicy`
- `BuildGraph_CoverageRatchet_StillReceivesItsInputs`
**Verification:** The end state is **one product package plus explicitly-declared tool packages**, not one lockfile. Resolve the nested config's policy deliberately: `testTimeout`/`hookTimeout` 60000 (chosen for Windows per #1620 and explicitly **not** to be re-scaled), `pool: 'forks'`, the `type-test`/`bench` includes, the `EXARCHOS_SMOKE_ONLY` exclude, `benchmark.outputJson`, and the v8 coverage block feeding `check-coverage-ratchet.mjs`. Collapsing 928 core tests into the root `unit` tier at `tierTimeout(5000)` without a decision would fail them by lottery on Windows. The `bun:sqlite` → `better-sqlite3` alias resolves once. Assert the multiset of `resolved` hostnames in the regenerated lockfile is unchanged.
**Dependencies:** 010
**Parallelizable:** No

### Task 011a: Classify `evals-pkg` and the `documentation` manifest

The third and fourth manifest pairs. `evals-pkg` appeared in no revision-1 task despite being named in CI.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `servers/exarchos-mcp/evals-pkg/`
- `.github/workflows/ci.yml`
**Tests:**
- `ManifestSet_EveryTrackedPackageJson_IsClassifiedRetainedOrRetired`
**Verification:** `evals-pkg` (opt-in promptfoo, named in `ci.yml`'s `prompts:` paths-filter) is retained under a declared home or retired with its CI filter removed in the same change. `documentation/`'s manifest is scoped to task 039's skeleton reduction. The test enumerates every tracked `package.json` and fails on one that is neither the product, a declared tool package, nor explicitly retired — so a fifth manifest cannot appear unnoticed.
**Dependencies:** 011
**Parallelizable:** No

### Task 012: Move L1–L3 — storage, events, projections

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks true, characterizationRequired true. Properties: "append/fold behavior is identical before and after the move". SLAs: event-append p99 unchanged within noise.
**Files:**
- `src/storage/`, `src/events/`, `src/projections/`
- `tsconfig.json`, `vitest.config.ts`, `.dependency-cruiser.cjs`
**Tests:**
- `EventStore_AfterRelocation_AppendAndFoldAreUnchanged`
**Verification:** Pure move of `storage/`, `event-store/` → `events/`, and `projections/` per the task 010 map, with every importer updated in the same change. Benchmarks are required here and nowhere else in Phase 1 because L2 is the load-bearing spine and a relocation that changes module resolution can change hot-path behavior. INV-1 is the acceptance condition: no read model gains state that is not a fold.
**Dependencies:** 011a
**Parallelizable:** No

### Task 012a: Retarget the live depcruise rule with the paths it governs

`no-domain-core-to-io-adapters` is `severity: 'error'` scoped to `^servers/exarchos-mcp/src/(event-store|workflow)/` → `adapters/`. Task 012 destroys the `event-store` half. Left alone it matches zero and passes forever.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3, DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `.dependency-cruiser.cjs`
- `tests/architecture/depcruise-rule-liveness.test.ts`
**Tests:**
- `DepcruiseRule_AfterRetarget_MatchesNonEmptyModuleSet`
- `DepcruiseRule_SeededViolation_StillFails`
**Verification:** Retarget both regex sides as the directories move, in the same change. This is **guard hygiene, not a second authority** — revision 1 forbade touching this file on one-authority grounds and would have silently disarmed a live error-severity rule executed by `runBoundaryLint` (`static-analysis.ts:216`). Repeat the liveness assertion after tasks 013, 018 and 019.
**Dependencies:** 012
**Parallelizable:** No
### Task 013: Move L4 — workflow and topology

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "no invalid HSM state is reachable from any valid state after the move".
**Files:**
- `src/workflow/`
- `tests/unit/workflow/`
**Tests:**
- `WorkflowHsm_AfterRelocation_TransitionTableIsUnchanged`
**Verification:** Move `workflow/` (179 files) and fold `topology/` into it per the map. The HSM transition table and every guard name are asserted unchanged — INV-6 requires the substrate stay workflow-type-agnostic, so no directory may encode a workflow type. Re-run the task 012a depcruise liveness assertion: this move destroys the `workflow` half of that rule's `from` alternation.
**Dependencies:** 012a
**Parallelizable:** No

### Task 014: Move L5 — contract and dispatch

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "the compiled contract's wire projection is identical before and after".
**Files:**
- `src/contract/`, `src/dispatch/`
- `tests/unit/contract/`
**Tests:**
- `CompiledContract_AfterRelocation_WireProjectionIsByteIdentical`
**Verification:** Move `contract/` (compiler, ir, bindings, reachability, oracle) and fold `core/` + `dispatch/` into `src/dispatch/`. INV-2 is the acceptance condition: the wire projection is the invocation surface, so a byte-identical projection before and after is the proof the move changed nothing observable.
**Dependencies:** 013
**Parallelizable:** No

### Task 015: Regroup `orchestrate/` into `src/verbs/` by capability

The single worst locality defect: 83 non-test files flat at the top of one directory. This is a Phase 1 task because it is a pure move; the DR-9 locality *assertion* lands in task 052.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2, DR-9
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `src/verbs/{gates,review,tasks,team,vcs,doctor,init,invariants,merge}/`
- `tests/architecture/verb-registration.test.ts`
**Tests:**
- `VerbRegistration_AfterRegrouping_EveryActionStillRegisters`
- `VerbRegistration_DroppedHandler_FailsTheSnapshot`
**Verification:** Group the 83 flat files by capability (the `check-*`, `assess-*`, `extract-*`, `gate-*` families plus the existing `doctor/`, `pure/`, `worktree/`, `init/`, `vcs/`, `invariants/`, `onboard/` subdirectories). A dropped registration **compiles cleanly**, so only a name snapshot catches it — the second test proves the snapshot actually fails when a handler is removed.
**Dependencies:** 014
**Parallelizable:** No

### Task 016: Move `views/` into `src/verbs/views/`

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks true, characterizationRequired true. Properties: "projection query results are identical before and after". SLAs: view materialization cold-start unchanged.
**Files:**
- `src/verbs/views/`
- `tests/integration/views/`
**Tests:**
- `Views_AfterRelocation_MaterializationResultsAreUnchanged`
**Verification:** Move the 77-file CQRS view layer. Benchmarks apply because view materialization is a declared benchmark category.
**Dependencies:** 015
**Parallelizable:** No

### Task 017: Move L7 — lifecycle verbs

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `src/lifecycle/`
- `tests/integration/lifecycle/`
**Tests:**
- `LifecycleVerbs_AfterRelocation_PsDescribeWaitExportAllDispatch`
**Verification:** Move `cli-commands/` to `src/lifecycle/`. INV-10's liveness protocol means these verbs query events generically; the test proves all four still dispatch.
**Dependencies:** 016
**Parallelizable:** No

### Task 018: Split L8 — `adapters/` into `mcp/` and `cli/`

This task makes INV-2 a directory-level fact: the contract is the invocation surface, the CLI is a client of it.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "CLI and MCP produce equivalent results for every registered action".
**Files:**
- `src/adapters/mcp/`, `src/adapters/cli/`
- `tests/acceptance/adapter-parity.test.ts`
**Tests:**
- `AdapterParity_EveryRegisteredAction_ProducesEquivalentResultOnBothSurfaces`
- `AdapterDirection_McpImportingCli_IsRejected`
**Verification:** Split the 27-file adapter layer. The existing parity harness is retargeted, not rewritten. The second test is the structural encoding of INV-2 and is the reason this task is separate from task 019.
**Dependencies:** 017
**Parallelizable:** No

### Task 018a: Extract the conformance suite as its own package

The author's directive. `src/architecture/` is 78 files and 13,785 LOC of first-party enforcement living inside the tree it governs.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-12
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/conformance/{package.json,tsconfig.json,src/,tests/}`
- `tools/audit/conformance-extraction-exceptions.md`
**Tests:**
- `Conformance_AfterExtraction_EveryCensusProducesTheSameVerdict`
- `Conformance_PackageBoundary_HasNoUninvertedEdgeIntoSrc`
**Verification:** Move the 37 non-test modules and their 41 tests into a real package with its own entry point. The blocker is measured and must be inverted, not ignored: **~26 outbound imports** into the core it inspects (`event-store` 6, `config` 5, `registry.js` 4, `review` 3, `contract` 2, `orchestrate` 2, `schemas`, `sdk`). Census modules take their inputs as parameters — a source root, a lexer port, a rule table — instead of importing the subject. Characterize every census verdict before and after; an identical verdict is the acceptance condition. Any edge that cannot be inverted cheaply leaves its module in `src/` and is **recorded as a stated exception**: a partial extraction that is honest beats a circular package that type-checks by accident.
**Dependencies:** 018
**Parallelizable:** No

### Task 019: Move L9 and the residual modules per the mapping table

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `src/runtime/`, `src/install/`, and every residual target named in `tools/audit/layer-map.json`
**Tests:**
- `LayerMap_AfterExecution_EveryMappedDirectoryExistsAtItsTarget`
**Verification:** Execute the remainder of the task 010 map: `runtime/`, `runtimes/`, `agents/`, `capabilities/`, `channel/`, `session/` into `src/runtime/`; the root `src/` installer and renderer toolchain into `src/install/`; and every directory carrying a stated exception to its declared home. The residual set is **enumerated in the map**, not left as "the remainder" — a task whose scope is unspecified cannot be reviewed. `servers/` no longer exists on disk at the end of this task; re-run the task 012a depcruise liveness assertion.
**Dependencies:** 018a
**Parallelizable:** No

### Task 020: Reconcile every path literal invalidated by the core move

Repo-relative literals are the class `tsc` cannot see. They are reconciled as one deliberate task rather than dribbled across the move tasks.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-2, DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `scripts/build-binary.ts`, `scripts/codegen-runtimes.ts`, `scripts/guard-inventory.ts`
- `.exarchos.yml`, `.github/workflows/*.yml`
- `tests/architecture/path-literal-resolution.test.ts`
**Tests:**
- `RepoRoot_EveryComputedRoot_EqualsTheActualRepositoryRoot`
- `PathLiterals_EveryRepoRelativeLiteral_ResolvesOnDisk`
- `EmbeddedBuildIdentity_AfterMove_StillResolvesRepoRoot`
**Verification:** The **first test is the load-bearing one**. The repo-root idiom is `path.resolve(__dirname, '../../../..')` (e.g. `dev-catalog-ref-paths.test.ts:20`), whose correct depth changes when a file moves — and a stale value **still resolves to a real directory** (the parent of the repo, or higher). "Every literal resolves on disk" is therefore structurally blind to exactly the failure this task names; revision 1 proposed only that oracle. Assert instead that each computed root **equals the real repository root** by checking for a sentinel (`.git`, or the root `package.json`). Then scan `**/*.{ts,tsx,mts,mjs,cjs,json,yml,yaml,sh,ps1}` for repo-relative literals and reconcile: `.exarchos.yml`'s `mutation:` adapter path, `collectEmbeddedBuildIdentity(repoRootFromHere())`, `codegenEmbeddedRuntimes`'s `src/runtimes/embedded.ts` output path, the `runtimes:guard` git-diff path, `manifest.json`'s `devEntryPoint`, and every CI path glob.
**Dependencies:** 019
**Parallelizable:** No

### Task 021: Author the `content/` domain skeleton, move the skills, and rescue the live files

`skills/` is **not** a generated tree: it carries 21 non-generated files that revision 1 would have swept into a never-hand-edited directory.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `content/{design,delivery,review,synthesis,continuity,remediation,governance,_shared,harness}/skills/`
- `tests/support/skill-fixtures/`, `tests/support/trigger-tests/`, `tools/skill-validators/`
- `tests/architecture/content-domains.test.ts`
**Tests:**
- `ContentDomains_EverySkill_LivesUnderADeclaredDomain`
- `SkillFixtures_AfterRelocation_AreStillReadByTheirValidators`
**Verification:** Move the 20 skills from `skills-src/` into their capability domains; `references/` subdirectories travel with their `SKILL.md`. **In the same change, relocate the 21 live files out of `skills/`**: `test-fixtures/` (13) and `trigger-tests/` (5) → `tests/support/`, `validate-all-skills.sh` / `validate-frontmatter.sh` / `validate-frontmatter.test.sh` → `tools/skill-validators/`. Their consumers — the validator scripts and `fixtures.jsonl` / `pressure-tests.jsonl` read paths — are updated with them. The `!**/test-fixtures` and `!**/trigger-tests` negations in `package.json files[]` are retired, since the paths they excluded no longer live under a shipped directory.
**Dependencies:** 020
**Parallelizable:** No

### Task 022: Move commands and rules into their capability domains

**Agents are NOT moved here.** Revision 1 treated `agents/*.md` as authored specs; they are **output** of `generate-agents.ts` from `ALL_AGENT_SPECS` in `src/agents/definitions.ts:612`, so moving them into the authoring root would relocate generated files into `content/`.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `content/<domain>/{commands,rules}/`
- `src/build-command-aliases.ts`
**Tests:**
- `ContentDomains_EveryCommandAndRule_LivesUnderADeclaredDomain`
- `CommandAliases_AfterMove_StillDeriveFromCommandFrontmatter`
**Verification:** Move the 18 hand-authored commands and `rm-safety.md` into the domain owning that capability. `src/build-command-aliases.ts:40` reads `commands/<name>.md` frontmatter via `COMMAND_TO_SKILL` to derive aliases — that read path moves in the same change. The **TypeScript agent definitions stay in `src/`**; only their rendered markdown is addressed, by task 026. `SKILL_AUTHORING.md` and the shared references land in `_shared/`.
**Dependencies:** 021
**Parallelizable:** No

### Task 022a: Decide the generator question for commands, rules and binding

These three artifact kinds have **no renderer today**. Revision 1 repinned `plugin.json` at `rendered/commands/` — a path nothing would have produced.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `docs/ARCHITECTURE.md`
- `tests/architecture/artifact-kind-classification.test.ts`
**Tests:**
- `ArtifactKinds_EveryKind_IsClassifiedAuthoredOrGenerated`
- `RenderedTree_EveryDeclaredPath_HasAProducer`
**Verification:** For each of `commands`, `rules`, `binding`, record the decision: introduce a generator (and which), or keep them authored under `content/` and ship from there. The second test is the guard that makes this un-skippable — **a path may not be declared under `rendered/` unless something emits it**. This decision gates tasks 024 and 026.
**Dependencies:** 022
**Parallelizable:** No

### Task 023: Move the harness on-ramps and rescue the shipped git hook

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `content/harness/{runtimes,hooks,binding}/`
- `tools/git-hooks/`
- `vitest.config.ts`
**Tests:**
- `HarnessOnRamps_AfterMove_RuntimeCodegenStillResolves`
- `GitHookSample_AfterRelocation_IsStillCollectedAndPasses`
**Verification:** Move `runtimes/*.yaml`, `hooks-src/hooks.json` and `binding-src/binding.md` into `content/harness/`; the `codegen:runtimes` input path and the `runtimes:guard` diff path move with them. **In the same change, relocate `hooks/pre-push.ship-gate.sample` and `hooks/pre-push.test.ts`** — a hand-authored shipped git hook and its live test — to `tools/git-hooks/`, and retarget the root `vitest.config.ts` `hooks/**/*.test.ts` include. The plugin-root `hooks/hooks.json` **stays** (DR-1 exception): only its *source* moves into `content/harness/`, and it is generated back into place.
**Dependencies:** 022a
**Parallelizable:** No

### Task 024: Teach the renderer to route by artifact kind and flatten

The capability grouping the author chose is only safe because the renderer stops propagating the source-relative path into the output.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "for every authored artifact, the rendered path depends only on its kind and its flat name, never on its domain".
**Files:**
- `src/install/build-skills.ts`
- `tests/unit/install/render-routing.test.ts`
**Tests:**
- `Render_DomainGroupedSource_EmitsFlatContractShapedOutput`
- `Render_ArtifactKind_RoutesToItsOwnRenderedRoot`
**Verification:** `build-skills.ts` currently emits to `join(outDir, runtime, skillRel)` where `skillRel` carries the source-relative path. Change it to route by artifact kind and emit a flat name, so `content/review/skills/mutation-adequacy/` renders to `rendered/skills/<runtime>/mutation-adequacy/SKILL.md`. Characterization first: capture the current rendered tree byte-for-byte, then prove the new renderer reproduces it from the regrouped source.
**Dependencies:** 023
**Parallelizable:** No

### Task 025: Fail closed on flattened-name collisions

Flattening introduces a namespace hazard that does not exist today. Left unguarded it is a silent last-writer-wins overwrite.

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-4
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `src/install/build-skills.ts`
- `tests/unit/install/render-collision.test.ts`
**Tests:**
- `Render_TwoDomainsDeclareSameFlatName_FailsAtBuildTimeNamingBothSources`
- `Render_DistinctNamesAcrossDomains_Succeeds`
**Verification:** Given two domains declare artifacts with the same flattened name, When the renderer runs, Then it fails at build time with both source paths named. The second test proves the guard does not over-trigger on the legitimate case.
**Dependencies:** 024
**Parallelizable:** No

### Task 026: Emit to `rendered/`, repin every external contract, and keep every consumer resolving

Revision 1 repointed three of seven shipped directories and left four as dead paths, repinned `plugin.json` at a path nothing produces, and never touched the fixed-root consumers.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4, DR-12
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `rendered/`
- `.claude-plugin/plugin.json`, `manifest.json`, `package.json`
- `src/install-skills.ts`, `src/projection-containment.ts`, `src/runtime/agents/generate-agents.ts`
**Tests:**
- `PluginManifest_DeclaredPaths_ResolveAndHaveAProducer`
- `Manifest_EveryComponentSource_ExistsOnDisk`
- `FilesArray_EveryShippedDirectory_ResolvesAfterTheMove`
- `InstallSkills_RootProbes_ResolveUnderTheNewLayout`
**Verification:** Repoint `plugin.json`'s `commands`/`skills`/`agents`, `manifest.json`'s component `source`/`target` pairs (**including `scripts`, installed as a core component**), and **all seven** `files[]` directories (`agents, commands, skills, command-aliases, rules, scripts, hooks`) — leaving four dead silently drops them from the published npm package. `generate-agents.ts` emits the new prefix into `manifest.agents`. Retarget `src/install-skills.ts`'s fixed root probes (`:275,280,290,430,433,439`) and `src/projection-containment.ts`'s projection inventory in the same change, or standalone install and the containment gate break. `rendered/commands/` is declared **only if** task 022a gave commands a generator. The harness dot-directories stay generated in place.
**Dependencies:** 025
**Parallelizable:** No

### Task 027: Consolidate the three render guards into one

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4, DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `src/install/render-guard.ts`
- `package.json`
- `tests/architecture/render-guard.test.ts`
**Tests:**
- `RenderGuard_DriftInRenderedTree_FailsClosed`
- `RenderGuard_DriftInHarnessDotDirectory_FailsClosed`
- `RenderGuard_ConfiguredScope_MatchesNonEmptyFileSet`
**Verification:** Replace `skills:guard`, `hooks:guard` and `runtimes:guard` with one guard that re-renders `content/` and diffs **both** `rendered/` and the harness dot-directories. The third test is the DR-11 liveness assertion: a consolidated guard that matches nothing would be strictly worse than the three it replaces.
**Dependencies:** 026
**Parallelizable:** No

### Task 028: Fresh-clone install smoke test

Repinning `plugin.json` is a sanctioned clean break. Only an end-to-end install proves it landed.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-4, DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tests/acceptance/fresh-install.test.ts`
- `.github/workflows/fresh-install-smoke.yml`
**Tests:**
- `FreshInstall_FromCleanClone_ResolvesSkillsCommandsAndAgents`
- `FreshInstall_RenderedSkill_IsDiscoveredByAHarness`
- `FreshInstall_PluginHooks_LoadExactlyOnce`
**Verification:** From a clean clone, install the plugin and assert every path declared in `plugin.json` and `manifest.json` resolves, and that a rendered skill is discovered at the flat location a harness expects. The third test covers the failure `.claude-plugin/packaging-policy.json:53` warns about: `hooks/hooks.json` is auto-loaded from the well-known plugin root, so declaring it in `plugin.json` **as well** makes every hook fire twice. Only an end-to-end install can catch a wrong flatten, a wrong repin, or a double-registered hook — each produces a tree that looks correct on disk.
**Dependencies:** 027
**Parallelizable:** No

### Task 029: Establish the `tests/` skeleton, tsconfig and runner retarget

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tests/tsconfig.json`, `vitest.config.ts`
- `tests/architecture/test-tree-contract.test.ts`
**Tests:**
- `TestTree_EveryTierDirectory_IsCollectedByExactlyOneProject`
**Verification:** Create `tests/{unit,integration,process,outcome,e2e,smoke,migration,benchmarks,evals,support}/` and a real `tests/tsconfig.json` so the tree is typechecked. Retarget the three vitest projects, the `bun:sqlite` alias and `setupFiles`. A directory collected by two projects, or by none, fails.
**Dependencies:** 028
**Parallelizable:** No

### Task 030: Move the co-located core tests

907 files — and, measured 2026-08-13, **not** the mechanical operation this task was written as.

> **Premises corrected before execution (measured against `worktree-exarchos-overhaul-staging`).**
>
> 1. **The move is not purely mechanical.** 138 of the 907 movers derive a filesystem path from their own location (`import.meta.dirname`, `__dirname`, `fileURLToPath(import.meta.url)`) across 291 occurrences. Two kinds hide inside that number, and only one is a depth change. A test whose anchor reaches the **repo root** (`path.resolve(__dirname, '../..')`) just needs more `../`. A test whose anchor IS **its own subject** does not: `src/adapters/adapter-direction.test.ts:30` reads `const ADAPTERS = dirname(fileURLToPath(import.meta.url))` because that directory *is* `src/adapters/`. Relocated, it scans the test directory, finds nothing, and **passes** — the third time this workflow has turned a guard vacuous rather than red. Do not classify these by hand: compute what each expression resolved to **before** the move and rewrite so it resolves to the **same absolute path after**, which covers both kinds uniformly.
> 2. **Rewrite on the AST, never a regex.** `src/architecture/dev-catalog-content.test.ts` carries `import.meta.url` inside template strings at `:184`, `:193`, `:402` and `:448` — those are code samples the test asserts *on*, not expressions to retarget. `tools/audit/measure-test-inventory.mjs` already parses with the TypeScript compiler; reuse that.
> 3. **Closure runs in both directions.** `src/__tests__/parity-harness.ts` is a traveler, and `tests/core/parity-actions.ts` — outside the move set — imports it. Importers that stay must be rewritten too, counting type-only edges.
> 4. **`protected-suites.json` does not exist, and its guard is dead.** The real path is `scripts/audit/protected-suites.json`, not `tools/audit/`; the file is absent entirely; `PROTECTED_ROOTS` was already retargeted to `['src', 'tools/conformance/src']` in `61fa6d938`, so the `generatedFrom: servers/exarchos-mcp/src` premise is spent; and `scripts/audit/check-protected.mjs` is referenced by **neither CI nor `package.json`**. It exits 2 fail-closed on the missing inventory, but nothing invokes it. The work here is to add `tests/` to `PROTECTED_ROOTS` and give the guard a live host.
> 5. **The relocation ledger is not a new file.** It is `relocations[]` inside `tools/audit/test-inventory-baseline.json` (5 entries as of `e8520ed`). The generator re-emits it **empty** on every run, so a wholesale regen silently discards it — append, and refuse to write if any file disappeared.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tests/unit/`, `tests/integration/`
- `scripts/audit/check-protected.mjs`, `scripts/audit/protected-suites.json`
- `tools/audit/test-inventory-baseline.json` (`relocations[]`)
**Tests:**
- `TestInventory_AfterCoreTestMove_EveryBaselineIdReconcilesViaTheMap`
- `ProtectedSuites_AfterMove_EveryPinnedPathResolves`
- `SelfAnchoredTest_AfterMove_StillResolvesToItsSubject`
**Verification:** Move the 907 test files under `src/` into `tests/`, mirroring the layer structure, rewriting relative imports **and** self-anchored path expressions in the same change, and appending every old→new pair to the relocation ledger. Reconcile against the task 002 oracle **here**, not three tasks later — localizing a loss of 907 files' worth of ids is far cheaper now. **Verify per-test, not by count:** capture `vitest --reporter=json` before, map old→new paths, and require every test id to keep its status. A test that went vacuous keeps the totals identical, so a pass count cannot see it — which is precisely the failure premise 1 describes.
**Dependencies:** 029
**Parallelizable:** No

### Task 031: Move the remaining co-located tests

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tests/unit/install/`, `tests/unit/tools/`
**Tests:**
- `TestInventory_AfterRemainingColocatedMove_NoIdIsLost`
**Verification:** Move the 61 co-located tests under the former root `src/` and the 77 under `scripts/`. The `*.test.sh` bash suites move with their subjects and keep their runner wiring.
**Dependencies:** 030
**Parallelizable:** No

### Task 032: Dissolve the four remaining test roots

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tests/{process,outcome,e2e,smoke,migration,support}/`
**Tests:**
- `TestRoots_AfterConsolidation_OnlyTestsDirectoryRemains`
**Verification:** Fold `test/` (fixtures, migration, process, setup, e2e, smoke), the old `tests/outcome/`, and the former nested `test/`+`tests/` roots into the single tree. `test/setup/global.ts`, the fixtures and the `__snapshots__` directory move with their consumers; the 103 `docs/` references inside `snapshots.test.ts.snap` are reconciled here.
**Dependencies:** 031
**Parallelizable:** No

### Task 033: Move benchmarks, eval suites and the eval graders

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5, DR-7
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks true, characterizationRequired true. SLAs: benchmark baselines unchanged within noise.
**Files:**
- `tests/benchmarks/`, `tests/evals/`
- `.github/workflows/{eval-gate,benchmark-gate}.yml`
**Tests:**
- `EvalGraders_AfterMove_AreStillCollectedByTheUnitProject`
- `CapturedEvalRuns_AfterMove_RemainExcludedFromCollection`
**Verification:** Move `benchmarks/` (86 files, of which 13 are tests), root `evals/` (31 files, 0 tests) and the executable graders under `docs/evals/` (114 files, 9 tests) — **directory counts, not test counts**; the oracle tracks only the tests among them. The `docs/**/runs/**` exclusion moves with them: captured run artifacts use a `process.exit` harness and must never reach a vitest worker. `baselines.json` and both gate workflows are retargeted.
**Dependencies:** 032
**Parallelizable:** No

### Task 034: Reconcile the test inventory after consolidation

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-5
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tests/architecture/test-inventory.test.ts`
**Tests:**
- `TestInventory_AfterFullConsolidation_ReconcilesAgainstBaseline`
- `TestInventory_UnexplainedLoss_NamesTheMissingFileAndBlocks`
**Verification:** Reconcile the post-move inventory against the task 002 oracle across all five former roots. Any delta is explained (a deliberate deletion recorded in task 009) or blocks. The second test proves the reconciliation names the missing source rather than reporting a count mismatch.
**Dependencies:** 033
**Parallelizable:** No

### Task 035: Retire the co-location rule from the agent instructions

`CLAUDE.md` and `AGENTS.md` currently mandate the exact convention this workflow retires. Left stale, they would misdirect every future agent — including the ones this repository dispatches on itself.

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-5, DR-10
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `CLAUDE.md`, `AGENTS.md`
- `tests/architecture/agent-instructions.test.ts`
**Tests:**
- `AgentInstructions_StatedTestConvention_MatchesTheEnforcedLayout`
**Verification:** Replace "Co-located tests — `foo.test.ts` beside `foo.ts`" with the centralized convention and the directory contract. The test ties the prose to the enforced layout, so the two cannot drift again.
**Dependencies:** 034
**Parallelizable:** Yes

### Task 036: Consolidate repo automation into `tools/`

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/{audit,eslint-rules,renovate-config,migrations,release}/`
- `package.json`, `eslint.config.js`, `renovate.json`, `renovate-config.js`
**Tests:**
- `Tools_EveryNpmScriptPath_ResolvesUnderTools`
**Verification:** Move `scripts/` (151 files), `eslint-rules/`, `renovate-config/` and `migrations/` under `tools/`. Every npm script, CI step and eslint config path is updated in the same change. `scripts/get-exarchos.{sh,ps1}` keeps a stable published location or its download URL is updated wherever it is referenced.

**Comment-hygiene fold (see Cross-spec sequencing):** the comment-hygiene Stage 1 modules land in `scripts/lib/` before this refactor begins and move here with everything else — `comment-prose.mjs`, `comment-policy.mjs`, `comment-classifier.mjs`, their tests, and `scripts/__fixtures__/comment-hygiene/`. `eslint-rules/comment-content.js` moves with `eslint-rules/`. None of them is a live guard at this point (Stage 1 ships nothing enabled), so this is a pure relocation with no wiring to retarget. This is also the destination for the Stage 2 gate primaries: they are authored under `tools/` directly rather than created in `scripts/` and moved afterwards. `.exarchos/comment-policy.json` does **not** move — `.exarchos/` is a classified dot-directory that stays put.
**Dependencies:** 035
**Parallelizable:** No

### Task 037a: Establish and verify the external documents destination

Revision 1 deleted hundreds of tracked documents while naming no destination, no transfer mechanism and no way to prove preservation.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tools/audit/prose-manifest.json`
- `docs/ARCHITECTURE.md`
**Tests:**
- `ProseManifest_EveryRelocatedFile_IsPresentAtTheDestinationWithAMatchingDigest`
**Verification:** Name the destination repository, its symlink-mount-compatible layout and the transfer mechanism. Emit a content manifest with a per-file digest for every document scheduled for removal, transfer, then reconcile destination against manifest. **Deletion in task 037 is gated on this reconciliation passing** — preservation must be provable before it is irreversible.
**Dependencies:** 036
**Parallelizable:** No

### Task 037: Execute the prose exodus

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-7
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `docs/`
- `tests/architecture/markdown-inventory.test.ts`
**Tests:**
- `MarkdownInventory_AfterExodus_NoProseRemainsOutsideContentAndDocs`
- `MarkdownInventory_EveryRemovedPath_HadZeroLiveReferences`
**Verification:** Remove the prose subtrees named in DR-7. **Gated on both the task 004 census (zero live references) and the task 037a destination reconciliation (proven preservation)** — revision 1 declared "census before deletion" as a principle but gave this task no dependency on the census at all. Live links are the scope; dated historical records referencing removed paths are explicitly out of scope.
**Dependencies:** 004, 037a
**Parallelizable:** No

### Task 038: Re-home the non-prose content under `docs/`

`docs/` is not all prose. This task exists because treating it as prose is precisely how live data gets deleted.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tests/evals/`, `src/contract/schemas/`, `docs/assets/`
- `.exarchos/invariants.md`
**Tests:**
- `InvariantCatalog_EveryReferenceKey_ResolvesOnDisk`
- `DocsAssets_EveryRetainedAsset_HasALiveReferent`
**Verification:** Datasets and graders to `tests/evals/` (with task 033), `docs/schemas/` into `src/`, and `docs/assets/` (21 binaries) to wherever its live referents are. The `.exarchos/invariants.md` `references:` keys pointing at `docs/architecture/invariants/references/*.md` are updated and asserted resolvable — a dangling catalog reference degrades the Phase 0 constraint-anchoring step of this repository's own `/ideate`.
**Dependencies:** 037
**Parallelizable:** No

### Task 039: Reduce `documentation/` to a VitePress skeleton under `docs/`

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7, DR-1
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `docs/.vitepress/`, `docs/index.md`, `docs/public/`
- `.github/workflows/docs.yml`, `package.json`
**Tests:**
- `Documentation_AfterReduction_VitePressStillBuilds`
**Verification:** The author has stated the site is exceptionally stale and needs a full rewrite; this task keeps only what makes VitePress build — config, an index, and the `public/` staging the bootstrap installers are copied into at deploy time. The 46 stale pages are removed. `docs:dev`/`docs:build`/`docs:preview` scripts and `docs.yml` are retargeted.
**Dependencies:** 038
**Parallelizable:** No

### Task 040: Give the layer census a path-aware edge model

The panel proved the current model **cannot express** the rules DR-3 assigns it. This is a model change, not the "retarget" revision 1 scoped.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-3
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "for any declared id set, an edge is intra-layer iff both modules resolve to the same longest-matching id".
**Files:**
- `tools/conformance/src/layer-boundaries-seam.ts`
- `tools/conformance/tests/layer-boundaries-seam.test.ts`
**Tests:**
- `LayerOf_ModuleUnderNestedLayerId_ResolvesToTheLongestMatch`
- `LayerCensus_McpImportingCli_ReportsForbiddenImportNamingBothEnds`
- `LayerCensus_RootFile_ContributesEdgesUnderTheStatedPolicy`
**Verification:** `layerOf()` resolves to the **longest matching declared layer id** instead of the first path segment; the declared-id set threads through `detectLayerEdges`, `scanLayerEdges` and `runLayerBoundaryCensus`; the `isRootFile` exclusion is replaced by a stated policy so `registry.ts` (4,636 LOC) is no longer invisible. The second test is the acceptance condition — it is **structurally impossible** today, because `adapters/mcp → adapters/cli` resolves to `adapters → adapters` and is discarded by the intra-layer skip. Measured scope: ~50 LOC across two files, **zero external consumers** (the symbols appear only in the seam and its own test). Known limitation to record: hand-rolled `resolveTarget` does not resolve directory-index imports — measured exposure is **1 extensionless relative import** in the whole core.
**Dependencies:** 039
**Parallelizable:** No

### Task 040a: Preserve the declaration and SDK seams through the extraction

`layer-boundaries-seam.ts` carries **three** censuses. Revision 1 scoped only the layer allowance table and would have silently dropped the other two.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-3
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/conformance/src/{declaration-seam,sdk-seam}.ts`
- `tools/conformance/tests/`
**Tests:**
- `DeclarationSeam_AfterMigration_StillDetectsAStorageSiteViolation`
- `SdkSeam_AfterMigration_StillDetectsAnUnownedSeamImport`
- `BothSeams_VacuityCheck_FailsOnAnEmptyRuleSet`
**Verification:** `DECLARATION_SEAM` (~380 LOC) and `SDK_SEAM_BOUNDARY` (~338 LOC) both encode exact module paths that the core move invalidates. Migrate each rule's paths and keep its vacuity check, so neither can pass by matching nothing. Characterize both verdicts before and after.
**Dependencies:** 040
**Parallelizable:** No

### Task 041: Promote the governed layer set incrementally, and settle the cycle-gate overlap

The census governs **12 peripheral leaves** today and deliberately leaves the tangled core ungoverned. Promoting the full chain is first-time governance of the hard part, not a retarget.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-3
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tools/conformance/src/layer-allowances.ts`
- `tools/conformance/tests/layer-rules-bite.test.ts`
- `tools/audit/cycle-gate.ts`
**Tests:**
- `LayerRule_SeededViolation_FailsAndNamesTheRule`
- `LayerAllowance_PhantomCover_FailsAsStale`
- `CycleGate_PhantomBaselineEntry_FailsClosed`
**Verification:** Admit layers to the governed set **one at a time**, each step ending with `STALE_LAYER_ALLOWANCE` clean — a big-bang promotion surfaces the whole core's finding set at once and invites a blanket allowance that governs nothing. Seed a violation per declared rule and assert the census fails naming it. Then settle the overlap: `depcruise` ships `depcruise-baseline` and `--ignore-known` (verified present), but **no reporter reports "this rule matched nothing"**, so the phantom-entry tooth is genuinely bespoke — either `cycle-gate.ts` demonstrates it or the layering-cycle leg is replaced. **`import-cycles.ts` is not deleted wholesale**: it also implements an independent forbidden-runtime-edge registry with its own stale-rule ratchet.
**Dependencies:** 040a
**Parallelizable:** No

### Task 042: Retarget the audit configs and assert glob liveness

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-3, DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/audit/{knip-allowlist,cycle-baseline,protected-suites}.json`
- `knip.json`, `eslint.config.js`, `eslint.envelopes.config.js`
- `tests/architecture/guard-liveness.test.ts`
**Tests:**
- `GuardLiveness_AfterRetarget_EveryGuardMatchesNonEmptySet`
- `GuardLiveness_ComparedToBaseline_NoGuardSilentlyLostItsScope`
**Verification:** Retarget every audit config onto the new tree and reconcile against the task 003 baseline. Given a guard's path config is retargeted, When it would match zero files, Then the gate fails closed. This is the highest-probability silent failure in the entire workflow — a guard that quietly stops matching reports success forever.

**Comment-hygiene fold (see Cross-spec sequencing):** this task absorbs the ESLint scope widening that `docs/specs/2026-08-11-comment-hygiene-enforcement.md` tasks 017 and 018 would otherwise perform. Widening lint reach onto the new tree is exactly this task's job, and doing it separately would measure a baseline over six roots that no longer exist. Two things that spec establishes still apply here and are easy to lose: widening requires changing **both** the flat-config `files` key **and** the `lint` script's CLI glob — the glob currently bounds the run to `servers/exarchos-mcp/src/**/*.ts` regardless of config — and the pre-existing ruleset's findings over the newly-linted directories are **recorded as a baseline before the scope widens**, because those directories have never been linted and a zero-new-findings outcome cannot be assumed. The widened step is hosted on a CI lane whose path filter covers the widened surface. `docs/evals/**/runs/**` (by then `tests/evals/**/runs/**`) stays excluded as captured evidence.
**Dependencies:** 041
**Parallelizable:** No

### Task 043: Assert the top-level allow-list and the directory contract

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-1
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tests/architecture/top-level-contract.test.ts`
**Tests:**
- `TopLevel_ContainsExactlyTheAllowedEntries`
- `TopLevel_UnlistedEntryAppears_FailsWithItsName`
- `TopLevel_OnABuiltTree_StillPasses`
**Verification:** Assert an explicit allow-list: the six directories (`src`, `content`, `rendered`, `tests`, `tools`, `docs`), the seven classified dot-directories (`.github`, `.claude`, `.claude-plugin`, `.codex`, `.cursor`, `.opencode`, `.exarchos`), the plugin-root `hooks/` exception, the tracked root files, **and the gitignored-but-present set** — `dist/`, `node_modules/`, `coverage/`, `.worktrees/`, `.serena/`, `.azurite/`. The third test is the one that makes this usable: revision 1 specified a filesystem assertion that omitted `dist/`, so it would have failed on every developer machine and every built tree. A test that only passes on a pristine clone is not an enforcement mechanism.
**Dependencies:** 042
**Parallelizable:** Yes

### Task 044: Assert the tree and the published layer set agree

This is the requirement that stops the tree and `docs/system-design.html` drifting apart again — the drift that motivated the whole workflow.

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-2, DR-10
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tests/architecture/layer-agreement.test.ts`
- `docs/ARCHITECTURE.md`
**Tests:**
- `LayerAgreement_DirectorySet_MatchesTheDeclaredMapping`
- `LayerAgreement_UndocumentedLayerDirectory_Fails`
**Verification:** Parse the **declared 11 → 9 mapping** from `docs/ARCHITECTURE.md` and compare it to the directory set under `src/`. Revision 1 asserted equality between the directory set and the *nine published layer names* — impossible, because the target tree has ten layer directories (L5 splits into `contract`/`dispatch`) plus the `install/` peer. Agreement is checked in **both** directions against the mapping: an undocumented directory fails, and a mapped entry with no directory fails.
**Dependencies:** 043
**Parallelizable:** No

### Task 045: Add the case-exactness and entry-point gate

The failure mode that is invisible on Windows and fatal on a case-sensitive host. `tsc --noEmit` structurally cannot catch it and `core.ignorecase=true` masks it locally.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-11
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired false. Properties: "a stored or compared path is POSIX-normalized for every input separator form".
**Files:**
- `tests/architecture/case-exactness.test.ts`
**Tests:**
- `EntryPoints_EveryDeclaredPath_ResolvesWithExactCase`
- `PathHandling_EveryStoredPath_IsPosixNormalized`
**Verification:** Read every declared entry point — `package.json` `bin`, `main`, `files[]`, `plugin.json` paths, `manifest.json` `bundlePath`/`devEntryPoint`, vitest `setupFiles`, the eslint and knip config paths — and check each against a **case-sensitive** directory listing. Assert INV-16: paths are built with `path.join` and POSIX-normalized when stored or compared, never separator-concatenated.
**Dependencies:** 044
**Parallelizable:** No

### Task 046: Phase 1 terminal gate — clean clone on Linux and Windows

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks true, characterizationRequired false. SLAs: full-suite wall clock within the pre-refactor envelope.
**Files:**
- `.github/workflows/ci.yml`
**Tests:**
- `CleanClone_OnLinuxAndWindows_BuildsTypechecksAndPassesEveryGate`
**Verification:** From a clean clone on both platforms: `npm ci`, `npm run build`, `npm run typecheck`, `npm run test:all`, the consolidated render guard, `lint:invariants`, `lint:envelopes`, the knip-diff gate and the cycle gate. Reconcile the test inventory against task 002 one final time. Phase 1 lands as **one merge commit**, so a bad structural landing is recovered by reverting it.
**Dependencies:** 045
**Parallelizable:** No

## Phase 2 — Complexity, locality and documentation

### Task 047: Snapshot persisted identifiers and registered action names

Every decomposition that follows is verified against this snapshot. A changed hash input or a dropped registration compiles cleanly, so only a snapshot catches it.

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-9
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "deterministic id and hash inputs produce identical output for identical input across the decomposition".
**Files:**
- `tests/architecture/identifier-stability.test.ts`
- `tools/audit/registered-actions-snapshot.json`
**Tests:**
- `PersistedIdentifiers_AcrossDecomposition_AreStable`
- `RegisteredActions_DroppedRegistration_FailsTheSnapshot`
**Verification:** Snapshot every persisted event-type identifier and version, every deterministic id/hash input, and the full registered composite-tool and action-name set (INV-5d: four visible tools, each with an action discriminator). The second test proves the snapshot bites when a registration is removed.
**Dependencies:** 046
**Parallelizable:** No

### Task 048: Decompose `registry.ts`

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-9
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks false, characterizationRequired true. Properties: "the compiled contract's wire projection is identical before and after".
**Files:**
- `src/contract/registry/`
- `tests/unit/contract/registry/`
**Tests:**
- `Registry_AfterDecomposition_WireProjectionIsByteIdentical`
**Verification:** 4,636 lines. Decompose into cohesive modules along the action-descriptor and CLI-hint seams already present in the file. INV-2 is the acceptance condition: the CLI must remain a client of the same compiled contract, equal **by construction** — a decomposition that forks the derivation path violates the invariant even if every test passes. No existing test is rewritten to accommodate the split.

**Comment-hygiene fold (see Cross-spec sequencing):** this file is a named remediation target of `docs/specs/2026-08-11-comment-hygiene-enforcement.md` task 029. No extracted module carries a planning ordinal in a comment — `DR-<n>`, `task <n>`, `T<n>`, `wave <n>`, `slice <n>`, `epic #<n>`, `INV-<n>`, or a `docs/{specs,designs,plans}/…` path. Each such comment is rewritten to state its constraint in words, or deleted where the ordinal was its entire content; deletions are listed in the PR description. Verified by running that spec's Stage 1 classifier over the decomposed output. `INV-<n>` is included: state the invariant's substance, and cite the ordinal in `docs/ARCHITECTURE.md` instead.
**Dependencies:** 047
**Parallelizable:** Yes

### Task 049: Decompose `sqlite-backend.ts`

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-9
**Testing Strategy:** exampleTests true, propertyTests true, benchmarks true, characterizationRequired true. Properties: "concurrent same-stream appends serialize; a genuine expected-version mismatch still surfaces as a conflict". SLAs: event-append p99 unchanged.
**Files:**
- `src/storage/sqlite/`
- `tests/integration/storage/`
**Tests:**
- `SqliteBackend_AfterDecomposition_MultiProcessAppendStillSerializes`
**Verification:** 3,009 lines. INV-7's two-tier serialization is a **closed** claim (EFF-001), so the existing three-process contention fixture is the acceptance oracle and must still fail if `BEGIN IMMEDIATE` is weakened, the startup repair is disabled, or a no-op driver is substituted. Benchmarks apply: this is the event-store hot path.

**Comment-hygiene fold (see Cross-spec sequencing):** this file is a named remediation target of `docs/specs/2026-08-11-comment-hygiene-enforcement.md` task 030. No extracted module carries a planning ordinal in a comment; each is rewritten to state its constraint in words, or deleted where the ordinal was its entire content, with deletions listed in the PR description. Verified by that spec's Stage 1 classifier. This file's serialization rationale is dense and load-bearing — preserve the reasoning and drop only the ordinal.
**Dependencies:** 047
**Parallelizable:** Yes

### Task 050: Decompose the two composite-tool surfaces

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-9
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks true, characterizationRequired true. SLAs: view materialization unchanged.
**Files:**
- `src/workflow/tools/`, `src/verbs/views/tools/`
- `tests/integration/workflow/`, `tests/integration/views/`
**Tests:**
- `CompositeTools_AfterDecomposition_EveryActionStillRegistersAndDispatches`
**Verification:** `workflow/tools.ts` (2,062) and `views/tools.ts` (2,286). Both are action-discriminated composite surfaces (INV-5d), so the decomposition splits per action family while the registered action set stays byte-identical against the task 047 snapshot. The `next_actions` carrier shape (INV-5b) is unchanged.

**Comment-hygiene fold (see Cross-spec sequencing):** both files are named remediation targets of `docs/specs/2026-08-11-comment-hygiene-enforcement.md` task 029. No extracted module carries a planning ordinal in a comment; each is rewritten to state its constraint in words, or deleted where the ordinal was its entire content, with deletions listed in the PR description. Verified by that spec's Stage 1 classifier. `workflow/tools.ts:52` is one of that spec's verbatim kill fixtures, so it is expected to be rewritten here.
**Dependencies:** 047
**Parallelizable:** Yes

### Task 051: Decompose the two tooling hotspots

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-9
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `tools/audit/guard-inventory/`, `src/install/build-skills/`
**Tests:**
- `GuardInventory_AfterDecomposition_ReportsTheSameInventory`
- `BuildSkills_AfterDecomposition_RendersAByteIdenticalTree`
**Verification:** `guard-inventory.ts` (2,751) and `build-skills.ts` (2,245, already modified by tasks 024–025). Both have a byte-comparable output, which makes them the cheapest hotspots to verify: render or report before and after and diff.

**Comment-hygiene fold (see Cross-spec sequencing):** both files are named remediation targets of `docs/specs/2026-08-11-comment-hygiene-enforcement.md` task 030. No extracted module carries a planning ordinal in a comment; each is rewritten to state its constraint in words, or deleted where the ordinal was its entire content, with deletions listed in the PR description. Verified by that spec's Stage 1 classifier. That spec singles out dense header essays for individual handling rather than batch rewriting — `guard-inventory.ts` qualifies, so preserve its reasoning and drop only the ordinal.
**Dependencies:** 047
**Parallelizable:** Yes

### Task 052: Assert the locality rule

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-2, DR-9
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `tests/architecture/locality.test.ts`
**Tests:**
- `Locality_NoDirectoryHoldsMoreThanTwentyFiveNonTestFilesAtItsOwnLevel`
- `Locality_DeclarativeBreadthExemption_IsExplicitlyPredicated`
**Verification:** Assert no directory under `src/` holds more than 25 non-test files at its own level — the rule that keeps the former 83-file flat `orchestrate/` from reappearing. The exemption predicate is explicit and testable, not an ad-hoc judgment; `event-store/schemas.ts` (4,093 lines, declarative Zod source) is contents-unchanged under it.
**Dependencies:** 048, 049, 050, 051
**Parallelizable:** No

### Task 053: Retarget dead-code detection and drive the allowlist to empty

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-8
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `knip.json`, `tools/audit/knip-allowlist.json`
**Tests:**
- `DeadCode_AfterRetarget_DetectorCoversTheNewTree`
- `DeadCode_MoveIntroducedFinding_IsResolvedNotAllowlisted`
**Verification:** The two workspace blocks in `knip.json` collapse to one and are retargeted onto `src/`, `tools/`, `tests/` and `content/`. Findings introduced by the moves are **resolved, not allowlisted** — the second test is what stops the refactor quietly re-inflating the ratchet it just emptied.
**Dependencies:** 052
**Parallelizable:** No

### Task 054: Rewrite the repository documentation

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-10
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `ONBOARDING.md`
- `docs/ARCHITECTURE.md`, `docs/system-design.html`
**Tests:**
- `Documentation_EveryStatedCommand_Executes`
- `Documentation_EveryStatedRule_IsOneThatIsEnforced`
- `Documentation_NoFileRetainsARemovedPath`
**Verification:** Rewrite **all five** root instruction files against the six-directory tree — revision 1 required rewriting `CLAUDE.md` and `AGENTS.md` in DR-10 but scheduled only a single-rule edit to one of them, leaving both stating a retired layout to every future agent. `docs/ARCHITECTURE.md` states the directory contract, the 11 → 9 layer mapping, the one-way rule, the per-artifact-kind authored/generated classification with its committed-artifacts rationale, the plugin-root `hooks.json` exception, and the dot-directory classification. `system-design.html`'s L1–L9 section is reconciled with the real directory names. The second test is the anti-drift condition: documentation may only state rules that DR-1, DR-2, DR-3 or DR-12 actually enforces.
**Dependencies:** 053
**Parallelizable:** Yes

### Task 055: Add per-directory READMEs and assert coverage

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-1, DR-10
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `src/README.md`, `content/README.md`, `rendered/README.md`, `tests/README.md`, `tools/README.md`, `docs/README.md`
**Tests:**
- `Readmes_EveryTopLevelDirectory_HasOne`
**Verification:** Each README states what belongs in that directory and what does not. `rendered/README.md` states explicitly that the tree is generated and must never be hand-edited. The test **enumerates directories** rather than hard-coding a count, so a seventh directory cannot be added without a README.
**Dependencies:** 053
**Parallelizable:** Yes

### Task 056: Phase 2 terminal gate

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-11
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks true, characterizationRequired false. SLAs: every benchmark within its pre-refactor envelope.
**Files:**
- `.github/workflows/ci.yml`
**Tests:**
- `Phase2_CleanClone_AllGatesGreenOnLinuxAndWindows`
- `Phase2_PersistedIdentifiers_MatchTheTask047Snapshot`
**Verification:** Clean-clone verification on both platforms, the full gate set, the final inventory reconciliation, and the identifier/action-name snapshot comparison. **Dogfooding continuity is asserted here:** a workflow initialized before Phase 1 rehydrates afterward with its recorded artifact paths resolving and its phase unchanged. Phase 2 lands as a second merge commit.
**Dependencies:** 054, 055
**Parallelizable:** No

### Task 057: Reconcile the invariants catalog references — including after decomposition

The `references:` keys name **source and test** paths, not just docs, and are asserted live by `dev-catalog-ref-paths.test.ts`. Revision 1 left that test red for 26 tasks and then re-broke it in Phase 2 with no follow-up.

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-12
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired true.
**Files:**
- `.exarchos/invariants.md`
- `tools/conformance/tests/dev-catalog-ref-paths.test.ts`
**Tests:**
- `InvariantCatalog_EveryReferenceKey_ResolvesOnDisk`
- `InvariantCatalog_AfterHotspotDecomposition_StillResolves`
**Verification:** Update every `references:` key that names a moved file — INV-7 alone cites `event-store/atomic-appender.ts`, `storage/sqlite-backend.ts` and `test/process/multi-process-append.test.ts`. Run **after** the Phase 2 decompositions (048–051), because task 049 splits `sqlite-backend.ts` into `src/storage/sqlite/` and re-breaks the key. A dangling catalog reference silently degrades the Phase 0 constraint-anchoring step of this repository's own `/ideate`.
**Dependencies:** 048, 049, 050, 051
**Parallelizable:** Yes

### Task 058: Assert every governance and packaging surface is live

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-12
**Testing Strategy:** exampleTests true, propertyTests false, benchmarks false, characterizationRequired false.
**Files:**
- `.github/CODEOWNERS`
- `tools/conformance/src/governance-liveness.ts`
- `tools/conformance/tests/governance-liveness.test.ts`
**Tests:**
- `Codeowners_EveryPattern_MatchesAtLeastOneTrackedFile`
- `FilesArray_EveryEntry_ExistsOnDisk`
- `ManifestComponents_EverySource_ExistsOnDisk`
- `GovernanceLiveness_StalePattern_FailsClosed`
**Verification:** `CODEOWNERS` owns `servers/exarchos-mcp/`, `scripts/`, `skills/` and `commands/` — every one relocated by this workflow — and it is **extensionless**, so it must be enumerated by name rather than matched by an extension-filtered glob. Without this, ownership silently collapses to the `*` fallback and every review gate on those paths disappears. The same census covers `files[]`, `manifest.json` components and `protected-suites.json`, and is run at every phase boundary.
**Dependencies:** 057
**Parallelizable:** No

### Parallelization

**The critical path is long and mostly sequential by necessity.** Structural refactors serialize: each move invalidates the configuration the next depends on, and Phase 1's reviewability rests on rename-detectable diffs that parallel edits to the same files would destroy.

**Genuinely parallel groups:**

- **Phase 0 fan-out after 001:** tasks 001a, 003, 004, 005 run in parallel (disjoint files — benchmark baseline, guard baseline, census, config schema). 007 and 008 join once 004 lands.
- **Phase 2 decomposition wave:** tasks **048, 049, 050, 051** are the widest parallel group — four independent hotspots in four disjoint directories, all gated on the 047 snapshot. This is where worktree dispatch pays.
- **Phase 2 documentation:** 054 and 055 run in parallel after 053; 057 joins after the decomposition wave.

**Serial spine:** 001 → 002 → [Phase 0 completes] → 010 → 011 → 011a → 012 → 012a → 013 → … → 020 (core + conformance extraction) → 021 → … → 028 (content/rendered) → 029 → … → 035 (tests) → 036 → 037a → 037 → … → 039 → [Phase 1 lands] → 040 → 040a → 041 → 042 → 043 → 044 → 045 → 046 → 047 → [048|049|050|051] → 052 → 053 → [054|055] → 057 → 058 → 056.

**Not parallel-safe, corrected from revision 1:** tasks 043 and 044 were listed as a parallel group while 044 declares a dependency on 043. They are sequential. Tasks 011, 020, 026, 036 and 042 all touch `package.json` or CI YAML and must never be dispatched to concurrent worktrees.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Every revision-1 HIGH gap is either fixed or explicitly answered in `### Corrected findings`
- [ ] No task depends on a task that lands after it; Phase 0 fully precedes Phase 1
- [ ] Every deletion task depends on the census (004) and, for prose, the destination reconciliation (037a)
- [ ] Open questions resolved (`content/` grouping, `install/` placement) or explicitly scheduled (`evals/` and `evals-pkg` in 010/011a, generators in 022a)
- [x] Ready for `plan-review` — **WAIVED by the operator on 2026-08-11**, recorded on the
  workflow stream as decision `plan-review-waived`. The gate never ran. Revision 2 of this
  document already absorbed an independent 3-voter adversarial panel that refuted revision 1
  on ~25 HIGH gaps, so the plan has had adversarial scrutiny — it simply arrived through a
  different door than the workflow's own gate.
