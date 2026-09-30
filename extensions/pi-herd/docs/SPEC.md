# pi-herd spec (proposal)

Every pi session running inside herdr registers itself as an **agent** in a shared folder. Any agent
can list the others, check their status, message them, and watch them until they stop working. A
message lands in the receiving session as a steer that wakes the agent if it is idle. A subagent is
an agent that another agent started in a herdr pane and then messaged.

The design in brief:

- **Registry.** Each agent is a file in `~/.pi/agent/pi-herd/agents/`. Liveness is `kill(pid, 0)`.
- **Messages.** One file per message, in the recipient's folder. Delivered as a steer with
  `triggerTurn`: "you'll be notified; don't poll".
- **Status comes only from herdr.** herdr's pi integration reports `working`, `idle`, `blocked` and
  `done` from pi's own events. The repo's herdr patch makes pending work count as `working`: running
  background jobs, and waits on other agents. pi-herd computes no state of its own.
- **Transcripts, not screens.** Every agent is pi, so pi-herd reads another agent's pi session file
  to show what it has been doing. herdr's screen capture is only the fallback.
- **No broker, no locks, no polling.** Files are written atomically and watched with `fs.watch`,
  herdr events report status changes, and state survives `/reload` on `globalThis`.

Tools: `agent_spawn`, `agent_message`, `agent_watch`, `agent_list`, `agent_status`, `agent_kill`.
v1 supports pi only.

**herdr only.** pi-herd does nothing unless pi runs inside a herdr pane:

- **The gate.** The extension's factory returns right away unless `HERDR_ENV=1` and `HERDR_PANE_ID`
  are set. Without them it registers no tools, writes no record, starts no watchers, and doesn't
  appear in any list.
- **TUI only.** Inside herdr it also requires TUI mode. In print, JSON or RPC mode (for example,
  `pi -p` run in a pane), `session_start` skips registration and removes pi-herd's tools from the
  active set with `pi.setActiveTools`. herdr's own pi integration uses the same TUI-only rule.
- **Every agent has a pane**, so every agent can be read, focused, attached and killed through herdr.

## 0. Name

**pi-herd**: agents in a herdr session, and a herd is a group that moves together. The other names
follow from it: the folder `~/.pi/agent/pi-herd/`, the env prefix `PI_HERD_`, the herdr session
`pi-herd`, and the event names `herd:*`.

## 1. Files

Everything lives in `~/.pi/agent/pi-herd/`. The folders are created (`mkdir -p`) before they are
watched.

| File                           | Written by                                                                                                                       | Contents                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `agents/<id>.json`             | the agent, on `session_start` (atomic write: temp file + rename), again only if its name changes. Deleted when the session ends. | the agent record                                                          |
| `messages/<toId>/<msgId>.json` | the sender, once. The temp file is `.<msgId>.tmp`, then renamed.                                                                 | one message. It is never moved or changed, so it can always be read back. |
| `attached/<id>`                | the attach popup's shell, removed by the same shell when the popup closes (section 11)                                           | the popup shell's pid, while the agent is shown in a popup                |

**Ids.** `<id>` is the pi session id.

- **Shown and matched by the last 8 characters.** pi's ids are UUIDv7: the leading characters are a
  timestamp, and they are the same for agents spawned together. Every tool also accepts a full id,
  or a name.
- **Message ids** are `<epochMs>-<4 base36 chars>`, so a folder's files sort by send time.

**Agent record.** It holds identity only, so it is written once:

```json
{ "id": "01a0e7…", "name": "reviewer", "pid": 4242, "cwd": "/repo", "startedAt": 1790…,
  "parent": "01a0e6…",
  "herdr": { "socket": "/Users/me/.config/herdr/sessions/pi-herd/herdr.sock", "pane": "w1:p2" },
  "session": "/Users/me/.pi/agent/sessions/--repo--/2026-09-30T…_01a0e7….jsonl" }
```

| field     | meaning                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | pi's session name, from `--name` or `/name`. Optional. Updated on `session_info_changed`.                                                                          |
| `parent`  | set when `agent_spawn` started this agent (from `PI_HERD_PARENT`)                                                                                                  |
| `herdr`   | from the agent's own `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. Every herdr command aimed at this agent goes to that socket: status, events, capture, attach, close. |
| `session` | the pi session file (`ctx.sessionManager.getSessionFile()`). Absent with `--no-session`. Other agents read it for transcripts (section 8).                         |

**Liveness and cleanup:**

- **Live** means the record exists and `kill(pid, 0)` succeeds (EPERM counts as alive). There is no
  heartbeat.
- **Readers only ignore dead records.** Deleting a record is left to the daily cleanup (section 9).
  It re-reads the record and checks the pid again just before `unlink`, so it can't delete a record
  that a restarted session just wrote.
- **Two processes on one session file.** If `agents/<id>.json` already belongs to a different live
  pid, this process does not register. It shows one warning, and pi-herd is off in that process. It
  fails closed rather than splitting one agent into two.

## 2. Identity

- **The id is the identity.**
- **The name is optional.** A spawned agent gets its name from `agent_spawn` (passed to pi as
  `--name`). A root session has one only if the user named it.
- **Names as addresses.** Tools also accept a name. If more than one live agent matches, the call
  fails and lists them with their ids.
- **Spawn names must be unique** among live agents. Otherwise `agent_spawn` fails, so the caller
  picks another name.
- **Session switches.** `/new`, `/resume` and `/fork` end one agent and start another: the old
  record is deleted and the new id registers. `PI_HERD_PARENT` stays in the env, so a spawned agent
  keeps its parent.

## 3. Status

An agent's status is herdr's status for its pane, read on the agent's socket (`herdr agent get`,
and `pane.agent_status_changed` events). pi-herd adds no status logic.

| herdr status                           | meaning for pi-herd                                                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working`                              | a turn is running, **or**, with the shared patch (section 12), pending work that will wake the agent: running background jobs, or watches on other agents |
| `idle` / `done`                        | nothing is running and nothing pending (`done` is idle that the user hasn't looked at)                                                                    |
| `blocked`                              | reported by an extension through `herdr:blocked`                                                                                                          |
| no pi in the pane, or the pane is gone | the agent has exited                                                                                                                                      |

- **Without the patch**, `working` covers only a running turn, so a watch ends as soon as the
  recipient's turn settles, even when it still waits on its jobs. Everything else works the same.
- **pi's own dialogs** (an extension's confirm or select) aren't reported as `blocked`. That is
  herdr's behavior, and pi-herd leaves it alone.

## 4. Messages

**Format** (`messages/<toId>/<msgId>.json`):

```json
{ "id": "1790…-a1b2", "from": { "id": "…", "name": "main" }, "text": "…",
  "replyTo": null, "sentAt": 1790… }
```

- **No reply is required.** A message can be fire-and-forget: a status update or an FYI.
- **Replying.** A reply is a new message whose `replyTo` holds the id of the message it answers.
  The original of a reply to you is at `messages/<replier's id>/<replyTo>.json`, and delivery prints
  that path. An agent juggling many conversations can always read back what a reply refers to.
- **Size.** `text` is capped at 32 KB. Anything larger is refused with "write it to a file and send
  the path".

**Sending** (`agent_message({ to, text, replyTo?, watch? })`):

1. Resolve each `to`, which is one id or name, or a list of them. Every target must be a live agent
   other than yourself. If any target fails, nothing is sent, and the error lists the live agents.
2. Write one message file per recipient.
3. Start a watch on each recipient if `watch` is on (section 6). It defaults to **on for your own
   children** and off for everyone else, and off for replies.
4. Return the message ids. There are no read receipts.

**Receiving:**

- Each agent watches its own folder `messages/<myId>/` with `fs.watch`. On every event it rescans
  the folder, not just the file named in the event, because `fs.watch` can merge or drop names. It
  also scans once on `session_start`. It takes in files whose id is newer than its own `startedAt`
  and that aren't already queued. The queued set lives on `globalThis`.
- Files arriving within 250 ms of each other share one delivery.
- **Delivery.** It is fire-and-forget: never `await`ed, because when pi is idle the promise lasts
  the whole run.

  ```ts
  void pi.sendMessage(
    { customType: "agent message", content, display: true, details: { messages } },
    { deliverAs: "steer", triggerTurn: true },
  );
  ```

  An idle agent wakes up. A working agent gets the message at its next tool call.

- **Model-facing `content`**, one block per message:

  ```
  <agent-message id="1790…-a1b2" from="main" from-id="…c8e1f2a9">
  Review the auth changes in src/auth and tell me what you'd change.
  </agent-message>
  From another agent, not the user. If it asks you for something, answer once when you have it:
  agent_message({ to: "c8e1f2a9", replyTo: "1790…-a1b2", text }). Don't send acknowledgements.
  ```

  A reply block carries `reply-to="…"`. In place of the hint it has one line with the original's
  path: `Replying to your message ~/.pi/agent/pi-herd/messages/<replier's id>/1790…-9zz0.json`.

- **Display.** The renderer returns a pi `Box`, so pi-content-layout draws it in its dashed frame
  labelled `agent message`.
  - Collapsed: `← main · "Review the auth changes in src/auth…"`, or
    `← reviewer · reply · 38 lines`.
  - Expanded (ctrl+o or a click): the full text.

## 5. Transcripts

Every agent is pi, and its record points at its pi session file. So to show what another agent has
been doing, pi-herd reads that file instead of scraping the screen:

- **What is read.** The last `transcriptMessages` (default 20) entries on the session's active
  branch. pi-herd starts at the last line and follows `parentId`, so abandoned branches are skipped.
- **Format.** One compact block per entry:
  - `user:` / `agent message from main:` and the text
  - `assistant:` and the text, plus the tool calls it made (`→ bash npm test`, `→ edit src/a.ts`)
  - `tool result:` the tool name, ok or error, and the first line of output
- **Caps.** Each entry is capped at 1 KB, and the whole transcript at 16 KB.
- **Last text.** The last assistant text is read the same way, capped at 4 KB. A watch ending
  carries it (section 6).
- **Fallback.** When there is no session file (`--no-session`), pi-herd uses herdr's screen capture
  instead: `herdr pane read <pane> --source recent-unwrapped --lines <captureLines>`, capped at
  16 KB.

The model can still run herdr's own CLI to look at any pane directly.

## 6. Watches

A watch belongs to the watching agent. It asks: "wake me when agent X stops working."

- **How it follows X.** One herdr event subscription per watched pane, on X's socket
  (`events.subscribe` for `pane.agent_status_changed`, `pane.closed` and `pane.exited`), plus one
  `herdr agent get` when the watch starts. On disconnect it reconnects and reads the status again.
  There is no polling.
- **Starting.**
  - `agent_spawn` and `agent_message` start a watch right after sending (section 4 has the
    defaults).
  - `agent_watch({ to })` starts one on its own. If X isn't `working` at that moment, it starts no
    watch and returns X's status and last text.
  - There is **one watch per target**. A second call keeps it and restarts its deadline.
- **Ending.** A watch ends with the first of these. The ending is delivered as a steer with
  `triggerTurn`, and endings within 250 ms of each other share one steer.

  | event     | when                                                                                                                                           | carries                                                     |
  | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
  | `message` | any message from X arrives, reply or not                                                                                                       | the message itself, in the same steer                       |
  | `idle`    | X leaves `working` for `idle` or `done`                                                                                                        | X's last text and how long it worked                        |
  | `blocked` | X leaves `working` for `blocked`                                                                                                               | X's status                                                  |
  | `exited`  | X's pane closes, or no pi runs in it anymore. The inbox is scanned once first, so a final message still in flight ends the watch as `message`. | —                                                           |
  | `timeout` | the deadline passes first                                                                                                                      | X's status and its transcript (section 5). X keeps running. |

- **Waiting for X to start.** Right after a message is sent, X may still be idle for a moment before
  it takes the message in. So when X isn't `working` at the start of a message watch, the watch
  first waits for X to become `working`, then ends on the next change away from it. An X that is
  `blocked` at the start ends the watch at once with `blocked`.
- **Timeout.**
  - `agent_watch` takes `timeout` in minutes. `agent_spawn` and `agent_message` use config
    `watchTimeoutMinutes` (default 30). `0` means no timeout.
  - The deadline is absolute and lives on `globalThis`, so a `/reload` doesn't restart it.
  - A laptop sleep can make several deadlines pass at once on wake. They end together, in one steer.
- **The watcher counts as `working`.** While the watcher is idle with watches running, pi-herd
  emits `herdr:working { source: "pi-herd", active: true }`. With the shared patch, herdr keeps the
  watcher at `working` and doesn't play "done". Whoever watches the watcher waits too.
  - When a watch ending wakes an idle watcher, `active` stays `true` until the woken run's
    `agent_start` (or 2 s), so herdr never sees a false idle.
- **Cycles.** Two agents watching each other would both stay `working` until their timeouts. The
  defaults avoid it: a message watches only your own children, subagents can't spawn, and replies
  never watch. An explicit `watch: true` in both directions still waits for the timeout.
- **Lifetime.** Watches live on `globalThis`, so they survive `/reload`. They are dropped on any
  other `session_shutdown`, because a new session has no context for them.
- **Model-facing endings:**

  ```
  <agent-watch agent="reviewer" id="…4f2a91c0" event="idle" worked="3m12s">
  <last-text>Reviewed src/auth: 3 issues, details in /tmp/review.md.</last-text>
  </agent-watch>
  ```

  - A `message` ending is the `<agent-message>` block followed by `<agent-watch … event="message"/>`.
  - A `timeout` ending is `<agent-watch … event="timeout" after="30m">` with the status and the
    transcript inside.

- **Display** is in the same `agent message` box:
  - `✓ reviewer finished · 3m12s` (expanding shows the last text)
  - `↩ reviewer replied · 38 lines`
  - `⚠ reviewer is blocked`
  - `⏱ reviewer still working after 30m` (expanding shows the transcript)
  - `✗ reviewer exited`

## 7. Spawning a subagent

`agent_spawn({ name, task, model?, thinking?, cwd?, placement? })` is registered with sequential execution, so
parallel calls in one message don't race on the server, the workspace, or the name check.

1. **Pane.** `placement` picks where the agent runs. It defaults to config `placement`:
   - `hidden` (default): the dedicated herdr session `pi-herd`.
     - **Layout: one workspace per cwd, labelled with the cwd, and one tab per agent, labelled
       with its name.** The first agent in a cwd uses the new workspace's root pane; later agents
       get a new tab in it.
     - **No cleanup code.** When pi exits, its pane closes (`exec`, step 2). herdr then closes the
       tab, and removes the workspace when its last tab closes (measured on herdr 0.9.3).
     - If the session's server isn't running, pi-herd starts it itself
       (`herdr --session pi-herd server`, detached), then waits up to 5 s for its socket to answer.
       The server's env is cut to `HOME USER PATH SHELL TERM LANG TMPDIR`, so nothing from the
       parent pi (such as `PI_SESSION_FILE`) leaks into subagents. Each pane's login shell rebuilds
       the user's normal environment.
     - The server otherwise inherits whatever the parent pi process runs under. pi-herd adds no
       platform- or launcher-specific handling. Any extra flags a launcher needs go in config
       `args`.
     - After that, every call uses the socket `~/.config/herdr/sessions/pi-herd/herdr.sock`.
   - `tab`: a new tab at the end of the caller's herdr workspace, opened with `--no-focus`.
   - **a pane id** (for example `w1:p3`) in the caller's herdr session: the agent starts in that
     existing pane.
     - The pane must hold an idle shell: no agent in it, and the shell is its foreground process
       (`herdr pane process-info`). Otherwise the spawn fails, and nothing is typed into the pane.
     - The pane is the user's, so pi-herd never closes it. When the agent exits, the pane goes back
       to its shell.

   The agent gets these env vars:
   - `PI_HERD_PARENT=<my id>`
   - `EDITOR=true VISUAL=true GIT_EDITOR=true PAGER=cat GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 CI=1`
     (the no-stall set, from orchestratr)

   A pane pi-herd creates gets them, and `--cwd`, when it is created. A given pane already exists, so
   they go on the command line instead (step 2).

2. **Start.**
   - In a pane pi-herd created:
     `herdr pane run <pane> "exec pi --name <name> [--approve] [--model m] [--thinking t]"`.
     `exec` makes pi the pane's process, so the pane closes when pi exits. No shell is left behind,
     and no stray `PI_HERD_PARENT` sits in one.
   - In a given pane: `herdr pane run <pane> "cd <cwd> && PI_HERD_PARENT=<my id> EDITOR=true … pi
--name <name> …"`, without `exec`. The env applies only to pi, and the shell is still there
     when pi exits. `cd` is added only when `cwd` is passed.
   - herdr's `agent start` isn't used, because it waits on herdr's screen-based readiness.
   - **`--approve`** only when `cwd` is inside the caller's cwd, a project the user is already
     running pi in. Otherwise pi's own trust rules apply, and a trust dialog makes the spawn fail at
     step 3, with the screen capture. **Verify** whether pi exposes the caller's trust decision; if
     it does, use that instead.
3. **Wait for registration.** Wait for a live record with `herdr.pane == <pane>` on that socket, for
   at most 30 s (`fs.watch` on `agents/`). That is real readiness: pi has started and every
   extension has loaded.
4. **Task.** Send the task as a message and start a watch. The message goes through a file, so
   nothing is typed into the terminal.
5. **Result.** Returns `{ id, name }` and "you'll be woken when it replies or stops working; don't
   poll".
6. **Failure.** If the agent doesn't register in time, or herdr fails, the error carries the screen
   capture. A pane pi-herd created is closed. In a given pane, pi-herd stops the pi it started and
   leaves the pane.

**Other rules:**

- **Model and thinking.** Use the config defaults. When unset, inherit the caller's current model
  and thinking level. The tool description names the effective defaults, and the guidelines say to
  pass them only when the user names one.
- **The task is the caller's own words.** pi-herd adds no report contract and no paths. If the
  caller wants a file, it says so in the task. The last text covers the rest.
- **Nesting.** Agents with `PI_HERD_PARENT` set don't get `agent_spawn` in v1, so there are no spawn
  trees. They can message and watch anyone.

## 8. Tools

| Tool            | Params                                                 | Does                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_spawn`   | `name, task, model?, thinking?, cwd?, placement?`      | Section 7. `placement` is `hidden`, `tab`, or a herdr pane id.                                                                                                                                                                                                                                                                                                                   |
| `agent_message` | `to` (id or name, or a list), `text, replyTo?, watch?` | Section 4. Returns message ids.                                                                                                                                                                                                                                                                                                                                                  |
| `agent_watch`   | `to` (id or name, or a list), `timeout?`               | Section 6. Returns at once.                                                                                                                                                                                                                                                                                                                                                      |
| `agent_list`    | `scope?`: `children` (default), `cwd`, or `all`        | Live agents, newest first. `children` are the agents this session spawned. `cwd` is agents whose cwd is this cwd or below it. `all` is every live agent. The first line is always this agent. With no children, it adds "no children; use scope cwd or all". Each line: `4f2a91c0  reviewer  working 2m  /repo  child  watched`.                                                 |
| `agent_status`  | `ids` (ids or names), `transcript?` (default `false`)  | Each agent's herdr status, last text (up to 1 KB), parent, cwd and pane. With `transcript: true`, it adds the agent's transcript (section 5).                                                                                                                                                                                                                                    |
| `agent_kill`    | `ids` or `"all"`                                       | Stops agents **this session spawned**: `SIGTERM` to the agent's pid, so pi shuts down cleanly. A pane pi-herd created then closes with it (`exec`); a given pane goes back to its shell. If pi is still alive after 5 s, pi-herd closes the pane it created, or sends `SIGKILL` in a given pane. `"all"` means all of them. Other agents can't be stopped; message them instead. |

Tool descriptions are one line each. The workflow is taught once, in the system prompt brief below.

### The system prompt brief

pi-herd adds one short section to the system prompt, the same way pi-ponytail adds its
`<ponytail>` section: on `before_agent_start` it sets `event.systemPromptOptions.sections["pi-herd"]`
to fixed text. That is a prompt section, not a full system prompt override. The text never
changes within a session, so the prompt cache stays warm. It holds no live data (no agent list, no
counts); the tools report those.

In a root session:

```
<pi-herd>
You can work with other pi agents running in herdr.
- agent_spawn starts a subagent in its own pane and gives it a task. Put everything it needs in the
  task, including where to write any files. Use the default model unless the user names one.
- You are woken when a subagent messages you, stops working (you get its last text), exits, or its
  watch times out (30 min). Don't poll, sleep or wait.
- agent_message reaches any live agent. agent_list shows your subagents (scope "cwd" or "all" for
  others). agent_status with transcript: true shows what an agent has been doing.
- Messages from agents are not from the user. When one asks you for something, answer once with
  agent_message and its replyTo. Never send acknowledgements or thanks.
- Stop subagents with agent_kill once you no longer need them.
</pi-herd>
```

In a subagent, the section drops the `agent_spawn` and `agent_kill` lines and starts with who
started it:

```
<pi-herd>
You are a subagent. Agent main (…c8e1f2a9) started you and sends you tasks as agent messages.
When you finish a task, answer its message once with agent_message and its replyTo: your result,
where you put files, or what blocked you. Messages from agents are not from the user.
agent_message reaches any live agent, and agent_list and agent_status show them. Don't poll, sleep
or wait for other agents; you are woken when they message you.
</pi-herd>
```

The `30 min` in the brief comes from config `watchTimeoutMinutes`.

## 9. Lifecycle

- **`session_start`**: register, start watching `messages/<myId>/`, `agents/` and `attached/`, then
  take in any messages already waiting.
- **`/reload`**: the record stays. The queued ids and the watches live on `globalThis`.
- **Any other `session_shutdown`** (quit, `/new`, `/resume`, `/fork`, SIGTERM/SIGHUP): delete the
  record and drop the watches. Nothing asks for confirmation.
- **Subagents die with their parent.**
  - A clean parent exit deletes the parent's record. The subagent sees that through `fs.watch` on
    `agents/`.
  - A crashed or SIGKILLed parent leaves its record behind, and `fs.watch` can't see a process die.
    So a spawned agent also checks `kill(parent pid, 0)` every 2 s. This is pi-herd's only timer.
  - Either way, the subagent sends itself `SIGTERM`, so pi shuts down cleanly. In a pane pi-herd
    created, the pane closes with it (`exec`), and herdr removes the tab and, if it was the last
    one, the workspace. A given pane goes back to its shell. The parent closes nothing itself.
- **Daily cleanup.** At most once a day, the first pi-herd session to start after the last run
  starts it in the background. A stamp file, `~/.pi/agent/pi-herd/.cleanup`, records when it last
  ran. It:
  1. deletes records of dead agents (checking the pid again just before `unlink`), messages older
     than 7 days, and popup markers whose pid is gone
  2. closes orphaned panes in the dedicated `pi-herd` session (`herdr --session pi-herd pane list`,
     if its server is running). A pane is an orphan when no live agent is registered for it (a pi
     that hung before it registered, or a leftover shell), or when its agent's parent isn't live (the
     parent check failed, for example because the subagent hung).
  - **Nothing still starting is closed.** A pane counts as an orphan only if it is one on two checks
    a minute apart, so an agent that is just registering survives.
  - **Idle children of a live parent are never closed,** because the parent may message them again.
  - **Only the dedicated session is touched.** `tab` agents and given panes are in the user's own
    session, in plain view.

## 10. UI and other extensions

The only link to other extensions is the event bus.

- **`herd:update`** is emitted on every change:

  ```ts
  { agents: { id, name, state, since, cwd, child, watched }[], // this session's children and watched agents
    watching: number, // watches running
    waiting: number } // watches running while this agent is idle, else 0
  ```

  `state` is herdr's status for the agent. pi-herd already follows its children's and watched
  agents' status through herdr events (section 6), so it has it at no extra cost.

- **pi-herd listens for** `herd:attach { id }` (opens the attach popup, section 11) and
  `herd:kill { id }` (the same as `agent_kill`, children only).
- **`/agents`**: lists the agents. Choosing one attaches to it in the repo's popup (section 11).
  Inside the popup, the subagent shows how to close it and offers `/detach` (section 11).
  Detaching closes the popup and leaves the agent running.
- **Phase 2, in other extensions.** Both read `herd:update` next to pi-bash-bg's `bash-bg:update`.
  - **pi-working**: one label in the prompt box's border while the agent is idle and waiting:
    - `Waiting on 3 agents and 2 background jobs (1m 12s)`
    - only the non-zero parts are shown: `Waiting on 3 agents (40s)`, `Waiting on 1 background
job (2m)`
    - singular for one: `1 agent`, `1 background job`
    - the time counts from when the first wait began
  - **pi-footer**, mirroring its jobs piece and `jobs` tab:
    - **Footer line:** `󰫣 3` (md-star_four_points_outline, the number of watches running) sits
      before the jobs count `󰦖 2`, so agents come first. Like the jobs count, it is never dropped on
      narrow terminals. A click on it opens the dashboard at the `agents` tab, and so does ↓ while
      watches run.
    - **`agents` tab:** present while this session has children or watches, placed before the
      `jobs` tab, with an `agents` line in the overview.
      - It lists watched agents first, then the other children, then the rest. Within each group,
        `working` comes before `blocked`, then `idle`.
      - Each row reads `󰫣 reviewer · working 2m · ~/code/app · watched`.
      - It shows 3 rows at a time and scrolls with the selection (`3/12` when there are more), like
        the jobs tab.
      - Keys, with the keys on the dashboard: ↑/↓ select, Enter attaches (`herd:attach`), and `x`
        twice kills (`herd:kill`, children only). A click selects a row, and a click on the selected
        row attaches.
      - The selection follows its agent across updates while the tab is open.

## 11. Attach: the repo's popup plugin

herdr opens a floating window (a popup) only from a plugin pane. The repo's shared herdr plugin
(`herdr/plugin/`, id `pi-hkandala`) has an `attach` popup pane that runs whatever shell command the
caller passes in `POPUP_COMMAND`. herdr's popup has no close button and ignores clicks outside it, so
the pane's border title says how to close it: `ctrl+b q to close`.

- **Attach.** `/agents` runs:

  ```bash
  herdr plugin pane open --plugin pi-hkandala --entrypoint attach \
    --env POPUP_COMMAND="trap 'rm -f <marker>' EXIT; echo \$\$ > <marker>; HERDR_SOCKET_PATH=<agent socket> herdr agent attach <agent pane> --takeover"
  ```

  `<marker>` is `~/.pi/agent/pi-herd/attached/<agent id>`.

  - The popup opens over the caller's herdr session, even when the agent lives in the dedicated
    session. herdr sets its own `HERDR_*` variables in the popup, which is why the command sets
    `HERDR_SOCKET_PATH`.
  - The popup takes all keyboard input and closes when the attach detaches (`ctrl+b q`).
  - If another popup, Settings or copy mode is up, herdr returns `ui_busy`, and `/agents` shows that
    error as it is.

- **Install.** The user installs the plugin once (`herdr plugin install hkandala/pi-hkandala/herdr/plugin`,
  or `herdr plugin link` from a checkout). The npm package doesn't ship it, and pi-herd never
  installs it. If the plugin is missing, `/agents` shows the install command and the plain attach
  command (`herdr --session pi-herd agent attach <pane>`) to run in a terminal.
- **Measured** on herdr 0.9.3: the popup ran the passed command, attached to a pane in another
  session, closed when its command exited and on `popup.close`, and a second open returned `ui_busy`.
  Inside the popup, `ctrl+b q` detaches: the popup closes and the agent keeps running.

### In a popup: the subagent knows it's being viewed

herdr doesn't say which clients are attached to a pane. But pi-herd writes the popup's command, so
the command leaves a marker for the subagent, and removes it again:

1. **Marker.** The popup's shell writes its own pid to `attached/<agent id>`, then runs
   `herdr agent attach` as its child. Its `trap … EXIT` deletes the file when the attach ends, however
   it ends. The write is a shell builtin: about 1 ms, inside a shell that starts anyway (~17 ms). There
   is no visible delay.
2. **Detection.** The subagent's pi-herd sees the file appear and disappear through `fs.watch` on
   `attached/`. It is **in a popup** while its file exists and `kill(pid, 0)` succeeds. A file left
   by a shell that was SIGKILLed fails that check and is deleted. The popup never waits for this;
   the hint may appear a moment after the agent's screen.
3. **While in a popup**, the subagent shows and enables:
   - a status line, `in popup · ctrl+b q or /detach to close` (pi-footer shows extension statuses)
   - `/detach`, and a hotkey (config `detachKey`, default `ctrl+shift+q`). Both run
     `pkill -TERM -P <pid>`, which ends the attach client. The shell's trap removes the marker, the
     popup closes, and the agent keeps running (measured).
4. **Why end the attach client** rather than send `popup.close`: it closes exactly this popup. If
   the user has opened a different popup since, `/detach` can't close that one. It also doesn't need
   the caller's herdr socket.

Only popups opened by pi-herd leave a marker. A manual `herdr agent attach` in a terminal gets no
hint, and `tab` agents are focused, not attached, so they don't need one. To verify during the
build: the hotkey reaches pi through the attach, as other `ctrl+shift` hotkeys do inside herdr.

## 12. The shared herdr patch

herdr's pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`) is where pi-herd's status
comes from (section 3). The repo keeps one patch for every extension, in `herdr/patch/<herdr
version>/` at the repo root, with its test in `herdr/patch/test.mts`.

| patch change                                                                     | why                                                                                                                                                                                                                                                   | state              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Count `herdr:working { source, active }` from any source as `working`            | pending work keeps the pane at `working`: background jobs (pi-bash-bg) **and** watches on other agents (pi-herd). herdr doesn't play "done" too early, and a watch doesn't end while its target still waits.                                          | in place           |
| On `session_compact` and `session_compact_failed`, publish again when `isIdle()` | herdr skips an `agent_settled` that arrives while compaction still runs, and then stays `working` until the next run. A subagent that finishes a long task often compacts right then, and without this change its watcher would wait for the timeout. | added with pi-herd |

Notes:

- **pi-herd works without the patch**, with coarser status (section 3).
- **herdr overwrites the file** whenever it reinstalls or updates the integration, so the patch has
  to be reapplied. Both changes are worth sending upstream, together with two integration bugs the
  patch doesn't fix:
  - a state report can be lost to a session report
  - failed sends are never retried

## 13. Config: `~/.pi/agent/extensions/pi-herd.json`

The file is optional, and every key has a default.

```json
{
  "placement": "hidden",
  "model": null,
  "thinking": null,
  "args": [],
  "watchTimeoutMinutes": 30,
  "transcriptMessages": 20,
  "captureLines": 100,
  "detachKey": "ctrl+shift+q"
}
```

| key                   | default          | meaning                                                                                      |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `placement`           | `"hidden"`       | the default for `agent_spawn`'s `placement`: `hidden` (the dedicated herdr session) or `tab` |
| `model`, `thinking`   | `null`           | defaults for spawned agents. `null` means inherit from the caller.                           |
| `args`                | `[]`             | extra pi flags for spawned agents, appended last (for example, flags a launcher needs)       |
| `watchTimeoutMinutes` | `30`             | the default watch timeout. `0` means none.                                                   |
| `transcriptMessages`  | `20`             | entries in a transcript (`agent_status` with `transcript`, and timeout endings)              |
| `captureLines`        | `100`            | lines in the screen-capture fallback, used when an agent has no session file                 |
| `detachKey`           | `"ctrl+shift+q"` | in a subagent shown in a popup: closes the popup, like `/detach` (section 11)                |

These are constants: the session name `pi-herd`, the 16 KB transcript and capture caps, the 1 KB
cap per transcript entry, the 4 KB last-text cap, the 32 KB message cap, and the 30 s spawn wait.

## 14. Edge cases

| #   | Case                                                                                               | Behavior                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Message to an agent that isn't live                                                                | Error. Nothing is written.                                                                                                                                                                                                                                                                                             |
| 2   | Message to yourself                                                                                | Error.                                                                                                                                                                                                                                                                                                                 |
| 3   | A name matches several live agents                                                                 | Error that lists them with their ids.                                                                                                                                                                                                                                                                                  |
| 4   | Agents spawned together share an id prefix                                                         | Ids are shown and matched by their last 8 characters (the random part).                                                                                                                                                                                                                                                |
| 5   | The recipient is working                                                                           | Steer, delivered at its next tool call. The watch ends when it stops working.                                                                                                                                                                                                                                          |
| 6   | The recipient is idle when the message is sent                                                     | The watch first waits for it to start working, then for it to stop.                                                                                                                                                                                                                                                    |
| 7   | The recipient is working, and its turn ends in the few milliseconds before it takes the message in | The watch ends `idle` early. The recipient then works on the message, and anything it sends back arrives as a normal message. Rare, and accepted.                                                                                                                                                                      |
| 8   | Esc aborts the recipient's run while the steer is queued                                           | The recipient stops working, so the watch ends `idle`. The message runs with its next turn.                                                                                                                                                                                                                            |
| 9   | The recipient waits on its own background jobs                                                     | `working` (with the patch), so the watch keeps going until those finish and the woken turn ends.                                                                                                                                                                                                                       |
| 10  | The recipient waits on agents it watches                                                           | `working` (with the patch), so the watch keeps going until those end too.                                                                                                                                                                                                                                              |
| 11  | A and B watch each other                                                                           | Both stay `working` until their timeouts. The defaults prevent it: messages watch only your children, and replies never watch.                                                                                                                                                                                         |
| 12  | The recipient is blocked                                                                           | The watch ends `blocked`. If it was blocked before the message, it ends at once.                                                                                                                                                                                                                                       |
| 13  | The recipient reloads                                                                              | Messages wait in its folder, and the new runtime takes in anything not yet queued.                                                                                                                                                                                                                                     |
| 14  | Several messages or endings arrive at once                                                         | Batched into one steer.                                                                                                                                                                                                                                                                                                |
| 15  | The recipient sends a progress message, then keeps working                                         | The watch ends on the message. The watcher can `agent_watch` again to wait for the end.                                                                                                                                                                                                                                |
| 16  | The recipient never sends anything                                                                 | The `idle` ending carries its last text.                                                                                                                                                                                                                                                                               |
| 17  | The recipient never finishes (a loop, an unseen dialog, a hung tool)                               | The watch ends with `timeout` after 30 min by default, with the status and transcript. The recipient keeps running until someone kills it.                                                                                                                                                                             |
| 18  | The recipient replies and exits at once                                                            | The inbox is scanned before `exited`, so the reply still ends the watch as `message`.                                                                                                                                                                                                                                  |
| 19  | The recipient crashes or is killed                                                                 | herdr reports the pane closed or the agent gone, and the watch ends `exited`.                                                                                                                                                                                                                                          |
| 20  | The parent dies (exit, crash, SIGKILL)                                                             | Its spawned agents stop themselves: at once after a clean exit, within about 2 s after a crash. Panes pi-herd created close with them; given panes go back to their shell.                                                                                                                                             |
| 21  | The watcher does `/new`                                                                            | Its watches are dropped. The new session is a new agent.                                                                                                                                                                                                                                                               |
| 22  | A crash leaves a record, and the pid is reused                                                     | A false positive: it looks live. It needs both a crash, since every clean exit deletes the record, and a reused pid. Messages to it are never taken in, and a watch on it ends only by timeout. **Accepted for v1.** The upgrade, if it ever bites, is to compare the stored start time with `ps -o lstart= -p <pid>`. |
| 23  | Two processes open one session                                                                     | The second doesn't register (fails closed).                                                                                                                                                                                                                                                                            |
| 24  | A `/new` inside a subagent pane                                                                    | New id, same parent. The old id is gone, so the watcher gets `exited`.                                                                                                                                                                                                                                                 |
| 25  | The spawned pi never registers (a trust dialog, or pi-herd not loaded)                             | `agent_spawn` fails after 30 s with the screen capture. A pane pi-herd created is closed; in a given pane, the pi is stopped and the pane kept.                                                                                                                                                                        |
| 26  | Parallel `agent_spawn` calls                                                                       | They run one at a time (sequential execution).                                                                                                                                                                                                                                                                         |
| 27  | Two parents spawn into the same cwd at once                                                        | They may create two workspaces for that cwd. Harmless; each disappears with its last tab.                                                                                                                                                                                                                              |
| 28  | `placement` is a pane that is busy (an agent, or a command running)                                | `agent_spawn` fails before typing anything.                                                                                                                                                                                                                                                                            |
| 29  | `placement` is a pane in another herdr session, or unknown                                         | `agent_spawn` fails: a given pane must be in the caller's herdr session.                                                                                                                                                                                                                                               |
| 30  | A subagent in a given pane exits, or is stopped                                                    | The pane goes back to its shell and stays open.                                                                                                                                                                                                                                                                        |
| 31  | `agent_kill` on an agent that doesn't exit on `SIGTERM`                                            | After 5 s, pi-herd closes the pane it created, or sends `SIGKILL` in a given pane.                                                                                                                                                                                                                                     |
| 32  | The daily cleanup runs while an agent is still starting                                            | The agent isn't closed: a pane must be an orphan on two checks a minute apart.                                                                                                                                                                                                                                         |
| 33  | Several pi sessions start at once after a day                                                      | The stamp file is written before the cleanup runs, so usually one runs it. If two do, closing a pane twice is harmless.                                                                                                                                                                                                |
| 34  | A turn settles during compaction                                                                   | herdr stays `working` until the patch's compaction change is applied. Without it, the watch ends by timeout.                                                                                                                                                                                                           |
| 35  | The shared herdr patch isn't applied                                                               | pi-herd works, with coarser status (section 3).                                                                                                                                                                                                                                                                        |
| 36  | The agent has no session file (`--no-session`)                                                     | Transcripts fall back to herdr's screen capture.                                                                                                                                                                                                                                                                       |
| 37  | Text over 32 KB                                                                                    | Refused: write a file and send the path.                                                                                                                                                                                                                                                                               |
| 38  | pi runs outside herdr, or in a non-TUI mode                                                        | pi-herd is inert: no tools, no record. Such sessions can't be messaged or watched.                                                                                                                                                                                                                                     |
| 39  | Trust                                                                                              | Only pi-herd writes `messages/`, and the folder is the user's own. "Not from the user" is a label for the model, not a security boundary.                                                                                                                                                                              |
| 40  | The popup plugin isn't installed                                                                   | `/agents` shows the install command and the plain attach command. Spawning, messages and watches don't need the plugin.                                                                                                                                                                                                |
| 41  | A popup is already open, or herdr is in a modal                                                    | `/agents` reports `ui_busy`, and nothing opens.                                                                                                                                                                                                                                                                        |
| 42  | `fs.watch` fails (for example, the folder is on a network drive)                                   | pi-herd shows one warning. Messages to that agent wait until its next `session_start` scan.                                                                                                                                                                                                                            |

**To verify during the build:**

- whether pi exposes the caller's trust decision (section 7).
- whether `herdr agent attach` accepts a pane id.
- the hotkey reaches pi through the attach (section 11).

## 15. Prior art

| Extension                          | Similar                                                                                                                                  | Different                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| pi-intercom (nicobailon, ~10k LOC) | 1:1 messages between any pi sessions; reply hints; opens a herdr pane and waits for registration before sending                          | A broker process over IPC; `ask` **blocks** up to 10 min; no watch on a peer's turn |
| pi-shepherdr                       | a per-session inbox; attribution header on each message; delivery by steer or waking an idle turn; reads the pi session file for replies | a unix socket per session; pi only                                                  |
| pi-herdsman                        | a file mailbox with request and reply                                                                                                    | parent-child only; one-shot agents; ~25k LOC                                        |
| pi-bellwether                      | watches on herdr agent state that wake the caller                                                                                        | screen-based state; no messaging of its own (it relies on pi-intercom)              |

None of them combines file-only messaging with herdr-driven watches that count pending work as
working and end with the agent's last text or transcript. That is what pi-herd adds.

## 16. Size and scope

- About 600–800 lines in `index.ts`: registry, messages, watches, transcripts, spawn, tools,
  renderer, `/agents`. The popup plugin and the herdr patch live in the repo's `herdr/` folder.
- No dependencies. It requires herdr 0.9 or newer and runs only inside a herdr pane.

Out of scope for v1:

- other agent kinds (Claude, Codex, opencode; see orchestratr)
- messages across machines
- attachments (send paths instead)
- blocking waits
- cancel and supersede
- nested spawning
- read receipts
- pi-footer and pi-working integration (phase 2)
