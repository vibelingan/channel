# Intermittent CI test failures (agent reference)

Read this before investigating a test that fails on CI and passes on rerun.
Section 1 routes you from what the failed log shows to the likely cause.
Sections 2 and 3 describe the causes already found and the signals that sent
earlier investigations the wrong way. Section 4 is the procedure for a failure
that matches nothing here; it finds a cause in about an hour instead of a day.

## 1. Start here: match what you see

Get the log of the attempt that failed first (section 4, step 1). Then find the
first failure in it; ignore everything after it until you have read this table.

| What the failed log shows | Most likely | Confirm with | Then |
| --- | --- | --- | --- |
| `expect(...) … Timeout: 5000ms … element(s) not found` on the first check after a click that saves; that subtest took about 5.6 s, its siblings about 1 s; passes on rerun | The test's Node process was blocked on disk (cause A) | The failed job's step "Report crashes and disk pressure…": a core dump listed, or `io` pressure high | Section 2 A, "If it comes back" |
| Many later subtests fail on `assert.deepEqual(errors, [])` with the same one message | Followers of the first failure; the `errors` array never empties | The first `not ok` in the test is a different assertion | Diagnose only the first failure |
| WebKit error `… due to access control checks.` | A fetch that was still pending got cancelled by a navigation. Not CORS | The request URL is the test's own origin (`127.0.0.1:517x`) | Ask what kept the request pending: usually cause A |
| Playwright call log inside a failed `expect` says `waiting for "…" navigation to finish...` / `navigated to …` and the test did not navigate | The dev server reloaded the page (cause B) | Was any file under `apps/site` created or changed during the run? | Section 2 B |
| `page.goto: Timeout 8000ms exceeded` in the first subtest; several test files slow or failing at once; only on a laptop or container | The machine is overloaded (cause C) | More than two browser test processes were running, or the container has under 8 GB | Run fewer at once; not a product problem |
| Fails only when two test files run together, never alone | The cause is outside the failing process: another test file or a system service | `# Port 5173 is in use` in the log means a second dev server was alive | Section 4, step 3, with the real shard command |
| An API call in the trace is `routed` and only `handled` seconds later | The handler's process is computing, waiting for a CPU, or blocked on I/O | The once-a-second `SCHED` line (section 4, step 4) | The table in section 4, step 4 |
| Fails on every CI run, passes locally | Not intermittent: an environment difference | Node 22.13.0, Linux, a fresh checkout | Reproduce in the Linux container (section 4, step 2) |
| The job is red in "Install Playwright", or a deploy step, not in a test | Not a test failure | Step names and timings | `docs/agents/cloudbase.md`, "Deploy timing and failure modes" |
| None of the above | A new cause | | Section 4, all steps in order |

## 2. Known causes

### A. A crashed browser helper stalls the runner's disk (fixed 2026-11-11)

**What the failed log shows**

- Job `Unit tests (site rest)` or `Unit tests (site heavy)`, a `*-browser.test.ts`
  file, usually the WebKit half.
- `expect(locator).toBeVisible() failed … Timeout: 5000ms … element(s) not found`
  on the first check after a click that makes the admin API write (for example
  Save). The failing subtest took about 5.6 s; its siblings took about 1 s.
- In WebKit, every later subtest then fails on `assert.deepEqual(errors, [])`
  with `'/127.0.0.1:5173/api/admin due to access control checks.'`. That text is
  WebKit's console message for a fetch that the next `page.goto` cancelled. It
  is not a CORS problem: the request is same-origin and answered by
  `page.route`.
- The same test passes on rerun, on macOS, and in a Linux container.

**Cause, in order**

1. Playwright's WebKit helper `WPEWebProcess` (WebKit build 2311, Playwright
   1.61.1) sometimes segfaults when a page navigates. The kernel log names the
   thread: `SkiaGPUWorker` or `ThreadedCompositor`. The page keeps working, so
   no test notices.
2. The runner pipes every crash to `systemd-coredump`, which writes the dump
   uncompressed, then compresses it: 250 to 590 MB per second for 18 to 26
   seconds, with I/O wait at 35 to 56 %.
3. In these tests the admin API runs inside the test's own Node process and
   stores its data with synchronous file writes
   (`apps/local-server/src/json-adapter.ts`). While the disk is saturated each
   write blocks. The handler for `product-operation-continue` took 5.4 to 8.7 s
   in failing runs and under 0.5 s otherwise, on 20 to 60 ms of CPU per second.
   With the fix its slowest run in 45 was 0.85 s.
4. The page is still showing "Saving…" when the 5 s `expect` gives up.

It hits whichever test is doing file writes during those 20 seconds, in either
engine, and the crash can come from another test file's WebKit. The
product-create test was hit most because its WebKit half starts its first full
publication a few seconds after such a crash.

**Measured on GitHub runners (ubuntu-24.04, 4 CPUs, 16 GB)**

| Condition | Shard runs | Failed | Core dumps |
| --- | --- | --- | --- |
| Before the fix, two test files at once | 99 | 17 | 1 to 7 per three runs |
| Before the fix, the file alone | 20 | 0 | not measured |
| With the fix, two test files at once | 75 | 0 | 0 |

**Fix**

A step named "Keep crashed browser helpers from writing core dumps", placed
right after the Playwright install step: `sudo sysctl -w
kernel.core_pattern=core`. The runner's core limit is already 0, but its
default pattern (`|/usr/lib/systemd/systemd-coredump … 9223372036854775808 …`)
passes a fixed unlimited size, so `ulimit -c 0` changes nothing (tested: three
dumps were still written). With a plain file pattern the kernel honours the
limit and writes nothing.

The step is in every workflow that installs Playwright WebKit: `ci.yml`,
`assistant-ui.yml`, `browser-regression.yml`, `deploy-ai-cloudrun.yml` (which
runs the same browser unit tests through `pnpm test`) and `deploy-test.yml`.
`scripts/deploy-ci-gate.test.mjs` fails if any workflow installs WebKit without
it. A new workflow that uses WebKit needs the same step.

**What is not fixed**

WebKit still crashes, 1 to 5 times per three shard runs (13 in 15 runs);
without a dump the crash costs nothing. Forcing CPU rendering
(`WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`) was tested and does not stop it: the
`SkiaGPUWorker` crashes disappear and `ThreadedCompositor` crashes remain
(5 in 15 runs). It is a defect in that WebKit build. Count
`segfault` lines in `sudo dmesg` again after a Playwright upgrade.

**If it comes back**

A failed unit job prints, in the step "Report crashes and disk pressure after
a failed unit group", the crashed processes, any core dump that was written,
and the pressure figures. Read those three blocks first:

- a core dump is listed: the pattern was reset or the core limit is no longer
  0; print both and fix that;
- no dump, but `io` pressure is high: something else is writing; rerun the loop
  in section 4, step 3 with `fatrace` to name it;
- neither: it is a different cause; go to section 4.

**Earlier sighting**

On 2026-11-05 the Chromium half of the same test failed in four consecutive
subtests over about 23 seconds, and the WebKit half that started two seconds
later passed. That length matches one core dump, and another browser test was
running beside it. The run kept no kernel log, so this is consistent with
cause A but not proven.

### B. The page reloads because a file under `apps/site` changed (fixed 2026-11-12)

**What the log shows**

- Playwright's call log for a failed `expect` contains
  `waiting for "http://127.0.0.1:517x/…" navigation to finish...` and
  `navigated to …` although the test did not navigate. Several subtests fail
  in one run, in different places each time.

**Cause**

Every `*-browser.test.ts` serves its page from a Vite dev server, most with
the Tailwind plugin. The plugin registers about 500 files under
`apps/site/{src,scripts,public}` as sources. When one of them is created,
changed or deleted, it sends the browser `{"type":"full-reload"}` and logs
nothing. The page reloads, in-memory form state is lost, and the next check
times out. It happens when a person or an agent saves a file while tests run.

**Fix**

The ten tests that start a dev server set `server: { host: '127.0.0.1',
port: 0, hmr: false, watch: null }`. `scripts/site-test-shard.test.mjs` fails
if a test starts a dev server without both settings. Measured in a Linux
container while a source file was rewritten every 0.7 s: 5 of 5 runs passed
with the settings, 0 of 2 without.

Still keep scratch files out of `apps/site` while tests run: the type check and
the test runner read that tree too.

CI never had this cause: the watcher saw no events and no reload was sent in
18 monitored shard runs.

### C. Too many browser tests at once on a small machine (local only)

**What the log shows**

- `page.goto: Timeout 8000ms exceeded` in the first subtest of a file, then
  count assertions such as `2 !== 3` in later ones; several files fail in the
  same minute.

**Cause and fix**

Each browser test file starts a dev server, bundles dependencies and launches
a browser. Four of them in a 4 GB container, or three loops beside other work
on a laptop, exhaust memory and the first page load misses its 8 s limit. Run
at most two at a time, as CI does. This was seen only locally, while looping
tests during the 2026-11-11 investigation.

## 3. Signals that mislead

Each of these cost time on 2026-11-11. Check a claim against the log before
building on it.

- **"Access control checks" suggests CORS.** It is WebKit's message for any
  cancelled fetch. The request was same-origin.
- **"Only WebKit fails" suggests WebKit-specific logic.** The WebKit half runs
  second and was simply in the way when the stall came. The same failure
  reached the Chromium half once.
- **"Siblings took 1 s, so the runner was fine."** A disk stall slows only the
  process that writes at that moment.
- **A local reproduction with the same error text.** The container produced
  the identical timeout through cause B, which CI does not have. The
  investigation's own scratch test files, saved under `apps/site`, were
  triggering it. Confirm on CI that the local mechanism is the CI mechanism.
- **A CPU profile of the slow window.** A blocked thread is sampled wherever
  it stopped, so the profile looks like ordinary code and points nowhere.
  Measure time on CPU, time waiting for a CPU and pressure instead.
- **A fix that must work.** `ulimit -c 0` is the textbook way to stop core
  dumps and changed nothing here. Only a side-by-side run showed it.
- **A new step that passed review.** Until a workflow step has run in its real
  job, say so; then read its log line once it has.

## 4. A new intermittent failure: what to do, in this order

### Step 1. Read the failed attempt, not the rerun

`gh run view --job <id> --log` returns the latest attempt, which passed. Ask
for the attempt that failed:

```bash
gh api repos/vibelingan/channel/actions/runs/<run-id>/attempts/<n>/jobs --jq '.jobs[] | select(.conclusion=="failure") | "\(.id) \(.name)"'
```

```bash
gh api --allow-escape-sequences repos/vibelingan/channel/actions/jobs/<job-id>/logs | cut -c30- > failed.txt
```

From the log alone you can already tell:

- which engine and which subtest failed first; later failures in the same test
  are usually followers (the `errors` array stays non-empty);
- whether the runner was slow in general (compare sibling `duration_ms`);
- whether a neighbour was running (`# Port 5173 is in use` means another dev
  server was alive when this file started).

Then go back to the table in section 1. Stop here if a row matches.

### Step 2. Do not expect a local reproduction of a runner problem

A Linux container (`mcr.microsoft.com/playwright:v1.61.1-noble`, Node 22.13.0,
pnpm 11.5.0, repository copied in with `git archive`) reproduces logic errors. It did not reproduce cause A in about 60 runs, because the laptop's
disk and crash handling differ from the runner's. If two or three local loops
pass, go to CI; do not keep looping locally.

Run the whole file, not one engine. The second engine starts right after the
first one's browser closes, and that ordering matters.

### Step 3. Loop it on CI with monitors

Push a temporary branch that contains one extra workflow triggered only by
pushes to that branch. A branch without a pull request starts no other
workflow and deploys nothing. Delete the branch when done.

```yaml
name: Diag flake loop
on:
  push:
    branches: [diag/<short-name>]
permissions:
  contents: read
jobs:
  loop:
    name: Loop ${{ matrix.mode }} (${{ matrix.slot }})
    runs-on: ubuntu-latest
    timeout-minutes: 40
    strategy:
      fail-fast: false
      matrix:
        slot: [1, 2, 3, 4]
        mode: [baseline, candidate] # candidate = the fix you want to prove
    env:
      CI: 'true'
      PUBLIC_CB_PROXY: '0'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.5.0, run_install: false }
      - uses: actions/setup-node@v4
        with: { node-version: 22.13.0, cache: pnpm, cache-dependency-path: pnpm-lock.yaml }
      - run: pnpm install --frozen-lockfile
      - uses: actions/cache/restore@v4
        with:
          path: ~/.cache/ms-playwright
          key: playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}
      - run: pnpm exec playwright install --with-deps chromium webkit
      - run: sudo apt-get install -y -qq inotify-tools fatrace >/dev/null
      - name: Loop
        run: |
          d="$RUNNER_TEMP/diag"; mkdir -p "$d"
          echo "core limit $(ulimit -c), pattern $(cat /proc/sys/kernel/core_pattern)"
          # if [ "${{ matrix.mode }}" = candidate ]; then <apply the candidate fix>; fi
          (sudo fatrace -c -t -f W > "$d/fatrace.log" 2>&1 &)
          (vmstat -t 1 > "$d/vmstat.log" 2>&1 &)
          (top -b -d 1 -w 200 -c -o %CPU | awk '/^top - /{n=0} {n++; if (n<=22) print}' > "$d/top.log" 2>&1 &)
          for i in 1 2 3; do
            DIAG_TRACE_DIR="$d/traces-$i" \
              pnpm --filter @vibelingan-channel/site exec node scripts/test-shard.mjs rest \
              > "$d/shard-$i.log" 2>&1 && echo "iteration $i PASSED" || echo "iteration $i FAILED"
            grep -E '^not ok|^# (pass|fail) ' "$d/shard-$i.log" || true
          done
          coredumpctl list --no-pager 2>&1 | tail -20 || true
          sudo dmesg | grep -iE 'segfault|traps:' | tail -20 || true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: diag-${{ matrix.mode }}-${{ matrix.slot }}
          path: ${{ runner.temp }}/diag
          retention-days: 3
```

Notes:

- Use the real shard command. This failure needs the second test file that CI
  runs alongside: 0 of 20 runs failed with the file alone.
- Eight jobs of three loops take about 15 minutes. At the 17 % failure rate
  seen here a round gave 1 to 6 failures. Fewer runs prove nothing.
- Give every artifact a unique name, or the upload step fails.
- Read job logs with the `gh api … /jobs/<id>/logs` command from step 1; get
  the files with `gh run download <run-id> -n <artifact> -D <dir>`.

### Step 4. Put probes in the test and let them choose the cause

Add these to the failing test on the temporary branch only. They write one
trace file per engine into `DIAG_TRACE_DIR`.

```ts
const t0 = Date.now();
const trace: string[] = [];
const note = (line: string) => trace.push(`+${Date.now() - t0}ms ${line}`);

// 1. The page: errors, console, navigations, failed requests.
page.on('pageerror', (e) => note(`pageerror ${e.message}`));
page.on('console', (m) => note(`console.${m.type()} ${m.text()}`));
page.on('framenavigated', (f) => note(`navigated ${f.url()}`));
page.on('requestfailed', (r) => note(`requestfailed ${r.url()} ${r.failure()?.errorText}`));

// 2. Each routed API call: when it arrived, when the handler returned.
//    Inside page.route: note(`${label} routed`) … note(`${label} handled after ${ms}ms`)

// 3. The dev server: file events and reload messages.
server.watcher.on('all', (event, file) => note(`WATCHER ${event} ${file}`));
for (const env of Object.values(server.environments)) {
  const send = env.hot.send.bind(env.hot);
  env.hot.send = (...a: unknown[]) => (note(`HMR-SEND ${JSON.stringify(a)}`), Reflect.apply(send, env.hot, a));
}

// 4. The Node process, once a second: is it running, waiting for a CPU, or blocked?
const sched = () => readFileSync('/proc/self/schedstat', 'utf8').split(' ').map(Number);
const psi = (k: string) => /some avg10=([0-9.]+)/.exec(readFileSync(`/proc/pressure/${k}`, 'utf8'))?.[1];
let last = sched();
setInterval(() => {
  const now = sched();
  note(`SCHED onCpu=${((now[0] - last[0]) / 1e6).toFixed(0)}ms waitingForCpu=${((now[1] - last[1]) / 1e6).toFixed(0)}ms psi cpu=${psi('cpu')} io=${psi('io')} mem=${psi('memory')}`);
  last = now;
}, 1000);

// 5. When the failing expect throws: print the trace tail, page.url() and
//    page.locator('body').innerText() to stderr, then rethrow.
// 6. In the test's finally: write trace.join('\n') to DIAG_TRACE_DIR.
```

Read the result with this table:

| What the trace shows during the slow window | Cause | Next |
| --- | --- | --- |
| `navigated` that the test did not ask for, with `HMR-SEND … full-reload` | dev server reload (cause B) | find the `WATCHER` file |
| `navigated` with console `[vite] server connection lost` | dev server socket dropped | look at the server process |
| API call `routed` but `handled` seconds later; `onCpu` near 1000 ms | the handler is computing | CPU profile (`node:inspector` `Profiler`) |
| same, `waitingForCpu` high, `psi cpu` high | CPU contention | `top.log` names the process |
| same, `onCpu` and `waitingForCpu` both low, `psi io` rising | blocked on disk (cause A) | `vmstat.log` column `bo`, then `fatrace.log` names the writer |
| API calls fast, element still missing | product or test logic | the DOM dump shows the page state |

### Step 5. Prove the fix on CI before writing it up

Run the candidate fix as one arm of the same loop, next to an unchanged arm.
The first fix tried for cause A (`ulimit -c 0`) was plausible and did nothing;
only the side-by-side run showed that. Do not raise a timeout or add a retry
unless the trace shows the product finished correctly and only time was short,
and say so in the pull request.

## 5. Facts about the runners that cost time to learn

- ubuntu-24.04, 4 CPUs, 16 GB, kernel 7.0 (Azure), 3 GB swap.
- Core limit 0; `core_pattern` pipes to `systemd-coredump` with a fixed
  unlimited size, so the limit is ignored.
- `/proc/pressure/*` and `/proc/self/schedstat` are readable; `fatrace`,
  `inotify-tools` and `vmstat` install or exist; `sudo` works without a
  password.
- A branch push without a pull request runs only workflows whose `on.push`
  names that branch. `ci.yml` runs on pull requests and on `main`.
- The site unit tests run two files at a time (`--test-concurrency=2`), each in
  its own process; a process outside the failing test can be the cause.
