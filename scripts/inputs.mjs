// Spec Decision 3, steps 1 and 2: decide whether `actions/setup-node` runs,
// then validate the inputs before anything is installed.
//
//   node inputs.mjs setup-node   writes `needed=true|false` to $GITHUB_OUTPUT
//   node inputs.mjs validate     one ::error:: per bad input, exit 1
//
// `setup-node` may run on an old Node (that is why it runs), so this file
// keeps to syntax and built-ins every maintained Node has.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_VERSION = '0.6.0';
export const MIN_NODE_MAJOR = 22;

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `formats` values `demoflow run --format` accepts (spec, facts). */
export const FORMATS = [
  'mp4',
  'gif',
  'webm',
  'mp4-vertical',
  'gif-vertical',
  'webm-vertical',
  'mp4-square',
  'gif-square',
  'webm-square',
];

/** Comma-separated `formats`, trimmed; empty input is no `--format` at all. */
export function parseFormats(input) {
  const text = String(input ?? '').trim();
  if (text === '') return [];
  return text.split(',').map((format) => format.trim());
}

/**
 * Compare two versions that match SEMVER. A prerelease sorts before its
 * release (`0.6.0-rc.1` < `0.6.0`); prerelease identifiers are not compared
 * further, which the >= 0.6.0 gate does not need.
 */
export function compareVersions(a, b) {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (coreA[i] !== coreB[i]) return coreA[i] < coreB[i] ? -1 : 1;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

function splitVersion(version) {
  const [core, pre] = version.split(/-(.*)/s);
  return [core.split('.').map(Number), pre];
}

/** The problems with the action's inputs, as messages; empty when all are valid. */
export function validate(env) {
  const errors = [];
  const version = String(env.INPUT_VERSION ?? '').trim();
  if (!SEMVER.test(version)) {
    errors.push(
      `version: "${version}" is not an exact version; use one like ${MIN_VERSION} (no range, no tag such as latest)`,
    );
  } else if (compareVersions(version, MIN_VERSION) < 0) {
    errors.push(
      `version: ${version} is older than ${MIN_VERSION}, the first demoflow release this action supports`,
    );
  }

  for (const format of parseFormats(env.INPUT_FORMATS)) {
    if (!FORMATS.includes(format)) {
      errors.push(
        `formats: "${format}" is not a format; use a comma-separated list of ${FORMATS.join(', ')}`,
      );
    }
  }

  const port = String(env.INPUT_PORT ?? '').trim();
  if (port !== '' && !(isInteger(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    errors.push(`port: "${port}" is not a port number (1-65535)`);
  }

  const retention = String(env.INPUT_RETENTION_DAYS ?? '').trim();
  if (!isInteger(retention)) {
    errors.push(`retention-days: "${retention}" is not a whole number of days`);
  }

  if (String(env.INPUT_ARTIFACT_NAME ?? '').trim() === '') {
    errors.push('artifact-name: must not be empty');
  }

  const maxGif = String(env.INPUT_MAX_GIF_SIZE_MB ?? '').trim();
  if (!(/^\d+(\.\d+)?$/.test(maxGif) && Number(maxGif) > 0)) {
    errors.push(`max-gif-size-mb: "${maxGif}" is not a positive number of megabytes`);
  }

  const previewsRetention = String(env.INPUT_PREVIEWS_RETENTION_DAYS ?? '').trim();
  if (!isInteger(previewsRetention)) {
    errors.push(`previews-retention-days: "${previewsRetention}" is not a whole number of days`);
  }

  const branch = String(env.INPUT_PREVIEWS_BRANCH ?? '').trim();
  if (!isBranchName(branch)) {
    errors.push(`previews-branch: "${branch}" is not a valid branch name`);
  }

  for (const [name, key] of [
    ['fail-on-error', 'INPUT_FAIL_ON_ERROR'],
    ['cache-browsers', 'INPUT_CACHE_BROWSERS'],
    ['install-system-deps', 'INPUT_INSTALL_SYSTEM_DEPS'],
    ['comment', 'INPUT_COMMENT'],
    ['previews', 'INPUT_PREVIEWS'],
  ]) {
    if (parseBoolean(env[key]) === undefined) {
      errors.push(`${name}: "${env[key] ?? ''}" is not true or false`);
    }
  }
  return errors;
}

/**
 * `true` / `false`, else undefined. Lower case only: action.yml's `if:`
 * conditions compare the raw input with `'true'`.
 */
export function parseBoolean(value) {
  const text = String(value ?? '').trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

function isInteger(text) {
  return /^\d+$/.test(text);
}

/**
 * A branch name `git check-ref-format --branch` accepts: no control
 * characters, space, `~^:?*[\`, `..` or `@{`; no `/`-separated part that
 * starts with `.` or ends with `.lock`; no leading `-` or `/`, no trailing
 * `/` or `.`; not `@`.
 */
export function isBranchName(name) {
  if (name === '' || name === '@' || name.startsWith('-')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$/.test(name)) return false;
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Whether `actions/setup-node` must run: `node-version` set, or this Node is too old. */
export function needsSetupNode(env, nodeVersion) {
  if (String(env.INPUT_NODE_VERSION ?? '').trim() !== '') return true;
  return Number(nodeVersion.split('.')[0]) < MIN_NODE_MAJOR;
}

function main(command) {
  if (command === 'setup-node') {
    const needed = needsSetupNode(process.env, process.versions.node);
    appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
    console.log(
      needed
        ? `Setting up Node (found ${process.versions.node}, input node-version "${process.env.INPUT_NODE_VERSION ?? ''}")`
        : `Using Node ${process.versions.node} from PATH`,
    );
    return 0;
  }
  if (command === 'validate') {
    const errors = validate(process.env);
    for (const error of errors) console.log(`::error title=demoflow-action input::${error}`);
    return errors.length === 0 ? 0 : 1;
  }
  console.error(`inputs.mjs: unknown command "${command}"`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv[2]);
}
