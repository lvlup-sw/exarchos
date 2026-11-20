"""workflow-hygiene: refuse pull-request workflows that never cancel superseded runs, and jobs with no timeout.

Usage: ``python -m workflow_hygiene [--root DIR]``. It scans ``DIR/.github/workflows/*.yml`` and
``*.yaml`` and reports one line per violation as ``<workflow-file>:<job>: <message>``:

  1. A workflow triggered by ``pull_request`` or ``pull_request_target`` must carry ``concurrency``
     with a truthy ``cancel-in-progress`` at workflow level, or on every job. The location is
     ``<workflow-file>:*``.
  2. Every job that is not a reusable-workflow call (job-level ``uses:``) must set ``timeout-minutes``.

Exemptions live in ``DIR/.github/workflow-hygiene.toml`` (see ``exemptions.py``).

Exit codes: 0 pass, 1 violation, 2 INDETERMINATE (the tool could not see its subject).
"""
