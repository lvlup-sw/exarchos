/** Configuration for the self-hosted Renovate runner. */
module.exports = {
  platform: 'github',
  onboarding: false,
  requireConfig: 'optional',

  repositories: [
    'lvlup-sw/exarchos',
    'lvlup-sw/agentic-engine'
  ],

  /** The shared base config sets the schedule, the patch automerge and the rate limits. */
  extends: [
    'github>lvlup-sw/exarchos//tools/renovate-config/renovate.json'
  ],

  /** A different prefix keeps these branches apart from the branches of the Mend app. */
  branchPrefix: 'renovate-self/',

  gitAuthor: 'Renovate Bot <bot@renovateapp.com>'
};
