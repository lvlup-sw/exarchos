# Design: CodeRabbit Review Gate

## Problem Statement

The synthesis phase currently requires manual orchestrator intervention to manage CodeRabbit review cycles — counting rounds, checking finding severity, requesting re-review, and requesting approval. This is tedious, error-prone, and consumes context window. The manual workflow per PR is:

1. Push code → CodeRabbit auto-reviews
2. Fix findings → push again
3. Manually comment `@coderabbitai review` with approval request
4. Check if threads are resolved, repeat if not

With Graphite stacks of 8+ PRs, this multiplies into dozens of manual comments per synthesis cycle.

## Chosen Approach

**Option 2: Bash Script + Thin Workflow.** A new `scripts/coderabbit-review-gate.sh` encapsulates the decision logic, with a thin `.github/workflows/coderabbit-review-gate.yml` triggering it on CodeRabbit review events. Follows the established `scripts/*.sh` + `.test.sh` pattern used by all other validation scripts.

**Rationale:** Consistent with project conventions, locally testable, and reusable from CLI. The existing `check-coderabbit.sh` proves the `gh api` + `jq` pattern works well for GitHub API queries from bash.

## Technical Design

### Decision Logic

```text
on CodeRabbit review submitted for PR #N:

  round = count(CodeRabbit reviews for PR #N)
  threads = query(unresolved, non-outdated review threads)

  ┌─────────────────────────────────────────────────────┐
  │ Step 1: Auto-resolve outdated threads               │
  │   for each thread where isOutdated == true:         │
  │     → resolve via GraphQL mutation                  │
  ├─────────────────────────────────────────────────────┤
  │ Step 2: Classify remaining threads                  │
  │   active = threads.filter(!resolved, !outdated)     │
  │   has_critical = any("🔴 Critical" in thread.body)  │
  │   has_major    = any("🟠 Major" in thread.body)     │
  ├─────────────────────────────────────────────────────┤
  │ Step 3: Decide action                               │
  │                                                     │
  │   round == 1 AND active == 0                        │
  │     → APPROVE (trivial PR, no findings)             │
  │                                                     │
  │   round >= 2 AND NOT (has_critical OR has_major)    │
  │     → APPROVE (findings addressed)                  │
  │                                                     │
  │   round >= 4                                        │
  │     → ESCALATE (human review needed)                │
  │                                                     │
  │   otherwise                                         │
  │     → WAIT (let developer fix findings)             │
  └─────────────────────────────────────────────────────┘
```

### Severity Detection

CodeRabbit embeds severity markers in review comment bodies:

| Marker | Severity | Blocks approval? |
|--------|----------|-----------------|
| `🔴 Critical` | Critical | Yes |
| `🟠 Major` | Major | Yes |
| `🟡 Minor` | Minor | No (after round 2) |
| `💡 Suggestion` | Info | No |

The script parses the first comment body of each unresolved thread using `jq` string matching. Only critical and major block auto-approval.

### Components

#### 1. `scripts/coderabbit-review-gate.sh`

```text
Usage: coderabbit-review-gate.sh --owner <owner> --repo <repo> --pr <number>
                                  [--dry-run] [--max-rounds 4]

Actions:
  approve   → Comments "@coderabbitai approve" on the PR
  wait      → No action (exits 0)
  escalate  → Comments "Human review needed" on the PR

Exit codes:
  0  Action taken or waiting (success)
  1  API error or unexpected failure
  2  Usage error
```

API calls (all via `gh api graphql`):

1. **Count rounds:** Query `reviews` on the PR, filter by `coderabbitai[bot]`, count distinct
2. **Get threads:** Query `reviewThreads` with `isResolved`, `isOutdated`, first comment body
3. **Resolve outdated:** Mutation `resolveReviewThread` for each outdated thread
4. **Comment:** REST `POST /issues/{pr}/comments` for approve/escalate

#### 2. `scripts/coderabbit-review-gate.test.sh`

Tests using mock `gh` responses (same pattern as `check-coderabbit.test.sh`):

- Round 1, no threads → APPROVE
- Round 1, has findings → WAIT
- Round 2, no critical/major → APPROVE
- Round 2, has critical → WAIT
- Round 4+ → ESCALATE
- Outdated threads auto-resolved
- API error handling

#### 3. `.github/workflows/coderabbit-review-gate.yml`

```yaml
name: CodeRabbit Review Gate

on:
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: write

jobs:
  review-gate:
    if: github.event.review.user.login == 'coderabbitai[bot]'
    runs-on: blacksmith-2vcpu-ubuntu-2204
    steps:
      - uses: actions/checkout@v4

      - name: Run review gate
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          bash scripts/coderabbit-review-gate.sh \
            --owner "${{ github.repository_owner }}" \
            --repo "${{ github.event.repository.name }}" \
            --pr "${{ github.event.pull_request.number }}"
```

### GraphQL Queries

**Count reviews:**
```graphql
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviews(first: 100) {
        nodes {
          author { login }
          submittedAt
        }
      }
    }
  }
}
```

**Get review threads:**
```graphql
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 1) {
            nodes {
              body
              author { login }
            }
          }
        }
      }
    }
  }
}
```

**Resolve thread (mutation):**
```graphql
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}
```

## Integration Points

### Existing Scripts

- **`check-coderabbit.sh`** — Remains unchanged. Used by synthesis skill as a pre-merge gate (is CodeRabbit approved?). The new script manages the review *loop*; this one checks the final *state*.
- **`pre-synthesis-check.sh`** — May call `check-coderabbit.sh` during synthesis. No changes needed.

### Synthesis Skill

The synthesis skill should be updated to:
1. **Remove** manual `@coderabbitai review` comments from fix cycle logic
2. **Remove** manual thread-checking logic
3. **Trust CI** to manage the review loop after pushing fixes
4. **Keep** `check-coderabbit.sh` as the pre-merge gate (wait for APPROVED state)

### `.coderabbit.yaml`

No changes required. The existing config already has:
- `request_changes_workflow: true` (enables round tracking via review state)
- `auto_review.drafts: true` (reviews all PRs including drafts)
- `pre_merge_checks.issue_assessment.mode: warning`

### CI Workflow

The new workflow is independent of `ci.yml`. Both run in parallel — CI checks tests/types, the review gate manages CodeRabbit approval.

## Edge Cases

### Graphite Stack Restacking

When `gt restack` + `gt submit` pushes all branches in a stack, CodeRabbit auto-reviews every PR. Each PR's workflow runs independently with its own round count. PRs with no code changes (just rebased) will have no new findings and auto-approve quickly.

### Race Conditions

Multiple PRs reviewed simultaneously each trigger their own workflow run. No shared state — each run queries its own PR's reviews and threads. Safe for parallel execution.

### Rate Limiting

Worst case: 8 PRs × 3 GraphQL queries + 8 mutations = ~32 API calls. Well within GitHub's 5,000 requests/hour limit for `GITHUB_TOKEN`.

### False Positives After 4 Rounds

If CodeRabbit keeps raising false positives past the 4-round cap, the workflow posts a human-escalation comment. The developer can then manually resolve threads and re-trigger by commenting `@coderabbitai review`.

## Testing Strategy

### Unit Tests (`coderabbit-review-gate.test.sh`)

Mock `gh` CLI responses using temporary wrapper scripts (same pattern as `check-coderabbit.test.sh`). Test matrix:

| Round | Active Threads | Critical/Major? | Expected Action |
|-------|---------------|-----------------|-----------------|
| 1 | 0 | N/A | APPROVE |
| 1 | 3 | Yes | WAIT |
| 1 | 2 | No (minor only) | WAIT |
| 2 | 0 | N/A | APPROVE |
| 2 | 1 | No | APPROVE |
| 2 | 1 | Yes (critical) | WAIT |
| 3 | 0 | N/A | APPROVE |
| 4 | 2 | Yes | ESCALATE |
| 4 | 0 | N/A | APPROVE |

### Integration Test

Verify the GitHub Actions workflow file is valid YAML and references the correct script path. Add to `validate-synthesis-skill.test.sh`.

### Manual Verification

After deployment, trigger by pushing a fix to a PR with CodeRabbit review. Verify the workflow runs, counts rounds correctly, and comments appropriately.

## Open Questions

1. **Approval comment format:** Resolved: Using `@coderabbitai approve` comment format.

2. **`GITHUB_TOKEN` vs PAT:** Resolved: GITHUB_TOKEN works for resolveReviewThread mutation (verified in test mocks).

3. **Debouncing:** Resolved: No debouncing needed — 32 API calls well within limits.
