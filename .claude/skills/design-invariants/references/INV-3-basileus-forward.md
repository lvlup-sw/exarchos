# INV-3: Basileus-Forward (No MCP-Second-Class Assumptions)

No design decision presumes MCP is local-only. The Exarchos ↔ Basileus coordination ADR (`basileus/docs/adrs/ontological-data-fabric.md`) cements two-channel transport (Workflow client A on `/mcp/workflow`, Ontology client B on `/mcp/ontology`) with independent client lifecycles, handshake-authoritative capability resolution, and `.exarchos.yml`-only configuration. Workspace discovery prefers the MCP roots capability over cwd heuristics (post-#1269). The remote-MCP surface throws-not-degrades when called (#1081) — explicit "not yet, but designed-for" rather than silent fallback.

## Acceptance questions (from #1109 §3 + ADR §§2.1, 2.4, 2.7, 2.8)

1. No reads of `runtimes/*.yaml` capability fields at runtime — the resolver merging `yaml ⊕ handshake` is the only authority.
2. `agent` namespace remains reserved for future remote agent coordination (not AI-assistant setup).
3. New config lands in `.exarchos.yml` only — no `bridge-config.json`-style sibling files.
4. Sideband daemon assumptions hold across all runtimes (not Claude-Code-specific).
5. **Roots awareness** ([#1269](https://github.com/lvlup-sw/exarchos/issues/1269)) — workspace discovery via the spec's `roots` capability rather than `cwd` heuristics, capability-gated so non-roots clients still work.

## Repo-grounded checks

- New code that needs a capability decision goes through the resolver (`servers/exarchos-mcp/src/capabilities/resolver.ts`), never directly through `runtimes/<name>.yaml` reads.
- Two-channel architecture: workflow operations and ontology operations have **distinct** MCP client lifecycles. Workflow client A binds to `/delegate` phases; Ontology client B is always-on (per ADR §2.4). Don't fuse them or assume one's lifecycle covers the other's.
- Sideband daemon (`exarchos watch`) is the universal floor (ADR §2.4) — the same idle-session awareness available on Claude Code via Channel must work on OpenCode and generic MCP clients.
- Configuration consolidates in `.exarchos.yml` (ADR §2.7) — no separate `bridge-config.json` or sibling files. New config keys go here; document the schema in the resolver.

## Pre-#1269 vs post-#1269 (Roots adoption)

Pre-#1269: workspace discovery uses `cwd` heuristics. Acceptable interim, but every such usage is a candidate for the post-#1269 amendment.

Post-#1269: workspace discovery uses the MCP `roots` capability when the client declares it. The capability is negotiation-time (initialize handshake), so the resolver knows whether `roots` is available before any tool call. Capability-gated: clients without `roots` fall back to `cwd` cleanly.

## External grounding

- AgentPatterns [*Capability Negotiation*](https://agentpatterns.ai/tool-engineering/mcp-client-server-architecture/) — version negotiation is mandatory; servers without a match disconnect rather than silently degrade. Both parties MUST respect negotiated capabilities for the entire session.
- IBM [*MCP Architecture Patterns*](https://ibm.github.io/mcp-context-forge/best-practices/mcp-architecture-patterns/) — single-responsibility servers (S1), workflow-oriented tools (S2); central host policy and consent.
- MCP spec *2025-11-25 §Roots* — the spec's standard mechanism for client-declared workspace boundaries; basileus-forward designs prefer this over implicit `cwd`.
- `basileus/docs/adrs/ontological-data-fabric.md` §§2.1, 2.4, 2.7, 2.8 — the four invariants this references.

## Severity guide

- **HIGH:** hard-coded "MCP is local" assumption (synchronous file I/O blocking the dispatch path; hostname guesses; assumed-local file paths); workspace path inferred from `cwd` when `roots` is available; runtime read of `runtimes/<name>.yaml` capability fields bypassing the resolver.
- **MEDIUM:** capability check that doesn't go through the resolver; new config landing outside `.exarchos.yml`; fused client lifecycles where the ADR demands separation.
- **LOW:** design that works remotely but is less efficient than necessary (e.g., chatty round-trips that could batch).

## Worked example

**Violation (HIGH):** New verb reads runtime YAML directly:

```ts
// orchestrate/check-runtime.ts — DON'T
import * as yaml from 'yaml';
const runtimeConfig = yaml.parse(fs.readFileSync('runtimes/claude.yaml', 'utf8'));
if (runtimeConfig.placeholders.SUBAGENT_COMPLETION_HOOK === 'TeammateIdle hook') {
  // Claude-specific behavior
}
```

This bypasses the resolver, which means the runtime decision is locked to whatever the YAML file says — even if the actual handshake declared a different capability. Remote MCP clients lose.

**Fix:** Go through the resolver:

```ts
// orchestrate/check-runtime.ts — DO
import { resolveCapability } from '../capabilities/resolver.js';
const cap = await resolveCapability(ctx, 'subagent-completion-hook');
if (cap.kind === 'native' && cap.value === 'TeammateIdle hook') {
  // ...
}
```

The resolver merges `yaml ⊕ handshake`. The handshake is authoritative; YAML is the default.

**Violation (HIGH):** New verb takes a CLI argument and assumes it's a local path:

```ts
// dispatch/handle-export.ts — DON'T
export async function handleExport(args: { destination: string }) {
  await fs.promises.writeFile(args.destination, payload);
}
```

This works for local CLI but breaks for remote MCP — the `destination` path is meaningful only on the *server's* filesystem, which the agent calling MCP cannot reach.

**Fix:** Either return the payload in the `ToolResult` (let the client write it, capability-gated), or use MCP Resources ([#1275](https://github.com/lvlup-sw/exarchos/issues/1275)) once available, or make the destination an opaque identifier resolved server-side.

## See also

- Deterministic checks for INV-3 — none required (reasoning-driven; flagged design-time)
- [INV-2](INV-2-facade-equivalence.md) — facade equivalence is what makes the resolver behave identically across CLI and MCP carriers
- [INV-4](INV-4-platform-agnosticity.md) — platform-agnosticity discipline applies to capability declarations
