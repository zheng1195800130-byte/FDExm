'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createLaunchPlan } = require('../desktop/launch-plan.cjs');
const plan = createLaunchPlan({ root: path.resolve(__dirname, '..'), electronExecutable: require('electron'), argv: process.argv.slice(2) });
const child = spawn(plan.executable, plan.args, { env: plan.env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
