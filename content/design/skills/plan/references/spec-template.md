# Unified design record

Save the completed file to `docs/specs/YYYY-MM-DD-<feature>.md`. Choose a design depth before writing. The task block has the same shape at every depth.

| Depth | Design sections |
| --- | --- |
| `thin` | Problem Statement and numbered requirements with acceptance criteria. |
| `standard` (default) | Add the chosen approach, technical design, integration points and relevant alternatives. |
| `deep` | Add Exploration with two or three approaches and a research note citation. Cite the note by path and by a `correlationId` recorded in both files. |

Copy the Markdown inside the outer fence. The example shows deep depth. Omit Exploration at standard depth and keep only the problem and requirements at thin depth. Replace the example headings, acceptance criteria and requirements with the design's own terms. Replace `__TASK_OBJECTS__` with comma-separated JSON objects using [the task template](./task-template.md).

````markdown
# [Feature Name]

## Design & Rationale

### Problem Statement

The importer needs to validate required fields and reject duplicate identifiers.

### Chosen Approach

Validate records before the importer persists them.

### DR-1: Validate required fields

**Acceptance criteria:**
- Given a record missing a required field
  When the importer validates it
  Then it reports the missing field

### DR-2: Reject duplicate identifiers

**Acceptance criteria:**
- Given two records with the same identifier
  When the importer processes the second record
  Then it reports the duplicate without persisting it

### Technical Design

Use one validator at the import boundary and retain accepted identifiers for the duration of each import.

### Integration Points

The importer calls the validator before writing records.

### Exploration

Research note: `docs/research/import-validation.md`, correlationId `import-validation-research`.
Streaming validation bounds record buffering. Buffered validation can report all errors together but retains the full import.

### Alternatives considered

Buffered validation was excluded because the importer accepts inputs larger than available memory.

## Decomposition

```exarchos-plan-v1
{
  "version": 1,
  "requirements": ["DR-1", "DR-2"],
  "tasks": [
    __TASK_OBJECTS__
  ]
}
```
````

Keep exactly one top-level `exarchos-plan-v1` fence in the actual document. Use valid JSON without comments or trailing commas. List the exact `DR-N` headings from Design & Rationale in `requirements`. The plan block defines the task membership and dependencies. Use surrounding prose for context and deferred scope.
