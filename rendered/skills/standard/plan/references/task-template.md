# Typed task objects

Copy the objects from the JSON examples into the `tasks` array of the [unified spec template](./spec-template.md). Separate objects with commas. Every field shown is required. Give each task a unique ID and list exact requirement IDs and prerequisite task IDs. Use checkout-relative POSIX paths without traversal. Put source paths in `files` and test paths in `testFiles`. High-risk tasks require test paths. An empty `blockedBy` array marks a task with no prerequisite.

```json
{
  "id": "T-01",
  "title": "Validate required fields",
  "implements": ["DR-1"],
  "blockedBy": [],
  "files": ["src/import/validate.ts"],
  "testFiles": ["tests/acceptance/import-required.test.ts"],
  "riskTier": "medium",
  "boundaryTouching": false,
  "testLayer": "acceptance",
  "acceptance": ["Report the first missing required field before writing the record."],
  "instructions": "Validate required fields before any persistence. Cover a record with a missing field.",
  "parallelizable": true
}
```

```json
{
  "id": "T-02",
  "title": "Reject duplicate identifiers",
  "implements": ["DR-2"],
  "blockedBy": ["T-01"],
  "files": ["src/import/import.ts"],
  "testFiles": ["tests/integration/import-duplicates.test.ts"],
  "riskTier": "high",
  "boundaryTouching": true,
  "testLayer": "integration",
  "acceptance": ["Report a duplicate identifier and persist only the first record."],
  "instructions": "Reuse the required-field validator. Verify the import boundary with two records that share an identifier.",
  "parallelizable": false
}
```

Choose `low`, `medium` or `high` for `riskTier` and set `boundaryTouching` explicitly. Use `acceptance`, `integration`, `unit` or `property` for `testLayer`. For more than one verification method, record the additional work in `instructions`. Check that parallel tasks have disjoint file targets. Keep requirement and task IDs in the design record, and describe the underlying constraint in words in code comments.
