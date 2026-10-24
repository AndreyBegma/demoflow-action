# demoflow-action: specification

Repository: `AndreyBegma/demoflow-action` (public, default branch `main`; holds
`LICENSE` (MIT) and a stub `README.md` from the initial commit). This file
lives in the repository as `docs/spec.md`.

Origin: DemoFlow roadmap, Cross-cutting "GitHub Action"; DemoFlow issue
[#287](https://github.com/AndreyBegma/DemoFlow/issues/287). Decisions it
honours: DemoFlow [ADR-0008](https://github.com/AndreyBegma/DemoFlow/blob/develop/docs/adr/0008-cloud-boundary.md)
(nothing uploaded to a DemoFlow cloud; videos stay with the user, which in CI
means GitHub's own storage),
[ADR-0011](https://github.com/AndreyBegma/DemoFlow/blob/develop/docs/adr/0011-no-docker-socket-or-host-cache-on-pull-requests.md)
(no host cache or privileged access on pull requests),
[ADR-0002](https://github.com/AndreyBegma/DemoFlow/blob/develop/docs/adr/0002-develop-integration-staging-and-os-matrix.md)
(Linux, macOS and Windows).

## Summary

A GitHub Action that, on every pull request, runs each
`demoflow/**/*.demo.json` of a project with the published `demoflow` npm
package, uploads the rendered MP4s (and GIFs and `result.json`) as a workflow
artifact, posts one sticky PR comment with a table of results and inline GIF
previews, and fails the check when any scenario fails.

```yaml
# .github/workflows/demoflow.yml in the user's repository
on: pull_request
permissions:
  contents: write        # GIF previews branch (optional, see Decision 4)
  pull-requests: write   # the sticky comment
concurrency:
  group: demoflow-${{ github.ref }}
  cancel-in-progress: true
jobs:
  demos:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 22 }
      - run: npm ci          # the app's own dependencies: devCommand needs them
      - uses: AndreyBegma/demoflow-action@v1
        env:
          APP_PASSWORD: ${{ secrets.APP_PASSWORD }}   # secrets a scenario reads
```

## Facts about `demoflow` this spec relies on

Confirmed in DemoFlow `develop` at the 0.6.0 release (`dc66efc`).

| Fact | Source |
|---|---|
| npm package `demoflow`, `engines.node >=22`; deps `playwright 1.64.1`, `ffmpeg-static 5.3.0` | `npm view demoflow@0.6.0` |
| `demoflow run <file> [--json] [--out <dir>] [--format <f>]... [--port <n>] [--fresh-app] [--base-url <url>]` | `apps/cli/src/main.ts` |
| `--json`: exactly one JSON object on stdout = `result.json` + `runDir`; progress on stderr | spec 5, `commands/output.ts` |
| Exit codes: `0` completed (with or without warnings), `1` execution or verification failed, `2` invalid input or readiness failed (app never answered), `3` another stage failed (recording, rendering, storage) | `commands/exit.ts`, `errors.ts` |
| `RunResult`: `runId`, `scenarioId` (path relative to the project root), `scenarioName`, `startedAt`, `finishedAt`, `status` (`completed` / `completed_with_warnings` / `failed`), `stages.{readiness,execution,verification,recording,rendering,storage}.{status,error.message,error.stepIndex}`, `renders[]` `{format, file (relative to runDir), durationMs, sizeBytes, width, height, fps}`, `warnings[]` | `packages/core/src/run-result.ts` |
| Run directory: `<home>/runs/<runId>/`; renders at `render/ffmpeg.<ext>` (`mp4`, `gif`, ...); home = `--out` first | `config/home.ts`, `renderer.ts` |
| A failed verification is still rendered (the video is the evidence); a readiness failure has no video | `commands/run.ts`, ADR-0004 §4 |
| `--format` is repeatable and replaces `render.formats`; values `mp4 gif webm mp4-vertical gif-vertical webm-vertical mp4-square gif-square webm-square` | `main.ts`, `run-result.ts` |
| `demoflow run` starts the app from `devCommand` (`command`, `args`, `readyUrl`, `timeoutMs`; no shell) and stops it after the run; `${PORT}` templates in `baseUrl`/`devCommand`; `--port` fills them and sets `PORT` | spec 90, spec 337 |
| `demoflow check --json` prints `{ root, configValid, scenarios: ["demoflow/a.demo.json", ...] (sorted, "/" separators), ffmpeg: system|bundled|missing, browser: installed|missing }`; exit 1 if FFmpeg or browser missing, exit 2 without `demoflow.config.json` | spec 266, `mcp/readonly.ts` |
| `demoflow setup` installs Chromium through the pinned Playwright (honours `PLAYWRIGHT_BROWSERS_PATH`); `run` does it on first use too. System libraries are **not** installed | `commands/browser.ts`, `setup.ts` |
| FFmpeg: a system `ffmpeg` with libx264 on `PATH` wins, else the bundled `ffmpeg-static` binary (downloaded by its npm install script) | `renderer/src/plan/ffmpeg.ts` |
| DemoFlow's own CI installs Chromium system libraries with `playwright install-deps chromium` on Linux only; macOS and Windows need nothing | `.github/workflows/package-smoke.yml` |
| `demoflow run` reports to the DemoFlow website only after `demoflow login`; CI has no credentials, so nothing leaves the runner | ADR-0008 §1, `runs-report/report.ts` |
| `demoflow list` lists past *runs*, not scenarios; the scenario list comes from `check` | spec 266 |

## Decisions

### 1. Composite action with zero-dependency Node scripts

`action.yml` is `runs.using: composite`. Logic lives in plain ESM files under
`scripts/*.mjs` run with the job's `node` (>= 22, already required by
`demoflow`), using only Node built-ins and the global `fetch` for the GitHub
REST API. No `package.json` runtime dependencies, no bundling, no `dist/`.

*Why:* a composite action can call `actions/upload-artifact` and
`actions/cache` directly; a JavaScript action cannot call other actions and
would have to re-implement artifact upload with `@actions/artifact`. A
node20/24 JavaScript action also needs `@actions/*` dependencies bundled with
ncc and a committed `dist/` kept in sync on every change and every Dependabot
bump. Bash alone cannot build a comment table or parse JSON portably across
Windows runners. Node scripts are testable with `node --test`, cross-platform,
and need nothing installed. Posting a comment is three REST calls; `fetch`
does that reliably.

Rules for the composite:
- Every `run:` step has `shell: bash` only for one-line invocations; logic is
  in Node. Inputs reach scripts through `env:` (`INPUT_*`), never through
  `${{ inputs.x }}` interpolated into a script body. *Why:* script injection.
- Third-party actions are pinned by commit SHA with the version in a comment,
  the same SHAs DemoFlow's CI uses: `actions/upload-artifact` v7.0.2
  (`cf430e030ddbb5b0abf93d22962f4752f3646cd9`), `actions/setup-node` v7.1.0
  (`949feb2413d6458794dcd2491c4babbbce0c15c1`); `actions/cache` pinned to its
  current major at implementation time. *Why:* the brief named
  `upload-artifact@v4`, but DemoFlow already runs v7, which keeps the v4+
  behaviour this spec needs (`artifact-url` output, `overwrite`).

### 2. Inputs and outputs

| Input | Default | Meaning |
|---|---|---|
| `version` | `0.6.0` | Exact `demoflow` version. Must match `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$` and be >= `0.6.0`; anything else (a range, `latest`) fails the step before installing. *Why:* reproducible checks; `0.6.0` is the first release with `check --json` and `--port`. Bumping the default is a minor release of the action. |
| `working-directory` | `.` | The project root (holds `demoflow.config.json`). |
| `scenarios` | `demoflow/**/*.demo.json` | Glob, relative to `working-directory`, matched against `check`'s scenario list. Supports `*`, `**`, `?`; several globs separated by newlines. |
| `formats` | `gif,mp4` | Comma-separated, passed as repeated `--format`. Empty string: no `--format`, the project's `render.formats` apply. |
| `port` | `` | Passed as `--port <n>` to every run (spec 337). |
| `comment` | `true` | Post or update the sticky PR comment (pull request events only). |
| `previews` | `true` | Publish GIFs to the previews branch for inline display (Decision 4). |
| `previews-branch` | `demoflow-previews` | The orphan branch for GIFs. |
| `max-gif-size-mb` | `10` | Larger GIFs are not embedded; the row links the artifact. |
| `previews-retention-days` | `30` | Preview directories older than this are pruned. |
| `artifact-name` | `demoflow-videos` | Must be unique per workflow run (set it per matrix leg). Also the sticky comment's key. |
| `retention-days` | `14` | Artifact retention (DemoFlow's own CI uses 14). |
| `fail-on-error` | `true` | Fail the step when any scenario exited non-zero. |
| `github-token` | `${{ github.token }}` | Comment and previews-branch push. |
| `node-version` | `` | Empty: use `node` on `PATH` if >= 22, otherwise set up Node 22. Set: always run `actions/setup-node` with it. |
| `cache-browsers` | `true` | Cache Chromium with `actions/cache` (Decision 7). |
| `install-system-deps` | `true` | Linux only: `playwright install-deps chromium` (needs `sudo`; turn off on self-hosted runners that have the libraries). |

| Output | Meaning |
|---|---|
| `results` | Absolute path of `results.json` the action writes (Decision 3). |
| `total`, `passed`, `failed` | Scenario counts. `passed` counts exit `0`. |
| `artifact-url` | URL of the uploaded artifact (empty when nothing was uploaded). |
| `comment-url` | URL of the sticky comment (empty when none was posted). |

### 3. Execution

Steps of `action.yml`, in order:

1. **Node**: `scripts/node-check.mjs` style one-liner decides whether
   `actions/setup-node` runs (input `node-version` or `node` < 22 / absent).
2. **Validate inputs** (`version`, `formats` syntax, numbers). Fail fast.
3. **Install the CLI**: `npm install --prefix "$RUNNER_TEMP/demoflow-cli"
   --no-audit --no-fund demoflow@<version>` (install scripts enabled:
   `ffmpeg-static` downloads its binary there). The CLI is invoked as
   `node <resolved demoflow bin>` (resolved from that prefix with
   `createRequire`). *Why not `npx demoflow@x` per call:* one install, no
   registry round-trip per scenario, no `.cmd` shims on Windows; it is the
   same npm package `npx demoflow` runs, with no clone or build.
4. **Chromium cache restore** (Decision 7), `PLAYWRIGHT_BROWSERS_PATH` =
   `$RUNNER_TEMP/demoflow-browsers` for all action steps.
5. **System libraries** (Linux, `install-system-deps`): `node
   <demoflow's playwright>/cli.js install-deps chromium`, the Playwright
   version `demoflow` pins.
6. **Chromium**: `demoflow setup`.
7. **Check**: `demoflow check --json` in `working-directory`. Exit 2 (no
   config) or 1 (FFmpeg/browser missing) fails the action with the CLI's
   message. The scenario list is filtered by `scenarios`. Zero matches: a
   `::notice::`, outputs `total=0`, success; an existing sticky comment is
   updated to "No scenarios matched".
8. **Run** (`scripts/run.mjs`): each scenario **sequentially**, sorted, never
   stopping at a failure: `demoflow run <file> --json --out
   "$RUNNER_TEMP/demoflow-home" [--format f]... [--port n]`, cwd
   `working-directory`, inheriting the step's environment (secrets a scenario
   needs are passed by the user as `env:` on the action step). stderr streams
   into a `::group::<scenarioId>` block. *Why sequential:* each run starts and
   stops the app on the same port; parallel runs would need distinct ports and
   double the runner's load.
   - stdout parsed as JSON → the `RunResult`; non-JSON stdout (exit 2 input
     errors such as an invalid scenario) → a synthetic failed entry whose
     message is the last 20 lines of stderr.
   - Each rendered file is copied to the artifact staging directory
     `$RUNNER_TEMP/demoflow-artifact/<slug>/` as `demo.<ext>` (from
     `renders[].file`, never a hard-coded path) together with `result.json`.
     `<slug>` = `scenarioId` without the leading `demoflow/` and the
     `.demo.json` suffix, `/` replaced by `__`.
   - `results.json` (`$RUNNER_TEMP/demoflow-results.json`):
     `{ schemaVersion: 1, demoflowVersion, scenarios: [{ scenarioId, slug,
     exitCode, result | null, message | null, files: { mp4?, gif?, ... } }] }`
     with `files` relative to the staging directory.
   - The run step itself always exits 0; the verdict is applied in step 12.
9. **Upload artifact** (`if: always()` and staging non-empty):
   `actions/upload-artifact` with `name: <artifact-name>`, `path:` staging,
   `retention-days`, `if-no-files-found: warn`, `overwrite: true` (*Why:* a
   re-run of the job uploads the same name again). Its `artifact-url` becomes
   the output and the link in the comment.
10. **Job summary** (`if: always()`): the same table as the comment
    (Decision 5) written to `$GITHUB_STEP_SUMMARY`, without GIFs.
11. **Previews and comment** (`if: always()`, pull request events only;
    Decisions 4 and 5).
12. **Verdict**: if `failed > 0` and `fail-on-error`, exit 1 with
    `::error::` per failed scenario (`<scenarioId>: <first failed stage>:
    <message>`). Any non-zero exit (1, 2, 3) counts as failed. *Why:* a
    readiness or render failure is as much a broken demo as a failed
    assertion.

Problems in steps 9–11 (artifact quota, comment API errors, push rejected)
produce `::warning::` and never change the verdict. *Why (fail-safe):* the
check must mean "the demos verified", not "the GitHub API was healthy"; and
it must never turn green because reporting broke, which it cannot, because
only step 12 decides.

Runner support: `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`,
`windows-latest` (the platforms of `demoflow` and `ffmpeg-static`). The
self-test covers the three `-latest` images.

### 4. GIF previews: an orphan branch in the same repository

GitHub cannot embed an artifact in a comment, and ADR-0008 rules out any
DemoFlow or third-party host. Options considered:

| Option | Verdict |
|---|---|
| Link to the artifact only | Always works, but no preview: misses the roadmap's "GIF previews in a PR comment". Kept as the fallback. |
| Draft-release assets | Draft assets are not readable by other viewers; a published release per PR pollutes Releases and notifies watchers. Same token needs as a branch. Rejected. |
| Commit GIFs to an orphan branch, embed by URL | **Chosen.** GitHub's own storage, no extra service, works in public repositories. |

Behaviour:
- Branch `previews-branch` (default `demoflow-previews`), created as an
  orphan on first use. Layout
  `pr-<number>/<artifact-name>/<run_id>-<run_attempt>/<slug>.gif`.
  A `README.md` at its root says what the branch is and that it is
  rewritten by the action.
  *Why `<artifact-name>`:* the legs of a matrix (the way to split scenarios,
  with a distinct `artifact-name` each) share `run_id-run_attempt`; without
  it they would overwrite each other's GIFs of the same slug and prune each
  other's directories. It is also the sticky comment's key, so one comment
  and one preview directory belong together. "This PR's older directories"
  below means those of the same `artifact-name`.
- The action refuses to rewrite (warns, links instead) a branch that is the
  repository's default branch or the PR's base or head branch, or an
  existing branch whose tip has a parent or lacks the action's `README.md`:
  a mistyped `previews-branch` must never force-push over real history.
- Embedded as `https://github.com/<owner>/<repo>/raw/<branch>/<path>` (a
  branch URL, not a commit URL, because the branch is rewritten; see
  pruning).
- Each publish **rewrites the branch as a single commit** whose tree is: the
  previous tree, minus this PR's older `pr-<number>/<artifact-name>/*`
  directories, minus
  directories older than `previews-retention-days` (age taken from the
  `run_id` directory's timestamp stored in a `meta.json` inside it; a
  directory without a readable one is pruned), plus the new GIFs. Pushed with `--force-with-lease` against the fetched SHA; on a
  lease failure (another PR pushed in between) re-fetch and retry up to 3
  times, then warn and fall back to links. *Why one commit:* history would
  otherwise keep every GIF forever and grow the repository's clone size; an
  unreachable blob is garbage-collected by GitHub.
- Implementation uses `git` with the token in an `http.extraheader` scoped to
  a temporary clone directory in `$RUNNER_TEMP` (never the user's checkout,
  never persisted credentials). Pushes made with `GITHUB_TOKEN` do not
  trigger other workflows, so the branch cannot start the user's `on: push`
  pipelines.
- GIF larger than `max-gif-size-mb`: not pushed; the row says
  `GIF too large (12.4 MB): see the artifact`.
- Needs `contents: write`. When the push is refused (fork PR, Dependabot PR,
  missing permission, a ruleset protecting the branch name), the action
  warns once and posts the comment with artifact links instead of images.

Fork pull requests: GitHub gives `pull_request` workflows from forks a
read-only token, so **neither the previews branch nor the comment can be
written**. The action detects a fork
(`pull_request.head.repo.full_name != github.repository`) and skips both
without trying, with one `::notice::` that the results are in the job
summary and the artifact. Runs, artifact upload, summary and verdict work
unchanged. The README explicitly warns **against** `pull_request_target` to
work around this: it would run the fork's scenarios and `devCommand` with a
write token (the hole ADR-0011 closes in DemoFlow's own CI).

Private repositories: whether `github.com/.../raw/...` images render in a
private repository's comment for signed-in viewers is verified in slice B's
manual check; if they do not, previews are disabled automatically for private
repositories (`repository.private`) and the comment links the artifact.

Exposure: in a public repository the previews branch is public. The README
says so: a GIF shows whatever the scenario typed and displayed (mask
sensitive elements in the scenario).

### 5. The sticky comment

- One comment per PR and `artifact-name`, found by the marker
  `<!-- demoflow-action:<artifact-name> -->` on its first line, among the PR's
  comments authored by the token's identity; updated in place (PATCH), or
  created (POST) when absent. Never a new comment per push.
- Content:

  ```
  <!-- demoflow-action:demoflow-videos -->
  ### DemoFlow: 2 of 3 scenarios passed
  | Scenario | Status | Took | Preview | Video |
  |---|---|---|---|---|
  | Customers (`demoflow/customers.demo.json`) | passed | 14.2 s | <img src="..." width="400"> | [MP4, 1.8 MB](artifact-url) |
  | Failing assertion (`demoflow/failing.demo.json`) | failed: verification | 6.1 s | <img ...> | [MP4, 0.9 MB](artifact-url) |
  | Login (`demoflow/login.demo.json`) | failed: readiness | 0.4 s | - | - |

  <details><summary>Failures</summary> ... per failed scenario: stage, step N, message in a fenced block ... </details>

  demoflow 0.6.0 · run <run link> · updated <ISO time> for <short head SHA>
  ```
- Status: `passed`, `passed with warnings`, `failed: <first failed stage>`
  (pipeline order), or `failed: input error` for a run without a result.
  "Took" = `finishedAt - startedAt`.
- Failure messages are redacted like DemoFlow's `runs-report/redact.ts`
  (spec 264): query strings and fragments of URLs removed, the workspace path
  replaced by `<project>`, the home directory by `~`, cut to 1000 characters,
  backticks neutralised so the fence cannot be closed. *Why:* the comment is
  public in a public repository and GitHub masks secrets only in logs.
- Body capped at 60 000 characters (GitHub's limit is 65 536): rows beyond
  the cap are replaced by `... and N more: see the job summary`.
- Push events and other non-PR events: no comment, summary only.

### 6. App startup

Nothing action-specific: `demoflow run` starts `devCommand` from the
project's `demoflow.config.json` and waits for `readyUrl` (ADR-0008 §4: the
command comes only from the config on disk). The user's workflow installs the
app's dependencies before the action. The README documents:
- `devCommand` runs without a shell; on Windows runners use `node` (or the
  real executable) rather than `npm` (`npm.cmd` is not started without a
  shell).
- `${PORT}` in `baseUrl` / `devCommand` with the `port` input when the default
  port is taken on the runner (spec 337).
- A project without `devCommand` must start its app in an earlier step.
- Scenario secrets come from the action step's `env:`.

### 7. Chromium and FFmpeg

- Chromium via `demoflow setup` into `PLAYWRIGHT_BROWSERS_PATH`, cached with
  `actions/cache`, key `demoflow-chromium-${runner.os}-${runner.arch}-<version>`
  (the `demoflow` version pins Playwright, hence the Chromium build). *Why
  this is compatible with ADR-0011:* GitHub isolates caches per ref; a cache
  written by a pull request is visible only to that pull request, never to
  the base branch or other PRs, so a PR cannot poison what pushes use. A PR
  can read a cache the base branch wrote, which is trusted.
- Linux system libraries: `playwright install-deps chromium` every run (apt;
  not cacheable), as DemoFlow's CI does.
- FFmpeg: nothing to install. The bundled `ffmpeg-static` binary is used
  unless the image's system `ffmpeg` has libx264. `demoflow check` fails the
  action early if neither works.

### 8. Repository layout

```
action.yml                 composite action; branding icon `film`, color `purple`
scripts/
  inputs.mjs               validate inputs, decide setup-node
  cli.mjs                  resolve the installed demoflow and playwright entry points
  run.mjs                  enumerate, filter, run, stage files, write results.json, outputs
  glob.mjs                 `*`, `**`, `?` matcher (no dependency)
  report.mjs               markdown table + failures (summary and comment), redaction
  previews.mjs             orphan-branch publish and prune
  comment.mjs              sticky comment via REST (fetch)
  verdict.mjs              final exit code and ::error:: annotations
test/
  *.test.mjs               `node --test` unit tests
  fixture/                 tiny app for the self-test (below)
.github/workflows/
  test.yml                 unit tests + self-test of the action (`uses: ./`)
  release.yml              moves the major tag on a published release
examples/demoflow.yml      the workflow users copy
docs/spec.md               this file
README.md  CHANGELOG.md  LICENSE (existing, MIT)  package.json (no runtime deps; `test` script)
```

Fixture: written in this repository, not copied from DemoFlow (whose fixture
is a Vite app needing a build and `bun`). `test/fixture/` holds
`server.mjs` (a zero-dependency `node:http` server serving two static pages on
`PORT`), `demoflow.config.json` with `baseUrl: "http://localhost:${PORT}"`
and `devCommand: { command: "node", args: ["server.mjs"], readyUrl:
"http://localhost:${PORT}/" }`, and scenarios `demoflow/passing.demo.json`
and `demoflow/failing.demo.json` (the latter asserts text that is absent,
like DemoFlow's `failing.demo.json`). Both validated with `demoflow validate`.

### 9. Releases

- Semver tags `vX.Y.Z` and a moving major tag `v1`. Users reference `@v1`
  (or a SHA).
- `release.yml`: on `release: published` with a `vX.Y.Z` tag, force-moves
  `vX` to that commit (`contents: write`, push/release event only, never on
  a pull request).
- `CHANGELOG.md` (Keep a Changelog) updated in the release PR.
- **Manual, by the owner:** publishing the first release to the GitHub
  Marketplace (the "Publish this Action to the GitHub Marketplace" checkbox,
  accepting the agreement, choosing categories). The action's `name` must be
  unique on the Marketplace: `DemoFlow Demo Videos` (fallback chosen by the
  owner if taken).
- Branches: `main` only; every pull request targets `main`.

## Slices

| Slice | Title | Depends on |
|---|---|---|
| A | Run every scenario, upload the videos, fail on a failed demo | nothing |
| B | Sticky PR comment with GIF previews | A |
| C | Marketplace README, CHANGELOG and the v1 release | A, B |

## Out of scope

- Uploading anything to the DemoFlow website or any host other than GitHub
  (ADR-0008).
- Running scenarios in parallel or sharding them across jobs (users can
  split with `scenarios` + matrix + distinct `artifact-name`).
- Running only scenarios affected by the PR's diff.
- `pull_request_target` support.
- Comparing videos with a baseline.
