// Spec Decision 3, steps 3, 5 and 6: the `demoflow` installed with
// `npm install --prefix "$RUNNER_TEMP/demoflow-cli"`, and the Playwright it
// pins, resolved to their entry points and run as `node <entry>` (no `.cmd`
// shims on Windows, no registry round-trip per call).
//
//   node cli.mjs demoflow <args...>     e.g. `demoflow setup`
//   node cli.mjs playwright <args...>   e.g. `playwright install-deps chromium`

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where action.yml installs the CLI: `$DEMOFLOW_CLI_PREFIX`, else `$RUNNER_TEMP/demoflow-cli`. */
export function cliPrefix(env = process.env) {
  if (env.DEMOFLOW_CLI_PREFIX) return env.DEMOFLOW_CLI_PREFIX;
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is not set');
  return path.join(env.RUNNER_TEMP, 'demoflow-cli');
}

/** The absolute path of the `demoflow` bin script under `prefix`. */
export function resolveDemoflowBin(prefix) {
  const require = createRequire(path.join(prefix, 'package.json'));
  const manifestPath = require.resolve('demoflow/package.json');
  const { bin } = require(manifestPath);
  const entry = typeof bin === 'string' ? bin : bin?.demoflow;
  if (!entry) throw new Error(`${manifestPath} declares no demoflow bin`);
  return path.join(path.dirname(manifestPath), entry);
}

/** The `cli.js` of the Playwright `demoflow` depends on, not any other copy. */
export function resolvePlaywrightCli(prefix) {
  const require = createRequire(path.join(prefix, 'package.json'));
  const fromDemoflow = createRequire(require.resolve('demoflow/package.json'));
  return path.join(path.dirname(fromDemoflow.resolve('playwright/package.json')), 'cli.js');
}

function main([tool, ...args]) {
  const prefix = cliPrefix();
  let entry;
  if (tool === 'demoflow') entry = resolveDemoflowBin(prefix);
  else if (tool === 'playwright') entry = resolvePlaywrightCli(prefix);
  else {
    console.error(`cli.mjs: unknown tool "${tool}" (demoflow or playwright)`);
    return 2;
  }
  const child = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
