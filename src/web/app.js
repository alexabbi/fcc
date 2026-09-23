"use strict";
/* global cytoscape, cytoscapeElk */

cytoscape.use(cytoscapeElk);

const $ = (sel) => document.querySelector(sel);
const state = {
  tasks: [],
  key: null, // "repoId/taskId"
  graph: null,
  cy: null,
  showContext: true,
  /** Width the viewer asked for; what is applied may be clamped to the window. */
  panelWidth: null,
  pollTimer: null,
  view: "story", // "story" (levels 0–1) | "structure" (levels 2–3)
  flowCy: null,
  /** Resolves when the structure layout has finished (ELK is async). */
  graphReady: Promise.resolve(),
  /** What the structure view currently shows, to avoid re-running the layout. */
  graphRendered: null,
  loadedKey: null,
  signature: null,
};

// ---------- data ----------

async function api(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

/** `#/history/<repo>` or `#/<repo>/<task>`. */
function currentRoute() {
  const [, a, b] = location.hash.split("/");
  if (a === "history" && b) return { kind: "history", repo: decodeURIComponent(b) };
  if (a && b) return { kind: "task", key: `${decodeURIComponent(a)}/${decodeURIComponent(b)}` };
  return null;
}

function taskHash(key) {
  return `#/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function route() {
  const r = currentRoute();
  if (r?.kind === "history") showHistory(r.repo);
  else if (r?.kind === "task") {
    if (r.key !== state.key) loadTask(r.key);
    else if (state.view === "history") {
      state.view = defaultView(state.graph);
      renderView();
    }
  }
}

function taskPath(key) {
  const [repo, task] = key.split("/");
  return `/api/tasks/${encodeURIComponent(repo)}/${encodeURIComponent(task)}`;
}

async function refreshTasks() {
  try {
    state.tasks = await api("/api/tasks");
  } catch {
    return; // server gone or token expired; keep what we have
  }
  renderTaskSelect();
  const route = currentRoute();
  if (route?.kind === "history") {
    // new tasks (or finished stories) change the timeline
    const sig = state.tasks.map((t) => t.id + t.status).join();
    if (sig !== state.tasksSignature) {
      if (state.tasksSignature !== undefined) showHistory(route.repo, true);
      state.tasksSignature = sig;
    }
  } else if (!state.key && state.tasks.length > 0) {
    const t = state.tasks[0];
    location.replace(`#/${encodeURIComponent(t.repoId)}/${encodeURIComponent(t.id)}`);
  } else if (state.tasks.length === 0) {
    setView("structure");
    showOverlay("No tasks yet. Run a task in Claude Code that edits files, and it will show up here.");
  }
}

async function loadTask(key) {
  clearTimeout(state.pollTimer);
  state.key = key;
  renderTaskSelect();
  let graph;
  try {
    graph = await api(taskPath(key));
  } catch (err) {
    state.graph = null;
    state.cy?.elements().remove();
    setView("structure");
    showOverlay(`Could not load task ${key}.`, String(err.message ?? err));
    return;
  }
  if (state.key !== key) return; // navigated away meanwhile
  const isNewTask = state.loadedKey !== key;
  const signature = `${graph.status}|${graph.narrative?.status}`;
  state.graph = graph;
  state.loadedKey = key;
  if (isNewTask) state.view = defaultView(graph);
  // Polling re-fetches the same task: only re-render when something progressed.
  if (isNewTask || signature !== state.signature) {
    state.signature = signature;
    renderView();
    renderOverview();
  }
  const waiting = graph.status === "pending" || graph.narrative?.status === "pending";
  if (waiting) state.pollTimer = setTimeout(() => loadTask(key), graph.status === "pending" ? 1000 : 2000);
}

function defaultView(g) {
  const s = g.narrative?.status;
  return !s || s === "off" ? "structure" : "story";
}

function setView(view) {
  if (view === "history") {
    const repo = state.graph?.task.repoId ?? state.historyRepo;
    if (repo) location.hash = `#/history/${encodeURIComponent(repo)}`;
    return;
  }
  if (state.view === "history") {
    if (!state.loadedKey) return;
    state.view = view;
    history.replaceState(null, "", taskHash(state.loadedKey));
    renderView();
    renderOverview();
    return;
  }
  if (state.view === view) return;
  state.view = view;
  renderView();
}

function renderView() {
  const v = state.view;
  $("#story-view").hidden = v !== "story";
  $("#structure-view").hidden = v !== "structure";
  $("#history-view").hidden = v !== "history";
  $("#context-toggle").hidden = v !== "structure";
  $("#fit").hidden = v === "history";
  $("#stats").hidden = v === "history";
  for (const b of document.querySelectorAll(".tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.view === v));
    b.disabled = b.dataset.view !== "history" && !state.loadedKey;
  }
  renderStats(state.graph);
  if (v === "history") {
    renderHistory();
  } else if (v === "story") {
    renderStory();
  } else {
    state.cy.resize();
    const shown = `${state.loadedKey}|${state.signature}|${state.showContext}`;
    if (state.graphRendered !== shown) {
      state.graphRendered = shown;
      renderGraph();
    }
  }
}

function activeCy() {
  return state.view === "story" ? state.flowCy : state.cy;
}

// ---------- header ----------

function renderTaskSelect() {
  const select = $("#task-select");
  select.replaceChildren();
  const byRepo = new Map();
  for (const t of state.tasks) {
    if (!byRepo.has(t.repoId)) byRepo.set(t.repoId, []);
    byRepo.get(t.repoId).push(t);
  }
  for (const [, tasks] of byRepo) {
    const group = document.createElement("optgroup");
    group.label = basename(tasks[0].repoRoot);
    for (const t of tasks) {
      const opt = document.createElement("option");
      opt.value = `${t.repoId}/${t.id}`;
      const status = t.status === "ready" ? "" : ` · ${t.status}`;
      opt.textContent = `${formatTime(t.endedAt)} · ${excerpt(t.headline, 70)}${status}`;
      group.append(opt);
    }
    select.append(group);
  }
  if (state.key) select.value = state.key;
}

function renderStats(g) {
  const box = $("#stats");
  box.replaceChildren();
  if (!g?.stats) return;
  const s = g.stats;
  const chip = (cls, text, title) => {
    const span = el("span", `stat ${cls}`, text);
    span.title = title;
    box.append(span);
  };
  chip("", `${s.filesChanged} files`, "Files changed in this task");
  if (s.symbolsAdded) chip("added", `+${s.symbolsAdded}`, "Symbols added");
  if (s.symbolsModified) chip("modified", `~${s.symbolsModified}`, "Symbols modified");
  if (s.symbolsRemoved) chip("removed", `−${s.symbolsRemoved}`, "Symbols removed");
}

// ---------- graph ----------

function colors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    font: v("--font"),
    text: v("--text"),
    muted: v("--muted"),
    surface: v("--surface"),
    bg: v("--bg"),
    border: v("--border"),
    accent: v("--accent"),
    add: v("--add"),
    addBg: v("--add-bg"),
    mod: v("--mod"),
    modBg: v("--mod-bg"),
    del: v("--del"),
    delBg: v("--del-bg"),
    ren: v("--ren"),
    edge: v("--edge"),
    fileBg: v("--file-bg"),
    pkgBg: v("--pkg-bg"),
  };
}

function stylesheet(c) {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "font-family": c.font,
        "font-size": 12,
        color: c.text,
        "text-valign": "center",
        "text-halign": "center",
      },
    },
    {
      selector: "node.symbol, node.leaf",
      style: {
        shape: "round-rectangle",
        width: "data(w)",
        height: 30,
        "background-color": c.surface,
        "border-width": 1.5,
        "border-color": c.border,
      },
    },
    { selector: "node.leaf", style: { shape: "cut-rectangle", "font-size": 11 } },
    { selector: "node.added", style: { "background-color": c.addBg, "border-color": c.add } },
    { selector: "node.modified", style: { "background-color": c.modBg, "border-color": c.mod } },
    { selector: "node.renamed", style: { "border-color": c.ren } },
    {
      selector: "node.removed",
      style: { "background-color": c.delBg, "border-color": c.del, "border-style": "dashed" },
    },
    {
      selector: "node.symbol.context",
      style: { "background-color": c.bg, "border-color": c.border, color: c.muted },
    },
    {
      selector: "node.file:parent",
      style: {
        shape: "round-rectangle",
        "background-color": c.fileBg,
        "border-width": 1.5,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -4,
        "font-size": 11,
        "font-weight": 600,
        color: c.muted,
        padding: 12,
      },
    },
    { selector: "node.file:parent.added", style: { "background-color": c.fileBg } },
    { selector: "node.file:parent.modified", style: { "background-color": c.fileBg } },
    { selector: "node.file:parent.removed", style: { "background-color": c.fileBg } },
    { selector: "node.file.context", style: { "border-color": c.border, "border-style": "dotted" } },
    { selector: "node.file.other", style: { opacity: 0.8 } },
    {
      selector: "node.package",
      style: {
        shape: "round-rectangle",
        "background-color": c.pkgBg,
        "border-width": 1,
        "border-color": c.border,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-y": -4,
        "font-size": 12,
        "font-weight": 700,
        color: c.text,
        padding: 16,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "curve-style": "bezier",
        "line-color": c.edge,
        "target-arrow-color": c.edge,
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.9,
      },
    },
    { selector: "edge.ref", style: { "line-style": "dotted" } },
    { selector: "edge.new", style: { "target-arrow-shape": "triangle-backcurve" } },
    { selector: "edge.render", style: { "target-arrow-shape": "diamond" } },
    { selector: "edge.added", style: { "line-color": c.add, "target-arrow-color": c.add, width: 2 } },
    {
      selector: "edge.removed",
      style: { "line-color": c.del, "target-arrow-color": c.del, "line-style": "dashed", width: 2 },
    },
    { selector: "node:selected", style: { "border-width": 3, "border-color": c.accent } },
    { selector: "edge:selected", style: { width: 3.5, "line-color": c.accent, "target-arrow-color": c.accent } },
    { selector: ".faded", style: { opacity: 0.18 } },
  ];
}

function initCy() {
  state.cy = cytoscape({
    container: $("#graph"),
    style: stylesheet(colors()),
    wheelSensitivity: 0.3,
    minZoom: 0.1,
    maxZoom: 3,
    boxSelectionEnabled: false,
  });
  const cy = state.cy;
  cy.on("tap", "node", (e) => select(e.target));
  cy.on("tap", "edge", (e) => select(e.target));
  cy.on("tap", (e) => {
    if (e.target === cy) {
      cy.elements().unselect();
      renderOverview();
    }
  });
  cy.on("mouseover", "node.symbol", (e) => {
    const hood = e.target.closedNeighborhood();
    const keep = hood.union(hood.ancestors());
    cy.elements().not(keep).addClass("faded");
  });
  cy.on("mouseout", "node.symbol", () => cy.elements().removeClass("faded"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => cy.style(stylesheet(colors())));
}

function symbolLabel(n) {
  switch (n.symbolKind) {
    case "function":
    case "method":
      return n.label.startsWith("get ") || n.label.startsWith("set ") ? n.label : `${n.label}()`;
    case "class":
      return `class ${n.label}`;
    case "type":
      return `type ${n.label}`;
    default:
      return n.label;
  }
}

function toElements(g) {
  const packages = g.nodes.filter((n) => n.kind === "package");
  const showPackages = packages.length > 1;
  let nodes = g.nodes;
  if (!state.showContext) {
    nodes = nodes.filter((n) => !(n.kind === "symbol" && n.status === "context"));
    const hasChild = new Set(nodes.filter((n) => n.kind === "symbol").map((n) => n.parent));
    nodes = nodes.filter((n) => !(n.kind === "file" && n.status === "context" && !hasChild.has(n.id)));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const parents = new Set(nodes.filter((n) => n.kind === "symbol").map((n) => n.parent));

  const els = [];
  for (const n of nodes) {
    if (n.kind === "package" && !showPackages) continue;
    if (n.kind === "package") {
      els.push({ group: "nodes", data: { id: n.id, label: n.label }, classes: "package" });
      continue;
    }
    const isLeafFile = n.kind === "file" && !parents.has(n.id);
    const label = n.kind === "symbol" ? symbolLabel(n) : n.label + (n.attribution === "other" ? "  ·  external" : "");
    const classes = [n.kind, n.status, isLeafFile ? "leaf" : "", n.attribution ?? "", n.symbolKind ?? ""].join(" ");
    const data = { id: n.id, label, w: Math.max(64, label.length * 7.3 + 26) };
    if (n.parent && (showPackages || n.kind !== "file")) data.parent = n.parent;
    els.push({ group: "nodes", data, classes });
  }
  for (const e of g.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    els.push({ group: "edges", data: { id: e.id, source: e.source, target: e.target }, classes: `${e.kind} ${e.status}` });
  }
  return els;
}

function renderGraph() {
  const g = state.graph;
  const cy = state.cy;
  cy.elements().remove();
  if (!g) return;
  if (g.status === "pending") return showOverlay("Analyzing the changes…");
  if (g.status === "error") return showOverlay("The analysis failed.", g.error ?? "");
  if (g.nodes.length === 0) return showOverlay("No visible changes (everything was filtered out).");
  hideOverlay();
  cy.add(toElements(g));
  // ELK runs async and the extension's own `fit` fires too early: fit on layoutstop instead.
  state.graphReady = new Promise((resolve) =>
    cy.one("layoutstop", () => {
      cy.fit(undefined, 32);
      resolve();
    }),
  );
  cy.layout({
    name: "elk",
    fit: false,
    animate: false,
    nodeDimensionsIncludeLabels: true,
    elk: {
      algorithm: "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.layered.spacing.nodeNodeBetweenLayers": 56,
      "elk.spacing.nodeNode": 20,
      "elk.spacing.componentComponent": 36,
      "elk.padding": "[top=30,left=14,bottom=14,right=14]",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    },
  }).run();
}

function showOverlay(message, detail) {
  const o = $("#overlay");
  o.replaceChildren(el("div", "", message));
  if (detail) o.firstChild.append(el("div", "error", detail));
  o.hidden = false;
}

function hideOverlay() {
  $("#overlay").hidden = true;
}

// ---------- panel ----------

function nodeById(id) {
  return state.graph?.nodes.find((n) => n.id === id);
}

function select(ele) {
  const cy = state.cy;
  cy.elements().unselect();
  ele.select();
  if (ele.isEdge()) return renderEdge(state.graph.edges.find((e) => e.id === ele.id()));
  const n = nodeById(ele.id());
  if (n?.kind === "symbol") renderSymbol(n);
  else if (n?.kind === "file") renderFile(n);
  else renderOverview();
}

async function focusNode(id) {
  await state.graphReady;
  const ele = state.cy.getElementById(id);
  if (ele.empty()) return;
  state.cy.animate({ center: { eles: ele }, zoom: Math.max(state.cy.zoom(), 1) }, { duration: 250 });
  select(ele);
}

function renderOverview() {
  const g = state.graph;
  const p = $("#panel");
  p.replaceChildren();
  if (!g) return;
  const t = g.task;
  p.append(el("h2", "", "Task"));
  const meta = el("div", "meta");
  meta.append(
    el("span", "", basename(t.repoRoot)),
    el("span", "", `${formatTime(t.startedAt)} → ${formatTime(t.endedAt)}`),
  );
  if (t.usedBash) meta.append(el("span", "badge", "ran shell commands"));
  p.append(meta);
  const goal = g.narrative?.data?.intent?.goal;
  if (goal) p.append(el("h3", "", "Goal"), el("div", "prompt", goal));
  if (g.warnings?.length) {
    p.append(el("h3", "", "Notes"));
    const ul = el("ul");
    for (const w of g.warnings) ul.append(el("li", "warn", w));
    p.append(ul);
  }
  const files = g.nodes.filter((n) => n.kind === "file" && n.status !== "context");
  if (files.length) {
    p.append(el("h3", "", `Changed files (${files.length})`));
    const ul = el("ul");
    for (const f of files) {
      const li = el("li");
      li.append(el("span", `badge ${f.status}`, f.status));
      const b = el("button", "link", f.path);
      b.type = "button";
      b.onclick = () => (state.cy.getElementById(f.id).empty() ? renderFile(f) : focusNode(f.id));
      li.append(b);
      if (f.attribution === "other") li.append(el("span", "badge", "external"));
      ul.append(li);
    }
    p.append(ul);
  }
  p.append(el("p", "note", "Click a node to see its diff. Hover a function to highlight its calls."));
}

function renderSymbol(n) {
  const p = $("#panel");
  p.replaceChildren(backLink());
  p.append(el("h2", "", symbolLabel(n)));
  const meta = el("div", "meta");
  meta.append(el("span", `badge ${n.status}`, n.status), el("span", "badge", n.symbolKind));
  p.append(meta, locationLine(n.path, n.line));
  if (n.status === "context") {
    p.append(el("p", "note", "Unchanged. Shown because it calls, or is called by, something that changed."));
  } else if (n.diff) {
    p.append(el("h3", "", "Diff"), renderDiff(n.diff));
  }
  renderConnections(p, n.id);
}

function renderFile(n) {
  const p = $("#panel");
  p.replaceChildren(backLink());
  p.append(el("h2", "", n.path));
  const meta = el("div", "meta");
  meta.append(el("span", `badge ${n.status}`, n.status));
  if (n.attribution === "claude") meta.append(el("span", "badge", "written by Claude"));
  if (n.attribution === "other") meta.append(el("span", "badge", "external"));
  p.append(meta);
  if (n.oldPath) p.append(el("p", "note", `Renamed from ${n.oldPath}`));
  if (n.attribution === "other") {
    p.append(
      el("p", "note", "Changed during the task, but not through Claude's edit tools: a shell command, you, or another session."),
    );
  }
  if (n.status !== "removed") p.append(locationLine(n.path, 1));
  if (n.status === "context") p.append(el("p", "note", "Unchanged. Contains neighbors of changed code."));
  else if (n.diff) p.append(el("h3", "", "Diff"), renderDiff(n.diff));
  else p.append(el("p", "note", "No textual diff available."));
}

function renderEdge(e) {
  const p = $("#panel");
  p.replaceChildren(backLink());
  const s = nodeById(e.source);
  const t = nodeById(e.target);
  const verb = { call: "calls", new: "instantiates", render: "renders", ref: "references" }[e.kind];
  p.append(el("h2", "", `${s ? symbolLabel(s) : e.source} ${verb} ${t ? symbolLabel(t) : e.target}`));
  const meta = el("div", "meta");
  const label = e.status === "unchanged" ? "existing" : e.status;
  meta.append(el("span", `badge ${e.status}`, label));
  p.append(meta);
  const ul = el("ul");
  for (const n of [s, t]) {
    if (!n) continue;
    const li = el("li");
    const b = el("button", "link", `${symbolLabel(n)} — ${n.path}`);
    b.type = "button";
    b.onclick = () => focusNode(n.id);
    li.append(b);
    ul.append(li);
  }
  p.append(el("h3", "", "Endpoints"), ul);
}

function renderConnections(p, id) {
  const edges = state.graph.edges.filter((e) => e.source === id || e.target === id);
  if (!edges.length) return;
  p.append(el("h3", "", "Connections"));
  const ul = el("ul");
  for (const e of edges) {
    const out = e.source === id;
    const other = nodeById(out ? e.target : e.source);
    if (!other) continue;
    const li = el("li");
    li.append(el("span", "badge", out ? "→" : "←"));
    const b = el("button", "link", symbolLabel(other));
    b.type = "button";
    b.onclick = () => focusNode(other.id);
    li.append(b);
    if (e.status !== "unchanged") li.append(el("span", `badge ${e.status}`, e.status));
    ul.append(li);
  }
  p.append(ul);
}

function locationLine(path, line) {
  const root = state.graph.task.repoRoot;
  const div = el("div", "meta");
  div.style.marginTop = "8px";
  div.append(el("span", "", `${path}:${line}`));
  const a = el("a", "", "Open in VS Code");
  a.href = `vscode://file${encodeURI(`${root}/${path}`)}:${line}`;
  div.append(a);
  return div;
}

function backLink() {
  const a = el("a", "", "← Task overview");
  a.href = "#";
  a.onclick = (ev) => {
    ev.preventDefault();
    state.cy.elements().unselect();
    renderOverview();
  };
  const d = el("div", "");
  d.style.marginBottom = "12px";
  d.append(a);
  return d;
}

/** Renders a unified diff (symbol-level or `git diff` output) with line numbers. */
function renderDiff(text) {
  const box = el("div", "diff");
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const row = (cls, o, n, code) => {
    const d = el("div", `dl ${cls}`);
    d.append(el("span", "n", o), el("span", "n", n), el("span", "c", code));
    box.append(d);
  };
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      row("hunk", "", "", line);
    } else if (!inHunk || line === "") {
      continue; // git headers (diff --git, index, ---, +++) and the trailing newline
    } else if (line.startsWith("+")) {
      row("add", "", String(newNo++), line.slice(1));
    } else if (line.startsWith("-")) {
      row("del", String(oldNo++), "", line.slice(1));
    } else if (line.startsWith("\\")) {
      row("hunk", "", "", line);
    } else if (line.startsWith("diff --git")) {
      inHunk = false;
    } else if (line.startsWith("…")) {
      row("hunk", "", "", line);
    } else {
      row("ctx", String(oldNo++), String(newNo++), line.slice(1));
    }
  }
  if (!box.childElementCount) box.append(el("div", "dl hunk", "(binary or empty diff)"));
  return box;
}

// ---------- resizable side panel ----------

const PANEL_MIN = 280;
const PANEL_DEFAULT = 440;
const PANEL_KEY = "fcc.panelWidth";

/** Keep the panel usable on any window size, without squashing the graph. */
function clampPanel(width) {
  return Math.round(Math.max(PANEL_MIN, Math.min(width, Math.max(PANEL_MIN, window.innerWidth - 360))));
}

/**
 * `width` is what the user asked for and is kept as such: a narrow window
 * only clamps what is applied, so widening the window restores their choice.
 */
function setPanelWidth(width, remember = true) {
  state.panelWidth = Math.round(Math.max(PANEL_MIN, width));
  const w = clampPanel(width);
  document.documentElement.style.setProperty("--panel-width", `${w}px`);
  $("#splitter").setAttribute("aria-valuenow", String(w));
  if (remember) {
    try {
      localStorage.setItem(PANEL_KEY, String(w));
    } catch {
      // private window or blocked storage: the width just won't be remembered
    }
  }
  // the graphs own a canvas: it has to be told the container changed
  state.cy?.resize();
  state.flowCy?.resize();
}

function initSplitter() {
  const splitter = $("#splitter");
  let stored = null;
  try {
    stored = Number(localStorage.getItem(PANEL_KEY)) || null;
  } catch {
    stored = null;
  }
  setPanelWidth(stored ?? PANEL_DEFAULT, false);

  let frame = 0;
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    // one update per frame: dragging fires far more often than that
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      setPanelWidth(window.innerWidth - e.clientX);
    });
  });
  const stop = (e) => {
    if (splitter.hasPointerCapture(e.pointerId)) splitter.releasePointerCapture(e.pointerId);
    document.body.classList.remove("resizing");
  };
  splitter.addEventListener("pointerup", stop);
  splitter.addEventListener("pointercancel", stop);
  splitter.addEventListener("dblclick", () => setPanelWidth(PANEL_DEFAULT));
  splitter.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 96 : 24;
    const current = state.panelWidth ?? PANEL_DEFAULT;
    if (e.key === "ArrowLeft") setPanelWidth(current + step);
    else if (e.key === "ArrowRight") setPanelWidth(current - step);
    else if (e.key === "Home") setPanelWidth(PANEL_DEFAULT);
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", () => setPanelWidth(state.panelWidth ?? PANEL_DEFAULT, false));
}

// ---------- utils ----------

function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function basename(p) {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function excerpt(s, n) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// ---------- boot ----------

initCy();
initSplitter();
$("#task-select").addEventListener("change", (e) => {
  location.hash = taskHash(e.target.value);
});
$("#fit").addEventListener("click", () => activeCy()?.fit(undefined, 32));
for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => setView(b.dataset.view));
$("#show-context").addEventListener("change", (e) => {
  state.showContext = e.target.checked;
  if (state.graph) renderView();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "f" && !e.metaKey && !e.ctrlKey && e.target === document.body) activeCy()?.fit(undefined, 32);
});
window.addEventListener("hashchange", route);
route();
refreshTasks();
setInterval(refreshTasks, 5000);
