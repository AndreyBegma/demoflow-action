// Spec Decision 3, step 12: the only step that decides the check. With
// `fail-on-error` and any scenario that exited non-zero, one ::error:: per
// failed scenario and exit 1; otherwise exit 0. Reporting problems (artifact,
// summary) never reach this step, so they can never change the verdict.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseBoolean } from './inputs.mjs';
import { cleanMessage, failureOf, isFailed } from './report.mjs';
import { escapeCommand } from './run.mjs';

/** `<scenarioId>: <first failed stage>: <message>`, redacted like the summary. */
export function annotationOf(entry, redaction) {
  const failure = failureOf(entry);
  const message = cleanMessage(failure.message, redaction) || `exit ${entry.exitCode}`;
  return `${entry.scenarioId}: ${failure.stage}: ${message}`;
}

/** The lines to print and the exit code, from `results.json` and `fail-on-error`. */
export function verdict(results, { failOnError, redaction }) {
  const failed = (results.scenarios ?? []).filter(isFailed);
  if (failed.length === 0) {
    return { exitCode: 0, lines: [`All ${results.scenarios?.length ?? 0} scenarios passed`] };
  }
  if (!failOnError) {
    return {
      exitCode: 0,
      lines: [
        `::warning title=demoflow-action::${failed.length} of ${results.scenarios.length} scenarios failed; fail-on-error is false`,
      ],
    };
  }
  return {
    exitCode: 1,
    lines: failed.map(
      (entry) => `::error title=DemoFlow scenario failed::${escapeCommand(annotationOf(entry, redaction))}`,
    ),
  };
}

function main(env) {
  const results = JSON.parse(readFileSync(env.DEMOFLOW_RESULTS, 'utf8'));
  const { exitCode, lines } = verdict(results, {
    failOnError: parseBoolean(env.INPUT_FAIL_ON_ERROR) !== false,
    redaction: {
      root: path.resolve(env.INPUT_WORKING_DIRECTORY || '.'),
      home: os.homedir(),
      pathApi: path,
    },
  });
  for (const line of lines) console.log(line);
  return exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.env);
}
