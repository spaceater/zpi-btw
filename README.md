# @semanaut/pi-btw

`/btw` — ask a one-off side question in [pi](https://github.com/earendil-works/pi).

The question inherits the full main-session context but is answered by a separate model call, so nothing enters the main conversation. The Q&A block streams into the live transcript in place and is never written to the session file or disk.

## Install

```bash
pi install npm:@semanaut/pi-btw
```

## Usage

Type `/btw <question>` in pi. The answer appears in a transient block below the current conversation.
