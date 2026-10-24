// Spec Decision 3, steps 7 and 8: `demoflow check --json`, the `scenarios`
// filter, then every matched scenario run sequentially (sorted, never stopping
// at a failure); renders staged for the artifact, `results.json` written,
// step outputs set. The verdict is not decided here: once `check` passed,
// this step exits 0 and `verdict.mjs` applies `fail-on-error`.

import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliPrefix, resolveDemoflowBin } from './cli.mjs';
import { filterPaths, parseGlobs } from './glob.mjs';
import { parseFormats } from './inputs.mjs';

/** Lines of stderr kept as the message of a run without a JSON result. */
export const STDERR_TAIL_LINES = 20;

/** `demoflow/admin/users.demo.json` → `admin__users` (Decision 3). */
export function slugOf(scenarioId) {
  return scenarioId
    .replace(/\\/g, '/')
    .replace(/^demoflow\//, '')
    .replace(/\.demo\.json$/, '')
    .replace(/\//g, '__');
}

/** The single JSON object `--json` prints, or undefined when stdout is not one. */
export function parseJsonObject(stdout) {
  try {
    const value = JSON.parse(stdout.trim());
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** The last `count` non-empty lines of `text`. */
export function tailLines(text, count = STDERR_TAIL_LINES) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n');
}

/**
 * The staged file name of a render: `demo.<ext>` for `mp4`, `gif` and `webm`;
 * a cropped variant keeps its crop (`demo-vertical.mp4`), so it never
 * overwrites the plain file of the same extension.
 */
export function stagedNameOf(render) {
  const ext = path.extname(render.file).slice(1) || render.format.split('-')[0];
  const variant = render.format.includes('-') ? `-${render.format.split('-').slice(1).join('-')}` : '';
  return `demo${variant}.${ext}`;
}

/**
 * One `results.json` entry from a finished `demoflow run`, staging its renders
 * and `result.json` under `<stagingDir>/<slug>/`. `files` maps each format to
 * its path relative to the staging directory.
 */
export function entryOf({ scenarioId, exitCode, stdout, stderr }, stagingDir) {
  const slug = slugOf(scenarioId);
  const parsed = parseJsonObject(stdout);
  if (parsed === undefined || typeof parsed.runDir !== 'string') {
    return {
      scenarioId,
      slug,
      // A run without a result failed, whatever its exit code said.
      exitCode: exitCode === 0 ? 1 : exitCode,
      result: null,
      message: tailLines(stderr) || tailLines(stdout) || `demoflow run exited with code ${exitCode} and printed no result`,
      files: {},
    };
  }
  const { runDir, ...result } = parsed;
  const dir = path.join(stagingDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const files = {};
  for (const render of result.renders ?? []) {
    const name = stagedNameOf(render);
    copyFileSync(path.join(runDir, ...render.file.split('/')), path.join(dir, name));
    files[render.format] = `${slug}/${name}`;
  }
  return { scenarioId, slug, exitCode, result, message: null, files };
}

/** `demoflow run` arguments for one scenario (Decision 3, step 8). */
export function runArgs(file, { home, formats, port }) {
  const args = ['run', file, '--json', '--out', home];
  for (const format of formats) args.push('--format', format);
  if (port) args.push('--port', port);
  return args;
}

/** Escape a workflow command's message (`%`, CR, LF). */
export function escapeCommand(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Run `node <bin> <args>`, streaming stderr (into the log) while capturing both streams. */
function runNode(bin, args, { cwd, env, echoStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      // The step's environment: secrets a scenario reads come from the action's `env:`.
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      if (echoStderr) process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ exitCode: code ?? 1, signal, stdout, stderr });
    });
  });
}

/** The CLI's own words for a failed `check` (exit 1: FFmpeg or browser missing; 2: no config). */
export function checkFailureMessage({ exitCode, stdout, stderr }) {
  const parsed = parseJsonObject(stdout);
  const missing = [];
  if (parsed?.ffmpeg === 'missing') missing.push('FFmpeg is missing');
  if (parsed?.browser === 'missing') missing.push('the browser is missing (demoflow setup)');
  const detail = [stderr.trim(), missing.join('; ')].filter(Boolean).join('\n');
  return `demoflow check failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`;
}

function setOutputs(file, outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`);
  appendFileSync(file, lines.join(''));
}

/** The whole step; returns its exit code (1 only when `check` failed). */
export async function main(env) {
  const temp = env.RUNNER_TEMP;
  const workingDirectory = path.resolve(env.INPUT_WORKING_DIRECTORY || '.');
  const home = path.join(temp, 'demoflow-home');
  const stagingDir = path.join(temp, 'demoflow-artifact');
  const resultsPath = path.join(temp, 'demoflow-results.json');
  const bin = resolveDemoflowBin(cliPrefix(env));

  // A second use of the action in the same job must not upload the first one's files.
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(resultsPath, { force: true });
  mkdirSync(stagingDir, { recursive: true });

  const check = await runNode(bin, ['check', '--json'], { cwd: workingDirectory, env, echoStderr: false });
  const checked = parseJsonObject(check.stdout);
  if (check.exitCode !== 0 || !Array.isArray(checked?.scenarios)) {
    console.log(`::error title=demoflow check::${escapeCommand(checkFailureMessage(check))}`);
    return 1;
  }

  const scenarios = filterPaths(checked.scenarios, parseGlobs(env.INPUT_SCENARIOS));
  const options = {
    home,
    formats: parseFormats(env.INPUT_FORMATS),
    port: String(env.INPUT_PORT ?? '').trim(),
  };
  const entries = [];
  if (scenarios.length === 0) {
    console.log(
      `::notice title=demoflow-action::No scenario matched ${escapeCommand(JSON.stringify(env.INPUT_SCENARIOS ?? ''))} among ${checked.scenarios.length} found by demoflow check`,
    );
  }
  for (const scenarioId of scenarios) {
    console.log(`::group::${scenarioId}`);
    const file = path.join(checked.root ?? workingDirectory, ...scenarioId.split('/'));
    const run = await runNode(bin, runArgs(file, options), { cwd: workingDirectory, env, echoStderr: true });
    console.log('::endgroup::');
    let entry;
    try {
      entry = entryOf({ scenarioId, ...run }, stagingDir);
    } catch (error) {
      // A result whose renders cannot be staged is a failed demo, not a crashed action.
      entry = {
        scenarioId,
        slug: slugOf(scenarioId),
        exitCode: run.exitCode === 0 ? 1 : run.exitCode,
        result: null,
        message: `could not stage the renders: ${error.message}`,
        files: {},
      };
    }
    console.log(`${scenarioId}: exit ${entry.exitCode}`);
    entries.push(entry);
  }

  const results = { schemaVersion: 1, demoflowVersion: env.INPUT_VERSION, scenarios: entries };
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  const failed = entries.filter((entry) => entry.exitCode !== 0).length;
  setOutputs(env.GITHUB_OUTPUT, {
    results: resultsPath,
    total: entries.length,
    passed: entries.length - failed,
    failed,
    // Every entry with a result staged its `result.json`, rendered or not.
    staged: entries.some((entry) => entry.result !== null),
  });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.env);
}
