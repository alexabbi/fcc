---
name: flow
description: Development history of this project (fcc). /flow opens the history; /flow start "name" and /flow end group tasks under a feature; /flow private keeps this session's tasks out of the repo; /flow public undoes it.
argument-hint: '[start "feature name" | end | private | public]'
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/fcc.mjs" flow --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

The command above has already run. Reply with its output line only, translated into the language the user writes in if needed. Copy any link exactly; add nothing else and do not run anything.
