# Trace requirements to tasks

List the numbered headings under Design & Rationale. Compare them with the `requirements` array in the typed plan block. For each requirement, collect the task IDs whose `implements` arrays contain that exact ID. A table can help during critique. The typed block defines the relation.

| Requirement | Task | Behavior to verify |
| --- | --- | --- |
| DR-1 | T-01 | Report a missing required field. |
| DR-2 | T-02 | Report the duplicate and preserve the first record. |

Resolve a missing requirement definition or task before approval. Confirm that the acceptance criterion proves the required behavior. When a requirement is out of scope, describe the deferral in the surrounding rationale and keep the implemented requirement set internally consistent.
