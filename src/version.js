'use strict';
// What is actually running. With the app deployed by pulling a commit onto a
// server, "which version is live" has to be answerable from the UI rather
// than by trusting that the last deploy worked.
//
// In a container there is no .git, so the commit is baked in at image build
// time; in development it is read straight from the working copy, where it
// can also report that there are uncommitted changes.
const path = require('node:path');
const fs = require('node:fs');

const pkg = require('../package.json');

function fromGit() {
  const root = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  try {
    const { execFileSync } = require('node:child_process');
    const git = (args) => execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return {
      commit: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      committedAt: git(['log', '-1', '--format=%cI']),
      // A dev machine is usually mid-edit, and saying so avoids chasing a
      // change that was never committed, let alone deployed.
      dirty: git(['status', '--porcelain']).length > 0,
    };
  } catch {
    return null;
  }
}

function build() {
  const env = process.env;
  const git = fromGit();

  const commit = env.GIT_COMMIT || (git && git.commit) || null;
  const branch = env.GIT_BRANCH || (git && git.branch) || null;

  return {
    version: pkg.version,
    commit: commit ? String(commit).slice(0, 12) : null,
    branch: branch || null,
    committedAt: env.GIT_COMMITTED_AT || (git && git.committedAt) || null,
    builtAt: env.BUILD_TIME || null,
    dirty: git ? git.dirty : false,
    // Where this instance is running, so a browser pointed at the wrong one
    // is obvious.
    source: env.BUILD_TIME ? 'container' : 'source',
    startedAt: new Date().toISOString(),
  };
}

// Resolved once: shelling out to git on every request would be silly, and
// none of this changes while the process is alive.
const INFO = build();

// "0.2.0 (a1b2c3d)", or with a + when the working copy has uncommitted edits.
function label() {
  const parts = [`v${INFO.version}`];
  if (INFO.commit) parts.push(`${INFO.commit}${INFO.dirty ? '+' : ''}`);
  return parts.join(' · ');
}

module.exports = { info: INFO, label };
