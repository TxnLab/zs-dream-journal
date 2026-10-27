// Dream journal UI. Plain DOM, no dependencies. Every string that comes from
// the journal or a model is inserted as text, never parsed as HTML.

const state = {
  token: null,
  journal: null,
  status: null,
  lockMessage: "",
  models: [],
  modelsError: null,
  tab: "journal",
  selected: null,
  filter: null, // { facet, value }
  query: "",
  draft: "",
  draftDate: null, // null follows today
  editing: null, // the id of the dream being edited
  editDraft: null, // { date, text }
  busy: null, // "new" while saving | "patterns"
  notice: null,
  patternCount: 30,
  settingsSaved: false,
  passphraseChanged: false,
};

const root = document.getElementById("root");
const $ = (sel) => document.querySelector(sel);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function moon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z");
  svg.append(path);
  return svg;
}

function today() {
  return new Date().toLocaleDateString("en-CA");
}
const asDate = (d) => new Date(`${d}T12:00:00`);
const shortDate = (d) => asDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (d) => asDate(d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const num = (n) => (n == null ? "n/a" : Number(n).toLocaleString());
const usd = (n) => (n == null ? "n/a" : `$${Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".00")}`);
const pair = (k, v) => [h("dt", {}, k), h("dd", {}, v ?? "n/a")];
const total = (ledger) => ledger.reduce((s, r) => s + (r.usd || 0), 0);

// ------------------------------------------------------------------- server

async function api(method, path, body) {
  const token = state.token;
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "X-Session": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw new Error("Can't reach the journal server. Check that it's still running (npm start).");
  });
  const data = await res.json().catch(() => ({}));
  // A reply to an older session's request doesn't lock a newer one.
  if (res.status === 401 && token && token === state.token) {
    lockLocal("Locked after a period of inactivity. Your draft is kept.");
    throw new Error("locked");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function lockLocal(message) {
  Object.assign(state, { token: null, journal: null, lockMessage: message, tab: "journal", selected: null, filter: null, query: "", busy: null });
  render();
}

// Replies can arrive out of order, such as a poll and a save at once, so keep
// whichever journal is newest.
function setJournal(journal) {
  if (!state.journal || journal.rev >= state.journal.rev) state.journal = journal;
  if (state.journal.analyzing.length) watchAnalyses();
}

// While dreams are analyzed in the background, check every couple of seconds
// and redraw when something changes.
let watching = false;
async function watchAnalyses() {
  if (watching) return;
  watching = true;
  while (state.journal?.analyzing.length) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const { journal } = await api("GET", "/api/journal");
      if (!state.journal || journal.rev <= state.journal.rev) continue;
      setJournal(journal);
      // Settings has fields that a redraw would reset; it catches up on the
      // next visit to the journal.
      if (state.tab === "journal") render();
    } catch {}
  }
  watching = false;
}

async function loadModels() {
  try {
    state.models = (await api("GET", "/api/models")).models;
    state.modelsError = null;
  } catch (err) {
    state.modelsError = err.message;
  }
  if (state.journal && state.tab === "settings") render();
}

// ------------------------------------------------------------------- render

function render() {
  const active = document.activeElement;
  const focusId = active && active.id;
  const caret = focusId && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  // A redraw can come from a background analysis at any moment, so keep
  // scrolled lists and text boxes where they were.
  const scrolled = [...root.querySelectorAll("[id]")].filter((el) => el.scrollTop).map((el) => [el.id, el.scrollTop]);
  root.replaceChildren(state.journal ? appView() : lockView());
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (caret && el.setSelectionRange) {
        try {
          el.setSelectionRange(...caret);
        } catch {}
      }
    }
  }
  for (const [id, top] of scrolled) {
    const el = document.getElementById(id);
    if (el) el.scrollTop = top;
  }
}

function lockView() {
  const s = state.status || {};
  const creating = s.exists === false;
  return h(
    "main",
    { class: "lock" },
    h(
      "form",
      { class: "lock-card", onsubmit: onUnlock },
      h("div", { class: "brand" }, moon(), h("span", {}, "Dream journal")),
      h("h1", {}, creating ? "Create your journal" : "Unlock your journal"),
      h(
        "p",
        { class: "muted" },
        creating
          ? "Choose a passphrase. It encrypts the journal file on this computer. It can't be recovered, so keep it somewhere safe."
          : "Your dreams are encrypted on this computer. Enter your passphrase to read them.",
      ),
      h("label", { for: "pass" }, "Passphrase"),
      h("input", { id: "pass", type: "password", required: true, autocomplete: creating ? "new-password" : "current-password", minlength: creating ? 8 : null }),
      creating ? [h("label", { for: "confirm" }, "Confirm passphrase"), h("input", { id: "confirm", type: "password", required: true, autocomplete: "new-password" })] : null,
      h("p", { class: "error", role: "alert" }, state.lockMessage),
      h("button", { class: "primary", type: "submit" }, creating ? "Create journal" : "Unlock"),
      s.proxyOnline === false
        ? h("p", { class: "warn" }, `The ZeroSignal proxy isn't answering at ${s.proxy}. You can still write; analysis needs the proxy running.`)
        : null,
      s.file ? h("p", { class: "fine" }, `Journal file: ${s.file}`) : null,
    ),
  );
}

async function onUnlock(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector("button");
  const error = form.querySelector(".error");
  const pass = $("#pass").value;
  const confirm = $("#confirm");
  if (confirm && confirm.value !== pass) {
    error.textContent = "The passphrases don't match.";
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Deriving your key…";
  error.textContent = "";
  try {
    const r = await api("POST", confirm ? "/api/create" : "/api/unlock", { passphrase: pass });
    state.token = r.token;
    setJournal(r.journal);
    state.lockMessage = "";
    if (state.status) state.status.exists = true;
    loadModels();
    render();
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
    button.textContent = label;
  }
}

function appView() {
  return h(
    "div",
    { class: "app" },
    topBar(),
    h(
      "main",
      { class: "main" },
      state.notice
        ? h("div", { class: "notice", role: "alert" }, h("p", {}, state.notice), h("button", { class: "ghost", onclick: () => ((state.notice = null), render()) }, "Dismiss"))
        : null,
      state.tab === "journal" ? journalView() : state.tab === "patterns" ? patternsView() : settingsView(),
    ),
  );
}

function topBar() {
  const ledger = state.journal.ledger;
  const tab = (id, label) =>
    h("button", { class: "tab", "aria-pressed": String(state.tab === id), onclick: () => (Object.assign(state, { tab: id, settingsSaved: false, passphraseChanged: false }), render()) }, label);
  return h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, moon(), h("span", {}, "Dream journal")),
    h("nav", { class: "tabs", "aria-label": "Sections" }, tab("journal", "Journal"), tab("patterns", "Patterns"), tab("settings", "Settings")),
    h(
      "div",
      { class: "top-right" },
      h("span", { class: "spend", title: "Everything this journal has spent on analysis" }, `${usd(total(ledger))} · ${ledger.length} ${ledger.length === 1 ? "request" : "requests"}`),
      h("button", { class: "ghost", onclick: onLock }, "Lock"),
    ),
  );
}

async function onLock() {
  try {
    await api("POST", "/api/lock");
  } catch {}
  lockLocal("Locked.");
}

// ------------------------------------------------------------------ journal

function catalog(dreams) {
  const facets = { themes: new Map(), symbols: new Map(), emotions: new Map(), dream_types: new Map() };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const d of dreams) {
    const a = d.analysis;
    if (!a) continue;
    a.themes.forEach((t) => bump(facets.themes, t));
    a.symbols.forEach((s) => bump(facets.symbols, s.symbol));
    a.emotions.forEach((e) => bump(facets.emotions, e));
    bump(facets.dream_types, a.dream_type);
  }
  const sorted = (m) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
  return Object.fromEntries(Object.entries(facets).map(([k, m]) => [k, sorted(m)]));
}

function facetValues(a, facet) {
  if (facet === "symbols") return a.symbols.map((s) => s.symbol);
  if (facet === "dream_types") return [a.dream_type];
  return a[facet] || [];
}

function matches(d) {
  const a = d.analysis;
  if (state.filter && (!a || !facetValues(a, state.filter.facet).includes(state.filter.value))) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const words = a ? [a.title, a.summary, ...a.themes, ...a.emotions, ...a.symbols.map((s) => s.symbol), ...a.people, ...a.places] : [];
  return [d.text, ...words].join(" ").toLowerCase().includes(q);
}

function journalView() {
  const dreams = state.journal.dreams;
  const shown = dreams.filter(matches);
  const selected = shown.find((d) => d.id === state.selected) || shown[0] || null;
  state.selected = selected?.id ?? null;
  return h(
    "div",
    { class: "journal" },
    h("aside", { class: "side" }, composer(), browse(shown, dreams.length), facetsView(dreams)),
    h("section", { class: "detail", "aria-live": "polite" }, !selected ? emptyView() : state.editing === selected.id ? editView(selected) : dreamView(selected)),
  );
}

function composer() {
  const saving = state.busy === "new";
  return h(
    "form",
    { class: "card composer", onsubmit: onSaveDream },
    h("h2", {}, "Last night"),
    h("label", { for: "dream-date" }, "Date"),
    h("input", {
      id: "dream-date",
      type: "date",
      value: state.draftDate || today(),
      max: today(),
      // Picking today means "keep following today".
      oninput: (e) => (state.draftDate = e.target.value === today() ? null : e.target.value),
    }),
    h("label", { for: "dream-text" }, "What do you remember?"),
    h(
      "textarea",
      { id: "dream-text", rows: 8, placeholder: "Everything, even fragments. The odd details are often the useful ones.", disabled: saving, oninput: (e) => (state.draft = e.target.value) },
      state.draft,
    ),
    h("button", { class: "primary", type: "submit", disabled: saving }, saving ? "Saving…" : "Save and analyze"),
    h("p", { class: "fine" }, "Encrypted and saved first. Then only the text is sent for analysis: not the date, and nothing else from your journal."),
  );
}

async function onSaveDream(e) {
  e.preventDefault();
  const text = state.draft.trim();
  if (!text) return;
  state.busy = "new";
  state.notice = null;
  render();
  try {
    const r = await api("POST", "/api/dreams", { date: state.draftDate || today(), text });
    setJournal(r.journal);
    Object.assign(state, { selected: r.id, draft: "", draftDate: null, filter: null, query: "" });
  } catch (err) {
    if (err.message !== "locked") state.notice = err.message;
  }
  state.busy = null;
  render();
}

function browse(shown, count) {
  return h(
    "div",
    { class: "card browse" },
    h("div", { class: "browse-head" }, h("h2", {}, "Catalog"), h("span", { class: "muted" }, `${count} ${count === 1 ? "dream" : "dreams"}`)),
    h("label", { for: "search", class: "sr-only" }, "Search your dreams"),
    h("input", { id: "search", type: "search", placeholder: "Search words, symbols, people", value: state.query, oninput: (e) => ((state.query = e.target.value), render()) }),
    state.filter
      ? h("button", { class: "chip active", "aria-label": `Clear the ${state.filter.value} filter`, onclick: () => ((state.filter = null), render()) }, `${state.filter.value} ✕`)
      : null,
    shown.length
      ? h(
          "ul",
          { id: "dream-list", class: "dream-list" },
          shown.map((d) =>
            h(
              "li",
              {},
              h(
                "button",
                { class: "dream-item", "aria-current": d.id === state.selected ? "true" : null, onclick: () => ((state.selected = d.id), render()) },
                h("span", { class: "date" }, shortDate(d.date)),
                h("span", { class: "title" }, d.analysis?.title || (state.journal.analyzing.includes(d.id) ? "Analyzing…" : "Not analyzed yet")),
                d.analysis ? h("span", { class: "tags" }, d.analysis.themes.slice(0, 2).join(" · ")) : null,
              ),
            ),
          ),
        )
      : h("p", { class: "muted" }, count ? "No dreams match." : "Your dreams will appear here."),
  );
}

function facetsView(dreams) {
  const cat = catalog(dreams);
  const groups = [
    ["themes", "Themes"],
    ["symbols", "Symbols"],
    ["emotions", "Emotions"],
    ["dream_types", "Kinds of dream"],
  ].filter(([k]) => cat[k].length);
  if (!groups.length) return null;
  return h(
    "div",
    { class: "card facets" },
    h("h2", {}, "At a glance"),
    h("p", { class: "fine" }, "Counted on this computer from each dream's analysis. Pick one to filter."),
    groups.map(([k, label]) =>
      h(
        "div",
        { class: "facet" },
        h("h3", {}, label),
        h(
          "div",
          { class: "chips" },
          cat[k].slice(0, 12).map(({ value, count }) => {
            const on = state.filter?.facet === k && state.filter.value === value;
            return h(
              "button",
              { class: on ? "chip active" : "chip", "aria-pressed": String(on), onclick: () => ((state.filter = on ? null : { facet: k, value }), render()) },
              value,
              h("span", { class: "count" }, String(count)),
            );
          }),
        ),
      ),
    ),
  );
}

function tagRow(label, values, facet) {
  if (!values.length) return null;
  return h(
    "div",
    { class: "tag-row" },
    h("h3", {}, label),
    h(
      "div",
      { class: "chips" },
      values.map((v) =>
        facet
          ? h("button", { class: "chip", title: `Show dreams with ${v}`, onclick: () => Object.assign(state, { filter: { facet, value: v }, query: "" }) && render() }, v)
          : h("span", { class: "chip static" }, v),
      ),
    ),
  );
}

function dreamView(d) {
  const a = d.analysis;
  const analyzing = state.journal.analyzing.includes(d.id);
  return h(
    "article",
    { class: "dream" },
    h("p", { class: "eyebrow" }, longDate(d.date)),
    h("h2", { class: "dream-title" }, a?.title || (analyzing ? "Analyzing…" : "Not analyzed yet")),
    a
      ? h(
          "div",
          { class: "meta" },
          h("span", { class: "badge" }, a.dream_type),
          h("span", { class: "vivid", role: "img", "aria-label": `Vividness ${a.vividness} of 5` }, "●".repeat(a.vividness) + "○".repeat(5 - a.vividness)),
        )
      : null,
    analyzing ? h("p", { class: "status", role: "status" }, "Analyzing through ZeroSignal. You can keep writing or reading while it works.") : null,
    a && d.stale && !analyzing ? h("p", { class: "warn" }, "You've edited this dream since it was analyzed. Analyze again to bring the analysis up to date.") : null,
    d.error && !analyzing
      ? h(
          "div",
          { class: "notice", role: "alert" },
          h("p", {}, d.error),
          d.rawReply ? h("details", {}, h("summary", {}, "Show the model's reply"), h("pre", {}, d.rawReply)) : null,
        )
      : null,
    a?.summary ? h("p", { class: "summary" }, a.summary) : null,
    h("details", { class: "words", open: !a }, h("summary", {}, "Your words"), h("p", { class: "dream-text" }, d.text)),
    a
      ? [
          tagRow("Emotions", a.emotions, "emotions"),
          tagRow("Themes", a.themes, "themes"),
          tagRow("People", a.people),
          tagRow("Places", a.places),
          a.symbols.length
            ? h("section", { class: "block" }, h("h3", {}, "Symbols"), h("dl", { class: "symbols" }, a.symbols.map((s) => [h("dt", {}, s.symbol), h("dd", {}, s.note)])))
            : null,
          a.interpretation ? h("section", { class: "block" }, h("h3", {}, "Possible readings"), h("p", {}, a.interpretation)) : null,
          a.question ? h("section", { class: "block" }, h("h3", {}, "To sit with"), h("blockquote", { class: "question" }, a.question)) : null,
        ]
      : null,
    d.receipt ? receiptView(d.receipt, d.sent) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "secondary", disabled: analyzing, onclick: () => reanalyze(d) }, analyzing ? "Analyzing…" : a ? "Analyze again" : "Analyze"),
      h("button", { class: "secondary", onclick: () => startEdit(d) }, "Edit"),
      h("button", { class: "ghost danger", onclick: () => removeDream(d) }, "Delete"),
    ),
  );
}

function editView(d) {
  const draft = state.editDraft;
  return h(
    "form",
    { class: "dream edit", onsubmit: (e) => onSaveEdit(e, d) },
    h("h2", { class: "dream-title" }, "Edit dream"),
    h("label", { for: "edit-date" }, "Date"),
    h("input", { id: "edit-date", type: "date", required: true, value: draft.date, max: today(), oninput: (e) => (draft.date = e.target.value) }),
    h("label", { for: "edit-text" }, "What do you remember?"),
    h("textarea", { id: "edit-text", rows: 12, required: true, oninput: (e) => (draft.text = e.target.value) }, draft.text),
    d.analysis ? h("p", { class: "fine" }, "The analysis stays as it is until you analyze again. Nothing is sent when you save.") : null,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit" }, "Save changes"),
      h("button", { class: "ghost", type: "button", onclick: () => ((state.editing = null), render()) }, "Cancel"),
    ),
  );
}

function startEdit(d) {
  Object.assign(state, { editing: d.id, editDraft: { date: d.date, text: d.text } });
  render();
  $("#edit-text").focus();
}

async function onSaveEdit(e, d) {
  e.preventDefault();
  try {
    setJournal((await api("PUT", `/api/dreams/${d.id}`, state.editDraft)).journal);
    Object.assign(state, { editing: null, editDraft: null });
  } catch (err) {
    if (err.message !== "locked") state.notice = err.message;
  }
  render();
}

function receiptView(r, sent) {
  const relayed = r.relay === "required";
  return h(
    "section",
    { class: "receipt" },
    h("h3", {}, "Receipt"),
    h(
      "dl",
      {},
      pair("Served by", r.operator != null ? `Operator ${r.operator}, node ${r.node}` : null),
      pair("Model", r.model),
      pair("Route", relayed ? "Through a relay (required)" : "Proxy default"),
      r.tee ? pair("Hardware", "Attested confidential compute (required)") : null,
      pair("Tokens", `${num(r.inputTokens)} in, ${num(r.outputTokens)} out`),
      pair("Cost", usd(r.usd)),
      pair("Ticket", r.ticket),
    ),
    h(
      "p",
      { class: "fine" },
      relayed
        ? "The operator received the text below, but not your IP address or anything that names you. The relay that carried it saw your IP address, but couldn't read the text."
        : "Sent with your proxy's default routing.",
    ),
    sent
      ? h(
          "details",
          {},
          h("summary", {}, "Exactly what left this computer"),
          h("p", { class: "fine" }, "Your proxy sealed this before sending. Routing preferences are read by the proxy and removed first."),
          h("pre", {}, JSON.stringify(sent, null, 2)),
        )
      : null,
  );
}

async function reanalyze(d) {
  state.notice = null;
  try {
    setJournal((await api("POST", `/api/dreams/${d.id}/analyze`)).journal);
  } catch (err) {
    if (err.message !== "locked") state.notice = err.message;
  }
  render();
}

async function removeDream(d) {
  if (!confirm(`Delete "${d.analysis?.title || shortDate(d.date)}"? This can't be undone.`)) return;
  try {
    setJournal((await api("DELETE", `/api/dreams/${d.id}`)).journal);
    state.selected = null;
    if (state.editing === d.id) state.editing = null;
  } catch (err) {
    if (err.message !== "locked") state.notice = err.message;
  }
  render();
}

function emptyView() {
  if (state.journal.dreams.length) return h("div", { class: "empty" }, h("p", { class: "muted" }, "No dreams match that filter."));
  return h(
    "div",
    { class: "empty" },
    h("h2", {}, "Write down last night's dream"),
    h("p", { class: "muted" }, "Here's what happens when you save one:"),
    h(
      "ol",
      {},
      h("li", {}, "It's encrypted with your passphrase and written to a file on this computer, before anything else."),
      h("li", {}, "Only the dream's text goes to a model on ZeroSignal, as you wrote it. The date and your other dreams stay here, and there's no account that ties it to you."),
      h("li", {}, "A relay carries it, so the operator running the model never sees your IP address, and the relay can't read it."),
      h("li", {}, "The catalog, tags and search are built here, from each dream's analysis. Nothing is sent twice."),
    ),
    h("p", { class: "muted" }, "There's nothing to set up first. If there's a name you'd rather not send, you can list it under Private terms in Settings, and it goes out as a placeholder instead."),
  );
}

// ----------------------------------------------------------------- patterns

function patternsView() {
  const j = state.journal;
  const analyzed = j.dreams.filter((d) => d.analysis).length;
  const busy = state.busy === "patterns";
  return h(
    "div",
    { class: "single" },
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Patterns across your dreams"),
      h(
        "p",
        { class: "muted" },
        "Sends the titles, tags and symbols from your analyzed dreams, numbered rather than dated, and asks what recurs. The dreams themselves are never sent again.",
      ),
      h(
        "div",
        { class: "row" },
        h("label", { for: "pattern-count" }, "Look at"),
        h(
          "select",
          { id: "pattern-count", onchange: (e) => (state.patternCount = Number(e.target.value)) },
          [10, 30, 1000].map((n) => h("option", { value: n, selected: n === state.patternCount }, n === 1000 ? "every analyzed dream" : `the last ${n} analyzed dreams`)),
        ),
        h("button", { class: "primary", disabled: busy || analyzed < 2, onclick: onFindPatterns }, busy ? "Reading patterns…" : "Find patterns"),
      ),
      analyzed < 2 ? h("p", { class: "fine" }, "Analyze at least two dreams first.") : null,
    ),
    j.patterns ? patternsResult(j.patterns) : null,
  );
}

async function onFindPatterns() {
  state.busy = "patterns";
  state.notice = null;
  render();
  try {
    setJournal((await api("POST", "/api/patterns", { count: state.patternCount })).journal);
  } catch (err) {
    if (err.message !== "locked") state.notice = err.message;
  }
  state.busy = null;
  render();
}

function patternsResult(p) {
  const r = p.result;
  const list = (items, key) =>
    items.length
      ? h("ul", { class: "pattern-list" }, items.map((x) => h("li", {}, h("strong", {}, x[key]), h("span", { class: "count" }, `×${x.count}`), h("p", {}, x.observation))))
      : h("p", { class: "muted" }, "Nothing stood out yet.");
  return h(
    "section",
    { class: "card patterns" },
    h("p", { class: "eyebrow" }, `From ${p.count} dreams, read ${new Date(p.at).toLocaleString()}`),
    r.emotional_trend ? h("section", { class: "block" }, h("h3", {}, "Emotional tone"), h("p", {}, r.emotional_trend)) : null,
    h("div", { class: "two" }, h("section", { class: "block" }, h("h3", {}, "Recurring symbols"), list(r.recurring_symbols, "symbol")), h("section", { class: "block" }, h("h3", {}, "Recurring themes"), list(r.recurring_themes, "theme"))),
    r.shifts ? h("section", { class: "block" }, h("h3", {}, "What changed"), h("p", {}, r.shifts)) : null,
    r.reflection ? h("section", { class: "block" }, h("h3", {}, "Possible readings"), h("p", {}, r.reflection)) : null,
    r.experiment ? h("section", { class: "block" }, h("h3", {}, "Something to try this week"), h("blockquote", { class: "question" }, r.experiment)) : null,
    receiptView(p.receipt, p.sent),
  );
}

// ----------------------------------------------------------------- settings

function checkbox(id, checked, label, help) {
  return h("div", { class: "check" }, h("input", { type: "checkbox", id, checked }), h("label", { for: id }, label), h("p", { class: "fine" }, help));
}

function settingsView() {
  const s = state.journal.settings;
  const known = state.models.some((m) => m.id === s.model);
  return h(
    "div",
    { class: "single" },
    h(
      "form",
      { class: "card settings", onsubmit: onSaveSettings },
      h("h2", {}, "Analysis"),
      h("label", { for: "model" }, "Model"),
      state.models.length
        ? h(
            "select",
            { id: "model" },
            known ? null : h("option", { value: s.model, selected: true }, `${s.model} (not in the live catalog)`),
            state.models.map((m) => h("option", { value: m.id, selected: m.id === s.model }, `${m.id}  ·  $${m.input.toFixed(2)} in, $${m.output.toFixed(2)} out per 1M tokens`)),
          )
        : h("input", { id: "model", value: s.model }),
      h(
        "p",
        { class: state.modelsError ? "warn" : "fine" },
        state.modelsError ? `Couldn't load the live model list: ${state.modelsError}` : "The live catalog from every ZeroSignal operator, read through your proxy. A typical dream costs well under a cent.",
      ),
      checkbox("relay", s.relayRequired, "Require a relay", "The operator running the model never sees your IP address. If no relay is available, the request fails instead of going direct."),
      checkbox(
        "tee",
        s.requireTee,
        "Require attested hardware",
        "Only operators whose confidential-compute attestation your proxy has verified itself. Few models qualify today, so analysis may fail with this on.",
      ),
      h("h2", {}, "Private terms (optional)"),
      h("label", { for: "terms" }, "Names and places you'd rather not send. Each is swapped for a placeholder before a request leaves, and swapped back when the analysis returns."),
      h("textarea", { id: "terms", rows: 6, placeholder: "Sarah = sister\nDr. Patel\nAcme Corp = workplace\nMaple Street = place" }, s.privateTerms),
      h("p", { class: "fine" }, "One per line. Anything not listed is sent as written. A name becomes Person A, Person B and so on. Add = and a label for a place, or to say who someone is: Sarah = sister becomes sister A."),
      h("h2", {}, "Locking"),
      h("label", { for: "autolock" }, "Lock after this many idle minutes"),
      h("input", { id: "autolock", type: "number", min: 1, max: 240, value: s.autoLockMinutes }),
      h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Save settings"), state.settingsSaved ? h("span", { class: "muted", role: "status" }, "Saved.") : null),
    ),
    passphraseView(),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Export"),
      h("p", { class: "muted" }, "Download every dream, analysis and receipt as one JSON file. The copy isn't encrypted, so anyone who opens it can read your dreams."),
      h("div", { class: "row" }, h("button", { class: "secondary", onclick: exportJournal }, "Download a copy")),
    ),
    ledgerView(),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "Where things live"),
      h("dl", { class: "plain" }, pair("Journal file", state.status?.file), pair("ZeroSignal proxy", state.status?.proxy)),
      h(
        "p",
        { class: "fine" },
        "The file is encrypted with a key derived from your passphrase (scrypt, then AES-256-GCM). Payments for analysis are public on-chain, so an operator could tell that several requests came from the same wallet, though not whose wallet it is.",
      ),
    ),
  );
}

async function onSaveSettings(e) {
  e.preventDefault();
  const body = {
    model: $("#model").value,
    relayRequired: $("#relay").checked,
    requireTee: $("#tee").checked,
    privateTerms: $("#terms").value,
    autoLockMinutes: Number($("#autolock").value),
  };
  try {
    setJournal((await api("PUT", "/api/settings", body)).journal);
    state.settingsSaved = true;
    state.notice = null;
  } catch (err) {
    if (err.message !== "locked") state.notice = err.message;
  }
  render();
}

function passphraseView() {
  return h(
    "form",
    { class: "card settings", onsubmit: onChangePassphrase },
    h("h2", {}, "Passphrase"),
    h("label", { for: "current-pass" }, "Current passphrase"),
    h("input", { id: "current-pass", type: "password", required: true, autocomplete: "current-password" }),
    h("label", { for: "new-pass" }, "New passphrase"),
    h("input", { id: "new-pass", type: "password", required: true, minlength: 8, autocomplete: "new-password" }),
    h("label", { for: "confirm-pass" }, "Confirm new passphrase"),
    h("input", { id: "confirm-pass", type: "password", required: true, autocomplete: "new-password" }),
    h("p", { class: "error", role: "alert" }),
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Change passphrase"), state.passphraseChanged ? h("span", { class: "muted", role: "status" }, "Changed.") : null),
    h("p", { class: "fine" }, "The journal and its backup copy are encrypted again under the new passphrase, so the old one opens neither. The new one can't be recovered either."),
  );
}

async function onChangePassphrase(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector("button");
  const error = form.querySelector(".error");
  const next = $("#new-pass").value;
  if (next !== $("#confirm-pass").value) {
    error.textContent = "The new passphrases don't match.";
    return;
  }
  button.disabled = true;
  button.textContent = "Encrypting again…";
  error.textContent = "";
  try {
    await api("POST", "/api/passphrase", { current: $("#current-pass").value, next });
    state.passphraseChanged = true;
    render();
  } catch (err) {
    if (err.message === "locked") return;
    error.textContent = err.message;
    button.disabled = false;
    button.textContent = "Change passphrase";
  }
}

// A plain copy of the whole journal, saved by the browser.
function exportJournal() {
  const { analyzing, rev, ...journal } = state.journal;
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), ...journal }, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = h("a", { href: url, download: `dream-journal-${today()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function ledgerView() {
  const rows = [...state.journal.ledger].reverse();
  return h(
    "section",
    { class: "card" },
    h("h2", {}, "Ledger"),
    h("p", { class: "muted" }, `${rows.length} ${rows.length === 1 ? "request" : "requests"}, ${usd(total(rows))} in total. Every request this journal has paid for, newest first.`),
    rows.length
      ? h(
          "div",
          { class: "table-wrap" },
          h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["When", "What", "Model", "Operator", "Tokens in / out", "Cost"].map((t) => h("th", { scope: "col" }, t)))),
            h(
              "tbody",
              {},
              rows.map((r) =>
                h(
                  "tr",
                  {},
                  h("td", {}, new Date(r.at).toLocaleString()),
                  h("td", {}, r.kind),
                  h("td", { class: "mono" }, r.model),
                  h("td", {}, r.operator != null ? `${r.operator}:${r.node}` : "n/a"),
                  h("td", { class: "num" }, `${num(r.inputTokens)} / ${num(r.outputTokens)}`),
                  h("td", { class: "num" }, usd(r.usd)),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

// -------------------------------------------------------------------- clock

// The page locks itself after the idle minutes in Settings, so a journal left
// open doesn't stay on screen. Reading needs no requests, so while someone is
// active it tells the server they're still there, at most once a minute.
let lastActivity = Date.now();
let lastPing = 0;

function onActivity() {
  lastActivity = Date.now();
  if (state.token && lastActivity - lastPing > 60_000) {
    lastPing = lastActivity;
    api("POST", "/api/ping").catch(() => {});
  }
}
for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "scroll"]) {
  addEventListener(type, onActivity, { capture: true, passive: true });
}

setInterval(() => {
  if (!state.journal) return;
  const minutes = state.journal.settings.autoLockMinutes;
  if (Date.now() - lastActivity < minutes * 60_000) return;
  api("POST", "/api/lock").catch(() => {});
  lockLocal(`Locked after ${minutes} idle ${minutes === 1 ? "minute" : "minutes"}. Your draft is kept.`);
}, 10_000);

// The composer's date follows the calendar unless someone picked another day,
// so a page left open overnight still dates the next dream today.
let day = today();
setInterval(() => {
  if (today() === day) return;
  day = today();
  for (const input of document.querySelectorAll('input[type="date"]')) input.max = day;
  const draftDate = $("#dream-date");
  if (draftDate && !state.draftDate) draftDate.value = day;
}, 30_000);

// --------------------------------------------------------------------- boot

(async () => {
  try {
    state.status = await api("GET", "/api/status");
  } catch (err) {
    state.lockMessage = err.message;
  }
  render();
})();
