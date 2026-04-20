# E2E Testing Strategy: Fidelity Across the Ship Surface

**Status:** Research (discovery phase). Not an implementation plan.
**Workflow:** `e2e-testing-coverage`
**Date:** 2026-04-19

**Related internal:**
- `docs/plans/2026-02-06-testing-gaps.md` (boundary + integration work, complete)
- `docs/plans/2026-02-08-test-coverage.md` (module coverage 88% → 95%+, in flight)
- `docs/audits/2026-02-06-testing-gaps.md` (what escaped, and why)
- axiom dimensions: `skills/backend-quality/references/dimensions.md`

**Related issues:**
- [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) codify platform-agnosticity principle
- [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) v3.0 cross-cutting: event-sourcing + MCP parity + basileus-forward
- [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) Agent Output Contract (HATEOAS + NDJSON)
- [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) universal bootstrap script

---

## 1. Executive summary

Exarchos has 420 tests and 95%+ line coverage inside the MCP server. It has zero tests against the binaries it ships, the installer run against a real `$HOME`, or the six agent harnesses it promises to support. Under the axiom **DIM-4 (Test Fidelity)** lens — *the degree to which tests exercise actual production behavior* — the question is not "do we need more test layers". It is "where does our test wiring diverge from the wiring every user actually runs". The answer is: nearly everywhere outside the module graph.

The ship surface is a 3 × 6 × 3 cross-product: 3 operating systems, 6 agent harnesses, 3 invocation surfaces (CLI, MCP stdio, installed content files). That is 54 production wirings. Today's tests cover approximately one tuple — Linux × no-harness × in-process handler — and the `install.test.ts` suite touches a partial second (Linux installer with real symlinks, documented as fragile under git worktrees).

This document proposes six fidelity classes (F1–F6) that replace the test-pyramid framing with a cross-product coverage model. It maps each class to the axiom dimensions it closes, to the minimum viable test shape, and to the v3.0 issues that require it before they can ship. Two classes (F2 process fidelity and F3 protocol fidelity) can be bought in a few weeks and should gate all v3.0 CLI work. Three more (F4 platform, F5 harness, F6 lifecycle) scale the investment to match the platform-agnosticity claim in [#1118](https://github.com/lvlup-sw/exarchos/issues/1118).

## 2. Why "layers" is the wrong frame

The test pyramid assumes a single production configuration and asks how much verification sits at each depth. It answers "does this module work" and "do these modules work together".

Exarchos does not ship a single configuration. It ships a CLI binary, an MCP server binary, and rendered content (skills, commands, rules) that each harness discovers from a harness-specific path. Every OS × harness combination is a distinct wiring. A test pyramid on the Linux × in-process configuration says nothing about whether the macOS × Claude Code tuple works. The two share source code, not wiring.

Axiom **DIM-4** names this directly. Its invariants: test setup matches production wiring, mocks are used only at true infrastructure boundaries, critical paths have integration tests with the same composition root as production. Its canonical failure mode is "4,192 tests pass, system is broken" — tests exercise a topology that does not exist in production.

The platform-agnosticity principle being codified in [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) hardens this reframe into a product invariant. If platform-agnosticity is a principle, every test that exercises only one platform under-fulfills it. The metric we care about is: *what fraction of the ship surface does the test suite actually exercise?*

## 3. The ship surface, formally

### 3.1 The cross-product

| Axis | Values | Count |
|------|--------|-------|
| OS | Linux, macOS, Windows | 3 |
| Harness | Claude Code, Codex, Copilot, Cursor, OpenCode, generic | 6 |
| Invocation surface | CLI (user shell), MCP stdio (harness-spawned subprocess), installed content files | 3 |
| **Production wirings** | | **54** |

Each cell has a distinct set of failure modes:

- **OS axis** — path separators, symlink semantics (Linux `getcwd` canonicalizes; macOS `process.cwd` preserves; Windows uses junction points), case sensitivity, line endings, executable format, shell quoting, `$HOME` resolution. The [opencode#16661](https://github.com/anomalyco/opencode/issues/16661) macOS symlink regression from 2026-03 is a recent, in-ecosystem example of what falls through when CI covers two of three OSes.
- **Harness axis** — each harness reads installed content from its own path. Claude Code reads `~/.claude/`. Codex, Copilot, Cursor, OpenCode each have their own conventions, and `build-skills` renders a per-runtime variant at `skills/<runtime>/<name>/SKILL.md`. Frontmatter dialects differ. Skill activation triggers differ.
- **Surface axis** — the CLI and the MCP facade are both first-class entry points. The v3.0 Agent Output Contract ([#1088](https://github.com/lvlup-sw/exarchos/issues/1088), [#1098](https://github.com/lvlup-sw/exarchos/issues/1098)) makes them contractually equivalent under the HATEOAS-envelope proposal. Installed content is a third surface: the skill files on disk are the contract the harness consumes.

### 3.2 Today's coverage

| Cell | Covered? | Evidence |
|------|----------|----------|
| Linux × none × in-process handler | Yes (420 tests) | `servers/exarchos-mcp/src/**/*.test.ts` |
| Linux × none × CLI | Partial | `src/install.test.ts` (39 tests; one fragile against git worktrees) |
| Linux × none × MCP stdio | **No** | No test spawns the built MCP binary |
| Linux × Claude Code × any surface | **No** | No test verifies Claude Code loads installed content |
| macOS × any × any | **No** | No macOS CI runner |
| Windows × any × any | **No** | No Windows CI runner; Windows bug [#1085](https://github.com/lvlup-sw/exarchos/issues/1085) shipped undetected |
| All other 49 cells | **No** | — |

The `boundary.test.ts` work closed a DIM-1 and DIM-3 gap (cross-module round-trips), and `2026-02-08-test-coverage.md` raises module coverage from 88% to 95%+. Both stay inside the Linux × in-process tuple. Neither addresses the other 53 cells.

## 4. Current state under an axiom lens

Mapping existing work to the eight axiom dimensions:

| Dimension | Status | Load-bearing evidence |
|-----------|--------|----------------------|
| DIM-1 Topology | Strong inside module graph via `boundary.test.ts`. Weak across process boundary — no test verifies `exarchos install` produces a state tree the running MCP server actually reads. |
| DIM-2 Observability | Unit-tested for error paths. No test observes server stderr during crashes or stdio deadlocks. |
| DIM-3 Contracts | **Major gap.** No test validates Zod tool-input schemas against the JSON-RPC wire. No test validates tool-output shape against an external contract. No CLI↔MCP parity test — and "MCP parity" is exactly what [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) asks for. |
| DIM-4 Test Fidelity | **Major gap.** One of 54 ship tuples covered. Test-only wiring (in-process handler, tmp state dir, no actual MCP client) diverges from production wiring at every published surface. |
| DIM-5 Hygiene | Good inside module graph, per the audit pass in `2026-02-06-testing-gaps.md` and the active cleanup in [#1097](https://github.com/lvlup-sw/exarchos/issues/1097). |
| DIM-6 Architecture | Per-module review in `2026-02-06-testing-gaps.md`. No architectural test at the process boundary. |
| DIM-7 Resilience | Gap. No subprocess-lifecycle tests (hang, crash, stdout-buffer-full, stdin-closed), no timeout tests, no concurrent-client tests. |
| DIM-8 Prose Quality | Out of scope for this document. |

The tightest failure-to-dimension mapping: every undetected bug in the opencode#16661 class (macOS-only, Windows-only, or harness-only regressions) is a **DIM-4** (test-production divergence) finding on the OS or harness axis.

## 5. External canon

Exarchos is not the first project to solve any of this. The landscape offers drop-in components:

- **`@modelcontextprotocol/conformance`** (Anthropic, 0.1.16 as of 2026-03-30) is the official MCP protocol conformance suite. It runs spec scenarios against a server implementation: initialize handshake, tool discovery, error codes, capability declaration. Adopting it closes the DIM-3 wire-conformance gap without writing custom JSON-RPC tests.
- **`@modelcontextprotocol/sdk` `StdioClientTransport`** is the canonical pattern for writing a test that spawns and drives an MCP server. A test sets `command: 'node', args: ['dist/servers/exarchos-mcp/index.js']`, connects a `Client`, calls `listTools()` and `callTool(...)`, and asserts on the real wire response. This is F2 process fidelity with no custom plumbing.
- **`@scalvert/bin-tester`** (v3.0.0) provides a CLI-in-tmpdir harness. For `exarchos install` verification the test creates a disposable `$HOME`, runs the built CLI, and asserts on the resulting filesystem.
- **`cli-testing-library`** offers a user-simulation API (`findByText`, `userEvent`) for interactive CLI flows like the wizard-fallback pattern in [#1093](https://github.com/lvlup-sw/exarchos/issues/1093).
- **`microsoft/tui-test`** handles terminal-rendering e2e for any TUI surface we eventually ship.
- **`mcpjam`** runs MCP servers against real LLMs (Claude, GPT, Ollama). A superset of what Exarchos needs; useful for benchmarks, out of scope here.

The near-analog regression is [opencode#16661](https://github.com/anomalyco/opencode/issues/16661) (2026-03-09): a macOS-only symlink behavior difference shipped because the CI matrix was Linux + Windows only. The author calls out `getcwd()` semantics as the divergence source. Exarchos's own `install.test.ts:356` hardcodes a `/exarchos$/` regex and fails under git worktrees — memory `feedback_worktree_install_fragility.md` notes this is "pre-existing, not a regression", which is exactly the signal that the same class of bug can ship here.

## 6. Six fidelity classes

Each class is independently adoptable. Each closes a specific set of axiom dimensions for a specific subset of the 54-tuple ship surface.

### F1 — Module fidelity

**What it tests:** single-module behavior; cross-module round-trips inside one process.
**Cells covered:** Linux × none × in-process (one tuple).
**Dimensions closed:** DIM-1, DIM-2, DIM-5, DIM-6, locally.
**Status:** Strong. 420 tests. `2026-02-06-testing-gaps.md` complete; `2026-02-08-test-coverage.md` in flight.
**Proposed action:** keep executing the existing plans. No new work from this document.

### F2 — Process fidelity

**What it tests:** the shipped binary, invoked exactly as the harness invokes it.
**Cells covered:** Linux × none × {CLI, MCP stdio}. Matrix expansion to macOS/Windows is F4.
**Dimensions closed:** DIM-1 across the process boundary (lazy-fallback constructors become visible); DIM-4 at the surface axis; DIM-7 (resource leak on process teardown).

**Minimum viable MCP test:**

```typescript
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/servers/exarchos-mcp/index.js'],
  env: { ...process.env, EXARCHOS_STATE_DIR: tmpStateDir },
});
const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
expect(tools.map(t => t.name)).toContain('exarchos_workflow');
const result = await client.callTool({
  name: 'exarchos_workflow',
  arguments: { action: 'init', featureId: 'e2e-smoke', workflowType: 'discovery' },
});
expect(result.isError).toBeFalsy();
await client.close();
```

**Minimum viable CLI test:** `bin-tester` invokes the built `exarchos install` against `$HOME = tmp/home-<id>/`, then asserts `~/.claude/` symlinks exist and `~/.claude.json` contains the MCP registration.
**Cost:** ~1 week once hermetic fixtures exist.
**Determinism risks:** process spawn adds ~300ms per test. Run F2 in its own vitest project. Use a per-test `EXARCHOS_STATE_DIR` to prevent cross-test state bleed.

### F3 — Protocol fidelity

**What it tests:** the MCP wire format, the CLI output format, and the CLI↔MCP response-equivalence contract.
**Cells covered:** cross-cutting on the invocation-surface axis. Any failure here is a 54-tuple failure.
**Dimensions closed:** DIM-3 at every published boundary.

Three sub-components:

1. **MCP conformance.** Integrate `@modelcontextprotocol/conformance` as a CI gate. The suite ships scenarios for initialize, tools/list, tools/call, error codes, capability declaration.
2. **CLI↔MCP parity.** For each action exposed on both surfaces, run it via both and assert the HATEOAS envelope is structurally identical after normalizing timestamps and IDs. This is what operationally satisfies the "MCP parity" goal in [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) and what validates the envelope spec in [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) / [#1098](https://github.com/lvlup-sw/exarchos/issues/1098).
3. **Capability handshake.** Once [#1139](https://github.com/lvlup-sw/exarchos/issues/1139) ships, tests must verify the yaml ⊕ handshake merge resolves to the expected effective capability record on each runtime. An F3 concern that transitively becomes F5.

**Cost:** conformance integration ~2 days; parity harness ~1 week (normalizer design dominates); handshake resolver tests scale with [#1139](https://github.com/lvlup-sw/exarchos/issues/1139) delivery.
**Determinism risks:** timestamps, stream IDs, and event sequences must be canonicalized before equivalence. The `_eventSequence` and `updatedAt` fields in workflow state are known non-deterministic; normalize to `<TIMESTAMP>` and `<SEQ>` placeholders.

### F4 — Platform fidelity

**What it tests:** OS-specific behavior differences. Symlink semantics, path separators, line endings, executable format, case sensitivity, shell quoting.
**Cells covered:** multiplies F1–F3 coverage by OS.
**Dimensions closed:** DIM-4 at the OS axis.

**Action:** extend GitHub Actions to `runs-on: ${{ matrix.os }}` with `[ubuntu-latest, macos-latest, windows-latest]`. Start with the F1 suite on all three to catch cheap regressions (the opencode#16661 class). Scale to F2 + F3 as those come online.

**Known probes to add:** symlink-vs-junction install on Windows (matches [#1085](https://github.com/lvlup-sw/exarchos/issues/1085)), case-insensitive path collisions on APFS, CRLF vs LF in rendered skill files.

**Cost:** CI matrix change is an afternoon. Probe tests land incrementally.
**Determinism risks:** macOS and Windows runners are slower and pricier. Gate F2/F3 on Linux per-PR; run macOS/Windows nightly, with a labeled opt-in for PRs touching installer or path handling.

### F5 — Harness fidelity

**What it tests:** that rendered skills, commands, and rules land at each harness's expected path and parse in that harness's format.
**Cells covered:** multiplies F1–F4 coverage by harness.
**Dimensions closed:** DIM-4 at the harness axis; DIM-3 at the frontmatter-contract boundary.

**Scope:** path-and-format parsing only. Actual harness loading stays manual QA in a tracked matrix. Automating the load step is a follow-on discovery (§13).

**Test shape:** for each runtime in `runtimes/<name>.yaml`, after `exarchos install`, assert:
1. Files exist at the runtime's expected paths.
2. Each `SKILL.md` has valid frontmatter matching the runtime's declared dialect.
3. `{{CALL}}` and other macros have been substituted (no unresolved placeholders).
4. File encoding and line endings match runtime requirements.

**Cost:** one `runtime-install.test.ts` per runtime (6 files). Initial harness-expectation fixture table ~1 week — the hard part is reading each harness's docs and writing down what it expects.
**Determinism risks:** harness path conventions change; record each runtime's spec version in the fixture.
**Non-Claude runtimes:** the daemon in [#1137](https://github.com/lvlup-sw/exarchos/issues/1137) is only useful if each non-Claude runtime actually works. F5 is how we know.

### F6 — Lifecycle fidelity

**What it tests:** a full workflow runs `init → plan → plan-review → delegate → integrate → synthesize → cleanup` against a real MCP server, real git worktree, real event stream, with compensation exercised on a forced failure.
**Cells covered:** Linux × Claude Code × all three surfaces in a single test.
**Dimensions closed:** DIM-1 across the full composition root; DIM-4 at scale; DIM-7 under realistic pressure.

**Test shape:** one long-running test initializes a tmp git repo, spawns the MCP server, drives it through a scripted workflow via `StdioClientTransport`, asserts event sequences at phase transitions, injects a compensation-triggering failure, asserts cleanup. Event-stream assertions use the F3 normalizers.

**Cost:** ~2–3 weeks. High value, high maintenance.
**Determinism risks:** the flakiest class. Budget ≤2% flake rate. Pin vitest timeout at 120s. Run nightly only.
**Explicit defer:** multi-agent delegation with real subagent spawning — out of scope until agent spawning has its own mocked-subagent harness. The `prune_stale_workflows` bug in [#1117](https://github.com/lvlup-sw/exarchos/issues/1117) is the kind of issue F6 would catch if it were extended to cover long-running state.

## 7. Cross-cutting concerns

**Hermeticity.** Every F2+ test needs an isolated `$HOME`, an isolated state dir, and (for F6) an isolated git repo. Centralize in `test/fixtures/hermetic.ts` — one `withHermeticEnv(callback)` helper that creates `tmp/{home,state,repo}/<test-id>/`, sets `HOME`, `EXARCHOS_STATE_DIR`, `GIT_DIR`, runs the callback, then unconditionally cleans up.

**Determinism.** Maintain one `test/fixtures/normalizers.ts` with canonicalizers for timestamps (`<TIMESTAMP>`), event sequences (`<SEQ>`), worktree paths (`<WORKTREE>`), PR URLs (`<PR_URL>`), and random IDs (`<ID>`). Every F3 equivalence assertion runs through it. Every F6 event-stream assertion runs through it.

**Flakiness budget.** Target: F1 and F2 at 0% flake on PR gate. F3 conformance at 0%. F4 matrix ≤1%. F6 lifecycle ≤2%, nightly only. Any F1/F2/F3 flake is a P0 — fix before merging any non-related change.

**CI cost envelope.** Current CI is ~3 min (Linux, one job). Adding F2 adds ~2 min. Adding F3 conformance adds ~1 min. Matrix expansion to macOS+Windows multiplies by 3 at peak. Keep per-PR CI under 10 min by deferring F4 full matrix and F6 lifecycle to nightly.

**Test-double ratio.** Per DIM-4 guidance in `skills/verify/references/test-antipatterns.md`, F2+ tests use mocks only at true infrastructure boundaries (network, external APIs we don't ship). Everything in-process runs real code. No `vi.mock` inside F2–F6.

**v3.0 alignment.**
- [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) (HATEOAS + NDJSON) — F3 parity harness is the test infrastructure this contract lives or dies by.
- [#1100](https://github.com/lvlup-sw/exarchos/issues/1100) (NDJSON streaming for `--follow`) — F2 CLI test spawns the process, reads line-delimited stdout, asserts each line parses as a typed NDJSON event.
- [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) (universal bootstrap script) — replaces the npm installer with a shell script that downloads a binary. Cannot ship without F4 matrix coverage; the value proposition *is* cross-platform.
- [#1139](https://github.com/lvlup-sw/exarchos/issues/1139) (capability resolver) — handshake + envelope conformance belongs in F3.
- [#1142](https://github.com/lvlup-sw/exarchos/issues/1142) (tier-gated bootstrap-pull) — F5 per-runtime render verification, parameterized on tier.

## 8. Recommended architecture

### 8.1 Vitest project split

```
vitest.config.ts
└── projects:
    ├── unit          — F1 (default test:run)
    ├── integration   — F1 cross-module (boundary.test.ts)
    ├── process       — F2 (StdioClientTransport + bin-tester)
    ├── conformance   — F3 (@modelcontextprotocol/conformance + parity)
    └── e2e           — F4 matrix probes + F5 install fixtures + F6 lifecycle
```

Each project has its own timeout, its own setupFiles, and its own CI gate.

### 8.2 Test layout

```
test/
├── fixtures/
│   ├── hermetic.ts           — tmp-$HOME / tmp-state / tmp-git harness
│   ├── normalizers.ts        — deterministic replacements
│   ├── runtimes/<name>.json  — per-runtime expected install layout
│   └── stdio-client.ts       — StdioClientTransport factory
├── process/
│   ├── mcp-stdio.test.ts     — F2 MCP smoke
│   └── cli-install.test.ts   — F2 CLI smoke
├── conformance/
│   ├── mcp-conformance.test.ts     — @modelcontextprotocol/conformance wrapper
│   ├── cli-mcp-parity.test.ts      — per-action parity
│   └── capability-handshake.test.ts — effective capability resolver
└── e2e/
    ├── platform-probes.test.ts     — F4 symlink/path/case probes
    ├── runtime-install.test.ts     — F5 per-harness install
    └── workflow-lifecycle.test.ts  — F6 full saga
```

### 8.3 Package.json scripts

```
"test:unit"          — existing test:run against unit + integration projects
"test:process"       — F2 (requires build)
"test:conformance"   — F3 (requires build)
"test:e2e"           — F4 + F5 + F6 (requires build + matrix env)
"test:all"           — all above, sequential
```

## 9. CI integration

### 9.1 PR gate (per commit)

- Unit + integration on Linux (~3 min).
- F2 process fidelity on Linux (~2 min).
- F3 MCP conformance on Linux (~1 min).
- Unit project on macOS and Windows (matrix, no extra infra — runs F1 against the other OSes for opencode#16661-class detection). Parallel wall-time ~4 min.

Total: ~10 min. Covers DIM-1, DIM-3, DIM-4 on all three OSes at the module level plus F2 + F3 on Linux.

### 9.2 Nightly

- F4 platform probes on all three OSes.
- F5 runtime-install tests on Linux (path assertions are OS-independent; platform interaction is F4's concern).
- F6 workflow-lifecycle on Linux.

### 9.3 Opt-in per-PR

Label `ci:full-matrix` triggers F4 + F5 + F6 on a PR when installer, path handling, or HSM code changes.

## 10. Prioritization

### Tier 1 — ships before any v3.0 CLI work (~2 engineer-weeks)

| Item | Effort | Unblocks |
|------|--------|----------|
| F2 MCP StdioClientTransport harness + one smoke test | 3 days | [#1088](https://github.com/lvlup-sw/exarchos/issues/1088), [#1098](https://github.com/lvlup-sw/exarchos/issues/1098), [#1109](https://github.com/lvlup-sw/exarchos/issues/1109), [#1139](https://github.com/lvlup-sw/exarchos/issues/1139), [#1140](https://github.com/lvlup-sw/exarchos/issues/1140) |
| F2 CLI bin-tester harness + installer smoke test | 2 days | [#1087](https://github.com/lvlup-sw/exarchos/issues/1087), [#1093](https://github.com/lvlup-sw/exarchos/issues/1093), [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) |
| F3 `@modelcontextprotocol/conformance` integration | 2 days | Spec-compliance claim for all future MCP work |
| Windows runner on GitHub Actions matrix for unit suite | 1 day | Closes [#1085](https://github.com/lvlup-sw/exarchos/issues/1085)-class regressions |
| Hermetic + normalizer fixtures | 3 days | Prerequisite for Tier 2 + 3 |

Tier 1 closes DIM-3 at the wire and DIM-4 at the process boundary. After Tier 1, every subsequent v3.0 CLI/MCP change can be verified before merge.

### Tier 2 — validates platform-agnosticity ([#1118](https://github.com/lvlup-sw/exarchos/issues/1118)) (~4 engineer-weeks)

| Item | Effort |
|------|--------|
| macOS runner on CI matrix | 1 day |
| F4 platform probes (symlink, path, case, line endings) | 1 week |
| F5 per-runtime install fixtures (6 harnesses × path assertions) | 2 weeks |
| Manual harness-loading QA matrix (documented) | 2 days |

Tier 2 is the empirical check on the platform-agnosticity principle. Without it, [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) is aspirational.

### Tier 3 — v3.0 polish (~6 engineer-weeks)

| Item | Effort |
|------|--------|
| F6 full workflow lifecycle | 3 weeks |
| F3 CLI↔MCP parity harness | 2 weeks |
| F3 capability-handshake resolver tests (follows [#1139](https://github.com/lvlup-sw/exarchos/issues/1139)) | Scales with #1139 |
| Compensation-on-failure lifecycle test | 1 week |

Tier 3 is worthwhile only after Tier 1 + Tier 2 provide the foundation. The lifecycle test is the most expensive and most valuable single test in the proposal; it catches the regression class that unit tests structurally cannot.

## 11. Issue-to-fidelity mapping

| Issue | Title | Fidelity class |
|-------|-------|---------------|
| [#1085](https://github.com/lvlup-sw/exarchos/issues/1085) | Windows MCP server bug | F4 (OS axis) |
| [#1087](https://github.com/lvlup-sw/exarchos/issues/1087) | v3.0 P1: CLI Ergonomic Infrastructure | F2 CLI |
| [#1088](https://github.com/lvlup-sw/exarchos/issues/1088) | v3.0 P2: Agent Output Contract | F3 parity |
| [#1092](https://github.com/lvlup-sw/exarchos/issues/1092) | Pluggable IInteractionService | F2 CLI |
| [#1093](https://github.com/lvlup-sw/exarchos/issues/1093) | TTY detection + wizard-fallback | F2 CLI (cli-testing-library) |
| [#1095](https://github.com/lvlup-sw/exarchos/issues/1095) | OptionWithLegacy for flag renames | F3 contracts |
| [#1096](https://github.com/lvlup-sw/exarchos/issues/1096) | Rich exit codes | F2 CLI |
| [#1098](https://github.com/lvlup-sw/exarchos/issues/1098) | Uniform HATEOAS envelope | F3 parity |
| [#1100](https://github.com/lvlup-sw/exarchos/issues/1100) | NDJSON streaming protocol | F2 CLI + F3 format |
| [#1101](https://github.com/lvlup-sw/exarchos/issues/1101) | Self-documenting root | F2 CLI |
| [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) | Event-sourcing + MCP parity | F3 parity |
| [#1115](https://github.com/lvlup-sw/exarchos/issues/1115) | Universal bootstrap script | F2 CLI + F4 matrix |
| [#1117](https://github.com/lvlup-sw/exarchos/issues/1117) | Pruner stale-workflow bug | F6 lifecycle |
| [#1118](https://github.com/lvlup-sw/exarchos/issues/1118) | Codify platform-agnosticity | **F4 + F5 together** |
| [#1137](https://github.com/lvlup-sw/exarchos/issues/1137) | exarchos watch sideband daemon | F2 + F5 non-Claude harnesses |
| [#1139](https://github.com/lvlup-sw/exarchos/issues/1139) | Capability resolver yaml ⊕ handshake | F3 handshake |
| [#1140](https://github.com/lvlup-sw/exarchos/issues/1140) | PiggybackSink + _notifications envelope | F3 envelope |
| [#1142](https://github.com/lvlup-sw/exarchos/issues/1142) | Skill bootstrap-pull tier-guarded | F5 per-runtime render |

## 12. Non-goals

- **Harness-internal behavior.** We test that our content lands at the right path in the right format. Whether Claude Code, Codex, etc. then behave correctly with that content is the harness's responsibility.
- **Full LLM-driven conversation E2E.** `mcpjam` exists for this. Useful for benchmarks, not for regression gating.
- **Basileus contract tests.** Basileus is a separate product; its interaction surface with Exarchos is tested via `exarchos_sync` fabric actions in [#1143](https://github.com/lvlup-sw/exarchos/issues/1143) when those land.
- **Property-based test expansion.** Scoped in `2026-02-08-test-coverage.md`.
- **Performance or load testing.** Mentioned in external references (k6); out of scope here.
- **Security testing.** Appropriate as a separate workflow under `/security-review`.

## 13. Escalation

Each tier corresponds to a `/exarchos:ideate` candidate:

1. **Tier 1 ideate:** *"Process-fidelity test harness: MCP stdio + CLI bin-tester + MCP conformance suite, with hermetic fixtures and Windows runner"*. Design deliverables: fixture-library API, vitest project split, CI config diff, per-action parity contract schema.
2. **Tier 2 ideate:** *"Platform-agnosticity verification: OS matrix, per-runtime install fixtures, harness-expectation table"*. Design deliverables: runtime fixture schema, macOS CI config, manual-QA matrix template.
3. **Tier 3 ideate:** *"Workflow-lifecycle e2e: full-saga test, compensation verification, HATEOAS-parity harness"*. Design deliverables: saga test DSL, event-stream normalizer, parity assertion library.

Separately, a follow-on discovery: *"automated harness-loading verification"* — whether it is feasible to spawn each supported harness in CI and observe it loading Exarchos content. The F5 upgrade path from path-parsing to load-verification.

## 14. Appendix

### 14.1 Glossary

- **Fidelity class (F1–F6)** — a category of test distinguished by which cells of the ship-surface cross-product it covers.
- **Ship surface** — the set of production wirings Exarchos supports: (OS × harness × invocation-surface).
- **Process fidelity** — tests that drive the shipped binary rather than the in-process module graph.
- **Protocol fidelity** — tests that verify the wire-format contract at every published boundary.
- **Harness** — an agent runtime that loads Exarchos content (Claude Code, Codex, Copilot, Cursor, OpenCode, generic).
- **Tuple** — one cell of the 54-cell cross-product.
- **HATEOAS envelope** — the v3.0 uniform response wrapper proposed in [#1098](https://github.com/lvlup-sw/exarchos/issues/1098).

### 14.2 References

**Internal:**
- `docs/plans/2026-02-06-testing-gaps.md`
- `docs/plans/2026-02-08-test-coverage.md`
- `docs/audits/2026-02-06-testing-gaps.md`
- `docs/bugs/2026-02-06-workflow-state-testing-gaps.md`
- `CLAUDE.md` (architecture overview)
- `skills-src/discovery/SKILL.md`
- axiom dimensions: `skills/backend-quality/references/dimensions.md`
- axiom test antipatterns: `skills/verify/references/test-antipatterns.md`
- axiom contract testing: `skills/verify/references/contract-testing.md`

**External:**
- `@modelcontextprotocol/conformance` — https://www.npmjs.com/package/@modelcontextprotocol/conformance
- `@modelcontextprotocol/sdk` TypeScript — https://github.com/modelcontextprotocol/typescript-sdk
- `@scalvert/bin-tester` — https://github.com/scalvert/bin-tester
- `cli-testing-library` — https://github.com/crutchcorn/cli-testing-library
- `microsoft/tui-test` — https://github.com/microsoft/tui-test
- Agnost AI testing guide — https://agnost.ai/blog/testing-mcp-servers-complete-guide
- opencode macOS matrix regression — https://github.com/anomalyco/opencode/issues/16661

### 14.3 Cross-references to existing plans

This document **does not** duplicate:
- `docs/plans/2026-02-06-testing-gaps.md` — F1 boundary tests inside the MCP server (complete).
- `docs/plans/2026-02-08-test-coverage.md` — F1 module-level line/function coverage (in flight).

This document **does** propose net-new work in F2, F3, F4, F5, F6. The F1 plans remain authoritative for module-level testing.
