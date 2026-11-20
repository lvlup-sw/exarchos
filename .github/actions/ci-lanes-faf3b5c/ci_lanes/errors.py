"""Exit semantics shared by every mode."""

from __future__ import annotations

EXIT_PASS = 0
EXIT_VIOLATION = 1
EXIT_INDETERMINATE = 2


class Indeterminate(Exception):
    """The tool could not see its subject, so it must not report a pass (exit 2)."""
