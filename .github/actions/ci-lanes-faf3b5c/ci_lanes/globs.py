"""Glob patterns for lane path sets.

The grammar is deliberately small, and anything outside it is refused rather than guessed at:

* A pattern is a repository-relative POSIX path of one or more segments separated by ``/``.
* A segment that is exactly ``**`` matches zero or more whole directories. As the LAST segment
  it matches every path below the directory (one or more segments), so ``src/**`` matches
  ``src/a.cs`` and ``src/a/b.cs`` but not a file named ``src``.
* Inside any other segment, ``*`` matches zero or more characters except ``/`` and ``?`` matches
  exactly one character except ``/``. Everything else matches literally.
* Character classes, braces, negation, backslashes, surrounding whitespace, a leading ``/`` or
  ``./``, a trailing ``/``, empty or ``.``/``..`` segments, consecutive ``**`` segments, and ``**``
  mixed with other text in one segment are all refused.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_UNSUPPORTED = frozenset("[]{}!\\")


class GlobError(ValueError):
    """A pattern is outside the supported grammar."""


@dataclass(frozen=True)
class Glob:
    pattern: str
    regex: re.Pattern[str]

    def matches(self, path: str) -> bool:
        return self.regex.fullmatch(path) is not None


def compile_glob(pattern: str) -> Glob:
    if not pattern:
        raise GlobError("empty pattern")
    if pattern != pattern.strip():
        raise GlobError(f"{pattern!r}: surrounding whitespace")
    unsupported = sorted(_UNSUPPORTED.intersection(pattern))
    if unsupported:
        raise GlobError(f"{pattern!r}: unsupported character(s) {''.join(unsupported)!r}")
    if pattern.startswith(("/", "./")) or pattern.endswith("/"):
        raise GlobError(f"{pattern!r}: must be repository-relative, with no leading '/' or './' and no trailing '/'")

    segments = pattern.split("/")
    parts: list[str] = []
    previous_was_globstar = False
    for index, segment in enumerate(segments):
        last = index == len(segments) - 1
        if segment in ("", ".", ".."):
            raise GlobError(f"{pattern!r}: empty, '.' or '..' segment")
        if segment == "**":
            if previous_was_globstar:
                raise GlobError(f"{pattern!r}: consecutive '**' segments")
            parts.append(".+" if last else "(?:[^/]+/)*")
            previous_was_globstar = True
            continue
        if "**" in segment:
            raise GlobError(f"{pattern!r}: '**' must be a whole segment")
        previous_was_globstar = False
        body = "".join(_segment_character(character) for character in segment)
        parts.append(body if last else body + "/")
    return Glob(pattern, re.compile("".join(parts)))


def _segment_character(character: str) -> str:
    if character == "*":
        return "[^/]*"
    if character == "?":
        return "[^/]"
    return re.escape(character)
