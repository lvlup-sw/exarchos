---
name: plan
description: "Author the typed decomposition of a local unified design record. Triggers: plan implementation, create tasks from spec, or /plan. Trace tasks to design requirements and take the complete file through independent critique and user approval."
metadata:
  author: exarchos
  version: 2.0.0
  category: workflow
  phase-affinity: plan
---

# Implementation planning

Read the checkout-relative spec path from the first argument and the selected `designDepth` from the second argument when ideate calls plan. If planning starts here, author the Design & Rationale section in the same file. Choose the depth with the user, with `standard` as the default. Use `references/spec-template.md` for the full record and `references/worked-example.md` for a walkthrough.

## Author the decomposition

1. Identify the exact numbered requirements and acceptance criteria in Design & Rationale. Use `references/spec-tracing-guide.md` to check coverage.
2. Write small tasks in dependency order using `references/task-template.md`. Give every task specific implementation paths, observable acceptance and actionable instructions. State each constraint in words in code comments. Keep planning identifiers in the record.
3. Assign each task its risk, boundary flag and verification layer. Low risk uses static checks. Medium risk adds scoped tests and a control that demonstrates the tests detect a defect. High risk also needs integration verification across the affected seam. Use `references/testing-strategy-guide.md` to choose additional methods and put them in the task instructions when the implementer needs them.
4. Combine the task objects into the single root-level plan block in Decomposition. Verify locally that every requirement has a matching heading and implementing task, every dependency exists, the graph is acyclic, and parallel tasks have disjoint file targets. Check that test paths fit the repository's test configuration. A declared test file can be created during implementation.

## Critique and approve

Dispatch fresh-context refuters with the harness subagent tool. Give them the local file, its selected depth and any constraints needed to read it. Ask them to find missing requirement coverage, dependency and parallelization errors, and unverifiable acceptance criteria. If the harness starts refuters in the background, collect their results with the harness tool. Use `references/rationalization-refutation.md` when evaluating a proposal to omit verification.

Read the refuters' findings, revise the file locally, and repeat critique where the revisions affect a finding. When invoked with `--revise`, use the findings supplied by the caller. After three unsuccessful revision rounds, give the user the unresolved findings and ask for a design decision.

Read the completed file as raw bytes and retain its bare lowercase SHA-256 hex digest. Present that snapshot for approval, including prose, line endings and trailing whitespace in the digest. Before handing off, verify that the current file still has that digest. If its bytes change, present the new snapshot for approval.

## Approved handoff to delegate

Give the coordinator the feature ID, absolute integration checkout, checkout-relative design reference, selected depth, and the approval decision and digest. For a new workflow also carry its type and integration base ref. For an overhaul bootstrap include the `overhaul` track and the scope assessment. The coordinator uses this handoff at delegation.
