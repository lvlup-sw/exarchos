# Worked example

The importer needs to validate required fields and reject duplicate identifiers. Copy the document from `spec-template.md`, replace the feature name, and copy the two JSON objects from `task-template.md` into its one plan fence.

Read the resulting graph. `T-01` implements `DR-1` and can start immediately. `T-02` implements `DR-2` and waits for `T-01`, since the importer needs the validator before it can reject duplicates. The tasks declare separate source files and their intended tests.

A fresh-context refuter points out that the second task only checks a returned error. Revise its acceptance criterion to verify that the duplicate was never written. Ask the refuter to check the revised criterion. Present the final file for approval, then carry the exact file digest and the approved depth to the coordinator.
