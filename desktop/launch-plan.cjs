'use strict';
const path = require('node:path');
const { findPortableExecutable, inspectDataDirectory } = require('./data-location.cjs');

function createLaunchPlan({ root, electronExecutable, env = process.env, argv = [] }) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const args = argv.filter(arg => arg !== '--dev');
  const portable = findPortableExecutable({ root });
  // Preserve a pre-existing source archive. Only an empty source archive can
  // defer to the portable edition; an explicit data directory stays isolated.
  const explicitData = typeof env.FDE_DATA_DIR === 'string' && env.FDE_DATA_DIR.trim();
  const usePortable = portable && !argv.includes('--dev') && !explicitData &&
    inspectDataDirectory(path.join(root, 'data')).status === 'empty';
  return {
    executable: usePortable ? portable : electronExecutable,
    args: usePortable ? args : [path.resolve(root), ...args],
    env: childEnv,
    mode: usePortable ? 'portable' : 'source'
  };
}

module.exports = { createLaunchPlan };
