# Implementation Plan — Cross-Harness Exarchos Binding via Session Lifecycle Hooks

**Design:** `docs/designs/2026-05-31-harness-binding-and-lifecycle-hooks.md`
**Issue:** #1485 · **Milestone:** v2.10.1 · **Feature ID:** `session-lifecycle-hooks`
**Iron Law:** No production code without a failing test first. Every task is RED → GREEN → REFACTOR.

## Grounding (verified against source)

- Capability schema: `src/runtimes/types.ts` `CapabilitiesSchema` (`hasHooks: z.boolean()` at L27). Reshape ripples to all 6 `runtimes/*.yaml`, generated `src/runtimes/embedded.ts` (`npm run codegen:runtimes`, guarded by `runtimes:guard`), and per-runtime YAML tests.
- Renderer: `src/build-hooks.ts` `buildAllHooks` reads `rt.capabilities.hasHooks` (L99) → claude `hooks/hooks.json` else `hooks/<rt>/HOOKS.md`. Tests in `src/build-hooks.test.ts`.
- Hook router: `servers/exarchos-mcp/src/adapters/hooks.ts` — `HOOK_COMMANDS = {session-end, subagent-stop}` (L20), handler map (L74). Dispatched generically from `index.ts` L289-297. Tests in `adapters/hooks.test.ts`.
- Handlers: `cli-commands/session-end.ts` (KEEP — feeds provenance), `cli-commands/subagent-stop.ts` (DELETE — `handleSubagentStop` returns `{observed,subagentType}`, **no consumer**).
- Session telemetry: `session/manifest.ts` exports `writeManifestEntry` / `readManifestEntries` / `writeManifestCompletion` / `findUnextractedSessions`; `session/types.ts` `SessionManifestEntry{startedAt,cwd,branch}` exists. `writeManifestEntry` has **no live caller** today — `session-start` will be its first.
- Provenance: `session/session-provenance-projection.ts` (pure left-fold over `sessions/<id>.events.jsonl` + manifest). Sole consumer of session-end output via `exarchos_view session_provenance`.

## Task Dependency Graph

```
T1 (schema) → T2 (YAML data + codegen) ──┬─→ T4 → T6 → T7 → T8 → T13 (renderer chain — shared build-hooks.ts, serial)
                                         │
                          T3 (binding SoT) ┘
T1 ─→ T9 (session-start handler) → T10 (router wire) → T11 (delete subagent-stop)   (verb chain — parallel to renderer chain)
T5 (hooks-src restructure) ─→ T6, T11
T12 (verify+prune agent PreToolUse)  · T14 (provenance duration)  · T15 (docs/ADR)   (independent)
```

---

### Task 1: Hook-capability descriptor replaces `hasHooks` boolean
**Phase:** RED → GREEN → REFACTOR · **High-blast (schema reshape)**

1. [RED] `src/runtimes/types.ts` test `runtimes/types.test.ts`:
   - `CapabilitiesSchema_AcceptsHooksDescriptor_Parses` — `{hooks:{profile:'claude-json',canInjectContext:true,sessionStartEvent:'SessionStart',sessionEndEvent:'SessionEnd'}}` parses.
   - `CapabilitiesSchema_RejectsBareHasHooks_Throws` — legacy `{hasHooks:true}` now fails `.strict()`.
   - `CapabilitiesSchema_ProfileNone_AllowsNullEvents` — generic `{hooks:{profile:'none',canInjectContext:false,sessionStartEvent:null,sessionEndEvent:null}}` parses.
   - Expected failure: `hooks` key unknown under current schema.
2. [GREEN] Add `HooksDescriptorSchema` (`profile: enum['claude-json','cursor-json','copilot-json','opencode-plugin','none']`, `canInjectContext: boolean`, `sessionStartEvent: string|null`, `sessionEndEvent: string|null`); replace `hasHooks` in `CapabilitiesSchema`.
3. [REFACTOR] Export `HooksProfile` type for renderer consumption.

**Dependencies:** None · **Parallelizable:** No (foundation)

---

### Task 2: Populate `hooks` descriptor in all 6 runtime YAMLs + regenerate embedded
**Phase:** RED → GREEN → REFACTOR · **High-blast — run full suite after merge**

1. [RED] Per-runtime tests (`servers/exarchos-mcp/src/runtimes/<rt>.test.ts` + `src/runtimes/*` loader tests):
   - `ClaudeRuntime_HooksProfile_IsClaudeJsonInjecting`
   - `CodexRuntime_HooksProfile_IsClaudeJsonInjecting` (shares Claude schema)
   - `OpencodeRuntime_HooksProfile_IsOpencodePluginNonInjecting`
   - `CursorRuntime_HooksProfile_IsCursorJsonInjecting`
   - `CopilotRuntime_HooksProfile_IsCopilotJsonNonInjecting`
   - `GenericRuntime_HooksProfile_IsNone`
   - Expected failure: YAMLs still carry `hasHooks`; loader rejects.
2. [GREEN] Edit `runtimes/{claude,codex,opencode,cursor,copilot,generic}.yaml` per §4.3 matrix; run `npm run codegen:runtimes` to regenerate `src/runtimes/embedded.ts`. Descriptor records *true* capability (codex `sessionEndEvent: Stop`); what the renderer emits now is a separate decision (see T6 G1 rule).
3. [REFACTOR] Confirm `runtimes:guard` clean (no embedded drift).

**Dependencies:** T1 · **Parallelizable:** No

---

### Task 3: Binding directive source-of-truth + `renderBindingBlock`
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-binding.test.ts`:
   - `RenderBindingBlock_SubstitutesMcpPrefix_InjectsPrefix` — `{{MCP_PREFIX}}` → runtime prefix.
   - `RenderBindingBlock_WrapsInMarkers_FencedIdempotent` — output bracketed by `<!-- exarchos:binding:start -->` / `<!-- exarchos:binding:end -->`.
   - Expected failure: module/function absent.
2. [GREEN] Add `binding-src/binding.md` (canonical one-paragraph directive with `{{MCP_PREFIX}}`/`{{COMMAND_PREFIX}}`); add `renderBindingBlock(placeholders)` reusing `render()` from `build-skills.ts`.
3. [REFACTOR] Co-locate marker constants for reuse by the consumer-install (v2.10.2) path.

**Dependencies:** None · **Parallelizable:** Yes (vs verb chain)

---

### Task 4: Renderer emits universal AGENTS.md/CLAUDE.md binding block for all 6 runtimes
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-hooks.test.ts` (renderer is generalizing — rename suite to binding):
   - `BuildBinding_EveryRuntime_EmitsBindingBlock` — all 6 produce a binding artifact (`binding/<rt>/AGENTS.md`; claude → `binding/claude/CLAUDE.md`) containing the fenced block.
   - `BuildBinding_Block_CarriesRuntimeMcpPrefix` — codex/opencode get `mcp__exarchos__`, claude gets plugin prefix.
   - Expected failure: renderer has no binding-block path.
2. [GREEN] Extend `buildAllHooks` (→ `buildAllBindingArtifacts`) to write the binding block per runtime using `renderBindingBlock` + `rt.placeholders`.
3. [REFACTOR] Single `written` set drives stale-cleanup (preserve existing narrow-scope deletion guarantees).

**Dependencies:** T2, T3 · **Parallelizable:** No (shared `build-hooks.ts`)

---

### Task 5: Restructure `hooks-src/hooks.json` → SessionStart + SessionEnd (drop SubagentStop)
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-hooks.test.ts`:
   - `HooksSource_ContainsSessionStartAndEnd_NoSubagentStop` — parsed template has `SessionStart` (cmd `exarchos session-start`) + `SessionEnd`, and **no** `SubagentStop`.
   - Expected failure: source still has SubagentStop, no SessionStart.
2. [GREEN] Edit `hooks-src/hooks.json`: remove `SubagentStop`; add `SessionStart` (matcher `startup|resume`, command `exarchos session-start ...{{MCP_PREFIX}}...`); keep `SessionEnd`.
3. [REFACTOR] none.

**Dependencies:** None · **Parallelizable:** Yes (data file; sequence before T6)

---

### Task 6: Profile-dispatched active artifact — `claude-json` → hooks.json (Claude + Codex)
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-hooks.test.ts`:
   - `BuildBinding_ClaudeJsonProfile_EmitsHooksJson` — claude → `hooks/hooks.json`; codex → `hooks/codex/hooks.json`.
   - `BuildBinding_Claude_RendersSessionStartAndEnd` — claude hooks.json has both `SessionStart` + `SessionEnd`.
   - **G1:** `BuildBinding_Codex_RendersSessionStartOnly` — codex hooks.json has `SessionStart` but **no `SessionEnd`** (Codex's end event is `Stop`, deferred per §8; session-end's transcript parser is Claude-specific). The template tokenizes event keys; the renderer emits a SessionEnd block only when `descriptor.sessionEndEvent === 'SessionEnd'`.
   - `BuildBinding_DispatchesOnProfileNotRuntimeName` — assert no runtime-name literal branch (INV-4): a synthetic `claude-json` runtime also emits hooks.json.
   - Expected failure: renderer keyed on old `hasHooks`/claude-name; fixed `SessionEnd` key.
2. [GREEN] Replace `rt.capabilities.hasHooks` check with `switch (rt.capabilities.hooks.profile)`; `claude-json` path renders `hooks-src/hooks.json` with `{{SESSION_START_EVENT}}` substituted and the SessionEnd block gated on `sessionEndEvent === 'SessionEnd'`.
3. [REFACTOR] Keep Claude's well-known top-level `hooks/hooks.json` path; codex under `hooks/codex/`.

**Dependencies:** T2, T5 · **Parallelizable:** No (shared file, after T4)

---

### Task 7: Profile-dispatched active artifact — `opencode-plugin` → TS lifecycle plugin
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-hooks.test.ts`:
   - `BuildBinding_OpencodePluginProfile_EmitsTsPlugin` — opencode → `hooks/opencode/plugin/exarchos-lifecycle.ts` exporting an async plugin with an `event` handler branching on `session.created` (→ `exarchos session-start`) and `session.idle` (→ `exarchos session-end`).
   - `BuildBinding_OpencodePlugin_DoesNotInjectContext` — plugin contains no additionalContext (binding via AGENTS.md only).
   - Expected failure: no plugin template.
2. [GREEN] Add `hooks-src/opencode-plugin.ts.tmpl`; renderer writes it for `opencode-plugin` profile, substituting `{{MCP_PREFIX}}`.
3. [REFACTOR] Note `session.idle` ≠ session-end (may fire repeatedly) — guard with idempotency comment for the implementer.

**Dependencies:** T2 · **Parallelizable:** No (shared file, after T6)

---

### Task 8: Corrected notes for deferred/none profiles (cursor-json, copilot-json, none)
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-hooks.test.ts`:
   - `BuildBinding_DeferredProfile_EmitsAccurateNote` — cursor/copilot `HOOKS.md` says "runtime supports hooks; Exarchos renders them in a future release; the AGENTS.md binding is active now" — **not** the stale "does not support hooks."
   - `BuildBinding_NoneProfile_GenericNote` — generic note references AGENTS.md as the binding surface.
   - Expected failure: `manualStepsNote` still says "does not declare hasHooks: true".
2. [GREEN] Rewrite `manualStepsNote()` to branch on profile (deferred vs none) with accurate copy.
3. [REFACTOR] none.

**Dependencies:** T2 · **Parallelizable:** No (shared file, after T7)

---

### Task 9: `session-start` handler — emit `session.started` + additionalContext
**Phase:** RED → GREEN → REFACTOR

1. [RED] `servers/exarchos-mcp/src/cli-commands/session-start.test.ts`:
   - `HandleSessionStart_ValidInput_WritesManifestEntry` — calls `writeManifestEntry` with `{sessionId,startedAt,cwd,branch,workflowId?}`.
   - `HandleSessionStart_InjectingHost_ReturnsAdditionalContext` — returns `{additionalContext:<directive>, continue:true}` when a directive is supplied (baked into the rendered hook command at build).
   - `HandleSessionStart_MissingSessionId_ReturnsError` — `MISSING_SESSION_ID`.
   - `HandleSessionStart_DuplicateSession_Idempotent` — existing entry → `{continue:true}`, no duplicate write.
   - Expected failure: handler absent.
2. [GREEN] Add `cli-commands/session-start.ts` `handleSessionStart(stdin, stateDir, opts?)` mirroring `session-end.ts` validation/idempotency; write manifest entry; emit additionalContext from the build-baked directive (per-runtime prefix substituted at build, passed via hook command arg).
   - **G2 (accepted deviation from design §4.5):** write the `session.started` record to the **manifest** (`writeManifestEntry` → `manifest.jsonl`), **NOT** `sessions/<id>.events.jsonl`. The latter is `session-end`'s idempotency sentinel (`session-end.ts:79`); creating it at start would make `session-end` early-return and silently skip transcript parsing → broken provenance. Reconcile design §4.5 prose to the manifest-entry surface.
3. [REFACTOR] Observe-only/fail-open: never return a policy `error`; never trigger rehydration (T-40 guard).
   - **G3 (INV-2 scope):** `session-start` is a hook-CLI observer like `session-end` — **no MCP action / `outputSchema`** (session-end has none). The design DoD's "registered outputSchema; CLI/MCP parity" is N/A for hook observers; INV-2 governs MCP-visible verbs only.
   - Cursor's `additional_context` (snake) format is a future `--format` concern (cursor renderer deferred).

**Dependencies:** T1 (schema only nominally) · **Parallelizable:** Yes (vs renderer chain)

---

### Task 10: Wire `session-start` into hook router; remove `subagent-stop`
**Phase:** RED → GREEN → REFACTOR

1. [RED] `servers/exarchos-mcp/src/adapters/hooks.test.ts`:
   - `IsHookCommand_SessionStart_ReturnsTrue`
   - `IsHookCommand_SubagentStop_ReturnsFalse` (invert existing `..._ReturnsTrue`)
   - `HOOK_COMMANDS_IsObserverOnlySet` — set is exactly `{session-start, session-end}`.
   - `HandleHookCommand_SessionStart_ReturnsHandledTrue`
   - Expected failure: set still `{session-end, subagent-stop}`.
2. [GREEN] `adapters/hooks.ts`: `HOOK_COMMANDS = {session-start, session-end}`; add `session-start` handler import; delete `subagent-stop` handler entry.
3. [REFACTOR] Update ADR-referencing comment block (still observe-only; now start+end).

**Dependencies:** T9 · **Parallelizable:** No (after T9)

---

### Task 11: Delete `subagent-stop` handler, test, and any registration
**Phase:** RED → GREEN

1. [RED] Removal-driven: the deleted `subagent-stop.test.ts` + the inverted `adapters/hooks.test.ts` (T10) assert no route exists; grep-guard test `NoSubagentStopReferences_InHookLayer` (optional) asserts `subagent-stop` absent from `adapters/hooks.ts` + `hooks-src/`.
2. [GREEN] Delete `cli-commands/subagent-stop.ts` + `cli-commands/subagent-stop.test.ts`; remove any registry/index references.

**Dependencies:** T5 (hooks-src), T10 (router) · **Parallelizable:** No

---

### Task 12: Verify + prune unused agent `PreToolUse` pre-write/pre-edit trigger mappings
**Phase:** RED → GREEN · **Verify-first (lower confidence)**

1. [RED] `agents/adapters/claude.test.ts`: `TriggerMap_NoUnusedPreWritePreEdit_AfterPrune` — only mappings referenced by a shipped agent remain. **First confirm** via grep that no shipped agent (`agents/*.md`) references `pre-write`/`pre-edit`; if any does, SKIP this task and record the finding.
2. [GREEN] Remove the unused `TRIGGER_MAP` entries (keep `post-test`→`run-tests`, which is live).

**Dependencies:** None · **Parallelizable:** Yes

---

### Task 13: Build pipeline + drift guard for binding artifacts
**Phase:** RED → GREEN → REFACTOR

1. [RED] `src/build-hooks.test.ts` / guard test: `BindingGuard_ReRenderMatches_NoDrift` — re-render is byte-identical to committed `hooks/` + `binding/` tree.
2. [GREEN] Extend `dist/hooks-guard.js` (`hooks:guard`) to cover binding blocks + opencode plugin + corrected notes; ensure `npm run build:hooks` emits all artifacts; commit regenerated tree.
3. [REFACTOR] Fold under existing `hooks:guard` (no new top-level script — minimal surface). Update `CLAUDE.md` build-commands note if needed.

**Dependencies:** T4, T6, T7, T8 · **Parallelizable:** No (capstone of renderer chain)

---

### Task 14: Provenance enrichment — session duration from `session.started`
**Phase:** RED → GREEN · **Optional (nice-to-have)**

1. [RED] `session/session-provenance-projection.test.ts`: `MaterializeProvenance_WithStartedEntry_ComputesDuration` — when a manifest entry exists, roll-up includes `durationMs = completion.extractedAt − entry.startedAt`.
2. [GREEN] Read `startedAt` via `readManifestEntries` in the projection; add `durationMs`. Pure left-fold preserved (INV-1).

**Dependencies:** T9 · **Parallelizable:** Yes

---

### Task 15: Docs — record (b) decision + binding orientation
**Phase:** GREEN (docs)

1. Append to `docs/adrs/2026-05-24-hook-layer-observe-only.md`: the #1485(b) decision (KEEP SessionEnd as the binding-proof instrument) + the new observe-only SessionStart binding (fail-open, no auto-rehydration).
2. Update `documentation/guide/installation.md` per-harness rows with the binding surface (AGENTS.md universal floor + active hook/plugin where rendered). Note consumer-install lands in v2.10.2 `onboard`.

**Dependencies:** None (write after implementation lands) · **Parallelizable:** Yes

---

## Parallelization Summary

- **Sequential foundation:** T1 → T2 (high-blast; full suite after T2).
- **Renderer chain (serial — shared `src/build-hooks.ts`):** T3 ∥ start, then T4 → T6 → T7 → T8 → T13. T5 before T6.
- **Verb chain (parallel to renderer):** T9 → T10 → T11.
- **Independent:** T12 (verify-first), T14 (optional), T15 (docs).

## Definition of Done

Maps to design §9 + #1485 acceptance: (b) decision recorded (T15); SessionStart binding for Claude+Codex + opencode plugin (T5–T7, T9–T10); universal AGENTS.md block all 6 (T4); SubagentStop + dead code removed (T8, T11, T12); `hooks` descriptor replaces `hasHooks` (T1–T2); `session-start` verb (T9); all guards green (T13). Consumer-install explicitly deferred to v2.10.2 `onboard`.
