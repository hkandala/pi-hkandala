# bench

Measures what pi agents cost in CPU, memory, wakeups and git spawns. It compares pi with no extensions of ours (`ne`) against this checkout's extensions as they are now (`ext`). macOS only. Needs python3, herdr and the `pi` command.

## Run

```bash
python3 bench/bench.py all ne,ext 3          # every scenario, both configs, 3 reps, interleaved
python3 bench/bench.py idle,working ext 1    # a subset, one config
python3 bench/summarize.py run               # tables: /tmp/pi-bench/results/run.md
herdr session stop pi-bench                  # when done
```

- Arguments: `<scenario,...|all> <config,...> [reps]`.
- Options:
  - `--tag=NAME` (default `run`): each run appends one JSON line to `<out>/<NAME>.jsonl`. The line includes the 1-minute load average at its start.
  - `--out=DIR` (default `/tmp/pi-bench/results`): where results go.
  - `--session=FILE`: the session that `long` forks. The default is the largest session in `~/.pi/agent/sessions`.
- `PIBENCH_MODEL` and `PIBENCH_THINKING` pick the model. The defaults are `google/gemini-3.5-flash` and `off`. A `working` run makes one cheap prompt.
- Runs are interleaved: for each rep, for each scenario, for each config. This gives both configs the same load. Compare configs only within one run of the bench, and check `load1`.
- With two configs, `summarize.py` adds a column with the change from the first to the second. It also lists outliers. To redo one, delete its line from the `.jsonl` and run that scenario again with the same tag.

## Configs

| config | pi command (each also gets the model flags and `--session-dir /tmp/pi-bench/sessions`)                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ne`   | `pi -ne -e builtin:codemode`                                                                                                                               |
| `ext`  | the same, plus `-e` for each `extensions/<name>` of a frozen copy of this checkout, and herdr's `~/.pi/agent/extensions/herdr-agent-state.ts` if it exists |

- `-ne` also drops pi's built-in codemode. `working` needs it, so both configs add it back.
- `ext` copies the working tree to `/tmp/pi-bench/ext` at the start, without `.git`, `bench/` and the root `node_modules`. Uncommitted changes are included. Edits made during a run don't leak in.
- Everything pi reads and writes is under `/tmp/pi-bench`: the copy, a scratch clone of this repo (reset before each run, with one uncommitted change), sessions, profiles and per-run logs. Meta's sandbox can't read some folders (for example `~/Downloads`), and pi then skips extensions there without an error.

## Scenarios

| scenario  | what it does                                                                                                                                                                                                                                             | metrics                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `startup` | Starts a new session and waits until the footer shows and CPU has been flat for 1 s. A second start runs with `BUN_OPTIONS=--cpu-prof`.                                                                                                                  | CPU and children CPU at ready, `wall_s`, peak footprint, git spawns, `blocked_s` (busy main-thread JS samples)                     |
| `idle`    | Waits 5 s after ready, then measures 60 s with no input.                                                                                                                                                                                                 | per minute: CPU, children CPU, git spawns and their CPU; wakeups/s, footprint                                                      |
| `working` | Sends one fixed prompt with 5 tool calls: `read`, `bash`, `edit`, `codemode` with 3 nested `bash` calls, and `write`. A run where the model skips or adds calls is marked failed.                                                                        | per tool call: ms of CPU (pi, children, total) and git spawns; footprint, RSS, peak, JS heap                                       |
| `long`    | `--fork`s the session, idles 30 s, then sends 160 wheel events and 300 mouse moves at 30/s through herdr.                                                                                                                                                | startup CPU and wall, idle CPU/min, wakeups/s, ms of CPU per wheel event and per move (idle rate subtracted), footprint, RSS, heap |
| `herd`    | Starts 10 idle agents in one herdr workspace. It measures 60 s quiet, then 60 s while a writer rewrites their pi-herd records at 3/s with a temp file and a rename, the way pi-herd does. `ne` has no records, so it rewrites 10 dummy `pibench-*` ones. | CPU, children CPU and git spawns per minute summed over the 10 agents, in both windows                                             |

## How it measures

- **CPU, children, wakeups, memory:** CPU, CPU of reaped children (git, bash, tools), wakeups and memory come from `proc_pid_rusage` on `pi.real`. This matches `ps`.
- **Heap:** a `--heap-prof` snapshot written at exit.
- **Git spawns:** pi runs with `/tmp/pi-bench/shim` first on `PATH`. `git-shim` logs each call's time, parent pid, subcommand and CPU, then runs the real git.
- **Isolation:**
  - Every pi runs in its own herdr session, `pi-bench`, which starts with a minimal environment: no `PI_*`, `HERDR_*` or `BUN_*` variables.
  - `PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` are set.
  - After each run, the pi-herd records of bench agents and the dummy records are removed.
- **Side effect:** while `herd`'s writer runs (60 s per run), it also wakes every other pi-herd agent on the machine.
