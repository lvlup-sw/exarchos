import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

// ─── The published site, reduced to what makes it build ──────────────────────
//
// The previous site carried 46 hand-written pages describing an Exarchos that
// had moved on without them. They were removed rather than migrated: a stale
// page outranks the source in a search result, so it is worse than no page.
//
// What survives is the machinery — this config, one index, and `public/`, which
// is where the deploy workflow stages the bootstrap installers so the README
// can advertise an install one-liner that is not a tagged raw.githubusercontent
// URL. The pages come back when someone writes them.

const DOCS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The relocated document subtrees, as globs, so VitePress does not try to
 * publish them.
 *
 * Those documents live in an external repository now, and `npm run docs:mount`
 * links them back into this directory for local reading. They are mounted as
 * SYMLINKS, so the set is read from the tree rather than listed here — a list
 * would be a third copy of something `.gitignore` and the mount script already
 * disagree about eventually, and the failure would be silent: an unlisted
 * subtree does not break the build, it publishes several hundred internal
 * design documents to a public site.
 *
 * On CI nothing is mounted and this is empty, which is the correct answer
 * there.
 *
 * Not theoretical: with this exclusion removed the build follows the links and
 * dies compiling a mounted ADR, because Vue reads a bare `<...>` in ordinary
 * prose as an unclosed element. That corpus fails loudly by luck. One that
 * happens to parse would simply be published.
 */
function mountedSubtrees(): string[] {
  return readdirSync(DOCS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => `${entry.name}/**`)
}

export default defineConfig({
  title: 'Exarchos',
  description: 'Durable SDLC workflows for Claude Code — checkpoint any task, resume where you left off',

  // GitHub Pages project site.
  base: '/exarchos/',

  // `README.md` explains the directory to someone reading the repository; it is
  // not a page. VitePress also treats it as an index candidate, so leaving it
  // in makes the site's home page ambiguous.
  srcExclude: ['README.md', 'migrations/**', ...mountedSubtrees()],

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/exarchos/logo.svg' }]],

  themeConfig: {
    logo: '/logo.svg',

    // No nav and no sidebar: both described pages that no longer exist, and
    // VitePress renders a nav entry pointing at a 404 without complaint.

    socialLinks: [{ icon: 'github', link: 'https://github.com/lvlup-sw/exarchos' }],

    editLink: {
      pattern: 'https://github.com/lvlup-sw/exarchos/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
    },

    footer: {
      message: 'Released under the Apache-2.0 License.',
      copyright: 'Copyright (c) lvlup-sw',
    },
  },
})
