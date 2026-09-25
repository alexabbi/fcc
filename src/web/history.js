"use strict";
/* global state, el, $, api, renderView, renderTaskSelect, formatTime */

// The project timeline (S11, S14): features, commits and sessions, newest first.

const LINK_LABEL = {
  included: (c) => `in ${c?.sha.slice(0, 7)}`,
  partial: (c) => `partly in ${c?.sha.slice(0, 7)}`,
  uncommitted: () => "not committed yet",
  discarded: () => "discarded",
  unknown: () => "",
};
const GROUP_KIND = { feature: "Feature", commit: "Commit", session: "Uncommitted work" };

async function showHistory(repoId, quiet = false) {
  clearTimeout(state.pollTimer);
  state.view = "history";
  state.historyRepo = repoId;
  renderTaskSelect(); // the task list follows the project being shown
  if (!quiet) {
    state.history = null;
    renderView();
    renderHistoryPanel();
  }
  try {
    state.history = await api(`/api/history/${encodeURIComponent(repoId)}`);
  } catch (err) {
    state.history = { error: String(err.message ?? err) };
  }
  if (state.view === "history" && state.historyRepo === repoId) {
    renderHistory();
    renderHistoryPanel();
  }
}

function renderHistory() {
  const box = $("#history");
  box.replaceChildren();
  const h = state.history;
  if (!h) {
    box.append(el("p", "note", "Loading the history…"));
    return;
  }
  if (h.error) {
    box.append(el("p", "note", `Could not load the history: ${h.error}`));
    return;
  }
  box.append(el("p", "level", "History"));
  box.append(el("h1", "headline", h.repo.name));
  box.append(el("p", "note", `${h.count} task${h.count === 1 ? "" : "s"} · records in ${h.repo.dir}/, committed together with the code`));

  const search = el("input", "history-search");
  search.type = "search";
  search.placeholder = "Search stories, decisions, files…";
  search.value = state.historyQuery ?? "";
  search.setAttribute("aria-label", "Search the history");
  const list = el("div", "timeline");
  search.addEventListener("input", () => {
    state.historyQuery = search.value;
    renderTimeline(list, h);
  });
  box.append(search, list);
  renderTimeline(list, h);
}

function renderTimeline(list, h) {
  list.replaceChildren();
  const words = (state.historyQuery ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const match = (it) => words.every((w) => it.search.includes(w));
  let shown = 0;
  for (const g of h.groups) {
    const items = g.items.filter(match);
    if (!items.length) continue;
    shown += items.length;
    const sec = el("section", `hgroup ${g.kind}`);
    const head = el("div", "hgroup-head");
    head.append(el("span", "hgroup-kind", GROUP_KIND[g.kind]), el("h2", "", g.title));
    const commit = g.kind === "commit" ? g.items[0].link.commits[0] : null;
    if (commit) head.append(el("span", "mono note", commit.sha.slice(0, 7)));
    head.append(el("span", "note", formatTime(g.latest)));
    sec.append(head);
    for (const it of items) sec.append(historyRow(h.repo.repoId, it));
    list.append(sec);
  }
  if (!shown) {
    list.append(
      el(
        "p",
        "note",
        h.count
          ? "Nothing matches the search."
          : "No tasks recorded yet. They appear here after Claude changes files in this project.",
      ),
    );
  }
}

function historyRow(repoId, it) {
  const row = el("button", "hrow");
  row.type = "button";
  row.onclick = () => (location.hash = `#/${encodeURIComponent(repoId)}/${encodeURIComponent(it.id)}`);
  row.append(el("span", "hrow-time", formatTime(it.endedAt)));
  const body = el("span", "hrow-body");
  body.append(el("span", "hrow-title", it.headline));
  if (it.goal) body.append(el("span", "hrow-goal", it.goal));
  row.append(body);
  const badges = el("span", "hrow-badges");
  const label = LINK_LABEL[it.link.state]?.(it.link.commits[0]);
  if (label) badges.append(el("span", `badge link-${it.link.state}`, label));
  if (it.asksMissing) badges.append(el("span", "badge removed", `${it.asksMissing} ask${it.asksMissing === 1 ? "" : "s"} not done`));
  if (it.verifyHigh) badges.append(el("span", "badge modified", `${it.verifyHigh} to verify`));
  if (!it.explained) badges.append(el("span", "badge modified", "not explained"));
  if (it.private) badges.append(el("span", "badge", "private"));
  if (!it.local) badges.append(el("span", "badge", "from the repo"));
  row.append(badges);
  return row;
}

function renderHistoryPanel() {
  const p = $("#panel");
  p.replaceChildren();
  p.append(el("h2", "", "Development history"));
  p.append(
    el(
      "p",
      "note",
      "Every task Claude completes here is summarized in the repo (Markdown + JSON) so the reasons behind the code travel with it. Commit the records together with the changes they describe.",
    ),
  );
  const h = state.history;
  if (h && !h.error) {
    const counts = {};
    for (const g of h.groups) for (const it of g.items) counts[it.link.state] = (counts[it.link.state] ?? 0) + 1;
    const ul = el("ul");
    const names = { included: "committed", partial: "partly committed", uncommitted: "not committed yet", discarded: "discarded" };
    for (const [k, label] of Object.entries(names)) if (counts[k]) ul.append(el("li", "", `${counts[k]} ${label}`));
    if (ul.childElementCount) p.append(el("h3", "", "Status"), ul);
  }
  p.append(el("h3", "", "In Claude Code"));
  const cmds = el("ul");
  for (const [c, d] of [
    ["/flow", "open this page"],
    ['/flow start "name"', "group the next tasks under a feature"],
    ["/flow end", "stop grouping"],
    ["/flow private", "keep this session out of the repo"],
  ]) {
    const li = el("li");
    li.append(el("code", "mono", c), el("span", "note", d));
    cmds.append(li);
  }
  p.append(cmds);
}
