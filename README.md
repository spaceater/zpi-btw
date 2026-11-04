# @semanaut/zpi-btw

`/btw` — ask a one-off side question in [pi](https://github.com/earendil-works/pi).

The question inherits the full main-session context but is answered by a separate model call, so nothing enters the main conversation. The Q&A block streams into the live transcript and is never written to the session file or disk. The answer renders as markdown, with streaming display: deltas arrive in the block delta by delta.

The request is the session's own request — same system prompt, same tool declarations, same conversation, projected the way pi projects it for the model — so the model cannot tell a side question apart from a real turn. The one difference is that **no tool ever runs**: every tool call, whatever the tool, gets the same notice as its result and the model answers from what it already knows. Tool calls and thinking are not shown; only the answer text is.

## Philosophy: minimal by design

`/btw` is deliberately bare-bones — a single command, a single question.

- **No state** — nothing to track, nothing to accumulate, no side-channel history.
- **No branching** — you are not managing a tree of parallel conversations.
- **No configuration** — no settings, no model overrides, no options to tune.

Just context plus one question: the answer appears below the current conversation and then it is gone. If you ever wanted a persistent or branching side conversation, you wanted a different tool.

## Install

```bash
pi install npm:@semanaut/zpi-btw
```

## Usage

Type `/btw <question>` in pi. The answer appears in a transient block below the current conversation, with a `working` line under it while the side call runs; that line disappears once the answer lands, or reports `interrupted` / the failure text.
