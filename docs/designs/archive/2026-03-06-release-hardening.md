# Release Hardening: First Public Release

**Date:** 2026-03-06
**Status:** Draft
**Workflow:** `release-hardening`

## Problem Statement

Exarchos is preparing for its first public release — transitioning from a private repository to a publicly visible open-source project. The codebase contains internal marketing materials, competitive intelligence, and Basileus SaaS strategy documents that must not be exposed. Additionally, CI/CD governance, community infrastructure, and public-facing documentation need hardening to present a professional, contributor-ready project.

## Constraints

- **Timeline:** Imminent — minimize scope creep
- **License:** Apache 2.0 (already in place)
- **Sensitive content:** Basileus (unannounced SaaS) references in marketing/strategy docs
- **Distribution:** npm CLI binary + Claude Code plugin via lvlup-sw marketplace + dev companion package
- **Current version:** 2.4.2 (package.json) vs v2.0.6 (latest git tag)

## Chosen Approach: Professional Open Source Release

Eliminate security/sensitivity risks, establish governance basics, and refresh public-facing documentation. No over-investment in release automation.

## Design Requirements

### DR-1: Sensitive Document Removal

Port internal/strategic documents to the basileus repository, then remove from exarchos.

**Files to port to `../basileus/docs/market/exarchos/`:**

| File | Risk |
|------|------|
| `docs/marketing/product-marketing-context.md` | Basileus funnel strategy |
| `docs/marketing/hn-ai-session-commits-thread.md` | Named HN user analysis |
| `docs/marketing/google-ads-campaign.md` | Paid acquisition budget/strategy |
| `docs/marketing/competitive-analysis.md` | Competitive intelligence |
| `docs/marketing/copy-templates.md` | Internal messaging playbook |
| `docs/adrs/productization-roadmap.md` | Basileus SaaS tier plans |
| `docs/designs/2026-03-01-marketplace-positioning.md` | Go-to-market strategy |

After porting, remove `docs/marketing/` directory entirely from exarchos and add it to `.gitignore` as a safeguard.

**Acceptance criteria:**
- All 7 files exist in basileus repo under `docs/market/exarchos/`
- All 7 files are removed from exarchos repo
- `docs/marketing/` is in `.gitignore`
- `git log --all --diff-filter=D -- docs/marketing/` confirms deletion is committed
- No files in the repo contain the phrase "validates demand for" (Basileus funnel language)

### DR-2: Basileus Reference Scrub

Audit and sanitize remaining basileus references in the codebase.

**Known references:**
- `docs/designs/2026-02-05-exarchos.md`: Replace `https://basileus.local/api` with `https://your-remote-server.example.com/api`
- `servers/exarchos-mcp/src/registry.ts`: `basileusConnected` schema field — this is a legitimate code reference (optional boolean flag), keep as-is
- Test files referencing `basileusConnected` — keep as-is (technical, not strategic)

**Acceptance criteria:**
- No `.local` domain URLs exist in docs (search: `basileus.local`)
- Strategic/funnel language about basileus is absent from all remaining files
- Code references to `basileusConnected` remain functional (tests pass)

### DR-3: Design Document Audit

Scan all 45 design documents for content unsuitable for public view.

**Search terms:** `basileus` (non-code), `SaaS`, `paid offering`, `revenue`, `pricing`, `funnel`, `acquisition`, competitive product names used in strategic context.

**Acceptance criteria:**
- Every file in `docs/designs/` has been scanned for sensitive terms
- Files with sensitive content are either redacted in-place or ported to basileus
- A checklist of audited files with disposition (keep/redact/port) is produced during implementation

### DR-4: CI Governance Hardening

Establish required status checks and review policies on `main`.

**Changes:**
1. **Required status checks:** CI Gate job must pass before merge
2. **Dismiss stale reviews:** Already enabled, verify
3. **CODEOWNERS file:** Create with ownership for critical paths:
   - `/` — project maintainer(s)
   - `servers/exarchos-mcp/` — MCP server owners
   - `scripts/` — validation script owners
   - `skills/` — skill content owners
4. **Require CODEOWNER review:** Enable in branch protection

**Not in scope:** Signed commits, GitHub-hosted runner migration, concurrency groups.

**Acceptance criteria:**
- `gh api repos/lvlup-sw/exarchos/branches/main/protection` shows required status checks configured
- `.github/CODEOWNERS` exists and is valid (no syntax errors)
- A PR targeting `main` cannot merge without CI passing (verify with dry-run or manual test)

### DR-5: Community Infrastructure

Add governance and contributor documentation.

**Files to create:**
1. **`SECURITY.md`** — Vulnerability disclosure policy (email or GitHub Security Advisories)
2. **`CONTRIBUTING.md`** — How to contribute: dev setup, branch naming, PR process, commit conventions, workflow overview
3. **`.github/DISCUSSION_TEMPLATE/`** — Templates for Q&A and feature ideas (referenced in issue config.yml)

**Not in scope:** FUNDING.yml, Code of Conduct (can add later if community grows).

**Acceptance criteria:**
- `SECURITY.md` exists at repo root with a clear reporting mechanism
- `CONTRIBUTING.md` exists at repo root with dev setup instructions that work (`git clone`, `npm install`, `npm run build`, `npm run test:run`)
- At least 2 discussion category templates exist in `.github/DISCUSSION_TEMPLATE/`

### DR-6: README Refresh

Update README.md to accurately reflect the current CLI surface and public positioning.

**Changes needed:**
- Verify all 15 command descriptions match current skill frontmatter
- Verify install instructions work for all 3 paths (marketplace, npm CLI, dev companion)
- Remove or update any stale architecture references
- Ensure no internal jargon or references to unreleased products
- Add badges (CI status, npm version, license)

**Acceptance criteria:**
- Every command listed in README has a corresponding file in `commands/` or `skills/`
- Install instructions are tested and work (at minimum: `npm pack` + local install test)
- No references to "Jules" (removed feature) remain in README
- README contains CI badge, npm version badge, and license badge

### DR-7: Version and Changelog Sync

Bridge the gap between package.json version (2.4.2) and git tags (v2.0.6).

**Changes:**
1. Update `CHANGELOG.md` to cover changes from v2.0.6 through v2.4.2
2. Create git tag `v2.4.2` aligned with current package.json
3. Verify `npm run version:check` passes

**Acceptance criteria:**
- `CHANGELOG.md` has entries for the v2.0.6 → v2.4.2 range
- `git tag -l 'v2.4.*'` returns `v2.4.2`
- `npm run version:check` exits 0

### DR-8: Gitignore Hardening

Prevent accidental re-introduction of sensitive files.

**Additions to `.gitignore`:**
- `.env`
- `.env.local`
- `docs/marketing/`

**Acceptance criteria:**
- `.env`, `.env.local`, and `docs/marketing/` appear in `.gitignore`
- `git check-ignore docs/marketing/test.md` confirms the pattern works

### DR-9: Self-Hosted Runner Risk Mitigation

Document and mitigate risks of self-hosted runners on a public repository.

Public repos with self-hosted runners are vulnerable to malicious PRs executing arbitrary code. This is a known GitHub security concern.

**Options (choose during implementation):**
- A: Restrict workflows to not run on PRs from forks (add `if: github.event.pull_request.head.repo.full_name == github.repository`)
- B: Move CI to GitHub-hosted runners for PR workflows only
- C: Document the risk and accept it (small project, low attack surface)

**Acceptance criteria:**
- A decision is documented (in this design doc or as a code comment in CI workflows)
- If option A or B chosen: workflow files are updated accordingly
- No workflow runs untrusted fork code on self-hosted runners without explicit guard

## Out of Scope

- Semantic-release / Changesets automation
- Signed commit requirements
- GitHub Sponsors / FUNDING.yml
- Code of Conduct
- Coverage threshold enforcement in CI
- Moving `docs/designs/` to a separate repo (individual file audit per DR-3 is sufficient)

## Implementation Notes

- DR-1 should be implemented first (highest risk)
- DR-2 and DR-3 can run in parallel after DR-1
- DR-4 through DR-9 are independent of each other
- The version tag (DR-7) should be created last, after all other changes are committed
