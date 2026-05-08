# VcsProvider Thread-Reply Fitness — #1165 vs Overhauled Milestones

**Date:** 2026-05-07
**Workflow:** `discover-vcsprovider-thread-reply-fitness`
**Scope:** Disposition recommendation for issue #1165 (provider-agnostic per-thread comment replies) against the recently overhauled v2.10–v3.1 milestones.
**Decision required:** Single milestone reassignment + acknowledgment of two implementation-time decisions.

## Executive summary

Issue `#1165` is **stale in v2.9.0 but fit-for-purpose in scope**. It is mis-milestoned, not obsolete. v2.9.0 GA has shipped (per `docs/contexts/2026-05-07-p4-shepherd-handoff.md`: "v2.9.0 GA already shipped — P1/P2/P3 merged") and the milestone has narrowed to install/cross-platform charter. The thread-reply primitive's only credible consumer — the autonomous shepherd loop — has been **decisively relocated to v2.11.0** under #1120 (self-healing PR shepherd) and #1263 (long-running headless daemon). The issue should follow.

## Disposition recommendation: **Move to v2.11.0 — Autonomous Orchestration**

Grounded in evidence:

- **Demand is concentrated in v2.11.0.** #1120 and #1263 explicitly extend the `comment-reply` action that today falls through to a Claude-Code-specific GitHub MCP namespace. A headless shepherd polling on a cron (#1263 acceptance: "runs unattended through at least one CI + review-bot cycle") cannot rely on a `mcp__plugin_github_github__*` tool — it needs a `VcsProvider`-mediated primitive to stay provider-agnostic across GitLab and Azure DevOps targets.
- **No v2.10.0 fit.** v2.10.0 (Agent Output Contract) is HATEOAS/NDJSON envelope work — #1287, #1288, #1290, #1291 are carrier/schema migrations. Thread-reply is an orthogonal VCS-surface primitive.
- **No v3.1.0 fit.** v3.1.0 (#1258 Workflow Builder SDK) is TypeSpec IR + combinators + registration. None of the P1–P11 sub-issues touch VCS abstractions.
- **Not obsolete.** `skills-src/shepherd/SKILL.md:154` still bears the platform-specific MCP fallback note pointing at #1165. No newer issue supersedes it.
- **Not "keep in v2.9.0."** The milestone is now a post-GA holding pen; leaving #1165 there guarantees it stays unscheduled.

## Consumer landscape

| Consumer | Status | Need |
|---|---|---|
| `skills-src/shepherd/SKILL.md:154` (interactive shepherd) | **Active today** | References #1165 as the tracking issue for breaking the GitHub-MCP dependency on `mcp__plugin_github_github__add_reply_to_pull_request_comment` |
| #1120 — self-healing autonomous PR shepherd | **Planned (v2.11.0)** | Parallel fix dispatch per cluster needs provider-neutral reply |
| #1263 — long-running headless shepherd daemon | **Planned (v2.11.0)** | Cannot embed Claude-Code-specific MCP namespace in unattended loop |
| v3.3.0 remote agent layer | **Hypothetical** | Could surface remote review threads, but no current v3.3.0 issue lists VCS abstractions |
| v2.10.0 envelope work (#1287/#1288/#1291) | **Not a consumer** | Orthogonal axis |
| v3.1.0 SDK (#1247–#1258) | **Not a consumer** | Workflow IR, not VCS surface |

## Architecture fit

**#1109 C3 (basileus-forward / transport-agnostic):** Strong fit. Current shepherd workaround embeds a Claude-Code-specific MCP tool name in skill prose — exactly the leakage C3 forbids. The `VcsProvider` abstraction in `servers/exarchos-mcp/src/vcs/provider.ts:87-99` already encapsulates GitHub/GitLab/Azure DevOps; adding `addReply(prId, threadId, body)` extends it at the right seam.

**Axiom dimensions:**
- **Abstractions:** Right level. `VcsProvider` already owns `addComment`; `addReply` is the missing thread-aware sibling. No new layer needed.
- **SOLID (OCP):** Adding to the interface is borderline OCP-violating but acceptable: (a) all three concrete providers must implement symmetrically, and (b) `UnsupportedOperationError` (provider.ts:101) already exists as graceful-degradation escape hatch for partial adapters.
- **Architecture (DIP):** Extending `VcsProvider` keeps shepherd consumers depending on the abstraction, not concrete MCP namespaces — dependency direction stays correct.

The acceptance criteria as written (interface method + orchestrate action + GitHub adapter + skill update + adapter test) match the established `VcsProvider` pattern (compare `add-pr-comment.ts` + provider method + adapter test triple).

## Open questions

1. **Thread ID portability.** Issue says "or equivalent shape that fits GitHub / GitLab / Azure DevOps reply APIs uniformly." GitLab discussions, Azure DevOps thread IDs, and GitHub review-thread IDs differ (string vs int vs GraphQL node ID). Implementer must decide: universal `threadId: string` or per-provider opaque IDs flowing through unchanged.

2. **Hard-dep relationship to #1263.** Today #1263 does not declare #1165 as a hard dependency, but #1263's "no platform-specific MCP" implication is load-bearing. Worth marking #1165 as a blocker of #1263 when relabeling.

3. **GraphQL alternative.** `docs/designs/2026-02-16-coderabbit-review-gate.md:91,160` already uses GitHub's `reviewThreads` GraphQL surface. Implementer should decide whether `addReply` reuses that path or stays REST.

4. **Relationship to #1118 (architectural principles codification).** If #1118 codifies the platform-agnostic invariant, #1165 may want to land alongside or after it as the first concrete enforcement. Currently both linger in v2.9.0 — pairing them in the relabel pass is reasonable.

## Recommended next action

Relabel #1165 from v2.9.0 to v2.11.0 in the same pass that handles the checkpoint cluster (`docs/research/2026-05-07-checkpoint-cluster-fitness.md`). When relabeling, add the `blocks` relationship from #1165 → #1263 to make the dependency explicit. Implementation-time decisions (thread-ID shape, GraphQL vs REST) belong in the implementing PR, not the relabel.

## Sources consumed

- GitHub issues: #1118, #1120, #1165, #1247, #1258, #1263, #1287, #1288, #1290, #1291
- Open issue lists for milestones v2.10.0, v2.11.0, v2.12.0, v3.1.0, v3.3.0
- `servers/exarchos-mcp/src/vcs/provider.ts:87-101`
- `skills-src/shepherd/SKILL.md:154`
- `skills-src/shepherd/references/fix-strategies.md:137,248`
- `docs/contexts/2026-05-07-p4-shepherd-handoff.md`
- `docs/designs/2026-02-16-coderabbit-review-gate.md:91,160`
- `skills/claude/axiom-backend-quality/SKILL.md` — eight-dimension taxonomy
