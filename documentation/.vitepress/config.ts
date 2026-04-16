import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Exarchos',
  description: 'Durable SDLC workflows for Claude Code — checkpoint any task, resume where you left off',

  // GitHub Pages project site
  base: '/exarchos/',

  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/exarchos/logo.svg' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Learn', link: '/learn/' },
      { text: 'Guide', link: '/guide/' },
      { text: 'Reference', link: '/reference/' },
      { text: 'Architecture', link: '/architecture/' },
      { text: 'Examples', link: '/examples/' },
    ],

    sidebar: {
      '/learn/': [
        {
          text: 'Learn',
          items: [
            { text: 'Why Exarchos', link: '/learn/' },
            { text: 'Core Concepts', link: '/learn/core-concepts' },
            { text: 'How It Works', link: '/learn/how-it-works' },
            { text: 'Comparison', link: '/learn/comparison' },
          ],
        },
      ],
      '/guide/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Overview', link: '/guide/' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'First Workflow', link: '/guide/first-workflow' },
          ],
        },
        {
          text: 'Workflows',
          items: [
            { text: 'Feature Development', link: '/guide/feature-workflow' },
            { text: 'Debugging', link: '/guide/debug-workflow' },
            { text: 'Refactoring', link: '/guide/refactor-workflow' },
            { text: 'Oneshot', link: '/guide/oneshot-workflow' },
          ],
        },
        {
          text: 'Key Capabilities',
          items: [
            { text: 'Checkpoint & Resume', link: '/guide/checkpoint-resume' },
            { text: 'Agent Teams', link: '/guide/agent-teams' },
            { text: 'Review Process', link: '/guide/review-process' },
            { text: 'Project Configuration', link: '/guide/project-config' },
            { text: 'Companion Plugins', link: '/guide/companion-plugins' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'Commands', link: '/reference/commands' },
            { text: 'Skills', link: '/reference/skills' },
            { text: 'Agents', link: '/reference/agents' },
            { text: 'Scripts', link: '/reference/scripts' },
            { text: 'Events', link: '/reference/events' },
            { text: 'Configuration', link: '/reference/configuration' },
            { text: 'Convergence Gates', link: '/reference/convergence-gates' },
          ],
        },
        {
          text: 'MCP Tools',
          items: [
            { text: 'Tools Overview', link: '/reference/tools/' },
            { text: 'Workflow', link: '/reference/tools/workflow' },
            { text: 'Event', link: '/reference/tools/event' },
            { text: 'Orchestrate', link: '/reference/tools/orchestrate' },
            { text: 'View', link: '/reference/tools/view' },
          ],
        },
      ],
      '/architecture/': [
        {
          text: 'Architecture',
          items: [
            { text: 'Overview', link: '/architecture/' },
            { text: 'Event Sourcing', link: '/architecture/event-sourcing' },
            { text: 'State Machine', link: '/architecture/state-machine' },
            { text: 'Token Efficiency', link: '/architecture/token-efficiency' },
            { text: 'Agent Model', link: '/architecture/agent-model' },
            { text: 'Design Rationale', link: '/architecture/design-rationale' },
            { text: 'Platform Portability', link: '/architecture/platform-portability' },
            { text: 'Facade and Deployment Choices', link: '/facade-and-deployment' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Overview', link: '/examples/' },
            { text: 'Feature Development', link: '/examples/feature-development' },
            { text: 'Bug Investigation', link: '/examples/bug-investigation' },
            { text: 'Code Refactor', link: '/examples/code-refactor' },
            { text: 'Agent Delegation', link: '/examples/agent-delegation' },
            { text: 'Session Recovery', link: '/examples/session-recovery' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/lvlup-sw/exarchos' },
    ],

    editLink: {
      pattern: 'https://github.com/lvlup-sw/exarchos/edit/main/documentation/:path',
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
