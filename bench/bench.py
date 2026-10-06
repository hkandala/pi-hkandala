#!/usr/bin/env python3
"""pi agent benchmark runner (macOS).

usage: bench.py <scenario,...|all> <config,...> [reps] [--tag=NAME] [--out=DIR] [--session=FILE]
  scenarios: startup idle working long herd
  configs:   ne (pi -ne: no extensions of ours)   ext (this checkout's extensions, as they are now)
  Runs are interleaved: for each rep, for each scenario, for each config.
  Each run appends one JSON line to <out>/<tag>.jsonl (default out: /tmp/pi-bench/results, tag: run).
  --session: the session `long` forks (default: the largest one in ~/.pi/agent/sessions).
  PIBENCH_MODEL / PIBENCH_THINKING pick the model (default: google/gemini-3.5-flash, off).
"""
import ctypes, glob, json, os, random, shlex, shutil, statistics, subprocess, sys, threading, time

HOME = os.path.expanduser("~")
BENCH = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(BENCH)  # this checkout
RUN = "/tmp/pi-bench"  # everything pi reads and writes: a copy of the extensions, a scratch clone, sessions
REPO = f"{RUN}/repo"
GIT = shutil.which("git")
SOCK = f"{HOME}/.config/herdr/sessions/pi-bench/herdr.sock"
HERD = f"{HOME}/.pi/agent/pi-herd"
MODEL_ID = os.environ.get("PIBENCH_MODEL", "google/gemini-3.5-flash")
MODEL = ["--model", MODEL_ID, "--thinking", os.environ.get("PIBENCH_THINKING", "off")]
PROMPT = (
    "Benchmark task. Make exactly these 5 tool calls, in this order, one per step, nothing else, "
    "then reply only with the word done. "
    "1) read README.md with limit 5. "
    "2) bash: git status --short && ls extensions | head -5 "
    "3) edit README.md: replace its first line with the same line followed by ' (bench)'. "
    "4) codemode: a script that awaits tools.bash three times, for 'git log --oneline -3', "
    "'wc -l README.md' and 'ls extensions | wc -l', and returns the three outputs joined. "
    "5) write bench.txt with the content ok"
)

# --- per-process counters: proc_pid_rusage(RUSAGE_INFO_V4) ---------------------------------------
_F = ["user", "system", "idle_w", "intr_w", "pageins", "wired", "resident", "footprint", "start", "exit",
      "c_user", "c_system", "c_idle_w", "c_intr_w", "c_pageins", "c_elapsed", "dio_r", "dio_w",
      *[f"q{i}" for i in range(7)], "billed", "serviced", "lwrites", "max_footprint"]
class _RU(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f, ctypes.c_uint64) for f in _F] + [("rest", ctypes.c_uint64 * 8)]
class _TB(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]
_libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
_sys = ctypes.CDLL("/usr/lib/libSystem.dylib")
_sys.mach_absolute_time.restype = ctypes.c_uint64
_tb = _TB(); _sys.mach_timebase_info(ctypes.byref(_tb))
TICK = _tb.numer / _tb.denom / 1e9  # mach ticks -> s

def ru(pid):
    """CPU s (self, reaped children), wakeups, memory MB; None once the process is gone."""
    r = _RU()
    if _libproc.proc_pid_rusage(pid, 4, ctypes.byref(r)):
        return None
    return dict(cpu=(r.user + r.system) * TICK, child=(r.c_user + r.c_system) * TICK,
                wake=r.idle_w + r.intr_w, fp=r.footprint / 1e6, maxfp=r.max_footprint / 1e6,
                rss=r.resident / 1e6, start=r.start * TICK, now=_sys.mach_absolute_time() * TICK)

# --- herdr (own session, clean env) -----------------------------------------------------------------
HENV = {k: v for k, v in os.environ.items() if not k.startswith(("HERDR_", "PI_", "BUN_"))} | {"HERDR_SOCKET_PATH": SOCK}

def herdr(*a, check=True):
    p = subprocess.run(["herdr", *a], env=HENV, capture_output=True, text=True)
    if check and p.returncode:
        raise RuntimeError(f"herdr {' '.join(a[:3])}: {p.stdout}{p.stderr}")
    return json.loads(p.stdout) if p.stdout.startswith("{") else p.stdout

def ensure_server():
    if subprocess.run(["herdr", "workspace", "list"], env=HENV, capture_output=True).returncode == 0:
        return
    env = {k: os.environ[k] for k in ("HOME", "USER", "PATH", "SHELL", "LANG", "TMPDIR") if k in os.environ}
    subprocess.Popen(["herdr", "--session", "pi-bench", "server"], env=env | {"TERM": "xterm-256color"},
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    for _ in range(50):
        time.sleep(0.2)
        if subprocess.run(["herdr", "workspace", "list"], env=HENV, capture_output=True).returncode == 0:
            return
    raise RuntimeError("herdr session pi-bench didn't start")

def send(pane, text):
    herdr("pane", "send-text", pane, text)

# --- configs ------------------------------------------------------------------------------------------
HERDR_STATE = f"{HOME}/.pi/agent/extensions/herdr-agent-state.ts"  # herdr's pi integration, if installed

def ext_args(cfg):
    base = ["-ne", "-e", "builtin:codemode"]  # -ne also drops pi's built-in codemode, which `working` needs
    if cfg == "ne":
        return base
    ext = f"{RUN}/ext/extensions"
    extra = ["-e", f"{RUN}/ext/herdr-agent-state.ts"] if os.path.exists(f"{RUN}/ext/herdr-agent-state.ts") else []
    return base + [x for d in sorted(os.listdir(ext)) if os.path.isdir(f"{ext}/{d}") for x in ("-e", f"{ext}/{d}")] + extra

def setup(cfgs, session):
    ensure_server()
    for d in ("shim", "sessions", "runs", "prof"):
        os.makedirs(f"{RUN}/{d}", exist_ok=True)
    shutil.copy(f"{BENCH}/git-shim", f"{RUN}/shim/git")
    if session:
        shutil.copy(session, f"{RUN}/long-session.jsonl")
    if not os.path.isdir(REPO):
        subprocess.run([GIT, "clone", "-q", SRC, REPO], check=True)
    if "ext" in cfgs:  # a frozen copy: edits to the checkout during a run don't leak in
        subprocess.run(["rsync", "-a", "--delete", "--exclude=.git", "--exclude=/bench", "--exclude=/node_modules", f"{SRC}/", f"{RUN}/ext/"], check=True)
        if os.path.exists(HERDR_STATE):
            shutil.copy(HERDR_STATE, f"{RUN}/ext/herdr-agent-state.ts")

def reset_repo():
    g = [GIT, "-C", REPO]
    subprocess.run(g + ["reset", "-q", "--hard"], check=True)
    subprocess.run(g + ["clean", "-fdq"], check=True)
    with open(f"{REPO}/extensions/pi-footer/index.ts", "a") as f:
        f.write("// bench\n")  # one uncommitted change, so git status has something to say

# --- one pi in a herdr pane ---------------------------------------------------------------------------
class Pi:
    def __init__(self, cfg, rid, args=(), env=None, ws=None):
        self.rid, self.dir = rid, f"{RUN}/runs/{rid}"
        os.makedirs(self.dir, exist_ok=True)
        self.gitlog = f"{self.dir}/git.log"
        e = {"PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PIBENCH_GITLOG": self.gitlog, "PIBENCH_GIT": GIT, **(env or {})}
        cmd = (f'exec env PATH={RUN}/shim:"$PATH" ' + " ".join(f"{k}={shlex.quote(v)}" for k, v in e.items())
               + " pi " + " ".join(map(shlex.quote, ext_args(cfg) + MODEL + ["--session-dir", f"{RUN}/sessions", *args])))
        if ws:
            r = herdr("tab", "create", "--workspace", ws, "--cwd", REPO, "--label", rid, "--no-focus")["result"]
            self.ws, self.own_ws = ws, False
        else:
            r = herdr("workspace", "create", "--cwd", REPO, "--label", rid, "--no-focus")["result"]
            self.ws, self.own_ws = r["workspace"]["workspace_id"], True
        self.pane = r["root_pane"]["pane_id"]
        shell = herdr("pane", "process-info", "--pane", self.pane)["result"]["process_info"]["shell_pid"]
        open(f"{self.dir}/run.sh", "w").write(cmd + "\n")  # a long command typed into the pane gets cut
        herdr("pane", "run", self.pane, f"exec /bin/sh {self.dir}/run.sh")
        for _ in range(300):
            out = subprocess.run(["pgrep", "-P", str(shell), "-x", "pi.real"], capture_output=True, text=True).stdout.split()
            if out:
                self.pid = int(out[0]); return
            time.sleep(0.05)
        raise RuntimeError(f"{rid}: pi.real didn't start")

    def ready(self, timeout=180):
        """Waits until the footer shows and pi.real's CPU has been flat for 1 s; returns s from
        process start to the last CPU step (the end of startup work)."""
        hist, t0, shown, last_step = [], time.time(), False, None
        while time.time() - t0 < timeout:
            r = ru(self.pid)
            if r is None:
                raise RuntimeError(f"{self.rid}: pi exited during startup")
            if hist and r["cpu"] - hist[-1]["cpu"] > 0.002:
                last_step = r["now"]
            hist.append(r)
            if not shown and len(hist) % 5 == 0:
                shown = MODEL_ID.split("/")[-1][:12] in herdr("pane", "read", self.pane, "--lines", "60", check=False)
            if shown and len(hist) > 10 and r["cpu"] - hist[-11]["cpu"] < 0.01:
                return (last_step or r["now"]) - r["start"]
            time.sleep(0.1)
        raise RuntimeError(f"{self.rid}: not ready after {timeout}s")

    def git(self, t0=0, t1=1e12):
        """(spawns, CPU s) of git runs started in [t0, t1) (s since epoch, 1 s resolution)."""
        n = cpu = 0
        if os.path.exists(self.gitlog):
            for l in open(self.gitlog):
                f = l.split()
                if len(f) >= 5 and int(t0) <= int(f[0]) < t1:
                    n += 1; cpu += float(f[-2]) + float(f[-1])
        return n, cpu

    def quit(self, timeout=180):
        if ru(self.pid):
            try:
                send(self.pane, "/quit\r")
            except RuntimeError:
                pass
        for _ in range(timeout * 10):
            if ru(self.pid) is None:
                break
            time.sleep(0.1)
        else:
            os.kill(self.pid, 15)
        if self.own_ws:
            herdr("workspace", "close", self.ws, check=False)

def cleanup_records():
    """Removes the pi-herd records (and their messages/stopped entries) of agents in the bench session."""
    for f in glob.glob(f"{HERD}/agents/*.json"):
        try:
            a = json.load(open(f))
        except Exception:
            continue
        if a.get("herdr", {}).get("socket") == SOCK or str(a.get("id", "")).startswith("pibench-"):
            os.remove(f)
            for d in ("messages", "stopped"):
                subprocess.run(["rm", "-rf", f"{HERD}/{d}/{a['id']}"])

def heap_mb(d):
    """Total self size (MB) of the newest heap snapshot in d."""
    fs = sorted(glob.glob(f"{d}/*.heapsnapshot"), key=os.path.getmtime)
    if not fs:
        return None
    h = json.load(open(fs[-1]))
    nf = h["snapshot"]["meta"]["node_fields"]
    n, si = len(nf), nf.index("self_size")
    total = sum(h["nodes"][si::n]) / 1e6
    for f in fs:
        os.remove(f)  # 100s of MB each
    return round(total, 1)

def busy_s(d):
    """Main-thread busy time (s) in the cpu profile in d: non-idle JS samples, up to the last idle
    gap of >= 0.8 s (the 1 s settle before /quit), so quitting isn't counted."""
    fs = sorted(glob.glob(f"{d}/*.cpuprofile"), key=os.path.getsize)
    if not fs:
        return None
    p = json.load(open(fs[-1]))
    idle = {n["id"] for n in p["nodes"] if n["callFrame"]["functionName"] in ("(idle)", "(program)")}
    t, idle_since, cut, ts = 0, None, len(p["samples"]), []
    for i, (s, dt) in enumerate(zip(p["samples"], p["timeDeltas"])):
        t += dt; ts.append(t)
        if dt > 800_000 and idle_since is None:
            idle_since = t - dt
        if s in idle:
            idle_since = t if idle_since is None else idle_since
        else:
            if idle_since is not None and t - idle_since >= 800_000:
                cut = i
            idle_since = None
    step = statistics.median(p["timeDeltas"]) / 1e6
    return round(sum(1 for s in p["samples"][:cut] if s not in idle) * step, 3)

# --- scenarios ----------------------------------------------------------------------------------------
def startup(cfg, rid):
    reset_repo()
    p = Pi(cfg, rid)
    try:
        wall = p.ready(); r = ru(p.pid)
    finally:
        p.quit()
    out = dict(cpu_s=r["cpu"], child_s=r["child"], wall_s=wall, peak_fp_mb=r["maxfp"], git_spawns=p.git()[0])
    q = Pi(cfg, rid + "-prof", env={"BUN_OPTIONS": f"--cpu-prof --cpu-prof-dir={RUN}/prof/{rid}"})
    try:
        q.ready()
        time.sleep(1)
    finally:
        q.quit()
    out["blocked_s"] = busy_s(f"{RUN}/prof/{rid}")
    return out

def idle(cfg, rid, secs=60):
    reset_repo()
    p = Pi(cfg, rid)
    try:
        p.ready(); time.sleep(5)
        a, ta = ru(p.pid), time.time()
        time.sleep(secs)
        b, tb = ru(p.pid), time.time()
        n, gcpu = p.git(ta, tb)
    finally:
        p.quit()
    m = 60 / (tb - ta)
    return dict(cpu_s_min=(b["cpu"] - a["cpu"]) * m, child_s_min=(b["child"] - a["child"]) * m,
                git_min=n * m, git_cpu_s_min=gcpu * m, wake_s=(b["wake"] - a["wake"]) / (tb - ta),
                fp_mb=b["fp"], peak_fp_mb=b["maxfp"])

def session_entries(path):
    out = []
    for l in open(path):
        try:
            out.append(json.loads(l))
        except ValueError:
            pass  # a line being written
    return out

def working(cfg, rid):
    reset_repo()
    before = set(glob.glob(f"{RUN}/sessions/*.jsonl"))
    p = Pi(cfg, rid, env={"BUN_OPTIONS": f"--heap-prof --heap-prof-dir=../prof/{rid}"})  # bun joins it to cwd
    try:
        p.ready(); time.sleep(3)
        a, ta = ru(p.pid), time.time()
        send(p.pane, PROMPT); time.sleep(0.5); send(p.pane, "\r")
        msgs, t0 = [], time.time()
        while time.time() - t0 < 300:
            time.sleep(0.5)
            new = set(glob.glob(f"{RUN}/sessions/*.jsonl")) - before
            if not new:
                continue
            msgs = [e["message"] for e in session_entries(new.pop()) if e.get("type") == "message"]
            last = msgs[-1] if msgs else {}
            if last.get("role") == "assistant" and last.get("stopReason") != "toolUse":
                break
        else:
            raise RuntimeError("prompt didn't finish in 300 s")
        time.sleep(3)  # work an extension does right after a tool or the run (e.g. a git refresh) belongs to the run
        b, tb = ru(p.pid), time.time()
        n_git, gcpu = p.git(ta, tb + 1)
    finally:
        p.quit()
    calls = [c["name"] for m in msgs if m.get("role") == "assistant" for c in m.get("content", [])
             if isinstance(c, dict) and c.get("type") == "toolCall"]
    if msgs[-1].get("stopReason") != "stop" or len(calls) != 5:  # a provider error or a model detour: redo the run
        raise RuntimeError(f"bad run: stop={msgs[-1].get('stopReason')} calls={calls}")
    n = len(calls)
    return dict(calls=len(calls), tools=",".join(calls), stop=msgs[-1].get("stopReason"), wall_s=tb - ta,
                cpu_ms_call=(b["cpu"] - a["cpu"]) * 1000 / n, child_ms_call=(b["child"] - a["child"]) * 1000 / n,
                total_ms_call=(b["cpu"] - a["cpu"] + b["child"] - a["child"]) * 1000 / n,
                git_call=n_git / n, git_cpu_ms_call=gcpu * 1000 / n,
                fp_mb=b["fp"], rss_mb=b["rss"], peak_fp_mb=b["maxfp"], heap_mb=heap_mb(f"{RUN}/prof/{rid}"))

def events(pane, seqs, rate=30):
    t = time.time()
    for i, s in enumerate(seqs):
        send(pane, s)
        time.sleep(max(0, t + (i + 1) / rate - time.time()))

def long(cfg, rid, idle_s=30):
    reset_repo()
    p = Pi(cfg, rid, args=["--fork", f"{RUN}/long-session.jsonl"],
           env={"BUN_OPTIONS": f"--heap-prof --heap-prof-dir=../prof/{rid}"})
    try:
        wall = p.ready(); r0 = ru(p.pid); time.sleep(5)
        a, ta = ru(p.pid), time.time()
        time.sleep(idle_s)
        b, tb = ru(p.pid), time.time()
        rate = (b["cpu"] - a["cpu"]) / (tb - ta)  # idle CPU/s, subtracted from the input windows
        wheel = ([f"\x1b[<64;60;15M"] * 40 + [f"\x1b[<65;60;15M"] * 40) * 2
        events(p.pane, wheel); time.sleep(2)
        c, tc = ru(p.pid), time.time()
        rnd = random.Random(1)
        moves = [f"\x1b[<35;{rnd.randint(5, 115)};{rnd.randint(3, 30)}M" for _ in range(300)]
        events(p.pane, moves); time.sleep(2)
        d, td = ru(p.pid), time.time()
    finally:
        p.quit()
    return dict(startup_cpu_s=r0["cpu"], startup_wall_s=wall, idle_cpu_s_min=rate * 60,
                idle_child_s_min=(b["child"] - a["child"]) * 60 / (tb - ta), wake_s=(b["wake"] - a["wake"]) / (tb - ta),
                wheel_ms=((c["cpu"] - b["cpu"]) - rate * (tc - tb)) * 1000 / len(wheel),
                move_ms=((d["cpu"] - c["cpu"]) - rate * (td - tc)) * 1000 / len(moves),
                fp_mb=d["fp"], rss_mb=d["rss"], peak_fp_mb=d["maxfp"], heap_mb=heap_mb(f"{RUN}/prof/{rid}"))

def herd(cfg, rid, n=10, secs=60, hz=3):
    reset_repo()
    ps = [Pi(cfg, f"{rid}-0")]
    ps[0].own_ws = False  # closed below, after every agent quit
    try:
        ps += [Pi(cfg, f"{rid}-{i}", ws=ps[0].ws) for i in range(1, n)]
        for p in ps:
            p.ready()
        time.sleep(5)
        pids = {p.pid for p in ps}
        recs = []
        for f in glob.glob(f"{HERD}/agents/*.json"):
            try:
                a = json.load(open(f))
                if a.get("pid") in pids and a.get("herdr", {}).get("socket") == SOCK:
                    recs.append(f)
            except Exception:
                pass
        if not recs:  # no pi-herd in this config: rewrite records of our own instead
            for i in range(n):
                f = f"{HERD}/agents/pibench-{i}.json"
                json.dump(dict(id=f"pibench-{i}", pid=0, cwd=REPO, startedAt=int(time.time() * 1000),
                               herdr=dict(socket=SOCK, pane="none"), ended=int(time.time() * 1000)), open(f, "w"))
                recs.append(f)

        def window(write):
            stop, writes = threading.Event(), [0]
            def writer():  # pi-herd's writeAtomic: a dot-named temp file, then rename
                while not stop.wait(1 / hz):
                    f = recs[writes[0] % len(recs)]
                    data = open(f).read()
                    tmp = os.path.join(os.path.dirname(f), "." + os.path.basename(f) + ".tmp")
                    open(tmp, "w").write(data); os.rename(tmp, f)
                    writes[0] += 1
            a, ta = {p.pid: ru(p.pid) for p in ps}, time.time()
            th = threading.Thread(target=writer) if write else None
            th and th.start()
            time.sleep(secs)
            stop.set(); th and th.join()
            b, tb = {p.pid: ru(p.pid) for p in ps}, time.time()
            m = 60 / (tb - ta)
            g = [p.git(ta, tb) for p in ps]
            return dict(cpu=sum(b[k]["cpu"] - a[k]["cpu"] for k in a) * m, child=sum(b[k]["child"] - a[k]["child"] for k in a) * m,
                        git=sum(x[0] for x in g) * m, writes=writes[0])
        base, w = window(False), window(True)
    finally:
        for p in ps:
            send(p.pane, "/quit\r") if ru(p.pid) else None
        for p in ps:
            p.quit()
        herdr("workspace", "close", ps[0].ws, check=False)
    return dict(records=len(recs), writes=w["writes"], base_cpu_s_min=base["cpu"], base_child_s_min=base["child"],
                base_git_min=base["git"], write_cpu_s_min=w["cpu"], write_child_s_min=w["child"], write_git_min=w["git"],
                write_extra_cpu_s_min=w["cpu"] - base["cpu"])

SCENARIOS = dict(startup=startup, idle=idle, working=working, long=long, herd=herd)

def largest_session():
    fs = glob.glob(f"{HOME}/.pi/agent/sessions/*/*.jsonl")
    return max(fs, key=os.path.getsize) if fs else None

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opt = lambda k, d: next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith(f"--{k}=")), d)
    tag, out = opt("tag", "run"), opt("out", f"{RUN}/results")
    if len(args) < 2:
        sys.exit(__doc__)
    scs = list(SCENARIOS) if args[0] == "all" else args[0].split(",")
    cfgs, reps = args[1].split(","), int(args[2]) if len(args) > 2 else 3
    if bad := [c for c in cfgs if c not in ("ne", "ext")] + [x for x in scs if x not in SCENARIOS]:
        sys.exit(f"unknown: {', '.join(bad)}\n{__doc__}")
    session = opt("session", largest_session()) if "long" in scs else None
    if "long" in scs and not session:
        sys.exit("long needs a session to fork: --session=FILE")
    setup(cfgs, session)
    os.makedirs(out, exist_ok=True)
    for rep in range(reps):
        for sc in scs:
            for cfg in cfgs:
                rid = f"{tag}-{sc}-{cfg}-{time.strftime('%H%M%S')}"
                rec = dict(tag=tag, scenario=sc, config=cfg, rid=rid, rep=rep, start=time.strftime("%F %T"),
                           load=[float(x) for x in subprocess.run(["sysctl", "-n", "vm.loadavg"], capture_output=True,
                                                                   text=True).stdout.strip("{} \n").split()])
                t = time.time()
                try:
                    rec |= SCENARIOS[sc](cfg, rid)
                except Exception as e:
                    rec["error"] = repr(e)
                finally:
                    cleanup_records()
                rec["secs"] = round(time.time() - t)
                rec = {k: round(v, 3) if isinstance(v, float) else v for k, v in rec.items()}
                print(json.dumps(rec), flush=True)
                with open(f"{out}/{tag}.jsonl", "a") as f:
                    f.write(json.dumps(rec) + "\n")

if __name__ == "__main__":
    main()
