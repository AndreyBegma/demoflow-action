// Spec Decision 5: the results table and the failures block, for the job
// summary now and the sticky comment in slice B; failure messages redacted
// like DemoFlow's `runs-report/redact.ts` (spec 264).
//
//   node report.mjs summary   appends the table to $GITHUB_STEP_SUMMARY

import { appendFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** DemoFlow's pipeline order (`STAGE_NAMES` in `@demoflow/core`). */
export const STAGE_NAMES = [
  'readiness',
  'execution',
  'verification',
  'recording',
  'rendering',
  'storage',
];

/** The API's bound on `failure.message` (DemoFlow spec 263). */
export const MAX_MESSAGE_LENGTH = 1_000;

/** GitHub's limit is 65 536; Decision 5 keeps a margin. */
export const MAX_BODY_LENGTH = 60_000;

// The query string and fragment of an `http(s)://` URL: from the first `?` or
// `#` to the end of the URL (whitespace, a quote, `)` or `>`).
const URL_TAIL = /(https?:\/\/[^\s"'`)>?#]*)[?#][^\s"'`)>]*/gi;

/**
 * DemoFlow's `redactMessage`, ported as is: query strings and fragments of
 * URLs go, the project root becomes `<project>` and the home directory `~`;
 * the result is trimmed and cut to 1000 characters.
 */
export function redactMessage(message, { root, home, pathApi }) {
  let text = message.replace(URL_TAIL, '$1');
  // The root first: it usually sits under the home.
  text = replacePath(text, root, '<project>', pathApi);
  text = replacePath(text, home, '~', pathApi);
  return truncate(text.trim());
}

function replacePath(text, target, replacement, pathApi) {
  // A filesystem root (`/`, `C:\`) would turn every separator into `~`.
  if (target === '' || pathApi.dirname(target) === target) return text;
  const windows = pathApi.sep === '\\';
  const trimmed = target.replace(windows ? /[\\/]+$/ : /\/+$/, '');
  const source = trimmed
    .split(windows ? /[\\/]/ : '/')
    .map(escapeRegExp)
    .join(windows ? '[\\\\/]' : '/');
  // `/home/ann` is not a prefix of `/home/anna`.
  const pattern = new RegExp(`${source}(?![\\p{L}\\p{N}_-])`, windows ? 'giu' : 'gu');
  return text.replace(pattern, replacement);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(text) {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  let end = MAX_MESSAGE_LENGTH - 1;
  // Never split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Backticks become `ˋ` (U+02CB), so a message can never close its fence. */
export function neutraliseBackticks(text) {
  return text.replace(/`/g, 'ˋ');
}

/** A message ready for a public comment: redacted, then fence-safe. */
export function cleanMessage(message, redaction) {
  return neutraliseBackticks(redactMessage(String(message ?? ''), redaction));
}

/** The first failed stage in pipeline order, with its error; undefined if none. */
export function firstFailedStage(result) {
  for (const name of STAGE_NAMES) {
    const stage = result?.stages?.[name];
    if (stage?.status === 'failed') return { name, error: stage.error };
  }
  return undefined;
}

/** Whether a `results.json` entry failed: any non-zero exit (Decision 3, step 12). */
export function isFailed(entry) {
  return entry.exitCode !== 0;
}

/** The Status column of Decision 5. */
export function statusOf(entry) {
  if (!isFailed(entry)) {
    return entry.result?.status === 'completed_with_warnings'
      ? 'passed with warnings'
      : 'passed';
  }
  if (entry.result == null) return 'failed: input error';
  const failed = firstFailedStage(entry.result);
  return failed ? `failed: ${failed.name}` : `failed: exit ${entry.exitCode}`;
}

/** The failure of an entry: stage, step and raw message; undefined when it passed. */
export function failureOf(entry) {
  if (!isFailed(entry)) return undefined;
  if (entry.result == null) {
    return { stage: 'input error', stepIndex: undefined, message: entry.message ?? '' };
  }
  const failed = firstFailedStage(entry.result);
  return {
    stage: failed?.name ?? `exit ${entry.exitCode}`,
    stepIndex: failed?.error?.stepIndex,
    message: failed?.error?.message ?? entry.message ?? '',
  };
}

/** "Took": `finishedAt - startedAt`, in seconds with one decimal. */
export function tookOf(result) {
  const started = Date.parse(result?.startedAt ?? '');
  const finished = Date.parse(result?.finishedAt ?? '');
  if (Number.isNaN(started) || Number.isNaN(finished)) return '-';
  return `${((finished - started) / 1000).toFixed(1)} s`;
}

function megabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The Video column: the MP4 (else the first render) and its size, linked to the artifact. */
export function videoOf(entry, artifactUrl) {
  const renders = entry.result?.renders ?? [];
  const render = renders.find((r) => r.format === 'mp4') ?? renders[0];
  if (!render || !entry.files?.[render.format]) return '-';
  const label = `${render.format.toUpperCase()}, ${megabytes(render.sizeBytes)}`;
  return artifactUrl ? `[${label}](${artifactUrl})` : label;
}

/** A table cell: no line break, no `|` that would split the row. */
function cell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function rowOf(entry, artifactUrl) {
  const name = entry.result?.scenarioName;
  const id = `\`${neutraliseBackticks(entry.scenarioId)}\``;
  const scenario = name ? `${cell(neutraliseBackticks(name))} (${id})` : id;
  return `| ${scenario} | ${statusOf(entry)} | ${tookOf(entry.result)} | ${videoOf(entry, artifactUrl)} |`;
}

function failureBlockOf(entry, redaction) {
  const failure = failureOf(entry);
  const step = failure.stepIndex === undefined ? '' : `, step ${failure.stepIndex}`;
  const message = cleanMessage(failure.message, redaction) || '(no message)';
  return `**\`${neutraliseBackticks(entry.scenarioId)}\`**: ${failure.stage}${step}\n\n\`\`\`text\n${message}\n\`\`\``;
}

/**
 * The job summary of Decision 5, without GIFs and without the comment marker:
 * heading, table, failures, footer; cut to `maxLength` by dropping the last
 * rows (and their failures) behind an "... and N more" line.
 */
export function summaryMarkdown(results, ctx) {
  const scenarios = results.scenarios ?? [];
  const passed = scenarios.filter((entry) => !isFailed(entry)).length;
  const heading =
    scenarios.length === 0
      ? '### DemoFlow: no scenarios matched'
      : `### DemoFlow: ${passed} of ${scenarios.length} scenarios passed`;
  const footer = [
    `demoflow ${results.demoflowVersion}`,
    ctx.runUrl ? `run ${ctx.runUrl}` : undefined,
    `updated ${ctx.now}${ctx.sha ? ` for ${ctx.sha.slice(0, 7)}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const maxLength = ctx.maxLength ?? MAX_BODY_LENGTH;

  const render = (shown) => {
    const parts = [heading];
    if (scenarios.length > 0) {
      const rows = scenarios.slice(0, shown).map((entry) => rowOf(entry, ctx.artifactUrl));
      if (shown < scenarios.length) {
        rows.push(`| ... and ${scenarios.length - shown} more: ${ctx.moreHint ?? 'see the job summary'} | | | |`);
      }
      parts.push(['| Scenario | Status | Took | Video |', '|---|---|---|---|', ...rows].join('\n'));
      const failures = scenarios.slice(0, shown).filter(isFailed);
      if (failures.length > 0) {
        const blocks = failures.map((entry) => failureBlockOf(entry, ctx.redaction));
        parts.push(`<details><summary>Failures</summary>\n\n${blocks.join('\n\n')}\n\n</details>`);
      }
    }
    parts.push(footer);
    return `${parts.join('\n\n')}\n`;
  };

  let shown = scenarios.length;
  let body = render(shown);
  while (body.length > maxLength && shown > 0) {
    shown -= 1;
    body = render(shown);
  }
  return body;
}

/** The context the summary needs, from the runner's environment. */
export function contextFromEnv(env) {
  let sha = env.GITHUB_SHA;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    sha = event.pull_request?.head?.sha ?? sha;
  } catch {
    // No event payload (a local run): the commit SHA is enough.
  }
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  return {
    artifactUrl: env.ARTIFACT_URL || undefined,
    runUrl,
    sha,
    now: new Date().toISOString(),
    redaction: {
      root: path.resolve(env.INPUT_WORKING_DIRECTORY || '.'),
      home: os.homedir(),
      pathApi: path,
    },
  };
}

function main(command) {
  if (command !== 'summary') {
    console.error(`report.mjs: unknown command "${command}"`);
    return 2;
  }
  const results = JSON.parse(readFileSync(process.env.DEMOFLOW_RESULTS, 'utf8'));
  // The summary is the full report; what it cannot hold is in the artifact.
  const ctx = { ...contextFromEnv(process.env), moreHint: 'see the artifact' };
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(results, ctx));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv[2]);
}
