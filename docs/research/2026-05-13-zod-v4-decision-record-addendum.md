# Zod v4 Migration — Decision Record Addendum (Modern Stack Reframe)

**Date:** 2026-05-13
**Phase:** PR-C / C-W1 (post-audit ratification)
**Tracking issue:** #1366
**Source:** `docs/research/2026-05-13-zod-v4-decision-record.md` (the original) is superseded by this addendum on Decisions 1b, 3, and 14.

The original decision record's recommendations were drafted from a "preserve status quo, file upstream issue" stance. The user invoked `/design-invariants` and `/axiom:design` and reframed: **prefer the most modern stack on MCP protocol + Zod**. This addendum captures the revised slate.

The invariant lens (full analysis in conversation transcript) flagged the original Decision 3 + Decision 14 (acceptance relaxation) as **violating INV-5b output contract** — accepting a claim/actual divergence (claim 2020-12, emit draft-7) is exactly the pattern PR-C exists to eliminate. DIM-3 contracts and DIM-4 test fidelity were also flagged.

---

## Versions of record (modern-stack tightening)

| Package | Current pin | Audit baseline | Latest stable | **Pinned by this PR** |
|---|---|---|---|---|
| `zod` | `^3.23.0` | n/a | `4.4.3` (2026-05-04, 9d) | **`^4.4.3`** |
| `@modelcontextprotocol/sdk` | `^1.0.0` *(loose; resolves to ~1.26)* | `1.26.0` | `1.29.0` | **`^1.29.0`** |

**Verification of SDK gaps against `1.29.0`** (not just `1.26.0` as the original audit ran):

- `mcp.js:76-95` — `toJsonSchemaCompat(obj, { strictUnions, pipeStrategy })` is called for both inputSchema and outputSchema **WITHOUT** a `target` option. `zod-json-schema-compat.js:9-16` `mapMiniTarget(undefined)` returns `'draft-7'` as fallback. **Gap 1 persists in `1.29.0`.**
- `zod-compat.js:104-115` — `normalizeObjectSchema` checks `def && (def.type === 'object' || def.shape !== undefined)`. A v4 `ZodDiscriminatedUnion` has `_zod.def.type === 'union'` (subclass of `ZodUnion`), so the match still fails. **Gap 2 persists in `1.29.0`.**

The SDK bump alone does not solve the contract divergence. Bumping to `^1.29.0` is still the right call for modernization (current pin `^1.0.0` is dangerously loose), but the gap-fixes must come from us.

---

## Decision 1 — Target Zod version

**Confirmed:** `zod@^4.4.3`. Unchanged from original record §1.

## Decision 1b — Target MCP SDK version (NEW)

**New:** bump `@modelcontextprotocol/sdk` from `^1.0.0` to `^1.29.0`.

**Rationale:** `^1.0.0` is too loose for a foundational dep; `1.29.0` is current (3 minors past the audit baseline). The bump does NOT fix either gap (see version verification above) but aligns us with the current SDK API surface, including v4 compat shims and unrelated bug fixes.

## Decision 2 — Wrapper vs strip `adapters/json-schema.ts`

**Confirmed:** Keep the wrapper. Unchanged from original record §2.

## Decision 3 — LCD reactivation strategy (REVISED)

The original record §3 recommended *"keep passthrough ZodObject workaround + file upstream SDK issue"* (Option B in that record's framing). The modern-stack reframe rejects pure status-quo.

**Revised: B+C combo.**

- **B (upstream contribution).** Draft a PR to `@modelcontextprotocol/sdk` fixing BOTH gaps:
  1. Pass `target: 'draft-2020-12'` to `toJsonSchemaCompat(...)` in `mcp.js:78` (input) and `mcp.js:91` (output). This may need to be opt-in via constructor option to avoid breaking other consumers — design the API surface in the PR.
  2. Extend `normalizeObjectSchema` in `zod-compat.js:104-121` to accept `ZodDiscriminatedUnion` on both v3 and v4 paths.
  Include tests covering both fixes. Submit upstream; the PR is INV-5b's official remediation path.

- **C (`patch-package` interim).** Apply both fixes locally via `patch-package` against `@modelcontextprotocol/sdk@^1.29.0`. This ships in PR-C and clears INV-5b immediately. Drop the patch once B merges and we bump to the SDK version that includes it.

**Plus reactivation:** with Gap 2 patched, reactivate the canonical `EnvelopeSchema(z.unknown())` discriminated-union LCD in `adapters/mcp.ts`. The passthrough-ZodObject workaround is dropped.

## Decision 4 — Acceptance criteria (REJECTED relaxation; HARDENED)

The original record §14 proposed relaxing the brief's acceptance bullet to *"SDK-mediated `tools/list` boundary is structurally compatible with 2020-12 (draft-7 is a subset for the constructs we emit)"*. **Rejected.**

**Hardened acceptance:**

- [ ] `tools/list` over MCP advertises `$schema: https://json-schema.org/draft/2020-12/schema` natively at the SDK boundary (verified by live integration test). Achieved via the `patch-package` fix from Decision 3 / Option C.
- [ ] Canonical `EnvelopeSchema(z.unknown())` discriminated-union LCD is registered as `outputSchema` for every action (the passthrough-ZodObject workaround is removed).
- [ ] The upstream MCP SDK PR (Decision 3 / Option B) is filed; PR number recorded in this addendum once it exists.
- [ ] All other original-record acceptance bullets remain (zod@^4.x pinned, json-schema adapter native, full test suite green, etc.).

---

## Revised wave structure for PR-C

The original brief's phases 2-8 are amended:

| Wave | Brief tasks | Revised scope |
|---|---|---|
| C-W2 | C2.1 – C2.7 (foundation) | **+ bump SDK to `^1.29.0`; + add `patch-package` dev dependency; + apply two-gap patch to `@modelcontextprotocol/sdk@1.29.0`** |
| C-W2.5 | NEW | **Draft upstream PR against `@modelcontextprotocol/sdk` fixing the two gaps. Can run in parallel with C-W3..C-W7. Authored as a researcher-implementer agent against a forked clone, NOT this repo's branch. Output: fork URL + draft PR URL recorded back to this addendum.** |
| C-W3 | C3.1 – C3.4 (`contract/schemas/envelope.ts`) | Unchanged |
| C-W4 | C4 (`registry.ts`) | Unchanged |
| C-W5 | C5.1 – C5.4 (adapters) | **Reactivate canonical `EnvelopeSchema(z.unknown())` LCD in `adapters/mcp.ts` (drop the passthrough workaround). Verify against patched SDK.** |
| C-W6 | C6.1 – C6.7 (sweep) | Unchanged |
| C-W7 | C7.1 – C7.3 (snapshots) | **Snapshot diffs now include the LCD shape change (passthrough-object → discriminated-union). Manual review per snapshot per brief §"Risks".** |
| C-W8 | C8.1 – C8.5 (final verification) | **C8.4 is now a HARD GATE: live integration test asserts `tools/list` emits native `$schema: …draft/2020-12/schema` at the SDK boundary (post-patch). Failure aborts PR-C.** |

---

## Risk register addendum

- **Patch maintenance burden** — `patch-package` against a churning upstream may need re-application on SDK bumps. **Mitigation:** B (the upstream PR) is authored in parallel; once it merges and a release lands, drop the patch in a follow-up PR.
- **Upstream PR rejection** — if the SDK maintainers reject the `target` option or the DU acceptance change, we carry the patch indefinitely. **Mitigation:** propose minimal, backward-compatible changes (e.g., `target` as opt-in option with `draft-7` default; DU accepted via additive `def.type === 'union' && isDiscriminated` branch). File the upstream issue first to socialize before opening the PR.
- **Live integration test infrastructure** — currently no in-process MCP server harness exists. **Mitigation:** C-W8 must establish one. Budget 2-3h for harness scaffolding within C-W8.

---

## Status

- [x] User ratified the B+C combo on 2026-05-14 via `/design-invariants` + `/axiom:design` skill-driven review.
- [x] **Upstream Option B socialization filed 2026-05-14:**
  - Gap 1 (tools/list draft-07 regression vs SEP-1613): NEW issue [modelcontextprotocol/typescript-sdk#2084](https://github.com/modelcontextprotocol/typescript-sdk/issues/2084) — file:line evidence from `1.29.0`, suggested diff, test plan, linked to lvlup-sw/exarchos#1366.
  - Gap 2 (DU `outputSchema` rejected): existing open issue [modelcontextprotocol/typescript-sdk#1308](https://github.com/modelcontextprotocol/typescript-sdk/issues/1308) (P2, fix-proposed; @lawrence3699 working on v1.x backport since 2026-04-19). Commented Exarchos DU envelope use case at [#1308 comment 4447691385](https://github.com/modelcontextprotocol/typescript-sdk/issues/1308#issuecomment-4447691385). Not duplicated.
- [x] **C-W2 landed in commit `36b1faca` (2026-05-14):**
  - Zod bumped to `^4.4.3`; SDK bumped to `^1.29.0`; `zod-to-json-schema` dropped.
  - `patch-package` wired (postinstall script). Patch file `servers/exarchos-mcp/patches/@modelcontextprotocol+sdk+1.29.0.patch` fixes both gaps with inline `[exarchos patch #1366]` comments.
  - `adapters/json-schema.ts` rewritten as ~10-line passthrough; 3/3 adapter tests GREEN. Default-target test uses `z.tuple(...)` to assert `prefixItems` (a true 2020-12-only structural keyword), not just `$schema` string.
  - RED-state baseline captured: 41 tsc errors + 230 vitest failures across `registry.ts`, `schema-to-flags.ts`, `evals/*`, `event-store/schemas.ts`, `adapters/mcp.ts`. This is the C-W3..C-W7 work surface.
- [x] **C-W3 landed in commit `a1a17e17` (2026-05-14):** envelope schemas migrated to Zod v4; canonical `EnvelopeSchema(z.unknown())` discriminated-union LCD reactivated in `adapters/mcp.ts` (passthrough-ZodObject workaround dropped).
- [x] **C-W4 landed in commit `0dfada7d` (2026-05-14):** `registry.ts` migrated to Zod v4 across 15 introspection sites (`_def` reads cleaned, `description` / `shape` reads updated for v4 internals).
- [x] **C-W6 landed in commit `f990c44f` (2026-05-14):** sweep complete across `event-store`, `workflow`, `evals`, `schema-to-flags`, `fingerprint`; tsc 22 → 0; vitest 6632 / 0 fail. Discovered + patched the third SDK gap — post-emission `type: 'object'` splice on DU-rooted `tools/list` outputs in `mcp.js` (the MCP spec requires `type: 'object'` on every tool's outputSchema, but `z.toJSONSchema` emits a DU as a top-level `anyOf` without `type`). Patch updated in-place; gap 3 has the same `[exarchos patch #1366]` comment convention.
- [x] **C-W8 landed in commit `b7c69dc0` (2026-05-14):** HARD GATE GREEN. Live in-process integration test `src/__tests__/integration/tools-list-2020-12.test.ts` boots the production MCP server via `InMemoryTransport` + `Client.listTools()` and asserts at the SDK boundary: (1) every `inputSchema.$schema === draft/2020-12`, (2) every production tool advertises `outputSchema` (gap-2 fix verified end-to-end), (3) every `outputSchema.$schema === draft/2020-12`, (4) every `outputSchema.type === 'object'` (gap-3 splice verified), (5) a 2020-12-only structural keyword (`prefixItems` on a fixture `z.tuple(...)`) is present on the wire — proof of native emission, not a $schema relabel. MCP suite 6637 / 0 / 24 GREEN; root suite 753 / 0 / 6 GREEN; both `tsc --noEmit` clean. The headline acceptance criterion from §4 is met.
- [ ] C-W2.5 (upstream PR for both gaps) — patch-file is the reference implementation; can be authored once C-W6 completes and the SDK PRs find a stable diff. **Gap 3 should be folded into the same upstream submission** — the splice belongs in the SDK alongside the `target: 'draft-2020-12'` thread-through, not as a permanent local patch.

## Notes for downstream waves

- The patch's inline `(TBD)` upstream-PR references should backfill once C-W2.5 files the SDK PR.
- `better-sqlite3` native bindings emit a "could not locate `.node` file" in agent worktrees (node v24 vs prebuilt v22). Pre-existing and unrelated to PR-C. Treat sqlite-bound test failures in subagent worktrees as environmental until proven otherwise; `npm rebuild better-sqlite3` in the worktree is the fix.
