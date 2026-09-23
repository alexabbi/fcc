---
name: flow
description: Development history of this project (fcc). /flow opens the history; /flow model picks the model that writes the stories; /flow start "name" and /flow end group tasks under a feature; /flow drop deletes the last task's report so it is never committed; /flow private keeps this session's tasks out of the repo; /flow public undoes it.
argument-hint: '[model <name> | start "feature name" | end | drop | private | public]'
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/fcc.mjs" flow --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

The line above, starting with "fcc:", is the result of the command, which has already run. It is the whole answer.

Reply with that line and nothing else: no questions, no lists of options, no commentary, no further tool calls. You may translate it into the language the user writes in, but keep links, paths and command names exactly as printed.
