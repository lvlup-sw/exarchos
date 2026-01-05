# CI/CD and Workflow Automation Design

## 1. Executive Summary

This document complements the [Jules Integration Design](./jules-integration-design.md) to complete the development workflow with a **phased approach**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PHASE 0 (NOW) - AZURE + BLACKSMITH                    │
├─────────────────────────────────────────────────────────────────────────┤
│  DEVELOP          │  REVIEW           │  CI/CD            │  DEPLOY     │
│  ───────          │  ──────           │  ─────            │  ──────     │
│  Claude Code      │  CodeRabbit       │  Blacksmith       │  azd        │
│  + Jules          │  + Coverage Gate  │  (fast runners)   │  (Azure)    │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    PHASE 1 (FUTURE) - SELF-HOSTED                        │
├─────────────────────────────────────────────────────────────────────────┤
│  DEVELOP          │  REVIEW           │  CI/CD            │  DEPLOY     │
│  ───────          │  ──────           │  ─────            │  ──────     │
│  Claude Code      │  CodeRabbit       │  Blacksmith       │  ArgoCD     │
│  + Jules          │  + Coverage Gate  │  (same)           │  (K3s)      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Decisions

| Area | Phase 0 (Now) | Phase 1 (Self-hosted) |
|------|---------------|----------------------|
| CI Runner | **Blacksmith** | Blacksmith (same) |
| Registry | Azure Container Registry | Harbor (self-hosted) |
| Deployment | `azd deploy` → Azure Container Apps | ArgoCD → K3s |
| Coverage | Script-based with Coverlet (90%) | Same |
| Dependencies | Renovate (Mend app) | Same |
| Code Review | CodeRabbit | Same |

---

## 2. Architecture

### PR Workflow (Same for Both Phases)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              PR WORKFLOW                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [Developer Push] ──► [GitHub] ──► [Blacksmith Runners]                 │
│                                           │                              │
│                     ┌─────────────────────┼─────────────────────┐       │
│                     │                     │                     │       │
│                     ▼                     ▼                     ▼       │
│              [Build + Test]        [Coverage Gate]      [CodeRabbit]    │
│                     │                     │                     │       │
│                     └─────────────────────┼─────────────────────┘       │
│                                           │                              │
│                                           ▼                              │
│                              [All Checks Pass?]                         │
│                                     │    │                               │
│                               Yes ──┘    └── No                         │
│                                     │         │                          │
│                                     ▼         ▼                          │
│                               [Merge OK]  [Block]                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Phase 0 Deployment (Azure + azd)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PHASE 0: DEPLOYMENT TO AZURE                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [Merge to main] ──► [Blacksmith CI]                                    │
│                            │                                             │
│                            ▼                                             │
│                    [Build + Push to ACR]                                │
│                            │                                             │
│                            ▼                                             │
│                    [azd deploy]  ◄── Follows Aegis pattern              │
│                            │                                             │
│                            ▼                                             │
│                    [Azure Container Apps]                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Phase 1 Deployment (Self-Hosted K3s)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PHASE 1: DEPLOYMENT TO K3S                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  [Merge to main] ──► [Blacksmith CI]                                    │
│                            │                                             │
│                            ▼                                             │
│                    [Build + Push to Harbor]                             │
│                            │                                             │
│                            ▼                                             │
│                    [ArgoCD Image Updater]                               │
│                            │                                             │
│                            ▼                                             │
│                    [Update k3s-gitops repo]                             │
│                            │                                             │
│                            ▼                                             │
│                    [ArgoCD Sync to K3s]                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Decisions

### 3.1 CI Runner: Blacksmith

**Why Blacksmith over alternatives:**
- Drop-in replacement for GitHub Actions (zero migration effort)
- 75% cheaper than GitHub runners
- 2x faster (bare metal gaming CPUs)
- 40x faster Docker builds (NVMe layer caching)
- Free tier: 3,000 min/month

**Trade-off**: Managed service (not self-hosted), but CI config stays portable.

### 3.2 Test Coverage Gate

**Approach**: Script-based enforcement using existing Coverlet configuration

**Integration:**
- Parse cobertura XML from test run
- Enforce 90% threshold (already configured in `Directory.Build.props`)
- Post coverage summary as PR comment
- Block merge if below threshold

### 3.3 Code Quality

**CodeRabbit:**
- AI-powered code review
- Custom rulesets for TDD, Result<T> pattern, guard clauses
- Knowledge base from CLAUDE.md and architecture docs

**Renovate:**
- Automated dependency updates
- Package grouping (Aspire, Wolverine, OpenTelemetry, etc.)
- Auto-merge for patch updates
- Weekend scheduling to minimize disruption

### 3.4 azd Integration (Aegis Pattern)

**Phase 0:** Full azd workflow with Terraform infrastructure
- Container Apps for hosting (scale to zero in dev)
- ACR for container images
- Key Vault for secrets
- Log Analytics for observability
- OIDC authentication

**Phase 1:** azd for local dev only, ArgoCD for staging/prod

### 3.5 GitOps Repository

**Recommendation:** Separate `k3s-gitops` repository

**Rationale:**
1. ArgoCD Image Updater commits would trigger CI if in same repo
2. Multi-app management (agentic-engine, future services)
3. Infrastructure configs alongside app deployments
4. ArgoCD best practice

**Structure:** Kustomize overlays (base + staging + production)

---

## 4. Implementation Phases

### Phase 0: Azure + Blacksmith (Immediate)

**Goal:** Get CI/CD working NOW with existing Azure infrastructure.

**Deliverables:**
1. GitHub Actions pipeline with Blacksmith runners
2. Coverage gate script
3. azd infrastructure (following Aegis pattern)
4. CodeRabbit + Renovate configuration

### Phase 1: Self-Hosted K3s (When Infrastructure Ready)

**Goal:** Migrate deployment target from Azure to K3s.

**Changes:**
- Pipeline: Change registry from ACR to Harbor, remove azd deploy step
- GitOps: Create k3s-gitops repository with Kustomize manifests
- ArgoCD: Configure Image Updater for automatic tag updates

---

## 5. Success Criteria

### Phase 0 Complete When:
- [ ] PRs trigger Blacksmith builds automatically
- [ ] Coverage gate blocks PRs below 90%
- [ ] CodeRabbit reviews PRs automatically
- [ ] Renovate creates dependency update PRs
- [ ] `azd up` provisions Azure environment
- [ ] Merge to main triggers CI → deploy to Container Apps

### Phase 1 Complete When:
- [ ] Images pushed to Harbor
- [ ] ArgoCD Image Updater detects new images
- [ ] ArgoCD syncs to K3s namespaces
- [ ] Applications healthy in K3s

---

## 6. References

### Internal (lvlup-sw)
- `clients/Aegis/` - azd + Terraform pattern reference
- `clients/ares-elite-frontend/` - Frontend azd pattern
- `agentic-engine/docs/self-hosting-plan.md` - K3s infrastructure
- `workflow/docs/jules-integration-design.md` - Development workflow

### External
- Blacksmith: https://blacksmith.sh/
- ArgoCD Image Updater: https://argocd-image-updater.readthedocs.io/
- CodeRabbit: https://coderabbit.ai/
- Renovate: https://docs.renovatebot.com/
- Azure Developer CLI: https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/
