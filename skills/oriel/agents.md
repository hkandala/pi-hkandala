# Agents

Oriel's chat view is a chat window over an agent's terminal. It needs launch flags that Oriel makes for each
launch, so start the agent through Oriel.

```sh
oriel agent claude                        # beside you, with the chat view
oriel agent pi --tab                      # the places of open (cards.md)
oriel chat w1:p4                          # relaunch an idle agent with the chat view
oriel info --json                         # "agents": the agents that oriel agent starts
```

- `agent` answers when it typed the agent's command, not when the agent is ready:
  `{"pane":"w1:p9","agent":"claude"}`. To wait for the agent or talk to it, use herdr (the herdr skill).
- `chat` needs an idle agent whose session herdr knows. A working or blocked agent is `busy`. Your own pane
  is `self`.
- For an agent without the chat view, run its command in a herdr pane (the herdr skill).
