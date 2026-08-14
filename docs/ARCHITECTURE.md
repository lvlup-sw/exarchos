# Architecture: the layer map

`docs/system-design.html` is the canonical statement of the nine-layer architecture and why it
is shaped that way. This file is narrower and more mechanical: it records **which directory
belongs to which layer**, so that no task in the structural refactor has to invent a placement.

The machine-readable form is [`tools/audit/layer-map.json`](../tools/audit/layer-map.json), and
[`tests/architecture/layer-map.test.ts`](../tests/architecture/layer-map.test.ts) checks it
against the live tree on every run. **The JSON is the authority; this page is its prose.** If the
two disagree, the test fails and the JSON is right.

## The nine published layers

Measured on the current tree: **27 directories** under `src/` — 25 mapped onto a target, 2
carrying a stated exception. The counts are asserted against the live listing by
`layer-map.test.ts`, so a stale number here fails rather than misleads.

| Layer | Name | Target directory |
|-------|------|------------------|
| L1 | Storage | `storage/` |
| L2 | Event store | `events/` |
| L3 | Projections | `projections/` |
| L4 | Workflow primitives | `workflow/` |
| L5 | Dispatch core | `contract/` **and** `dispatch/` |
| L6 | Composite tools | `verbs/` |
| L7 | Lifecycle verbs | `lifecycle/` |
| L8 | Adapters | `adapters/` |
| L9 | Cooperative agents | `runtime/` |
| — | *(non-layer peer)* | `install/` |

That is **11 target directories serving 9 published layers**, and the arithmetic is deliberate
rather than sloppy:

- **L5 is served by two directories.** `contract/` is what may be called and by what authority;
  `dispatch/` is the single function that calls it. They are split because the contract is
  asserted independently of the dispatcher that honours it — a contract test that imported the
  dispatcher would be checking the dispatcher against itself.
- **`install/` is a declared non-layer peer, not a tenth layer.** It installs and packages the
  engine rather than sitting in its call graph. Nothing in L1–L9 may import from it.

Task 044 asserts *this relation*, not set equality between directories and layers. A future
change that collapses L5 into one directory, or promotes `install/` to a layer, has to edit the
map and that test together — which is the point.

## Directories that are not layers

Eleven directories carry an exception. They fall into four groups, and none of them is a
judgement deferred for lack of thought:

**Conformance scanners** — `architecture/`, `ctk/`, `parity/` → `tools/conformance/`.
These read the tree; they are not part of it. `architecture/` is the largest at 73 files and
holds the seam audits and vocabulary lint; `ctk/` and `parity/` are test-only.

**Measurement** — `evals/`, `benchmarks/`, `bench/` → `tools/evals/`.
This resolves the plan's open question on `evals/`: **it is not a layer.** It measures the engine
from outside, and code that measures the engine must not sit in the engine's call graph, or the
measurement acquires a stake in the result.

**Test-only** — these held no product source and were folded into `tests/` and `tools/`. Two were
worth naming at the time because their names suggested product source and they contained none: a
`commands/` of prose tests over the authored command Markdown, and a `runtimes/` of adapter tests
whose runtime *data* is the harness YAML. Both now live with the rest of the test tree.

**Unresolved, on purpose** — `utils/`.
`atomic-write`, `paths`, `process` and `task-id` have consumers in five layers. Splitting it is a
real decision about who owns each helper, and that belongs to task 020, where the moves happen.
It is recorded as unresolved rather than forced into a bucket that would have to be undone.

## Authored and generated artifact kinds

Content splits in two. `content/` holds what a human writes; everything a build produces is
generator output, committed so the published package needs no build step. Each kind is
classified explicitly, because assuming a whole directory is one or the other is what put live
files inside a generated tree in the first place.

| Kind | Classification | Source | Emitted to | Producer |
|------|----------------|--------|------------|----------|
| `skills` | authored → rendered per runtime | `content/<domain>/skills/` | `rendered/skills/<runtime>/` | `build-skills/` |
| `commands` | authored → flattened | `content/<domain>/commands/` | `rendered/commands/` | `build-authored-artifacts.ts` |
| `rules` | authored → flattened | `content/<domain>/rules/` | `rendered/rules/` | `build-authored-artifacts.ts` |
| `command-aliases` | generated from command frontmatter | `rendered/commands/*.md` + `COMMAND_TO_SKILL` | `rendered/command-aliases/<runtime>/` | `build-command-aliases.ts` |
| `agents` | generated from TypeScript | `ALL_AGENT_SPECS` | `rendered/agents/` | `generate-agents.ts` |
| `binding`, `hooks` | authored → generated into place | `content/harness/` | plugin root | `build-hooks.ts` |

**Commands and rules get a generator rather than shipping from where they are authored.** They
carry no placeholders and no per-runtime variance, so the question looked like it had a third
answer — leave them where they are. It does not: a harness resolves a command by its bare name
from one flat directory, and `plugin.json` declares a single path per kind. Authoring by
capability and resolving by flat name cannot both hold unless something flattens, which is the
same reason the skills renderer stopped propagating its source-relative path. The generator is a
copy, and that is the whole point — the transformation being performed is the flattening.

The rule that keeps this honest: **a path may not be declared under a generated root unless
something emits it.** Declaring an output directory that no producer writes is not a harmless
forward reference; it is a broken path that resolves for nobody, and it is asserted against
rather than left to review.

Because the flat trees are now output, editing one directly is discarded by the next build.
`render:guard` regenerates and diffs the whole of `rendered/` so that discard is a red signal
instead of a surprise.

## Judgement calls worth knowing about

A few placements are defensible rather than obvious, and are recorded here so a later reader
disagrees with the reasoning instead of guessing at it:

- **`config/` → `workflow/` (L4).** Configuration is genuinely cross-cutting. It is placed at its
  consumer — the resolved config is what the dispatch context and the workflow guards read —
  rather than split across the layers that touch it.
- **`views/`, `telemetry/`, `quality/`, `session/`, `task-store/` → `projections/` (L3).** Each
  derives from the event log and none of them decides anything. Read models, not new substrates.
- **`vcs/` → `adapters/` (L8).** A GitHub or Azure DevOps provider adapts an external system,
  which is the same shape as adapting a CLI or MCP caller.
- **`runbooks/`, `sync/`, `describe/` → `lifecycle/` (L7).** L7's own description — "generic
  windows over the log" — fits all three; none is a workflow primitive.
- **`artifacts/` → `storage/` (L1).** The content-addressed store is persistence. Its
  path-containment guards travel with it.
