"""The parts of a pull-request body the rules read: lines outside code fences, headings, sections.

A fenced code block (three or more backticks or tildes) is example text, never structure, so a
heading, an HTML comment, a footer or a word inside one is not seen. The parser reads ATX headings
(``#`` to ``######``) only. A setext heading (a line underlined with ``===`` or ``---``) is not
recognised, so it reads as section text, not as a sixth heading.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_FENCE = re.compile(r"^ {0,3}(?P<token>`{3,}|~{3,})")
_HEADING = re.compile(r"^ {0,3}(?P<level>#{1,6})[ \t]+(?P<text>.+?)[ \t]*#*[ \t]*$")
# One left-to-right scan: a code span is consumed first, so a "<!--" inside backticks never opens a
# comment. Only the "comment" group is removed. A code span stays on one line, as in _INLINE_CODE.
_CODE_OR_COMMENT = re.compile(r"(?P<code>(`+)(?:(?!\2)[^\n])+?\2)|(?P<comment><!--.*?(?:-->|\Z))", re.DOTALL)
_INLINE_CODE = re.compile(r"(`+)(?:(?!\1).)+?\1")
_WORD = re.compile(r"\S*[^\W_]\S*")


@dataclass(frozen=True)
class Line:
    number: int
    text: str


@dataclass(frozen=True)
class Heading:
    number: int
    level: int
    text: str

    @property
    def key(self) -> str:
        return self.text.casefold()

    def render(self) -> str:
        return f"{'#' * self.level} {self.text}"


@dataclass(frozen=True)
class Section:
    heading: Heading
    lines: tuple[Line, ...]

    @property
    def is_empty(self) -> bool:
        return not strip_comments("\n".join(line.text for line in self.lines)).strip()


def prose_lines(markdown: str) -> list[Line]:
    """Every line outside a fenced code block, with 1-based line numbers."""
    result: list[Line] = []
    fence: str | None = None
    for number, text in enumerate(markdown.splitlines(), start=1):
        marker = _FENCE.match(text)
        if marker:
            token = marker.group("token")
            if fence is None:
                fence = token
                continue
            if token[0] == fence[0] and len(token) >= len(fence) and not text[marker.end():].strip():
                fence = None
                continue
        if fence is None:
            result.append(Line(number, text))
    return result


def _drop_comments(text: str, *, keep_newlines: bool) -> str:
    def replace(match: re.Match[str]) -> str:
        comment = match.group("comment")
        if comment is None:
            return match.group(0)
        return "\n" * comment.count("\n") if keep_newlines else ""

    return _CODE_OR_COMMENT.sub(replace, text)


def strip_comments(text: str) -> str:
    return _drop_comments(text, keep_newlines=False)


def without_inline_code(text: str) -> str:
    return _INLINE_CODE.sub("", text)


def headings(lines: list[Line]) -> list[Heading]:
    """ATX headings outside fences and outside HTML comments."""
    result: list[Heading] = []
    for line in visible(lines):
        match = _HEADING.match(line.text)
        if match:
            result.append(Heading(line.number, len(match.group("level")), match.group("text").strip()))
    return result


def sections(lines: list[Line]) -> list[Section]:
    """The text under each heading, up to the next heading. Text before the first heading is dropped."""
    found = headings(lines)
    starts = {heading.number: heading for heading in found}
    result: list[Section] = []
    current: Heading | None = None
    body: list[Line] = []
    for line in lines:
        if line.number in starts:
            if current is not None:
                result.append(Section(current, tuple(body)))
            current, body = starts[line.number], []
        elif current is not None:
            body.append(line)
    if current is not None:
        result.append(Section(current, tuple(body)))
    return result


def comment_lines(lines: list[Line]) -> list[Line]:
    """Lines outside fences where an HTML comment opens, ignoring inline code spans."""
    return [line for line in lines if "<!--" in without_inline_code(line.text)]


def word_count(lines: list[Line]) -> int:
    """Words outside fences, comments and heading lines. A word holds at least one letter or digit."""
    heading_numbers = {heading.number for heading in headings(lines)}
    return sum(
        len(_WORD.findall(line.text)) for line in visible(lines) if line.number not in heading_numbers
    )


def visible(lines: list[Line]) -> list[Line]:
    """The lines with HTML comments removed, including comments that span lines."""
    if not lines:
        return []
    joined = "\n".join(line.text for line in lines)
    cleaned = _drop_comments(joined, keep_newlines=True)
    return [Line(line.number, text) for line, text in zip(lines, cleaned.split("\n"), strict=True)]
