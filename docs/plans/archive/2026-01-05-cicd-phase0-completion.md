# Implementation Plan: CI/CD Phase 0 Completion

**Design Document:** `docs/adrs/cicd-workflow-design.md`
**Reference Projects:** Aegis, ares-elite-platform (lvlup-sw)
**Date:** 2026-01-05
**Status:** Ready for Implementation

---

## Analysis Summary

### Already Implemented
| Component | Location | Status |
|-----------|----------|--------|
| CI Workflow (Blacksmith) | `ci-templates/workflows/ci-dotnet.yml` | Complete |
| Coverage Gate Script | `ci-templates/coverage-gate/coverage-gate.sh` | Complete |
| Coverage Gate Tests | `ci-templates/coverage-gate/coverage-gate.test.sh` | Complete |
| CodeRabbit Config | `coderabbit-config/config.yaml` | Complete |

### Remaining for Phase 0
| Component | Priority | Complexity | Assignee |
|-----------|----------|------------|----------|
| Renovate Configuration | High | Low | Jules |
| CD Workflow (Azure Deploy) | High | Medium | Claude Code |
| azd Infrastructure Templates (Terraform) | Medium | Medium | Claude Code |
| Update coverage threshold to 90% | Low | Trivial | Claude Code |

---

## Task Breakdown

### Group A: Renovate Configuration (Delegate to Jules)

#### Task A1: Create Renovate Configuration
**Assignee:** Jules
**Phase:** Implementation

**Specification for Jules:**
Create a complete Renovate configuration for .NET projects in `renovate-config/` with:

1. **Base configuration** (`renovate-config/renovate.json`):
   - Extend `config:recommended`
   - Enable auto-merge for patch updates only
   - Schedule: weekends (Saturday/Sunday)
   - Timezone: America/Denver
   - Rate limiting: max 10 PRs open, 2 PRs per hour
   - Lockfile maintenance: weekly

2. **.NET preset** (`renovate-config/presets/dotnet.json`):
   - Package grouping:
     - `aspire-*` packages together
     - `Wolverine*` packages together
     - `OpenTelemetry*` packages together
     - `xunit*` packages together
     - `Microsoft.Extensions.*` packages together
   - Enable `.NET SDK` updates
   - Support Central Package Management (`Directory.Packages.props`)

3. **Validation test** (`renovate-config/renovate.test.sh`):
   - Validate JSON syntax
   - Check required fields exist
   - Verify schema compliance (if possible)

4. **Documentation** (`renovate-config/README.md`):
   - Usage instructions for target projects
   - How to extend/override presets
   - Link to Renovate docs

**Acceptance Criteria:**
- [ ] JSON files pass validation
- [ ] Test script runs successfully
- [ ] README provides clear setup instructions

**Dependencies:** None

---

### Group B: CD Workflow (Claude Code)

#### Task B1: Create CD Workflow Template for Azure
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write workflow validation test
   - File: `ci-templates/workflows/cd-azure.yml.test.sh`
   - Test: `Workflow_ValidYaml_Passes`
   - Expected failure: Workflow file doesn't exist

2. **[GREEN]** Create Azure deployment workflow
   - File: `ci-templates/workflows/cd-azure.yml`
   - Triggers: Push to main branch
   - Jobs:
     - `build-push`: Build container, push to ACR
     - `deploy`: Run `azd deploy` to Container Apps
   - Features:
     - Uses Blacksmith runners
     - OIDC authentication (no secrets)
     - Environment-based deployment (dev/staging/prod)
   - Pattern: Follow Aegis `azure.yaml` pipeline approach

3. **[REFACTOR]** Add validation comments

**Dependencies:** None

---

#### Task B2: Create OIDC Setup Documentation
**Phase:** GREEN only (docs)

1. **[GREEN]** Document OIDC setup for Azure
   - File: `ci-templates/docs/azure-oidc-setup.md`
   - Contents:
     - Service principal creation with federated credentials
     - GitHub repository configuration
     - Required secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
     - Verification commands

**Dependencies:** Task B1

---

### Group C: azd Infrastructure Templates (Claude Code)

Following Aegis pattern: azd + Terraform + hooks

#### Task C1: Create azd Base Structure
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write structure validation test
   - File: `azd-templates/azd.test.sh`
   - Test: `AzdYaml_RequiredFields_Exist`
   - Expected failure: azure.yaml doesn't exist

2. **[GREEN]** Create base azd structure (Aegis pattern)
   - Files:
     - `azd-templates/azure.yaml` - Service definitions with Terraform provider
     - `azd-templates/.azure/config.json` - Default environment config
   - Features:
     - Single service definition (containerapp host)
     - Terraform infra provider
     - Hook definitions (preprovision, postprovision)

3. **[REFACTOR]** Add inline documentation

**Dependencies:** None

---

#### Task C2: Create Terraform Infrastructure Modules
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write Terraform validation test
   - File: `azd-templates/infra/infra.test.sh`
   - Test: `Terraform_Validate_Passes`
   - Expected failure: main.tf doesn't exist

2. **[GREEN]** Create Terraform modules (Aegis pattern)
   - Files:
     - `azd-templates/infra/main.tf` - Main orchestration
     - `azd-templates/infra/backend.tf` - Azure Storage backend
     - `azd-templates/infra/variables.tf` - Input variables
     - `azd-templates/infra/outputs.tf` - azd-compatible outputs
     - `azd-templates/infra/main.tfvars.json` - Variable template
     - `azd-templates/infra/provider.conf.json` - Backend config template
     - `azd-templates/infra/modules/container-apps/` - Container Apps module
       - `main.tf`, `variables.tf`, `outputs.tf`
       - ACR, Key Vault, Log Analytics integrated
   - Features:
     - Scale to zero in dev
     - Managed identity for all access
     - OIDC-ready configuration

3. **[REFACTOR]** Extract reusable patterns

**Dependencies:** Task C1

---

#### Task C3: Create azd Hooks
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write hook execution test
   - File: `azd-templates/infra/scripts/hooks.test.sh`
   - Test: `Preprovision_SetsVariables_Succeeds`
   - Expected failure: Hook script doesn't exist

2. **[GREEN]** Create azd hooks (Aegis pattern)
   - Files:
     - `azd-templates/infra/scripts/preprovision.sh`:
       - Setup Terraform backend if needed
       - Get current user principal ID
       - Set TF_VAR_* environment variables
       - Verify Azure CLI authentication
     - `azd-templates/infra/scripts/postprovision.sh`:
       - Extract Terraform outputs
       - Configure any post-deploy settings
     - `azd-templates/infra/scripts/setup-backend.sh`:
       - Create storage account for Terraform state

3. **[REFACTOR]** Add error handling and logging

**Dependencies:** Task C1, C2

---

#### Task C4: Create azd Documentation
**Phase:** GREEN only (docs)

1. **[GREEN]** Document azd template usage
   - File: `azd-templates/README.md`
   - Contents:
     - Prerequisites (Azure CLI, azd CLI, Terraform)
     - Quick start: `azd init`, `azd up`
     - Environment configuration
     - Customization guide
     - Troubleshooting

**Dependencies:** Task C1, C2, C3

---

### Group D: Threshold Update (Claude Code)

#### Task D1: Update Coverage Threshold to 90%
**Phase:** GREEN

1. **[GREEN]** Update threshold in workflow template
   - File: `ci-templates/workflows/ci-dotnet.yml`
   - Change: `COVERAGE_THRESHOLD: 80` → `COVERAGE_THRESHOLD: 90`
   - Update: `ci-templates/README.md` to reflect 90%
   - Update: `coderabbit-config/config.yaml` SPEC COMPLIANCE check (80% → 90%)

**Dependencies:** None

---

### Group E: Integration Validation (Claude Code)

#### Task E1: Create Template Validation Script
**Phase:** RED → GREEN

1. **[RED]** Write validation test scaffold
   - File: `scripts/validate-templates.sh`
   - Expected failure: Script doesn't exist

2. **[GREEN]** Implement validation script
   - Validates:
     - YAML files parse correctly (`yq`)
     - Shell scripts pass `shellcheck`
     - JSON files are valid
     - Terraform validates (`terraform validate`)
     - Required files exist
   - Exit codes: 0 success, 1 failure

**Dependencies:** All previous tasks

---

## Parallelization Strategy

```
                    ┌──────────────┐
                    │    START     │
                    └──────┬───────┘
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Group A  │    │ Group B  │    │ Group D  │
    │ Renovate │    │ CD Work- │    │ Threshold│
    │ (JULES)  │    │ flow     │    │ Update   │
    └────┬─────┘    └────┬─────┘    └────┬─────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Group C    │
                  │ azd Templates│
                  │ (Terraform)  │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │   Group E    │
                  │ Validation   │
                  └──────┬───────┘
                         │
                         ▼
                    ┌──────────┐
                    │   DONE   │
                    └──────────┘
```

### Assignment Summary
| Group | Tasks | Assignee | Can Run With |
|-------|-------|----------|--------------|
| A | A1 | **Jules** | B, D |
| B | B1, B2 | Claude Code | A, D |
| C | C1 → C2 → C3 → C4 | Claude Code | After A, B, D |
| D | D1 | Claude Code | A, B |
| E | E1 | Claude Code | After all |

---

## Success Criteria (Phase 0)

From design document, validated by this implementation:

- [x] PRs trigger Blacksmith builds automatically - **Template exists**
- [ ] Coverage gate blocks PRs below 90% - **Task D1**
- [x] CodeRabbit reviews PRs automatically - **Config exists**
- [ ] Renovate creates dependency update PRs - **Task A1 (Jules)**
- [ ] `azd up` provisions Azure environment - **Tasks C1-C4**
- [ ] Merge to main triggers CI → deploy to Container Apps - **Tasks B1-B2**

---

## File Structure After Implementation

```
lvlup-claude/
├── ci-templates/
│   ├── README.md                    # Updated (90% threshold)
│   ├── coverage-gate/
│   │   └── ... (existing)
│   ├── docs/
│   │   └── azure-oidc-setup.md      # NEW (Task B2)
│   ├── templates/
│   │   └── global.json              # existing
│   └── workflows/
│       ├── ci-dotnet.yml            # Updated (90% threshold)
│       ├── cd-azure.yml             # NEW (Task B1)
│       └── cd-azure.yml.test.sh     # NEW (Task B1)
├── renovate-config/                  # NEW (Jules - Task A1)
│   ├── README.md
│   ├── renovate.json
│   ├── renovate.test.sh
│   └── presets/
│       └── dotnet.json
├── azd-templates/                    # NEW (Tasks C1-C4)
│   ├── README.md
│   ├── azure.yaml
│   ├── azd.test.sh
│   ├── .azure/
│   │   └── config.json
│   └── infra/
│       ├── main.tf
│       ├── backend.tf
│       ├── variables.tf
│       ├── outputs.tf
│       ├── main.tfvars.json
│       ├── provider.conf.json
│       ├── infra.test.sh
│       ├── scripts/
│       │   ├── preprovision.sh
│       │   ├── postprovision.sh
│       │   ├── setup-backend.sh
│       │   └── hooks.test.sh
│       └── modules/
│           └── container-apps/
│               ├── main.tf
│               ├── variables.tf
│               └── outputs.tf
├── coderabbit-config/
│   └── config.yaml                  # Updated (90% threshold)
└── scripts/
    └── validate-templates.sh        # NEW (Task E1)
```

---

## Reference Patterns Used

From Aegis/ares-elite-platform analysis:

1. **azd + Terraform Integration**
   - `infra.provider: terraform` in azure.yaml
   - Outputs in outputs.tf match azd variable names
   - Hook scripts for pre/post provisioning

2. **Terraform Backend**
   - Azure Storage Account for state
   - `provider.conf.json` with `${RS_*}` env var substitution
   - `setup-backend.sh` for initial creation

3. **Hook Pattern**
   - `preprovision.sh`: Auth check, TF_VAR_* setup, backend init
   - `postprovision.sh`: Output extraction, post-config

4. **Module Structure**
   - `modules/container-apps/` with main.tf, variables.tf, outputs.tf
   - Integrated ACR, Key Vault, Log Analytics
   - Managed identity for all access

---

## Estimated Task Count

| Group | Tasks | Test Files | Implementation Files | Assignee |
|-------|-------|------------|---------------------|----------|
| A | 1 | 1 | 4 | Jules |
| B | 2 | 1 | 2 | Claude Code |
| C | 4 | 3 | 13 | Claude Code |
| D | 1 | 0 | 3 | Claude Code |
| E | 1 | 0 | 1 | Claude Code |
| **Total** | **9** | **5** | **23** | - |
