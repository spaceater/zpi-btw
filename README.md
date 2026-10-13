# @semanaut/zpi-btw

`/btw` — ask a one-off side question in [pi](https://github.com/earendil-works/pi).

Developed against pi 1.1.0; see the `piVersion` field in `package.json`.

The question inherits the full main-session context but is answered by a separate model call, so nothing enters the main conversation. The Q&A block streams into the live transcript in place and is never written to the session file or disk. The answer renders as markdown, with streaming display: deltas arrive in the block delta by delta.

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

Type `/btw <question>` in pi. The answer appears in a transient block below the current conversation.
