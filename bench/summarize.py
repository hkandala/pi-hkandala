#!/usr/bin/env python3
"""Tables from <out>/<tag>.jsonl: mean ± sd (n) per scenario, metric and config.

usage: summarize.py <tag> [configs] [--out=DIR]   writes <out>/<tag>.md (default out: /tmp/pi-bench/results;
default configs: those in the data). With two configs, a last column shows the change from the first to the second.
Outliers (more than 25% and 3 units off the median of their group) are listed by run id; delete or
move their lines out of the .jsonl and re-run them to redo.
"""
import json, os, statistics, sys

SKIP = {"tag", "scenario", "config", "rid", "rep", "start", "load", "secs", "tools", "stop", "error"}
NOTES = dict(
    startup="New session in a scratch clone of this repo. cpu/child: CPU s of pi.real and its reaped children until ready. "
            "wall: s from process start until startup CPU settles. blocked: main-thread busy s (JS samples, separate profiled start).",
    idle="60 s idle after ready + 5 s, new session in the scratch clone. Per minute: pi.real CPU, children CPU, git spawns and their CPU; wakeups/s.",
    working="One prompt, 5 tool calls (read, bash, edit, codemode with 3 nested bash, write), gemini-3.5-flash, thinking off. "
            "Per top-level tool call: pi.real ms, children ms, git spawns. Memory at the end; heap = JS heap snapshot at exit.",
    long="--fork of a large session. Idle 30 s; 160 wheel events and 300 mouse moves at 30/s "
         "(ms of pi.real CPU per event, idle rate subtracted). Memory at the end.",
    herd="10 idle agents in one herdr session. base: 60 s quiet; write: 60 s while a writer rewrites their pi-herd records "
         "(temp file + rename) at 3/s. CPU s/min summed over the 10 agents.",
)

def fmt(xs):
    if not xs:
        return "–"
    m = statistics.mean(xs)
    sd = statistics.stdev(xs) if len(xs) > 1 else 0
    d = 0 if abs(m) >= 100 else 1 if abs(m) >= 10 else 2 if abs(m) >= 1 else 3
    return f"{m:.{d}f} ± {sd:.{d}f} ({len(xs)})"

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = next((a[6:] for a in sys.argv[1:] if a.startswith("--out=")), "/tmp/pi-bench/results")
    if not args:
        sys.exit(__doc__)
    tag = args[0]
    rows = [json.loads(l) for l in open(f"{out_dir}/{tag}.jsonl") if l.strip()]
    cfgs = args[1].split(",") if len(args) > 1 else list(dict.fromkeys(r["config"] for r in rows))
    out, outliers = [f"# pi bench: {tag}\n"], []
    errs = [r for r in rows if "error" in r]
    for sc in dict.fromkeys(r["scenario"] for r in rows):
        rs = [r for r in rows if r["scenario"] == sc and "error" not in r]
        if not rs:
            continue
        diff = len(cfgs) == 2
        out += [f"\n## {sc}\n", NOTES.get(sc, ""), "",
                "| metric | " + " | ".join(cfgs) + (f" | {cfgs[0]}→{cfgs[1]} |" if diff else " |"),
                "|---" * (len(cfgs) + 1 + diff) + "|"]
        metrics = [k for k in dict.fromkeys(k for r in rs for k in r) if k not in SKIP and isinstance(rs[0].get(k), (int, float))]
        for k in metrics + ["load1"]:
            vals = {c: [r["load"][0] if k == "load1" else r[k] for r in rs if r["config"] == c and (k == "load1" or r.get(k) is not None)] for c in cfgs}
            line = f"| {k} | " + " | ".join(fmt(vals[c]) for c in cfgs)
            if diff:
                b, a = vals[cfgs[0]], vals[cfgs[1]]
                line += " | " + (f"{(statistics.mean(a) / statistics.mean(b) - 1) * 100:+.0f}%" if a and b and statistics.mean(b) else "–")
            out.append(line + " |")
            if k != "load1":
                for c in cfgs:
                    if len(vals[c]) >= 3:
                        med = statistics.median(vals[c])
                        for r in rs:
                            v = r.get(k)
                            if r["config"] == c and v is not None and abs(v - med) > max(0.25 * abs(med), 3 if abs(med) >= 10 else 0.05):
                                outliers.append(f"{r['rid']}: {k} = {v} (median {med:.3g})")
    if outliers:
        out += ["\n## Outliers\n"] + [f"- {o}" for o in outliers]
    if errs:
        out += ["\n## Failed runs\n"] + [f"- {r['rid']}: {r['error']}" for r in errs]
    text = "\n".join(out) + "\n"
    open(f"{out_dir}/{tag}.md", "w").write(text)
    print(text)

if __name__ == "__main__":
    main()
