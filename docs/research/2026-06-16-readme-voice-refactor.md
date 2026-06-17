# README voice refactor — learnings from popular OSS READMEs

**Date:** 2026-06-16
**Workflow:** `readme-voice-refactor` (discovery)
**Deliverable:** de-AI'd `README.md` rewrite (humanize pass)

## Why

The exarchos README reads as AI-voice-heavy: bold-led pseudo-lists, "by construction"/
"comes free" filler, an "X over Y, X over Y" cadence, and six tables stacked dense enough
that the page feels machine-assembled. This note records what the good OSS READMEs actually
do and what changed.

## Sources studied

| README | What it is | Why it's a good model |
|--------|-----------|------------------------|
| [ripgrep](https://github.com/BurntSushi/ripgrep) | line-oriented search CLI | The gold standard for a dev tool. Opinionated, candid, has a literal **"Why shouldn't I use ripgrep?"** section. Tables only where they carry benchmark data. |
| [uv](https://github.com/astral-sh/uv) | Python package manager (Rust) | One-sentence tagline, then a benchmark image — shows speed instead of claiming it. Prose + console output, almost no tables, no emoji. Casual FAQ ("It's pronounced 'you-vee'"). |
| [Jellyfin](https://github.com/jellyfin/jellyfin) | media server | Earnest community voice: "no strings attached, no premium licenses or features, and no hidden agendas." Prose-dominant, sparse boldface. |
| [Bitwarden server](https://github.com/bitwarden/server) | backend APIs/infra | Plain and factual. ~90-word intro that says exactly what the thing is. Tables only for production image hashes. Pragmatic, not exhaustive. |

## What the good ones share

1. **Open by saying what it is, plainly.** uv: "An extremely fast Python package and
   project manager, written in Rust." No stacked sub-claims, no slogan pileup.
2. **Prose carries the page; tables carry data.** A table earns its place when it holds a
   benchmark grid or a hash list — not when it's three feature bullets wearing a grid.
3. **Sparse boldface, no emoji.** Emphasis is rare enough to mean something.
4. **They admit the edges.** ripgrep tells you when *not* to use it. That honesty reads as
   human and buys more trust than any superlative.
5. **One consistent voice with asides.** "Beware of performance cliffs though." "good old
   grep." The author is a person, and you can tell.
6. **Show, don't assert.** A benchmark image or an example transcript beats "blazingly fast."

## AI tells found in the old exarchos README

- **Inline-header bold list** (the #1 tell) in "What you get": every item led with a bold
  phrase + period (`**Phases that enforce themselves.**`, `**Convergence gates run as code.**`).
- **Promotional filler:** "Audit trail comes free.", "Token-efficient by construction."
- **`X over Y` parallelism:** "Structured input over natural language and strict schema
  validation over loose parsing."
- **Repetition across sections:** the event log / ~2,500-token rehydrate / "state machine
  refuses the transition" points were each made two or three times.
- **Table density:** six tables, several of which were prose wearing a grid.
- **No honest edge:** every line was a confident upside; nothing said when the machinery is
  overkill.

## What changed in the rewrite

- Converted "What you get" from a bold-led list into four prose paragraphs, de-duplicated
  against the narrative sections above it.
- Cut "comes free" / "by construction" / the `X over Y` fragment.
- Added an honest line to "What's different": if your work fits in one sitting, this is more
  machinery than you need — borrowed straight from ripgrep's "why you shouldn't" candor.
- Kept the tables that hold real reference data (runtime matrix, install flags, the four MCP
  tools, command lists). Those earn their grid.
- Left the already-voiced bits alone ("It works. It's also manual, and one long context
  window away from the agent ignoring all of it." — that line was fine).

## What was *not* touched

The install section, flag tables, version-rename note, and build commands are operational
reference, not prose. They weren't AI-voicey, so they stayed. Refactoring for voice is not a
license to churn the parts that were already plain.
