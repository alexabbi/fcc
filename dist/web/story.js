"use strict";
/* global cytoscape, state, el, $, nodeById, symbolLabel, renderDiff, colors, setView, focusNode, explainTask */

// Levels 0–1: the story of the task and its behavior flow, anchored to code.

const ASK_MARK = { done: "✓", partial: "◐", missing: "✗" };
const STEP_STATUS = { added: "new", modified: "changed", removed: "removed", unchanged: "unchanged" };
const STEP_SHAPE = { trigger: "round-rectangle", outcome: "round-rectangle", action: "round-rectangle", decision: "diamond", data: "barrel" };

function renderStory() {
  const box = $("#story");
  box.replaceChildren();
  state.flowCy?.destroy();
  state.flowCy = null;
  const g = state.graph;
  const n = g?.narrative;
  if (!g) return;
  if (g.status === "pending") {
    box.append(storyNote("Analyzing the changes…", "Building the structure of what changed. The story comes right after.", false, "pending"));
    return;
  }
  if (g.status === "error") {
    box.append(storyNote("The analysis failed", g.error ?? "", false));
    return;
  }
  if (g.status === "captured") {
    if (state.explaining === state.key) {
      box.append(storyNote("Explaining this task…", "Reading the change and writing the story. This usually takes under a minute; the page updates by itself.", false, "pending"));
      return;
    }
    const files = g.task.claudeFiles.length;
    const note = storyNote(
      "Captured, not explained yet",
      `This project is in manual mode: the ${files || "changed"} file${files === 1 ? "" : "s"} of this task were recorded, but nothing has been analyzed or sent to a model. Ask for it when this task is worth a story.`,
      false,
    );
    const b = el("button", "primary", "Explain this task");
    b.type = "button";
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = "Explaining…";
      try {
        await explainTask(state.key);
      } catch (err) {
        b.disabled = false;
        b.textContent = "Explain this task";
        alert(`fcc: ${err.message ?? err}`);
      }
    };
    note.append(b);
    box.append(note);
    return;
  }

  if (!n || n.status === "off") {
    box.append(storyNote("No story for this task", "Descriptions are turned off (FCC_LLM=off) or the task has nothing to describe.", true));
    return;
  }
  if (n.status === "pending") {
    box.append(storyNote("Writing the story of this task…", `${n.model ?? "The model"} is reading the changes. This usually takes under a minute; the page updates by itself.`, true, "pending"));
    return;
  }
  if (n.status === "error") {
    const note = storyNote("The story could not be written", n.error ?? "", true);
    note.querySelector("p")?.classList.add("error");
    box.append(note);
    return;
  }

  const d = n.data;
  box.append(el("p", "level", "Level 0 · Story"));
  box.append(el("h1", "headline", d.headline));
  const why = intentBlock(d.intent);
  if (why) box.append(why);
  box.append(el("p", "story-text", d.story));

  const cols = el("div", "cols");
  cols.append(card("What you asked", d.asks, (a) => {
    const it = el("div", "item");
    it.append(el("div", `mark ${a.status}`, ASK_MARK[a.status] ?? "?"));
    const body = el("div");
    body.append(el("div", "", a.request));
    if (a.note) body.append(el("div", "note", a.note));
    if (a.anchors.length) body.append(anchorChips(a.anchors, a.request));
    it.append(body);
    return it;
  }, "No explicit asks found in the request."));
  cols.append(card("What to verify", d.verify, (v) => {
    const it = el("div", "item");
    const dot = el("div");
    dot.append(el("i", `dot ${v.priority}`));
    dot.title = `${v.priority} priority`;
    it.append(dot);
    const body = el("div");
    body.append(el("div", "", v.text));
    if (v.anchors.length) body.append(anchorChips(v.anchors, v.text));
    it.append(body);
    return it;
  }, "Nothing specific to check."));
  box.append(cols);

  box.append(el("p", "level", "Level 1 · Behavior"));
  const head = el("div", "flowhead");
  head.append(el("h2", "", d.flow.title || "What happens now"));
  const legend = el("div", "flow-legend");
  for (const [cls, text] of [["added", "new"], ["modified", "changed"], ["removed", "removed"], ["unchanged", "unchanged"]]) {
    const s = el("span");
    s.append(el("i", `sw ${cls === "unchanged" ? "context" : cls}`), document.createTextNode(text));
    legend.append(s);
  }
  const inferred = el("span");
  inferred.append(el("i", "ln dashed"), document.createTextNode("inferred link (no call path in the code)"));
  legend.append(inferred);
  head.append(legend);
  box.append(head);
  const flow = el("div", "flow");
  flow.id = "flow";
  box.append(flow);
  box.append(provenance(n));
  renderFlow(d.flow);
}

/** "Why": the goal, decisions and rejected alternatives from the conversation (S13). */
function intentBlock(intent) {
  if (!intent || (!intent.goal && !intent.decisions?.length && !intent.rejected?.length)) return null;
  const box = el("div", "why");
  box.append(el("p", "level", "Why"));
  if (intent.goal) box.append(el("p", "why-goal", intent.goal));
  const list = (title, items, cls) => {
    if (!items?.length) return;
    const d = el("div", `why-list ${cls}`);
    d.append(el("span", "why-title", title));
    const ul = el("ul");
    for (const i of items) ul.append(el("li", "", i));
    d.append(ul);
    box.append(d);
  };
  list("Decided", intent.decisions, "decided");
  list("Rejected", intent.rejected, "rejected");
  return box;
}

function storyNote(title, text, withStructureLink, cls = "") {
  const div = el("div", `story-note ${cls}`);
  div.append(el("h2", "", title), el("p", "", text));
  if (withStructureLink && state.graph?.nodes.length) {
    const b = el("button", "", "Open the structure view");
    b.type = "button";
    b.onclick = () => setView("structure");
    div.append(b);
  }
  return div;
}

function card(title, items, render, empty) {
  const c = el("div", "card");
  c.append(el("h2", "", title));
  if (!items.length) c.append(el("p", "note", empty));
  for (const i of items) c.append(render(i));
  return c;
}

function anchorChips(anchors, title) {
  const box = el("div", "chips");
  for (const id of anchors) {
    const node = nodeById(id);
    if (!node) continue;
    const b = el("button", "chip", node.kind === "symbol" ? symbolLabel(node) : node.path);
    b.type = "button";
    b.title = node.path;
    b.onclick = () => showAnchors({ title, anchors: [id] });
    box.append(b);
  }
  return box;
}

function provenance(n) {
  const c = n.checks ?? {};
  const parts = [`Written by ${n.model} in ${n.seconds}s`];
  if (n.costUsd !== undefined) parts.push(`$${n.costUsd.toFixed(3)}`);
  const links = (c.groundedLinks ?? 0) + (c.inferredLinks ?? 0);
  if (links) parts.push(`${c.groundedLinks}/${links} links backed by calls in the code`);
  if (c.unanchoredSteps) parts.push(`${c.unanchoredSteps} step(s) without code behind them`);
  if (c.droppedAnchors) parts.push(`${c.droppedAnchors} invalid reference(s) removed`);
  if (n.trimmed) parts.push("long diffs were shortened for the model");
  return el("p", "provenance", parts.join(" · "));
}

function renderFlow(flow) {
  const c = colors();
  const palette = {
    added: [c.add, c.addBg],
    modified: [c.mod, c.modBg],
    removed: [c.del, c.delBg],
    unchanged: [c.border, c.surface],
  };
  const els = [];
  for (const s of flow.steps) {
    const [border, bg] = palette[s.status] ?? palette.unchanged;
    const isDecision = s.kind === "decision";
    const unanchored = s.anchors.length === 0 && s.kind !== "trigger" && s.kind !== "outcome";
    els.push({
      data: {
        id: s.id,
        label: s.label + (unanchored ? "  ?" : ""),
        border,
        bg,
        shape: STEP_SHAPE[s.kind] ?? "round-rectangle",
        w: Math.min(250, Math.max(120, s.label.length * 7.4 + 34)) * (isDecision ? 1.35 : 1),
        h: isDecision ? 82 : 46,
        dash: s.status === "removed" || unanchored ? "dashed" : "solid",
        pill: s.kind === "trigger" || s.kind === "outcome" ? 1 : 0,
      },
    });
  }
  flow.links.forEach((l, i) => {
    els.push({ data: { id: `link${i}`, source: l.from, target: l.to, label: l.label ?? "", style: l.grounded ? "solid" : "dashed" } });
  });

  const cy = cytoscape({
    container: $("#flow"),
    elements: els,
    wheelSensitivity: 0.3,
    minZoom: 0.2,
    maxZoom: 2.5,
    boxSelectionEnabled: false,
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          shape: "data(shape)",
          width: "data(w)",
          height: "data(h)",
          "text-wrap": "wrap",
          "text-max-width": 160,
          "text-valign": "center",
          "text-halign": "center",
          "font-family": c.font,
          "font-size": 13,
          color: c.text,
          "background-color": "data(bg)",
          "border-color": "data(border)",
          "border-width": 2,
          "border-style": "data(dash)",
        },
      },
      { selector: "node[pill = 1]", style: { "corner-radius": 23, "font-weight": 600 } },
      {
        selector: "edge",
        style: {
          width: 1.8,
          "curve-style": "bezier",
          "line-color": c.edge,
          "target-arrow-color": c.edge,
          "target-arrow-shape": "triangle",
          "line-style": "data(style)",
          label: "data(label)",
          "font-size": 11,
          color: c.muted,
          "text-background-color": c.surface,
          "text-background-opacity": 1,
          "text-background-padding": 2,
        },
      },
      { selector: "node:selected", style: { "border-width": 4, "border-color": c.accent } },
    ],
  });
  state.flowCy = cy;
  cy.one("layoutstop", () => cy.fit(undefined, 24));
  cy.layout({
    name: "elk",
    fit: false,
    elk: {
      algorithm: "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": 42,
      "elk.spacing.nodeNode": 32,
      "elk.spacing.edgeLabel": 6,
    },
  }).run();
  cy.on("tap", "node", (e) => {
    const s = flow.steps.find((x) => x.id === e.target.id());
    if (s) showAnchors({ title: s.label, detail: s.detail, anchors: s.anchors, status: s.status, kind: s.kind });
  });
  cy.on("tap", (e) => {
    if (e.target === cy) {
      cy.elements().unselect();
      renderOverview();
    }
  });
}

/** Side panel for a behavior step or an anchor chip: the code behind it (levels 2–3). */
function showAnchors({ title, detail, anchors, status, kind }) {
  const p = $("#panel");
  p.replaceChildren(backLink());
  p.append(el("p", "level", "Behind this step · code"));
  p.append(el("h2", "", title));
  if (status) {
    const meta = el("div", "meta");
    meta.append(el("span", `badge ${status === "unchanged" ? "" : status}`, STEP_STATUS[status] ?? status));
    p.append(meta);
  }
  if (detail) p.append(el("p", "", detail));
  if (!anchors.length) {
    const isEdge = kind === "trigger" || kind === "outcome";
    p.append(el("p", "note", isEdge ? "Start or end of the flow: no code behind it." : "The model could not point to code for this step: treat it as unverified."));
  }
  for (const id of anchors) {
    const n = nodeById(id);
    if (!n) continue;
    const sec = el("div", "anchor");
    const head = el("div", "meta");
    head.append(el("b", "mono", n.kind === "symbol" ? symbolLabel(n) : n.path), el("span", `badge ${n.status}`, n.status));
    sec.append(head);
    const where = el("div", "meta");
    where.append(el("span", "", `${n.path}${n.line ? `:${n.line}` : ""}`));
    const toGraph = el("a", "", "Show in structure");
    toGraph.href = "#";
    toGraph.onclick = (ev) => {
      ev.preventDefault();
      setView("structure");
      focusNode(id);
    };
    where.append(toGraph);
    sec.append(where);
    if (n.diff) sec.append(renderDiff(n.diff));
    else if (!state.graph.task.before) sec.append(el("p", "note", "Diff not in this machine's cache (task recorded elsewhere): see its commit."));
    else sec.append(el("p", "note", "Unchanged: shown as context."));
    p.append(sec);
  }
}
