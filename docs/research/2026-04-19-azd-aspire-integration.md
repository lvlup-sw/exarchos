# Exarchos × azd × Aspire: Integration Research

**Status:** Research (discovery phase). Not an implementation plan.
**Workflow:** `azd-aspire-integration`
**Date:** 2026-04-19

**Related internal:**
- `CLAUDE.md` — "agent-first CLI patterns (Aspire-inspired)" is already a stated design principle
- `docs/designs/2026-03-05-ga-extensibility.md` — Exarchos already exposes `registerCustomTool`, `registerCustomWorkflows`, `registerCustomView`
- `project_v3_roadmap.md` (memory) — v3.0 pillars #1087–#1091, cross-cutting #1109
- Azure DevOps VCS provider: `servers/exarchos-mcp/src/vcs/azure-devops.ts`
- Microsoft Learn companion MCP: `packages/create-exarchos/src/companions.ts:72–79`

**External references:**
- azd extension framework: [Azure/azure-dev/cli/azd/docs/extension-framework.md](https://github.com/Azure/azure-dev/blob/main/cli/azd/docs/extension-framework.md)
- Aspire MCP server: [aspire.dev/reference/cli/commands/aspire-agent-mcp](https://github.com/microsoft/aspire.dev/blob/main/src/frontend/src/content/docs/reference/cli/commands/aspire-agent-mcp.mdx), shipped in Aspire 13.2
- Local `aspire` skill at `~/.claude/skills/aspire/` (already installed via Claude Code)

---

## 1. Executive summary

Three CLIs, three different problems, one shared premise: **agent-first, composable command surfaces with structured output**. Exarchos orchestrates SDLC workflows. `aspire` operates the local AppHost and Azure-bound deploys. `azd` provisions and deploys Azure infra from a project model. They do not overlap — they **stack**.

There are three integration vectors, ranked by leverage:

1. **Exarchos as an azd extension** (`azd x` → `azd exarchos <action>`). azd's Go/gRPC extension framework is the closest analogue to Exarchos's own custom-tool registry, and it would put Exarchos's workflow primitives directly into the Azure developer loop without requiring Claude Code. Medium cost (Go shim + gRPC client), high reach.
2. **Aspire MCP federation** (mount `aspire agent mcp` alongside `exarchos mcp`). Aspire 13.2 already ships a Claude Code-compatible MCP server and an `aspire agent init` scaffolder. Exarchos skills can call `aspire_*` tools for live resource state during `/exarchos:debug` or `/exarchos:shepherd` without any code in Exarchos. Near-zero cost, narrow but high-signal reach.
3. **Three-CLI unified SDLC trace**. An Exarchos workflow spans review → `aspire publish` → `azd up` → PR merge, with each step emitting into the Exarchos event stream and each CLI remaining the authority over its own domain. High cost, strategic payoff — it is the v3.0 cross-cutting story (#1109) made concrete for .NET/Azure users.

Vector 2 is zero-lift and should be the first thing we validate. Vector 1 is the real question this report tries to answer. Vector 3 is aspirational and depends on both.

## 2. Surface inventory

### 2.1 Exarchos today

- **Distribution:** standalone CLI (`exarchos install | mcp | install-skills`), Claude Code plugin, marketplace-registered (`@lvlup-sw/exarchos`). Node 20+, ESM, TypeScript. `src/install.ts:26, package.json:7`.
- **MCP surface:** 4 public composite tools (`exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`) + `exarchos_sync` hidden.
- **Extension surface:** `registerCustomTool`, `registerCustomWorkflows`, `registerCustomView`, all resolved from `.exarchos.yml` at MCP startup (`servers/exarchos-mcp/src/config/register.ts:1–149`). External code can register composite-tool actions today.
- **Runtime independence:** skill rendering to 6 runtimes (`claude`, `codex`, `copilot`, `cursor`, `opencode`, `generic`) — Exarchos already treats "non-Claude users" as a first-class axis (`src/runtimes/load.ts:29–36`).
- **Azure footprint today:** Azure DevOps as a VCS provider; Microsoft Learn companion MCP. **No Aspire or azd touchpoint.**

### 2.2 azd extension framework

- **Scaffold + lifecycle:** `azd x init | build | watch | pack | release | publish`. Registry lives at `~/.azd/registry`; extensions are distributed via GitHub releases and a `registry.json` manifest.
- **Manifest:** YAML with `id`, `namespace`, `capabilities: [custom-commands, lifecycle-events]`, `examples`. Any subcommand you register under your namespace becomes `azd <namespace> <command>`.
- **gRPC contract (proto):** extensions run out-of-process and talk to azd core over gRPC. Services exposed: `Project`, `Environment`, `Prompt`, `Event`, `Workflow`, `Deployment`, `Compose`, `UserConfig`. The `Prompt` service is "UX as a service" — extensions get consistent interactive UX without re-implementing it.
- **Reference implementation:** `microsoft.azd.demo` is Go; the gRPC framing means any language works, but the SDK path is Go-first.
- **AI/MCP status:** no azd MCP server today. The demo extension integrates Azure AI resource catalogs (model deployment, quotas) — that is AI-as-*resource*, not agent-tooling. The SDK-side Azure MCP server (`eng/common/mcp/azure-sdk-mcp.ps1`) is unrelated infra for Azure SDK development.

### 2.3 Aspire CLI

- **App lifecycle:** `aspire new | init | start | stop | ps | describe | wait | add | update | restore | doctor`.
- **Observability:** `aspire logs | otel logs | otel traces | export`.
- **Deploy:** `aspire publish | deploy | do <step>`. Azure Container Apps via `azd up` remains the default deploy backend, but Aspire 9.3+ made publisher selection internal (resource-annotation driven).
- **Docs for agents:** `aspire docs search | get`, `aspire docs api search | get` — a first-class way to pull authoritative Aspire API/workflow docs without WebFetch.
- **MCP server (13.2):** `aspire agent mcp` serves an MCP stdio endpoint exposing resource management, logs/traces, resource commands, integration info. `aspire agent init` **auto-detects Claude Code and writes `.mcp.json`** — this is the exact path Exarchos uses today.

## 3. The fit: why these three stack cleanly

| Axis | Exarchos | azd | Aspire |
|---|---|---|---|
| Owns | SDLC workflow state, agent orchestration | Azure infra provisioning + env lifecycle | Local AppHost + distributed-app telemetry |
| State store | JSON event streams (per-workflow) | Azure subscription + local env folder | AppHost process + OTel pipeline |
| Extension point | custom-tool / workflow / view registry | gRPC extensions under `azd <namespace>` | custom resources + `WithCommand`; MCP tools |
| Agent exposure | MCP server (stdio) | none today | MCP server (stdio, 13.2+) |
| Azure coupling | none | total | strong but optional |

**The non-overlap is the point.** Exarchos never wants to own "how to provision a Container App" or "how to start a PostgreSQL sidecar locally". azd and Aspire already own those. Conversely, neither azd nor Aspire wants to own "workflow phase transitions with saga compensation" or "review-classifier triage" — that is Exarchos.

What is missing is a **shared trace**: when an Exarchos workflow kicks off a deploy, the azd/Aspire side of the story disappears into stderr. A shared trace is the integration thesis.

## 4. Integration vectors

### Vector 1 — Exarchos as an azd extension

**Shape.** An extension with manifest `id: lvlup.exarchos`, `namespace: exarchos`, `capabilities: [custom-commands, lifecycle-events]`. It registers `azd exarchos workflow init|get|set`, `azd exarchos event append|query`, and a curated subset of orchestrate actions. Under the hood, the extension is a thin client that spawns `exarchos mcp` as a subprocess and proxies calls, or (cleaner) wraps the handler library directly via a Node child process with NDJSON over stdio.

**Why this specifically.** Three properties make this vector qualitatively better than the alternatives:

1. **Reaches Azure devs where they already are.** Every `azd init` user is a candidate; they never have to know about Claude Code, MCP, or the plugin marketplace.
2. **Gives Exarchos event-stream access to azd's own lifecycle events.** The azd `Event` gRPC service lets extensions subscribe to project/service events (pre-deploy, post-deploy, env-up, env-down). Exarchos can append these as `deploy.*` events into the workflow stream without any polling.
3. **`Prompt` gRPC service = free UX parity.** Exarchos CLI prompts today are inconsistent with the azd experience. Delegating to azd's prompt service inside an azd-hosted extension means a deploy-triggered workflow gets the same subscription-picker and env-selector the rest of azd uses.

**Cost.** Moderate. The azd extension SDK is Go-first; a Go shim that shells to `node dist/exarchos.js mcp` is small (~500 LOC) but adds a Go build artifact to the repo. Alternative: write the extension in TypeScript, handle gRPC manually via `@grpc/grpc-js`. Both work; Go is less friction for distribution.

**Risks.**
- **Violates "standalone CLI" principle** if it becomes the primary install path. The `.claude-plugin` surface must remain first-class; azd extension is a *second* distribution, not a replacement.
- **Registry story.** azd extensions publish to a GitHub-hosted registry; Exarchos would need a versioned release pipeline for the shim binaries across OS × arch. Doable, non-trivial.
- **Scope bleed.** It is tempting to expose all 50+ orchestrate actions. Don't. Pick the 6–8 that make sense inside an azd project (workflow init, event append/query, pipeline view, a read-only status surface). The extension should feel like "azd-native Exarchos", not "Exarchos-but-run-via-azd".

### Vector 2 — Aspire MCP federation

**Shape.** Zero Exarchos code. In projects with an Aspire AppHost, the user runs `aspire agent init` once. This writes `.mcp.json` listing `aspire` alongside `exarchos`. Both MCP servers are now visible to Claude Code (or any MCP client) in the same session.

**Exarchos side.** Update relevant skills (`/exarchos:debug`, `/exarchos:shepherd`, `/exarchos:oneshot`) to **detect** an adjacent Aspire AppHost and, when found, prefer `aspire_*` tools for runtime state over shelling out to `dotnet` or reading logs directly. This is a documentation change, not a code change.

**Why this works now.** The Aspire MCP server is already Claude Code-compatible. The `.mcp.json` it writes is the same schema Exarchos uses. No bridge code is needed; MCP is the bridge.

**Cost.** Near zero. A skill update in `skills-src/debug/references/` and `skills-src/shepherd/references/` adding an "if Aspire AppHost, prefer `aspire` MCP for live state" paragraph. One PR.

**Risks.**
- **Runtime drift.** We would be recommending an external tool whose behavior Exarchos does not control. If Aspire's MCP tool names change between 13.2 and 13.3, our skills go stale. Mitigation: treat the guidance as examples, not hard dispatch.
- **Not all MCP clients.** Only clients where the user has installed both servers see the federation. The skill language must be conditional.

### Vector 3 — Unified SDLC trace across all three

**Shape.** An Exarchos workflow type `cloud-ship` that bakes in three phases:
1. `review` (existing Exarchos) — design + plan + TDD task dispatch
2. `publish` — call `aspire publish` (via MCP tool or shell), emit `publish.artifacts_generated` into the workflow stream with the Bicep/Compose output paths
3. `deploy` — call `azd up` (via the azd extension from Vector 1, or shell), emit `deploy.started` / `deploy.resource_provisioned` / `deploy.completed` by subscribing to azd's `Event` gRPC service

**Why this is the strategic bet.** It turns Exarchos into the *system of record* for a deploy's entire narrative. Today when a deploy fails in CI, a reviewer has to stitch together the Exarchos PR thread, the Aspire AppHost logs, and the azd deploy output from three terminals. A `cloud-ship` workflow collapses all three into one event stream that `exarchos_view` can render.

**Cost.** High. Depends on Vector 1 (extension needed for live azd event subscription) and Vector 2 (skill guidance for Aspire live state). A new workflow type, a new phase topology, synthesis hooks, shepherd hooks. Not v3.0 — more like v3.1 or v4.0.

**Risks.**
- **Defining "success" across three tools.** Exarchos's gate model (D1–D5 dimensions) does not natively map to "did the Container App health probe go green". A cloud-ship workflow has to define post-deploy gates that are Azure-specific, and that pushes Azure concepts into Exarchos's core.
- **Over-indexing on Azure.** If `cloud-ship` becomes a first-class workflow type, it tilts Exarchos toward Azure in a way the VCS-provider abstraction has so far avoided.

## 5. What Exarchos should borrow, not integrate

Independent of the vectors above, two patterns from these CLIs are worth copying into Exarchos itself:

**From Aspire: `WithCommand` on resources.** Aspire lets an AppHost author attach named commands to a resource (e.g., `myservice.WithCommand("seed-data", ...)`), surfaced both in the dashboard and via MCP. The Exarchos analogue would be **per-task custom actions**: an implementer task could declare `withCommand("rerun-failing-tests", ...)` and the shepherd/reviewer could invoke it without having to know the task's internal shape. Low cost, high UX win.

**From azd: `Prompt` as a service.** azd's insight that "interactive UX is a shared service, not per-extension code" is exactly the problem Exarchos has today — every custom tool re-invents its own prompting. A `PromptService`-style gRPC-or-MCP surface where Exarchos extensions delegate prompting back to the host would make the custom-tool story much more consistent.

Both are independent of the integration vectors and could ship inside v3.0 extensibility (#1087).

## 6. Recommendation

**Do Vector 2 now.** A single PR updating `debug`, `shepherd`, and `oneshot` skills to reference `aspire agent mcp` when an Aspire AppHost is detected. This is the cheapest signal that the three-CLI thesis has users.

**Plan Vector 1 for v3.1.** The azd extension is the real integration. It should be designed against the v3.0 extensibility surface (#1087) — if the Exarchos custom-tool API is well-shaped, the extension is thin. If it is not, the extension work will drive the API harder than Claude Code alone ever would. That pressure is valuable.

**Defer Vector 3 until after Basileus.** A `cloud-ship` workflow type belongs in the world where Basileus handles the remote agent surface and Exarchos stays local-authoritative for workflow state. Revisit after the Basileus posture (see `project_basileus_mcp_posture.md`) firms up.

**Adopt the `WithCommand` and `PromptService` patterns inside v3.0.** Both are independently justified; the integration framing is a bonus.

## 7. Open questions

1. Does the azd extension framework support non-Go extensions in practice, or is the Go SDK path a de facto requirement? (Answer by prototyping a TypeScript extension against the gRPC protos.)
2. What is the Aspire MCP tool surface exactly — names, args, return shapes? Needed before the skill update in Vector 2 can be specific about which `aspire_*` tools replace which Exarchos shell-outs.
3. Does Aspire 13.2's `aspire agent init` conflict with Exarchos's `.mcp.json` when both scaffold to the same file? (Test: run `aspire agent init` in an Exarchos-plugin-enabled repo.)
4. If Exarchos ships as an azd extension, what is the signed-release / supply-chain story? azd extensions trust GitHub releases; Exarchos today ships via npm + Claude Code marketplace.
