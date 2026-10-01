# pi-herd

pi agents in [herdr](https://herdr.dev). Every pi session running in a herdr pane becomes an **agent**. An agent can list the others, message them, and watch them until they stop working. It can also start agents of its own in herdr panes, send them work, stop them, and resume them later; those agents can start their own.

```
 ● I started reviewer with the review request. I'll be woken when it replies.
 ╭┄┄ agent message ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮
 ┆ 󱉰 reviewer replied · 38 lines (ctrl+o to expand)                ┆
 ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```

- **Messages** are files. By default a message arrives as a steer: an idle agent wakes up, and a working agent gets it at its next tool call. It can also wait for the current turn to end (`followUp`), or abort it (`immediate`), for stopping an agent that's doing something wrong.
- **Replies are asked for.** A message with `needsReply` tells the recipient to answer, and watches it: the sender is woken when it replies, stops working (with its last text, or the error its turn failed with), is blocked (with its screen), exits, or the watch times out (30 min by default, with a transcript of what it was doing). A message without it expects no answer. Starting an agent asks for a reply by default, so the agent never has to poll.
- **Status comes from herdr**: `working`, `idle`, `blocked`, `done`. pi-herd adds no status logic of its own.
- **Agents stop with the agent that started them**, whether it quits or crashes, and so do the agents they started. A stopped agent can be resumed from its session id.
- **Every agent has a name.** One without a `--name` or `/name` gets two words derived from its session id, like `frog-thunder`: always the same for that session, and never stored.
- The agent learns the workflow from a short brief in its system prompt.

pi-herd does nothing outside herdr, and nothing in print, JSON or RPC mode.

## Agent tools

| Tool          | Does                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_start` | Starts a pi agent (`name`, `message`) and sends it that message, asking for a reply; or resumes a stopped one (`session`, `message` optional)                           |
| `agent_send`  | Sends a `message` (`to`, `replyTo`) to one or more live agents                                                                                                          |
| `agent_watch` | Watches agents that are working (`to`, `timeout` in minutes)                                                                                                            |
| `agent_list`  | Lists live agents: the ones you started (default), agents in this folder (`cwd`), or `all` (also other sessions'; rarely needed)                                        |
| `agent_read`  | What an agent has been doing: its transcript (default), or its last text (`transcript: false`); `screen: true` adds what its pane shows now                             |
| `agent_stop`  | Stops agents you started, or that they started (`ids`, or `"all"`: the ones you started) and prints each one's session id, to resume it with `agent_start({ session })` |

`message` is `{ text, needsReply?, delivery? }`:

- `needsReply`: you want an answer, and are woken for it. Default `true` for `agent_start`, `false` for `agent_send`.
- `delivery`: `steer` (default: at its next tool call), `followUp` (after its current turn), or `immediate` (aborts its current turn first).

`agent_start` also takes `model`, `thinking`, `cwd` and `placement`. Without `session`, `name` and `message` are required.

Agents are addressed by id, the last 8 characters of it, or name. Every agent gets every tool and the same rules, so agents can start agents to any depth.

**Where a started agent runs** (`placement`, default from config):

| Placement           | Where                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hidden` (default)  | A separate herdr session, `pi-herd`: one workspace per folder, one tab per agent. pi-herd starts its server when needed. |
| `tab`               | A new tab in your herdr workspace, opened without focus                                                                  |
| a pane id (`w1:p3`) | An existing pane in your herdr session. It must be an idle shell; when the agent exits, the pane goes back to its shell. |

A new agent gets your model and thinking level unless config or the call names others; a resumed one keeps its own. A resumed session runs in its saved folder unless the call names a `cwd`. It gets `--approve` only when its folder is inside yours and you trust your project.

## Commands

| Command   | Does                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/agents` | Lists agents; picking one attaches to it in a herdr popup (an agent in your own herdr session is focused instead)                                  |
| `/detach` | In an agent shown in a popup: closes the popup, and the agent keeps running. `ctrl+shift+q` does the same. `ctrl+b q` inside the popup also works. |

While a popup shows an agent, that agent shows `ctrl+b q or /detach to close` in yellow, right-aligned above its prompt.

The popup needs the repo's herdr plugin (below). Without it, `/agents` prints the command to attach in a terminal.

## Works with

Optional; install any of them for the extra:

- [pi-footer](../pi-footer/README.md): `󰫣 3` in the footer line while this session watches agents, a `waiting  3 agents · 2 jobs` line in the dashboard's overview, and an agents tab (↓ opens it while watches run): the agents you started and the ones you watched, listed like background jobs in the order they were started (stopped ones last), with messages sent and received, `󱖡` on agents you didn't start and `󰅐` on the ones you wait on. Enter views an agent, `x` twice stops one of yours.
- [pi-working](../pi-working/README.md): `Waiting on 3 agents and 2 background jobs (1m 12s)` in the prompt's border while the agent waits.
- [pi-content-layout](../pi-content-layout/README.md): agent messages and watch endings in its dashed frames (`agent message`, `agent watcher`; click to expand, markdown highlighted), messages in open tool calls as highlighted markdown, and tool groups that read `Started 2 agents, talked to 3 agents, stopped 2 agents`.
- [herdr/](../../herdr/README.md) in this repo:
  - **the patch** keeps a pane `working` while it waits on agents or background jobs, so a watch doesn't end while its target still waits, and herdr doesn't play "done" too early.
  - **the plugin** has the popup `/agents` attaches in.

## Install

```bash
pi install npm:@hkandala/pi-herd
herdr plugin install hkandala/pi-hkandala/herdr/plugin   # for /agents popups
```

Or from a checkout of [pi-hkandala](../../README.md): `pi install <checkout>/extensions/pi-herd`, and `herdr plugin link <checkout>/herdr/plugin`.

Requires herdr 0.9 or newer. pi-herd starts `pi` from your `PATH`; flags your launcher adds go in `args`. From a checkout, run `npm install` in `extensions/pi-herd` once, for its one dependency ([friendly-words](https://github.com/glitchdotcom/friendly-words), pinned to 1.2.1: later versions pull in a web server).

## Configuration

Optional: `~/.pi/agent/extensions/pi-herd.json`. Every key has a default.

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

| Key                   | Meaning                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `placement`           | default placement for `agent_start`: `hidden` or `tab`                            |
| `model`, `thinking`   | defaults for agents you start; `null` inherits yours                              |
| `args`                | extra pi flags for agents you start, appended last                                |
| `watchTimeoutMinutes` | default watch timeout; `0` means none                                             |
| `transcriptMessages`  | entries in a transcript (`agent_read` with `transcript`, and timeout endings)     |
| `captureLines`        | screen lines read instead, for an agent that has no session file (`--no-session`) |
| `detachKey`           | closes the popup showing this agent, like `/detach`                               |

## Files

Everything lives in `~/.pi/agent/pi-herd/`: `agents/<id>.json` (one per live agent), `messages/<to>/<id>.json` (one per message), and `attached/<id>` (while a popup shows that agent). Once a day, the first session to start deletes records of dead agents, messages older than 7 days, and stale popup markers, and closes orphaned panes in the `pi-herd` herdr session.

See [docs/SPEC.md](docs/SPEC.md) for the design.
