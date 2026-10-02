# pi-herd spec

Every pi session running inside herdr registers itself as an **agent** in a shared folder. Any agent
can list the others, check their status, message them, and watch them until they stop working. A
message lands in the receiving session as a steer that wakes the agent if it is idle. An agent can
start other agents in herdr panes and message them.

The design in brief:

- **Registry.** Each agent is a file in `~/.pi/agent/pi-herd/agents/`. Liveness is `kill(pid, 0)`.
- **Messages.** One file per message, in the recipient's folder. Delivered as a steer with
  `triggerTurn`: "you'll be notified; don't poll".
- **Status comes only from herdr.** herdr's pi integration reports `working`, `idle`, `blocked` and
  `done` from pi's own events. The repo's herdr patch makes pending work count as `working`: running
  background jobs, and waits on other agents. pi-herd computes no state of its own.
- **Transcripts, not screens.** Every agent is pi, so pi-herd reads another agent's pi session file
  to show what it has been doing. herdr's screen capture is only the fallback.
- **No broker, no locks, no polling of the files.** Files are written atomically and watched with `fs.watch`,
  herdr events report status changes, and state survives `/reload` on `globalThis`.

Tools: `agent_start`, `agent_send`, `agent_watch`, `agent_list`, `agent_read`, `agent_stop`.
v1 supports pi only.

**herdr only.** pi-herd does nothing unless pi runs inside a herdr pane:

- **The gate.** The extension's factory returns right away unless `HERDR_ENV=1`, `HERDR_PANE_ID`
  and `HERDR_SOCKET_PATH` are set. Without them it registers no tools, writes no record, starts no watchers, and doesn't
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

| File                           | Written by                                                                                                                                  | Contents                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agents/<id>.json`             | the agent, on `session_start` (atomic write: temp file + rename), again when its name or cost changes, and when the session ends (`ended`). | the agent record                                                                                      |
| `messages/<toId>/<msgId>.json` | the sender, once. The temp file is `.<msgId>.tmp`, then renamed.                                                                            | one message. It is never moved or changed, so it can always be read back.                             |
| `attached/<pid>`               | the attach popup's shell (named by its pid), removed by the same shell when the popup closes (section 11)                                   | the agent the popup shows: its id, socket, pane and name, then the agent that opened it, one per line |
| `stopped/<id>`                 | whoever stops the agent (`agent_stop`), or the agent itself when it ends with the agent that started it; removed when it resumes            | the time; lists show the ended agent as `stopped`, not `exited`                                       |

**Ids.** `<id>` is the pi session id.

- **Shown and matched by the last 8 characters.** pi's ids are UUIDv7: the leading characters are a
  timestamp, and they are the same for agents spawned together. Every tool also accepts a full id,
  or a name.
- **Message ids** are `<epochMs>-<4 base36 chars>`, so a folder's files sort by send time.

**Agent record.** Its identity, its own cost (what the agents above it add up), and once it ended, when:

```json
{ "id": "01a0e7…", "name": "auth-reviewer", "pid": 4242, "cwd": "/repo", "startedAt": 1790…,
  "parent": "01a0e6…",
  "herdr": { "socket": "/Users/me/.config/herdr/sessions/pi-herd/herdr.sock", "pane": "w1:p2" },
  "session": "/Users/me/.pi/agent/sessions/--repo--/2026-09-30T…_01a0e7….jsonl" }
```

| field     | meaning                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | pi's session name, from `--name` or `/name`. Optional. Updated on `session_info_changed`.                                                                          |
| `parent`  | set when `agent_start` started this agent (from `PI_HERD_PARENT`)                                                                                                  |
| `herdr`   | from the agent's own `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. Every herdr command aimed at this agent goes to that socket: status, events, capture, attach, close. |
| `cost`    | its own session's cost in $ (not its agents'), written after each turn                                                                                             |
| `ended`   | when its session ended. The record stays (7 days): lists show it as ended, and the agents above it keep counting its cost. Live also needs no `ended`.             |
| `session` | the pi session file (`ctx.sessionManager.getSessionFile()`). Absent with `--no-session`. Other agents read it for transcripts (section 8).                         |

**Liveness and cleanup:**

- **Live** means the record exists, has no `ended`, and `kill(pid, 0)` succeeds (EPERM counts as alive). There is no
  heartbeat.
- **Readers only ignore dead records.** Deleting a record is left to the daily cleanup (section 9).
  It re-reads the record and checks the pid again just before `unlink`, so it can't delete a record
  that a restarted session just wrote.
- **Two processes on one session file.** If `agents/<id>.json` already belongs to a different live
  pid, this process does not register. It shows one warning, and pi-herd is off in that process. It
  fails closed rather than splitting one agent into two.

## 2. Identity

- **The id is the identity.**
- **The name is optional in the record.** A created agent gets its name from `agent_start`
  (passed to pi as `--name`). A root session has one only if the user named it.
- **Every agent still shows a name.** Without one, it is two words derived from the session id:
  two nouns from [friendly-words](https://github.com/glitchdotcom/friendly-words) (1.2.1, pinned:
  later versions pull in a web server), picked by the first 8 bytes of the id's SHA-256, joined with
  a hyphen (`frog-thunder`). It is the same every time for that session, so it is never stored;
  it is worked out wherever a name shows (lists, the footer tab, messages, tab labels) and tools
  accept it as an address. A later `--name` or `/name` wins.
- **Names as addresses.** Tools also accept a name. If more than one live agent matches, the call
  fails and lists them with their ids.
- **Created names must be unique** among live agents' names. Otherwise `agent_start` fails, so the caller
  picks another name.
- **Session switches.** `/new`, `/resume` and `/fork` end one agent and start another: the old
  record is marked ended (it stays 7 days) and the new id registers. `PI_HERD_PARENT` stays in the env, so a spawned agent
  keeps its parent.

## 3. Status

An agent's status is herdr's status for its pane, read on the agent's socket (`pane.get`,
and `pane.agent_status_changed` events). pi-herd adds no status logic.

| herdr status                         | meaning for pi-herd                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `working`                            | a turn is running, **or**, with the shared patch (section 12), pending work that will wake the agent: running background jobs, or watches on other agents |
| `idle` / `done`                      | nothing is running and nothing pending (`done` is idle that the user hasn't looked at)                                                                    |
| `blocked`                            | reported by an extension through `herdr:blocked`                                                                                                          |
| the pane is gone, or the agent's pid | the agent has exited                                                                                                                                      |

- **Without the patch**, `working` covers only a running turn, so a watch ends as soon as the
  recipient's turn settles, even when it still waits on its jobs. Everything else works the same.
- **pi's own dialogs** (an extension's confirm or select) aren't reported as `blocked`. That is
  herdr's behavior, and pi-herd leaves it alone.

## 4. Messages

**Format** (`messages/<toId>/<msgId>.json`):

```json
{ "id": "1790…-a1b2", "from": { "id": "…", "name": "main" }, "text": "…",
  "replyTo": null, "needsReply": true, "delivery": "steer", "sentAt": 1790… }
```

- **The `message` param** of `agent_send` and `agent_start` is an object:
  `{ text, needsReply?, delivery? }`.
- **`needsReply`** says the sender wants an answer. It defaults to `false` for `agent_send` and
  `true` for `agent_start` (a new task almost always wants one).
  - `true`: the sender watches the recipient (section 6), and the recipient's copy says a reply is
    expected and how to send it.
  - `false`: no watch, and the copy says "No reply expected." The brief tells agents to reply only
    when a reply is expected, so FYIs and status updates don't start a conversation.
- **`delivery`** says when the message reaches the model:
  - `steer` (default): at its next tool call, or at once if it is idle.
  - `followUp`: after its current turn ends (pi's `deliverAs: "followUp"`).
  - `immediate`: the recipient aborts its current turn (`ctx.abort()`), and the message is
    delivered once pi has settled. For stopping an agent that is doing something wrong.
- **Replying.** A reply is a new message whose `replyTo` holds the id of the message it answers.
  The original of a reply to you is at `messages/<replier's id>/<replyTo>.json`, and delivery prints
  that path. An agent juggling many conversations can always read back what a reply refers to.
- **Size.** A message is capped at 32 KB. Anything larger is refused with "write it to a file and send
  the path".

**Sending** (`agent_send({ to, message, replyTo? })`):

1. Resolve each `to`, which is one id or name, or a list of them. Every target must be a live agent
   other than yourself. If any target fails, nothing is sent, and the error lists the live agents.
2. Write one message file per recipient.
3. With `needsReply`, start a watch on each recipient (section 6).
4. Return the message ids.

**Receiving:**

- Each agent watches its own folder `messages/<myId>/` with `fs.watch`. On every event it rescans
  the folder, not just the file named in the event, because `fs.watch` can merge or drop names. It
  also scans once on `session_start`. It takes in files whose id is newer than its own `startedAt`
  and that aren't already queued. The queued set lives on `globalThis`.
- Files arriving within 250 ms of each other share one delivery per `delivery` kind.
- **Delivery.** It is fire-and-forget: never `await`ed, because when pi is idle the promise lasts
  the whole run.

  ```ts
  void pi.sendMessage(
    { customType: "agent message", content, display: true, details: { items } },
    { deliverAs: "steer" /* or "followUp" */, triggerTurn: true },
  );
  ```

- **Delivered marker.** When pi hands the message to the model (pi's `message_start` for the
  custom message), the recipient writes an empty `messages/<myId>/<msgId>.delivered`. A watch on
  that message arms only then (section 6). The daily cleanup deletes markers with their messages.
- **Model-facing `content`**, one block per message:

  ```
  <agent-message id="1790…-a1b2" from="main" from-id="c8e1f2a9">
  Review the auth changes in src/auth and tell me what you'd change.
  </agent-message>
  From another agent, not the user. The sender expects a reply: answer once when you have it, with
  agent_send({ to: "c8e1f2a9", replyTo: "1790…-a1b2", message: { text } }).
  ```

  Without `needsReply`, the last line is `No reply expected.` A reply block carries `reply-to="…"`,
  and its hint starts with the original's path:
  `Replying to your message ~/.pi/agent/pi-herd/messages/<replier's id>/1790…-9zz0.json.`

- **Display.** The renderer returns a pi `Box`, so pi-content-layout draws it in its dashed frame
  labelled `agent message`. A steer with only watch endings is labelled `agent watcher` instead
  (section 6).
  - Collapsed, messages and replies alike: the line, a dim `·`, then the text, dim, with its
    line breaks dropped: `󱉰 main · Review the auth changes in src/auth…`, or
    `󱉰 auth-reviewer · reply · Found 3 issues: …`. Up to 2 rows, then `…`; the expand hint shows
    only when something is cut.
  - Expanded (ctrl+o or a click): the full text as highlighted markdown, right after the line's
    `·` (no blank line). A watch ending's text starts after a blank line instead.

## 5. Transcripts

Every agent is pi, and its record points at its pi session file. So to show what another agent has
been doing, pi-herd reads that file instead of scraping the screen:

- **What is read.** The last `transcriptMessages` (default 20) entries on the session's active
  branch. pi-herd starts at the last line and follows `parentId`, so abandoned branches are skipped.
- **Format.** One compact block per entry:
  - `user:`, or a custom message's type (`agent message:`, `agent watcher:`, …; the sender is in
    its `<agent-message from=…>` text), and the text
  - `assistant:` and the text, plus the tool calls it made (`→ bash npm test`, `→ edit src/a.ts`)
  - `tool result:` the tool name, ok or error, and the first line of output
- **Caps.** Each entry is capped at 1 KB, and the whole transcript at 16 KB.
- **Last text.** The last assistant text is read the same way, capped at 4 KB. A watch ending
  carries it (section 6).
- **Fallback.** When there is no session file (`--no-session`), pi-herd uses herdr's screen capture
  instead: `herdr pane read <pane> --source recent-unwrapped --lines <captureLines>`, capped at
  16 KB.

`agent_read` with `screen: true` adds that capture for any agent, so the model never needs herdr's
CLI.

## 6. Watches

A watch belongs to the watching agent. It asks: "wake me when agent X stops working."

- **How it follows X.** One herdr event subscription per watched pane, on X's socket
  (`events.subscribe` for `pane.agent_status_changed`, `pane.closed` and `pane.exited`), plus one
  `pane.get` when the watch starts. On disconnect it reconnects and reads the status again.
  There is no polling.
- **Starting.**
  - `agent_start` and `agent_send` start a watch right after sending, when `needsReply` is
    set (section 4).
  - `agent_watch({ to })` starts one on its own. If X isn't `working` at that moment, it starts no
    watch and returns X's status and last text.
  - There is **one watch per target**. A second call keeps it and restarts its deadline; a new
    message makes it wait for that message's delivery again.
- **Ending.** A watch ends with the first of these. The ending is delivered as a steer with
  `triggerTurn`, and endings within 250 ms of each other share one steer.

  | event     | when                                                                                                                                           | carries                                                                                                                         |
  | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
  | `message` | any message from X arrives, reply or not                                                                                                       | the message itself, in the same steer                                                                                           |
  | `idle`    | X leaves `working` for `idle` or `done`, after the watch is armed                                                                              | X's last text (4 KB) and how long it worked; the error if its last turn failed; its last 5 transcript entries if it has no text |
  | `blocked` | X is `blocked`                                                                                                                                 | what X's pane shows (the dialog)                                                                                                |
  | `exited`  | X's pane closes, or no pi runs in it anymore. The inbox is scanned once first, so a final message still in flight ends the watch as `message`. | X's last text                                                                                                                   |
  | `timeout` | the deadline passes first                                                                                                                      | X's status and its transcript (section 5). X keeps running.                                                                     |

- **Arming: waiting for delivery.** A watch on a message must not end on the turn X was already
  in: with `followUp`, X finishes that turn first; with `immediate`, the abort makes X idle for a
  moment. So a message watch arms only once X's delivered marker for that message exists (section
  4), and then ends on the next change away from `working`.
  - If X's turn is already over when the marker is seen (a quick answer), herdr says idle; pi-herd
    checks again a second later, and if X is still idle the watch ends `idle`.
  - A plain `agent_watch` is armed from the start (X is working).
  - An X that is `blocked` ends the watch at once with `blocked`.
- **Timeout.**
  - `agent_watch` takes `timeout` in minutes. `agent_start` and `agent_send` use config
    `watchTimeoutMinutes` (default 30). `0` means no timeout.
  - The deadline is absolute and lives on `globalThis`, so a `/reload` doesn't restart it.
  - A laptop sleep can make several deadlines pass at once on wake. They end together, in one steer.
- **The watcher counts as `working`.** While the watcher has watches, pi-herd emits
  `herdr:working { source: "pi-herd", active: true }`, also during its own turn. With the shared
  patch, herdr keeps the watcher at `working` and doesn't play "done". Whoever watches the watcher
  waits too: an agent that starts its own agent and waits on it stays `working` for its parent.
  - During the turn too, because herdr's integration publishes idle when the turn settles, before
    pi-herd's `agent_settled` handler runs.
  - A watch whose ending is queued still counts until its steer is sent (endings are batched for
    250 ms), and after that `active` stays `true` until the woken run's `agent_start` (or 2 s). So
    herdr never sees a false idle that would end the parent's watch.
  - An ending still being gathered (its last text, say) when `agent_stop` drops the watch isn't
    sent.
- **Cycles.** Two agents watching each other would both stay `working` until their timeouts. The
  defaults avoid it: only `needsReply` watches, it defaults to false for `agent_send`, and replies
  use false. `needsReply: true` in both directions still waits for the timeout.
- **Lifetime.** Watches live on `globalThis`, so they survive `/reload`. They are dropped on any
  other `session_shutdown`, because a new session has no context for them.
- **Model-facing endings:**

  ```
  <agent-watch agent="auth-reviewer" id="4f2a91c0" event="idle" worked="3m12s">
  <last-text>Reviewed src/auth: 3 issues, details in /tmp/review.md.</last-text>
  </agent-watch>
  ```

  - A `message` ending is the `<agent-message>` block followed by `<agent-watch … event="message"/>`.
  - Inside an ending, as it carries them: `status:`, `<error>`, `<last-text>`, `<screen>`,
    `<transcript>`.

- **Display.** Endings without a message go in an `agent watcher` box (a message ending stays in
  the `agent message` box with its message), with circle glyphs for endings and
  md-inbox-arrow-down (`󱉰`) for anything received. Expanding shows what the ending carries, or a
  message's full text (section 4, Display):
  - `󰗡 auth-reviewer finished · 3m12s` (red, `· with an error`, when its last turn failed)
  - `󱉰 auth-reviewer replied · Found 3 issues: …`
  - `󰗖 auth-reviewer is blocked`
  - `󰗎 auth-reviewer still working after 30m`
  - `󰅚 auth-reviewer exited`

## 7. Starting or resuming an agent

`agent_start({ name?, session?, message?, model?, thinking?, cwd?, placement? })` is registered with
sequential execution, so parallel calls in one message don't race on the server, the workspace, or
the name check.

- **New:** `name` and `message` are both required.
- **Resume:** `session` is a saved session id (or its last characters), such as the one `agent_stop`
  prints. `name` and `message` are optional. pi-herd finds the file in its own sessions folder or
  pi's, fails if that session is live, and starts `pi --session <file>` in the session's saved cwd
  (unless `cwd` is passed). The session keeps its own name, model and thinking level unless the
  call names them. With a `message`, it is the resumed agent's next message; with none, the agent just
  starts, and nothing is sent or watched. It
  becomes a child of the caller.

1. **Pane.** `placement` picks where the agent runs. It defaults to config `placement`:
   - `hidden` (default): the dedicated herdr session `pi-herd`.
     - **Layout: one workspace per cwd, labelled with the cwd, and one tab per agent, labelled
       with its name.** The first agent in a cwd uses the new workspace's root pane; later agents
       get a new tab in it.
     - **No cleanup on exit.** When pi exits, its pane closes (`exec`, step 2). herdr then closes the
       tab, and removes the workspace when its last tab closes (measured on herdr 0.9.3).
     - If the session's server isn't running, pi-herd starts it itself
       (`herdr --session pi-herd server`, detached), then waits up to 5 s for its socket to answer.
       The server's env is cut to `HOME USER PATH SHELL TERM LANG TMPDIR`, so nothing from the
       parent pi (such as `PI_SESSION_FILE`) leaks into started agents. Each pane's login shell rebuilds
       the user's normal environment.
     - The server otherwise inherits whatever the parent pi process runs under. pi-herd adds no
       platform-specific handling. A launcher's own flags come with the start command (step 2);
       any other extra flags go in config `args`.
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
   - pi-herd talks to herdr's socket API directly (`pane.send_input` with the text and `enter`,
     which is what `herdr pane run` does), not through the CLI.
   - In a pane pi-herd created:
     `herdr pane run <pane> "exec pi [launcher flags…] --session-dir <sessions> [--session f] [--name <name>] [--approve] [--model m] [--thinking t] [args…]"`.
     `exec` makes pi the pane's process, so the pane closes when pi exits. No shell is left behind,
     and no stray `PI_HERD_PARENT` sits in one.
   - In a given pane: `herdr pane run <pane> "cd <cwd> && PI_HERD_PARENT=<my id> EDITOR=true … pi
--name <name> …"`, without `exec`. The env applies only to pi, and the shell is still there
     when pi exits. `cd` is added only when `cwd` is passed or a session is resumed.
   - herdr's `agent start` isn't used, because it waits on herdr's screen-based readiness.
   - **A launcher's flags.** A user may run pi through a launcher named `pi` on `PATH` that runs the
     real pi with its own args and doesn't pass its own flags on (for example
     `pi --dangerously-disable-osx-sandbox`, which runs `pi.real` unsandboxed). A plain `pi` would
     start the agent without them (sandboxed, say). So when this pi's parent process is named `pi`
     and runs another program than this pi (`ps -o comm=`; `process.execPath` can't tell, a
     compiled pi reports the launcher's path), the parent's args that aren't in this process's argv
     are the launcher's own flags, with their values. They go right after `pi`, quoted, before
     pi-herd's flags, in both start commands. No flag names are built in.
     - The parent's argv is read once: `/proc/<ppid>/cmdline` on Linux (exact), `ps -ww -o args=`
       elsewhere (joined with spaces, so split on them). This process's args are split on spaces
       too, so a prompt with spaces isn't taken for flags; a launcher flag's value with a space
       comes out split (pass that flag in `args` instead). A launcher token that this process also
       got (say, a flag value equal to one of pi's args) is dropped.
     - Agents started by an agent inherit them the same way: each one's pi runs under the
       launcher.
   - **`--session-dir ~/.pi/agent/pi-herd/sessions`** always (pi then keeps every session flat in
     that folder): started agents' sessions, also a `/new` in one, stay out of the user's
     `/resume` and `pi --resume` lists, which read pi's default folder. They are still saved, and
     a resume finds them there (`findSession` reads that folder and pi's default one).
   - **`--approve`** only when `cwd` is inside the caller's cwd (real paths: a symlink out of it
     doesn't count) **and** the caller's project is trusted (`ctx.isProjectTrusted()`). Otherwise pi's own trust rules apply, and a trust dialog
     makes the spawn fail at step 3, with the screen capture.
3. **Wait for registration.** Wait for a live record with `herdr.pane == <pane>` on that socket, for
   at most 30 s (`fs.watch` on `agents/`). That is real readiness: pi has started and every
   extension has loaded.
4. **Message.** Send `message` (section 4; `needsReply` defaults to `true` here), which starts a
   watch. The message goes through a file, so nothing is typed into the terminal.
5. **Result.** Its name and id, and "you'll be woken when it replies or stops working; don't
   poll".
6. **Failure.** If the agent doesn't register in time, or herdr fails, the error carries the screen
   capture. A pane pi-herd created is closed. In a given pane, pi-herd stops the pi it started and
   leaves the pane.

**Other rules:**

- **Model and thinking.** Use the config defaults. When unset, inherit the caller's current model
  and thinking level. The parameter descriptions name the effective defaults, and say to pass
  them only when the user names one.
- **The message is the caller's own words.** pi-herd adds no report contract and no paths.
  If the caller wants a file, it says so in the message. The last text covers the rest.
- **Nesting.** Every agent gets every tool, with the same rules: an agent started with
  `agent_start` can start agents of its own, to any depth. The records' `parent` links make the
  tree. Stopping cascades: an agent stops when the agent that
  started it ends, so a whole subtree goes with its root.

## 8. Tools

| Tool          | Params                                                                            | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start` | `name?, session?, message?, model?, thinking?, cwd?, placement?`                  | Section 7. `message` is `{ text, needsReply?, delivery? }` (section 4). `placement` is `hidden`, `tab`, or a herdr pane id.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `agent_send`  | `to` (id or name, or a list), `message, replyTo?`                                 | Section 4. Returns message ids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `agent_watch` | `to` (id or name, or a list), `timeout?`                                          | Section 6. Returns at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `agent_list`  | `scope?`: `children` (default), `cwd`, or `all`                                   | Live agents, newest first. `children` are the agents this session created, almost always what's wanted. `cwd` is agents whose cwd is this cwd or below it. `all` is every live agent, also other sessions' (rarely needed; the description says so). The first line is always this agent. With no children, it adds `No children; use scope "cwd" or "all".` Each line: `4f2a91c0  auth-reviewer  working 2m  /repo  child  watched`.                                                                                                                                |
| `agent_read`  | `ids` (ids or names), `transcript?` (default `true`), `screen?` (default `false`) | Reads what each agent has been doing: its status, parent, cwd and pane, then its transcript (section 5); with `transcript: false`, only its last text (up to 1 KB). `screen: true` adds what its pane shows now (`captureLines` lines), for an agent that seems stuck or blocked.                                                                                                                                                                                                                                                                                    |
| `agent_stop`  | `ids` or `"all"`                                                                  | Stops agents **this session created**, or that they created (any depth): `SIGTERM` to the agent's pid, so pi shuts down cleanly. A pane pi-herd created then closes with it (`exec`); a given pane goes back to its shell. If pi is still alive after 5 s, pi-herd sends `SIGKILL`. The agent's watch is dropped first, so its exit doesn't wake the caller. Prints each one's session id: `To resume it: agent_start({ session: "…" })`. `"all"` means every agent this session started; the agents they started stop with them. Other agents can only be messaged. |

Tool descriptions are one line each. The workflow is taught once, in the system prompt brief below.

### The system prompt brief

pi-herd adds a short brief to the system prompt, as `agent_send`'s `promptGuidelines`. pi
puts tool guidelines in its base prompt (the `<rules>` section, one bullet per line), which every
turn uses. The text never changes within a session, so the prompt cache stays warm. It holds no
live data (no agent list, no counts); the tools report those.

- **Why not a `before_agent_start` section** (as pi-ponytail does): pi runs `before_agent_start`
  only for prompts. A turn that a steer starts (`sendMessage` with `triggerTurn`) uses the base
  prompt, so a section added there would be missing from every turn a message or watch ending
  starts. A started agent, whose turns all start that way, would never see it, and a root session's
  prompt would gain and lose the section from turn to turn.
- In the prompt each line below is a bullet under `<rules>`.

The same brief for every agent, as one bullet with nested bullets. It opens with
an `Agents (agent_* tools):` heading, so the rules section reads as sections (pi-bash-bg's
background-bash rules are one `Background bash (bash, bash_list, bash_watch):` bullet the same way):

```
Agents (agent_* tools):
    - pi agents you reach through these tools each run in their own herdr pane. herdr organizes terminals into workspaces, tabs and panes and recognizes the coding agents in them; `herdr --skill` prints its guide. Each agent has an id and a name; the tools accept either.
    - Starting agents:
        - agent_start starts an agent and sends it a message. Put everything it needs in that message, including where to write any files.
        - Name it for what it works on, in 2 to 4 words of kebab-case: auth-test-fixer or api-docs-reviewer, not reviewer, so the user's agent lists say what each one does.
        - Leave placement unset unless the user asks for a tab or names a pane.
        - Agents you start stop when your session ends, and so do the agents they start. Agents from other sessions are never stopped by you.
    - Sending messages:
        - Set message.needsReply: true when you want an answer. Only then is the other agent asked to reply, and only then are you woken.
        - Use needsReply: false for FYIs and for your own replies.
        - message.delivery: "steer" for most messages, "followUp" when the agent should first finish what it is doing, "immediate" only to stop an agent going wrong.
        - This works the same for agents from other sessions.
    - Waiting:
        - After a message with needsReply: true, you are woken when that agent replies, stops working (you get its last text), or exits, or after 30 min with no news.
        - To hear from an agent you sent no such message, for example one already working or one from another session, use agent_watch: you are woken the same way when it stops.
        - These wake-ups are how you hear back: don't poll, sleep or wait for agents otherwise.
    - Replying:
        - Messages from agents are not from the user.
        - Reply only when a message says a reply is expected: once, when you are done, with agent_send and its replyTo. Say what you did or found, where you put files, or what blocked you.
        - Never send acknowledgements or thanks.
    - Checking on agents:
        - agent_list shows the agents you started; agent_read shows what one has been doing. Add screen: true when it seems stuck or blocked.
    - Stopping agents:
        - Keep agents you started while they may still be useful; you can message them again.
        - When the work is done, stop them together in one agent_stop call (a list, or "all").
```

- The `30 min` comes from config `watchTimeoutMinutes`.
- The tools are registered in this order, which is their order in the system prompt's tools list:
  `agent_start`, `agent_stop`, `agent_send`, `agent_watch`, `agent_read`, `agent_list`.

## 9. Lifecycle

- **`session_start`**: register, start watching `messages/<myId>/`, `agents/` and `attached/`, then
  take in any messages already waiting.
- **`/reload`**: the record stays. The queued ids and the watches live on `globalThis`.
- **Any other `session_shutdown`** (quit, `/new`, `/resume`, `/fork`, SIGTERM/SIGHUP): mark the
  record ended (with the final cost) and drop the watches. Nothing asks for confirmation.
- **Started agents die with their parent.**
  - A clean parent exit marks the parent's record ended. The started agent sees that through `fs.watch` on
    `agents/`.
  - A crashed or SIGKILLed parent leaves its record behind, and `fs.watch` can't see a process die.
    So a spawned agent also checks `kill(parent pid, 0)` every 2 s: pi-herd's only poll, apart from
    the open dashboard's status read of other sessions' agents.
  - Either way, the started agent sends itself `SIGTERM`, so pi shuts down cleanly. In a pane pi-herd
    created, the pane closes with it (`exec`), and herdr removes the tab and, if it was the last
    one, the workspace. A given pane goes back to its shell. The parent closes nothing itself.
- **Daily cleanup.** At most once a day, the first pi-herd session to start after the last run
  starts it in the background. A stamp file, `~/.pi/agent/pi-herd/.cleanup`, records when it last
  ran. It:
  1. deletes records of dead agents (ended ones after 7 days; checking the pid again just before
     `unlink`), messages older than 7 days, popup markers whose pid is gone, and stop markers of
     dead agents older than 7 days
  2. closes orphaned panes in the dedicated `pi-herd` session (`herdr --session pi-herd pane list`,
     if its server is running). A pane is an orphan when no live agent is registered for it (a pi
     that hung before it registered, or a leftover shell), or when its agent's parent isn't live (the
     parent check failed, for example because the started agent hung).
  - **Nothing still starting is closed.** A pane counts as an orphan only if it is one on two checks
    a minute apart, so an agent that is just registering survives.
  - **Idle children of a live parent are never closed,** because the parent may message them again.
  - **Only the dedicated session is touched.** `tab` agents and given panes are in the user's own
    session, in plain view.

## 10. UI and other extensions

The only link to other extensions is the event bus.

- **`herd:update`** is emitted on every change:

  ```ts
  { agents: { id, name, state, since, live, cwd, parent, mine, watched, sent, received }[],
    watching: number, // watches running
    waiting: number, // watches running while this agent is idle, else 0
    // the agents below this one (any depth, ended ones too): their own costs summed, and how many
    subagents: { cost: number, count: number },
    placeholder?: string } // while a popup shows this agent: "ctrl+b q or /detach to close"
  ```

  - `agents` are this session's children and the agents it has watched (with `agent_watch`, or a
    message with `needsReply`), and below them the agents they started, to any depth; grouped
    (working, then any other live status, then ended; in each group, by when the agent entered it:
    `byGroup`). Messages alone don't list an agent, so a started agent
    doesn't list its parent. `parent` makes the tree; `mine` says the agent is below this one in
    it (it can be stopped from here). `name` is always set (section 2); `sent` and `received`
    count messages with that agent, kept on `globalThis` (so across `/reload`, not a restart).
  - `state` is herdr's status while the agent is live (`working`, `blocked`, `idle`, or `done`: idle
    that the user hasn't looked at), `unknown` until herdr reports; once it ended, `stopped` or
    `exited`. pi-herd follows each listed agent's status through herdr events
    (section 6).
  - **Agents that ended stay listed** for the rest of the session, like finished jobs, with
    `live: false` and `state` `stopped` (it has a `stopped/<id>` marker: someone stopped it, or it
    ended with the agent that started it) or `exited` (it ended any other way); `since` is when it
    ended. The marker makes an agent several levels down read `stopped` for everyone above it. An agent resumed with `agent_start` is live
    again.

- **pi-herd listens for** `herd:attach { id }` (opens the attach popup, section 11) and
  `herd:stop { id }` (the same as `agent_stop`: any live agent below this one).
- **`/agents`** (`/agents list [children|cwd|all]`): prints the agents like `/background list`
  prints jobs: `appendEntry("pi-herd-list", …)` with a framed entry renderer (never sent to the
  model). `/agents stop <id|name …|all>` stops like `agent_stop`.
- **The agent dashboard**: ← on an empty prompt, or `/agents dashboard`. A full-screen page
  (`dashboard.ts`): a margin of 2 rows at the top, 1 at the bottom and 4 columns on each side, every row padded to the full width so nothing of pi's screen shows, no border. Inside:
  the bold title `agents`, a dim line of counts by status over every agent on the page (`2
working · 1 idle · 1 stopped`; only non-zero ones; ended agents counted even while hidden), a
  rule, the list, and the keys pinned to the bottom. Section titles start at the left edge; each
  agent's `◇` (`◆` when selected, in accent) sits in that column, before its name. ↑↓ wrap around.
  - **← counts only** when the prompt has the keys (pi's focused component is the editor, not a
    selector or dialog), its text is empty, no overlay is up, and no popup shows this agent.
    Otherwise ← is the editor's. pi-herd gets pi's TUI from its widget's factory, and adds its
    input listener after the other extensions' (pi-footer's tabs use ← while they have the keys).
  - Three sections: `current agent` (this one, on top and selected; Enter on it closes the page;
    its status is `working` while a run goes or it waits on agents, as herdr shows it, else
    `idle`), `your
agents` (`herd:update`'s agents as a tree, `├ └ │` by `parent`; ended ones once `e` shows
    them), and `other agents` (every other live agent, its status read every 2 s while the page is
    open). `󱖡` marks only an agent this one watches but didn't start.
  - **Order:** first-listed (the order pi-herd first listed them), ended ones last at every level
    of the tree; other agents by when they started, oldest first. Only an agent ending moves a row
    (to the end of its level). (`herd:update` sends the agents grouped instead, for pi-footer: working, then any
    other live status, then ended; in each group, by when the agent entered it, so a newcomer goes
    last. pi-herd keeps those times, `byGroup`.)
  - Keys: ↑↓ and PgUp/PgDn select, Enter opens a live agent in a popup (section 11), `x` twice
    stops a live agent below this one, `e` shows or hides the ended ones, Esc or `q` closes. In
    pi's fullscreen mode, a left click on an agent's row selects it and does what Enter does, and
    the mouse wheel moves the selection one agent per step, like ↑↓ but without wrapping around.
  - In a popup, ← does nothing special and `/agents dashboard` is refused: "Close the popup first
    (ctrl+b q or /detach)."
- **In other extensions.** Both read `herd:update` next to pi-bash-bg's `bash-bg:update`.
  - **pi-working**: one label in the prompt box's border while the agent is idle and waiting:
    - `Waiting on 3 agents and 2 background jobs (1m 12s)`
    - only the non-zero parts are shown: `Waiting on 3 agents (40s)`, `Waiting on 1 background
job (2m)`
    - singular for one: `1 agent`, `1 background job`
    - the time counts from when the first wait began
  - **pi-footer**, mirroring its jobs piece and `jobs` tab:
    - **Footer line:** `󰫣 3` (md-star_four_points_outline, the number of watches running) sits
      before the jobs count `󰦖 2`, so agents come first. Like the jobs count, it is never dropped on
      narrow terminals. A click on it opens the footer's dashboard at the `agents` tab, and so does
      ↓ while watches run.
    - **`agents` tab:** present once `herd:update` lists any agent, always the last tab.
      Its rows look like the jobs tab's. Its label counts the agents this session waits on
      (`agents 2`; no count when none), and the jobs tab's the running jobs (`jobs 1`).
      - **A flat list** of the live top-level agents (not under another listed agent), then, while
        `e` shows them, the ended top-level ones, in `herd:update`'s order: working first, then
        other live ones, then ended; in each group, by when the agent entered it.
      - Always 3 rows tall: with none running and ended ones hidden, the first row reads `no
running agents`, and the hint line at the bottom `e show ended (2)`.
      - Each row, in aligned columns (padded by display width): the name with its markers, status,
        folder, messages sent `󱉱` and received `󱉰` (blank when none), and the time last (it
        grows): `▸ frog-thunder 󱖡 󰅐  working  ~/code/lib  󱉱 1 󱉰 0  40s`
      - Markers after the name, dim: `󱖡` (md-handshake-outline) on an agent this session didn't
        start, `󰅐` (md-clock-outline) while this session waits on the agent.
      - Time: how long in this status, plain for every status (`40s`, `2m`, `1h`; ended ones too).
      - Colors: only `working` (accent) and `blocked` (warning) stand out. `idle` and
        `done` are dim, and the time is always dim.
      - 3 rows at a time; it scrolls with the selection (`3/12`).
      - Keys, with the keys on the dashboard: ↑/↓ select, Enter opens a live agent in a popup
        (`herd:attach`), `x` twice stops a live agent this session started (`herd:stop`), `e`
        shows or hides ended ones. A click selects a row, and a click on the selected row opens
        it. The hint reads `↑↓ select · enter view · x stop · e show ended (2)`, with only what
        applies.
      - The selection follows its agent across updates while the tab is open.
    - A live agent with live agents below it shows their count, dim, after its name:
      `auth-reviewer +2`.
    - **Name:** a named session shows its name at the right end of the prompt box's top border
      (pi-footer reads `pi.getSessionName()`, so it needs no pi-herd).
  - **pi-content-layout** shows an open `agent_start` or `agent_send` call's message text as
    highlighted markdown, and a closed one's `message` param by its flags only
    (`message · followUp · needsReply true`). It words tool groups by agents, not calls: `Started 2 agents, talked to 3
agents, checked agents, stopped 2 agents`. `agent_send` and `agent_watch` count as "talked
    to", `agent_read` and `agent_list` as "checked agents" (uncounted); counts come from `to` or
    `ids`, and for `agent_stop("all")` from its result's `details.stopped`.

## 11. Attach: the repo's popup plugin

herdr opens a floating window (a popup) only from a plugin pane. The repo's shared herdr plugin
(`herdr/plugin/`, id `pi-hkandala`) has an `attach` popup pane that runs whatever shell command the
caller passes in `POPUP_COMMAND`. herdr's popup has no close button and ignores clicks outside it.
How to close it is shown by the started agent inside, in or above its prompt (below), so the pane's border title
only names what it shows: `pi agent` (herdr requires a non-blank title).

- **Attach.** Viewing an agent (the dashboard's Enter, pi-footer's Enter) runs:

  ```bash
  herdr plugin pane open --plugin pi-hkandala --entrypoint attach \
    --env POPUP_COMMAND='M=~/.pi/agent/pi-herd/attached/$$; trap "rm -f $M" EXIT
      printf "%s\n" <agent id> <agent socket> <agent pane> <agent name> <opener id> > "$M"
      while { read -r ID; read -r S; read -r P; read -r N; } < "$M" && [ -n "$P" ]; do
        printf "\033[2J\033[H\n  \033[2mopening %s…\033[0m" "$N"; set -- $(stty size)
        { sleep 0.2; echo "{\"type\":\"terminal.release\"}"; } | HERDR_SOCKET_PATH="$S" \
          herdr terminal session control "$P" --takeover --rows "$1" --cols "$2" >/dev/null 2>&1
        HERDR_SOCKET_PATH="$S" herdr agent attach "$P" --takeover
        { read -r NEXT; } < "$M"; [ "$NEXT" != "$ID" ] || break
      done'
  ```

  The marker, `attached/<shell pid>`, names the agent the popup shows (its id, socket, pane and
  name), then the agent that opened the popup (the opener, whose pane is behind it). The loop reads
  only the first four lines.
  - **No resize flicker:** attaching resizes the agent's pane to the popup, and pi redraws at the
    new size on screen. So before each attach the shell sizes the pane itself with a short
    `terminal session control` (herdr keeps a size after the controller releases, measured on
    0.9.3), gives pi 200 ms to redraw behind the `opening <name>…` line, and then attaches at the
    same size.
  - **Switching:** an agent shown in a popup that views another agent (its dashboard's or
    pi-footer's Enter, say on an agent it started) doesn't open a second popup: it writes that
    agent into the marker and ends the current attach (`pkill -TERM -P <shell pid>`). The loop sees
    a new agent and attaches it, so the same popup now shows it. The new marker keeps the opener.
    Tested with a stub `herdr`.
  - **Viewing the opener closes the popup:** when the agent to view is the popup's opener, it is
    already on screen behind the popup. So instead of switching, the agent in the popup ends its
    attach with the marker unchanged, and the popup closes (S → T → view M still closes it). Every
    way of viewing goes through this (pi-footer's agents tab, say). A marker written by an older
    pi-herd has no 5th line: it never matches, and viewing switches as before.
  - Any other end of an attach (detach, `/detach`, the agent exits) leaves the marker as it was,
    so the loop ends and the popup closes.

  - The popup opens over the caller's herdr session, even when the agent lives in the dedicated
    session. herdr sets its own `HERDR_*` variables in the popup, which is why the command sets
    `HERDR_SOCKET_PATH`.
  - An agent in the dedicated session that isn't shown in a popup (a direct `herdr agent attach`
    in a terminal) refuses to view an agent: "This agent runs in herdr session pi-herd, where a
    popup wouldn't show: open <name> from your main herdr session." herdr shows a popup only to
    the session's own clients, never to a direct attach, so the popup would be invisible, its
    `--takeover` would take the agent's pane from wherever it shows, and it would keep the session
    `ui_busy` until that agent exits.
  - The popup takes all keyboard input and closes when the attach detaches (`ctrl+b q`).
  - If another popup, Settings or copy mode is up, herdr returns `ui_busy`, and viewing shows that
    error as it is.

- **Install.** The user installs the plugin once (`herdr plugin install hkandala/pi-hkandala/herdr/plugin`,
  or `herdr plugin link` from a checkout). The npm package doesn't ship it, and pi-herd never
  installs it. If the plugin is missing, viewing shows the install command and the plain attach
  command (`HERDR_SOCKET_PATH=<socket> herdr agent attach <pane>`) to run in a terminal.
- **Measured** on herdr 0.9.3: the popup ran the passed command, attached to a pane in another
  session, closed when its command exited and on `popup.close`, and a second open returned `ui_busy`.
  Inside the popup, `ctrl+b q` detaches: the popup closes and the agent keeps running.

### In a popup: the started agent knows it's being viewed

herdr doesn't say which clients are attached to a pane. But pi-herd writes the popup's command, so
the command leaves a marker for the started agent, and removes it again:

1. **Marker.** The popup's shell writes the agent it shows to `attached/<its pid>`, then runs
   `herdr agent attach` as its child. Its `trap … EXIT` deletes the file when the attach ends, however
   it ends. The write is a shell builtin: about 1 ms, inside a shell that starts anyway (~17 ms). There
   is no visible delay.
2. **Detection.** The started agent's pi-herd sees the file appear and disappear through `fs.watch` on
   `attached/`. It is **in a popup** while a marker names it and `kill(pid, 0)` succeeds for that
   marker's pid. A file left
   by a shell that was SIGKILLed fails that check and is deleted. The popup never waits for this;
   the hint may appear a moment after the agent's screen.
3. **While in a popup**, the started agent shows and enables:
   - `ctrl+b q or /detach to close`: with pi-footer's prompt box (it emits `footer:box`), as the
     prompt's dim placeholder (`herd:update`'s `placeholder`); otherwise in yellow, right-aligned
     just above the prompt (a widget)
   - `/detach`, and a hotkey (config `detachKey`, default `ctrl+shift+q`). Both run
     `pkill -TERM -P <pid>`, which ends the attach client. The shell's trap removes the marker, the
     popup closes, and the agent keeps running (measured).
4. **Why end the attach client** rather than send `popup.close`: it closes exactly this popup. If
   the user has opened a different popup since, `/detach` can't close that one. It also doesn't need
   the caller's herdr socket.

Only popups opened by pi-herd leave a marker. A manual `herdr agent attach` in a terminal gets no
hint. To verify during the
build: the hotkey reaches pi through the attach, as other `ctrl+shift` hotkeys do inside herdr.

## 12. The shared herdr patch

herdr's pi integration (`~/.pi/agent/extensions/herdr-agent-state.ts`) is where pi-herd's status
comes from (section 3). The repo keeps one patch for every extension, in `herdr/patch/<herdr
version>/` at the repo root, with its test in `herdr/patch/test.mts`.

| patch change                                                                     | why                                                                                                                                                                                                                                                        | state    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Count `herdr:working { source, active }` from any source as `working`            | pending work keeps the pane at `working`: background jobs (pi-bash-bg) **and** watches on other agents (pi-herd). herdr doesn't play "done" too early, and a watch doesn't end while its target still waits.                                               | in place |
| On `session_compact` and `session_compact_failed`, publish again when `isIdle()` | herdr skips an `agent_settled` that arrives while compaction still runs, and then stays `working` until the next run. A started agent that finishes a long task often compacts right then, and without this change its watcher would wait for the timeout. | in place |

Notes:

- **pi-herd works without the patch**, with coarser status (section 3).
- **herdr overwrites the file** whenever it reinstalls or updates the integration, so the patch has
  to be reapplied. Both changes are worth sending upstream, together with two integration bugs the
  patch doesn't fix:
  - a state report can be lost to a session report
  - failed sends are never retried

## 13. Config: `~/.pi/agent/extensions/pi-herd.json`

The file is optional, and every key has a default. A value of the wrong type is ignored (the
default applies).

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

| key                   | default          | meaning                                                                                                                             |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `placement`           | `"hidden"`       | the default for `agent_start`'s `placement`: `hidden` (the dedicated herdr session) or `tab`                                        |
| `model`, `thinking`   | `null`           | defaults for spawned agents. `null` means inherit from the caller.                                                                  |
| `args`                | `[]`             | extra pi flags for spawned agents, appended last (a launcher's own flags come without it: section 7)                                |
| `watchTimeoutMinutes` | `30`             | the default watch timeout. `0` means none.                                                                                          |
| `transcriptMessages`  | `20`             | entries in a transcript (`agent_read` with `transcript`, and timeout endings)                                                       |
| `captureLines`        | `100`            | lines of an agent's screen read: `agent_read` with `screen`, `blocked` endings, and the transcript of an agent with no session file |
| `detachKey`           | `"ctrl+shift+q"` | in an agent shown in a popup: closes the popup, like `/detach` (section 11)                                                         |

These are constants: the session name `pi-herd`, the 16 KB transcript and capture caps, the 1 KB
cap per transcript entry, the 4 KB last-text cap, the 32 KB message cap, and the 30 s spawn wait.

## 14. Edge cases

| #   | Case                                                                                               | Behavior                                                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Message to an agent that isn't live                                                                | Error. Nothing is written.                                                                                                                                                                                                                                                                                                                                          |
| 2   | Message to yourself                                                                                | Error.                                                                                                                                                                                                                                                                                                                                                              |
| 3   | A name matches several live agents                                                                 | Error that lists them with their ids.                                                                                                                                                                                                                                                                                                                               |
| 4   | Agents spawned together share an id prefix                                                         | Ids are shown and matched by their last 8 characters (the random part).                                                                                                                                                                                                                                                                                             |
| 5   | The recipient is working                                                                           | Steer, delivered at its next tool call. The watch ends when it stops working.                                                                                                                                                                                                                                                                                       |
| 6   | The recipient is idle when the message is sent                                                     | The message wakes it; the watch arms when the message is delivered, then ends when it stops working.                                                                                                                                                                                                                                                                |
| 7   | The recipient is working, and its turn ends in the few milliseconds before it takes the message in | The watch isn't armed yet (no delivered marker), so that turn's end doesn't count; it ends after the turn that takes the message in.                                                                                                                                                                                                                                |
| 8   | A `followUp` message to a working agent                                                            | Delivered after its current turn. The watch arms only then, so the current turn's end doesn't end it.                                                                                                                                                                                                                                                               |
| 9   | An `immediate` message to a working agent                                                          | Its turn is aborted, and the message is delivered once pi settles. The idle moment from the abort doesn't end the watch (not armed yet).                                                                                                                                                                                                                            |
| 10  | An `immediate` message to an idle agent                                                            | Delivered like a steer: it wakes the agent.                                                                                                                                                                                                                                                                                                                         |
| 11  | A message without `needsReply`                                                                     | No watch, and the recipient is told no reply is expected. If it replies anyway, the reply arrives as a normal message.                                                                                                                                                                                                                                              |
| 12  | The recipient's turn ends before the watcher sees the delivered marker                             | herdr already says idle; pi-herd checks again a second later and ends the watch `idle`.                                                                                                                                                                                                                                                                             |
| 13  | Esc aborts the recipient's run while the steer is queued                                           | The watch isn't armed until the message reaches the model (its delivered marker), so this idle doesn't end it. The message runs with the recipient's next turn, and that turn's end ends the watch; if pi drops the queued steer, the watch ends by timeout.                                                                                                        |
| 14  | The recipient waits on its own background jobs                                                     | `working` (with the patch), so the watch keeps going until those finish and the woken turn ends.                                                                                                                                                                                                                                                                    |
| 15  | The recipient waits on agents it watches                                                           | `working` (with the patch), so the watch keeps going until those end too.                                                                                                                                                                                                                                                                                           |
| 16  | A and B watch each other                                                                           | Both stay `working` until their timeouts. The defaults avoid it: only `needsReply` messages watch, it defaults to false for `agent_send`, and replies use false.                                                                                                                                                                                                    |
| 17  | The recipient is blocked                                                                           | The watch ends `blocked`. If it was blocked before the message, it ends at once.                                                                                                                                                                                                                                                                                    |
| 18  | The recipient reloads                                                                              | Messages wait in its folder, and the new runtime takes in anything not yet queued.                                                                                                                                                                                                                                                                                  |
| 19  | Several messages or endings arrive at once                                                         | Batched into one steer.                                                                                                                                                                                                                                                                                                                                             |
| 20  | The recipient sends a progress message, then keeps working                                         | The watch ends on the message. The watcher can `agent_watch` again to wait for the end.                                                                                                                                                                                                                                                                             |
| 21  | The recipient never sends anything                                                                 | The `idle` ending carries its last text.                                                                                                                                                                                                                                                                                                                            |
| 22  | The recipient never finishes (a loop, an unseen dialog, a hung tool)                               | The watch ends with `timeout` after 30 min by default, with the status and transcript. The recipient keeps running until someone kills it.                                                                                                                                                                                                                          |
| 23  | The recipient replies and exits at once                                                            | The inbox is scanned before `exited`, so the reply still ends the watch as `message`.                                                                                                                                                                                                                                                                               |
| 24  | The recipient crashes or is killed                                                                 | herdr reports the pane closed or the agent gone, and the watch ends `exited`.                                                                                                                                                                                                                                                                                       |
| 25  | The parent dies (exit, crash, SIGKILL)                                                             | Its spawned agents stop themselves: at once after a clean exit, within about 2 s after a crash. Panes pi-herd created close with them; given panes go back to their shell.                                                                                                                                                                                          |
| 26  | The watcher does `/new`                                                                            | Its watches are dropped. The new session is a new agent.                                                                                                                                                                                                                                                                                                            |
| 27  | A crash leaves a record, and the pid is reused                                                     | A false positive: it looks live. It needs both a crash, since every clean exit marks the record ended, and a reused pid. Messages to it are never taken in, and a watch on it ends only by timeout. **Accepted for v1.** `agent_stop` would also signal that pid. The upgrade, if it ever bites, is to compare the stored start time with `ps -o lstart= -p <pid>`. |
| 28  | Two processes open one session                                                                     | The second doesn't register (fails closed).                                                                                                                                                                                                                                                                                                                         |
| 29  | A `/new` inside a started agent                                                                    | New id, same parent. The old id is gone, so the watcher gets `exited`.                                                                                                                                                                                                                                                                                              |
| 30  | The created pi never registers (a trust dialog, or pi-herd not loaded)                             | `agent_start` fails after 30 s with the screen capture. A pane pi-herd created is closed; in a given pane, the pi is stopped and the pane kept.                                                                                                                                                                                                                     |
| 31  | Parallel `agent_start` calls                                                                       | They run one at a time (sequential execution).                                                                                                                                                                                                                                                                                                                      |
| 32  | Two parents spawn into the same cwd at once                                                        | They may create two workspaces for that cwd. Harmless; each disappears with its last tab.                                                                                                                                                                                                                                                                           |
| 33  | `placement` is a pane that is busy (an agent, or a command running)                                | `agent_start` fails before typing anything.                                                                                                                                                                                                                                                                                                                         |
| 34  | `placement` is a pane in another herdr session, or unknown                                         | `agent_start` fails: a given pane must be in the caller's herdr session.                                                                                                                                                                                                                                                                                            |
| 35  | A started agent in a given pane exits, or is stopped                                               | The pane goes back to its shell and stays open.                                                                                                                                                                                                                                                                                                                     |
| 36  | `agent_stop` on an agent that doesn't exit on `SIGTERM`                                            | After 5 s, pi-herd sends `SIGKILL`; a pane it created closes with pi.                                                                                                                                                                                                                                                                                               |
| 37  | The daily cleanup runs while an agent is still starting                                            | The agent isn't closed: a pane must be an orphan on two checks a minute apart.                                                                                                                                                                                                                                                                                      |
| 38  | Several pi sessions start at once after a day                                                      | The stamp file is written before the cleanup runs, so usually one runs it. If two do, closing a pane twice is harmless.                                                                                                                                                                                                                                             |
| 39  | `agent_start({ session })` for a session that is live                                              | Fails: `Session … is already live.`                                                                                                                                                                                                                                                                                                                                 |
| 40  | `agent_start({ session })` for an unknown id, or a suffix matching several sessions                | Fails, naming the problem; the full id always works.                                                                                                                                                                                                                                                                                                                |
| 41  | `agent_start` without `session` and without `name` or `message`                                    | Fails: both are required unless you resume a session.                                                                                                                                                                                                                                                                                                               |
| 42  | `agent_stop` on an agent stopped before its first turn                                             | pi hasn't written its session file yet, so there is nothing to resume; the result says so.                                                                                                                                                                                                                                                                          |
| 43  | Two unnamed agents derive the same two words (about 1 in 9 million)                                | Their names match, so addressing by name fails and lists both ids.                                                                                                                                                                                                                                                                                                  |
| 44  | A turn settles during compaction                                                                   | herdr stays `working` until the patch's compaction change is applied. Without it, the watch ends by timeout.                                                                                                                                                                                                                                                        |
| 45  | The shared herdr patch isn't applied                                                               | pi-herd works, with coarser status (section 3).                                                                                                                                                                                                                                                                                                                     |
| 46  | The agent has no session file (`--no-session`)                                                     | Transcripts fall back to herdr's screen capture.                                                                                                                                                                                                                                                                                                                    |
| 47  | Text over 32 KB                                                                                    | Refused: write a file and send the path.                                                                                                                                                                                                                                                                                                                            |
| 48  | pi runs outside herdr, or in a non-TUI mode                                                        | pi-herd is inert: no tools, no record. Such sessions can't be messaged or watched.                                                                                                                                                                                                                                                                                  |
| 49  | Trust                                                                                              | Only pi-herd writes `messages/`, and the folder is the user's own. "Not from the user" is a label for the model, not a security boundary.                                                                                                                                                                                                                           |
| 50  | The popup plugin isn't installed                                                                   | Viewing an agent shows the install command and the plain attach command. Spawning, messages and watches don't need the plugin.                                                                                                                                                                                                                                      |
| 51  | A popup is already open, or herdr is in a modal                                                    | Viewing reports `ui_busy`, and nothing opens.                                                                                                                                                                                                                                                                                                                       |
| 52  | `fs.watch` fails (for example, the folder is on a network drive)                                   | pi-herd shows one warning. Messages to that agent wait until its next `session_start` scan.                                                                                                                                                                                                                                                                         |

**Checked during the build:**

- pi exposes the caller's trust decision: `ctx.isProjectTrusted()` (section 7).
- `herdr agent attach` accepts a pane id, also on another session's socket.
- Not checked: whether the detach hotkey reaches pi through a real popup client (section 11).
  `/detach` works.
- herdr 0.9.3 names its events inconsistently: `pane.agent_status_changed`, but `pane_exited` and
  `pane_closed`. pi-herd accepts both spellings.
- An agent that registered may not show `agent: "pi"` in herdr yet (its integration reports at the
  same `session_start`). So "exited" means the pane is gone or the pid is dead, never just "no
  agent in the pane".

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

- About 2,800 lines as formatted, in six files: `index.ts` (registry, messages, watches, tools,
  `/agents`, about 1,600), `dashboard.ts` (the agents dashboard), `store.ts` (the shared files,
  agent names and the daily cleanup), `herdr.ts` (the socket API, the hidden session, and the herdr
  side of spawning, following status and the popup command), `transcript.ts` (transcripts and
  saved sessions) and `text.ts` (the brief, steer texts, and their renderers). The popup plugin
  and the herdr patch live in the repo's `herdr/` folder.
- One dependency, `friendly-words` (pinned to 1.2.1; later versions pull in a web server), for
  derived names. It requires herdr 0.9 or newer and runs only inside a herdr pane.

Out of scope for v1:

- other agent kinds (Claude, Codex, opencode; see orchestratr)
- messages across machines
- attachments (send paths instead)
- blocking waits
- cancel and supersede
- read receipts
