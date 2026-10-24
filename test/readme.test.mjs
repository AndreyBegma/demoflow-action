import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const unquote = (value) => {
  const text = value.trim();
  if (text.length >= 2 && (text[0] === "'" || text[0] === '"') && text.at(-1) === text[0]) return text.slice(1, -1);
  return text;
};

// action.yml has a fixed shape: `inputs:` / `outputs:` at column 0, one entry
// per 2-space key, `description`/`default`/`value` at 4 spaces, one line each.
function parseSection(yaml, section) {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${section}:`);
  assert.notEqual(start, -1, `action.yml has no ${section}:`);
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const entry = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (entry) {
      entries.push({ name: entry[1], description: '', default: undefined });
      continue;
    }
    const field = /^ {4}(description|default):\s?(.*)$/.exec(line);
    if (field && entries.length > 0) entries.at(-1)[field[1]] = unquote(field[2]);
  }
  return entries;
}

const cell = (text) => text.replaceAll('|', '\\|');

function renderInputs(entries) {
  const rows = entries.map((e) => `| \`${e.name}\` | ${e.default === '' ? '*(empty)*' : `\`${cell(e.default ?? '')}\``} | ${cell(e.description)} |`);
  return ['| Input | Default | Description |', '|---|---|---|', ...rows].join('\n');
}

function renderOutputs(entries) {
  const rows = entries.map((e) => `| \`${e.name}\` | ${cell(e.description)} |`);
  return ['| Output | Description |', '|---|---|', ...rows].join('\n');
}

function block(readme, name) {
  const match = new RegExp(`<!-- ${name}:start -->\\n([\\s\\S]*?)\\n<!-- ${name}:end -->`).exec(readme);
  assert.ok(match, `README.md has no <!-- ${name}:start --> ... <!-- ${name}:end --> block`);
  return match[1];
}

const action = read('action.yml');
const readme = read('README.md');

test('README inputs table matches action.yml', () => {
  const inputs = parseSection(action, 'inputs');
  assert.ok(inputs.length > 0);
  assert.equal(block(readme, 'inputs'), renderInputs(inputs));
});

test('README outputs table matches action.yml', () => {
  const outputs = parseSection(action, 'outputs');
  assert.ok(outputs.length > 0);
  assert.equal(block(readme, 'outputs'), renderOutputs(outputs));
});

test('action.yml carries the Marketplace metadata', () => {
  assert.match(action, /^name: DemoFlow Demo Videos$/m);
  const description = /^description: (.+)$/m.exec(action)?.[1] ?? '';
  assert.ok(description.length > 0 && description.length < 125, `description is ${description.length} characters`);
  assert.match(action, /^author: \S+/m);
  assert.match(action, /^branding:\n {2}icon: film\n {2}color: purple$/m);
});

test('README documents the points the Marketplace page must make', () => {
  for (const needle of ['pull_request_target', 'devCommand', '${PORT}', 'previews: false', 'artifact-name', 'ADR-0008', 'docs/sticky-comment.png']) {
    assert.ok(readme.includes(needle), `README.md does not mention ${needle}`);
  }
});

test('CHANGELOG follows Keep a Changelog and has 1.0.0', () => {
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /keepachangelog\.com/);
  assert.match(changelog, /^## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}$/m);
});

test('release.yml moves the major tag on a published release only', () => {
  const release = read('.github/workflows/release.yml');
  assert.match(release, /^on:\n {2}release:\n {4}types: \[published\]$/m);
  assert.doesNotMatch(release, /pull_request/);
  assert.match(release, /^permissions: \{\}$/m);
  assert.equal(release.match(/contents: write/g)?.length, 1, 'contents: write exactly once');
  const job = release.slice(release.indexOf('\njobs:'));
  assert.match(job, /permissions:\n {6}contents: write/);
  assert.match(release, /git push --force origin "refs\/tags\/\$major"/);
});
