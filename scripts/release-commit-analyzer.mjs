// The analyzeCommits step of semantic-release (.releaserc.json): @semantic-release/commit-analyzer with one change.
// While the last release is 0.x, a breaking change bumps the minor version instead of the major (0.3.1 → 0.4.0), like
// release-please's "bump-minor-pre-major" in the app repository; feat still bumps the minor, fix/docs/… the patch.
// To release 1.0.0, set "bumpMinorPreMajor": false in .releaserc.json; the next breaking change then bumps the major.
import { analyzeCommits as analyze } from '@semantic-release/commit-analyzer';

export async function analyzeCommits({ bumpMinorPreMajor = true, ...pluginConfig }, context) {
  const releaseType = await analyze(pluginConfig, context);
  const lastVersion = context.lastRelease?.version;
  if (releaseType === 'major' && bumpMinorPreMajor && lastVersion?.startsWith('0.')) {
    context.logger.log('The last release is %s (before 1.0): the breaking change bumps the minor version', lastVersion);
    return 'minor';
  }
  return releaseType;
}
