module.exports = {
  // Self-hosted specific settings
  platform: 'github',
  onboarding: false,
  requireConfig: 'optional',

  // Target repositories
  repositories: [
    'lvlup-sw/exarchos',
    'lvlup-sw/agentic-engine'
  ],

  // Extend the shared base config (schedule, automerge, rate limits)
  extends: [
    'github>lvlup-sw/exarchos//renovate-config/renovate.json'
  ],

  // Use different branch prefix to avoid conflicts with Mend app
  branchPrefix: 'renovate-self/',

  // Git author for commits
  gitAuthor: 'Renovate Bot <bot@renovateapp.com>'
};
