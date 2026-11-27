// STITCH admin console. Talks only to its own /api on this origin.
// Everything from a submission is put on the page with textContent, never as HTML.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) n.append(kid);
    return n;
  };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "x-stitch": "1", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && path !== "/api/verify") { showSignin(); throw Object.assign(new Error("signed out"), { quiet: true }); }
    if (!res.ok) throw Object.assign(new Error(data.error || "That did not work."), { data, status: res.status });
    return data;
  }

  const ADL = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Adelaide", dateStyle: "medium", timeStyle: "short" });
  const HM = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Adelaide", hour: "numeric", minute: "2-digit" });
  function ago(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    return ADL.format(new Date(iso));
  }

  // ------------------------------------------------------------ sign in
  let signinEmail = "";
  function showSignin() {
    stopLive();
    $("app").hidden = true;
    $("signin").hidden = false;
    if ($("drawer").open) $("drawer").close();
    $("emailForm").hidden = false; $("codeForm").hidden = true;
    $("email").focus();
  }
  $("emailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $("signinMsg").textContent = "Please enter your email address."; return; }
    const btn = e.submitter || e.target.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      await api("POST", "/api/login", { email });
      signinEmail = email;
      $("codeHint").textContent = "If " + email + " can sign in, a 6-digit code is on its way. It works for 10 minutes. Check spam if it is not there in a minute.";
      $("emailForm").hidden = true; $("codeForm").hidden = false; $("signinMsg").textContent = "";
      $("code").value = ""; $("code").focus();
    } catch (err) { if (!err.quiet) $("signinMsg").textContent = err.message; }
    finally { btn.disabled = false; }
  });
  $("codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("code").value.replace(/\D/g, "");
    if (code.length !== 6) { $("signinMsg").textContent = "The code is 6 digits."; return; }
    const btn = e.submitter || e.target.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      await api("POST", "/api/verify", { email: signinEmail, code });
      $("signinMsg").textContent = "";
      start();
    } catch (err) { if (!err.quiet) $("signinMsg").textContent = err.message; }
    finally { btn.disabled = false; }
  });
  let autoSent = "";
  $("code").addEventListener("input", () => {
    const v = $("code").value.replace(/\D/g, "");
    if (v.length === 6 && v !== autoSent) { autoSent = v; $("codeForm").requestSubmit(); }
  });
  $("again").addEventListener("click", () => { $("codeForm").hidden = true; $("emailForm").hidden = false; $("signinMsg").textContent = ""; $("email").focus(); });
  $("logout").addEventListener("click", async () => { try { await api("POST", "/api/logout"); } catch {} showSignin(); });

  // ------------------------------------------------------------ live
  let liveTimer = null, lastOk = 0, version = -1, first = true;
  const prev = {};
  function setStat(id, value) {
    const node = $(id);
    const v = String(value);
    if (prev[id] !== undefined && prev[id] !== v) {
      node.parentElement.classList.remove("flash"); void node.offsetWidth; node.parentElement.classList.add("flash");
    }
    prev[id] = v; node.textContent = v;
  }
  const PAGE_NAMES = { home: "Home", info: "Info", links: "Links", directory: "Directory", sponsors: "Sponsors", other: "Other" };
  async function tick() {
    try {
      const d = await api("GET", "/api/live");
      lastOk = Date.now();
      setStat("sOnline", d.presence.total);
      setStat("sForm", d.presence.form);
      setStat("sUploading", Math.max(d.presence.uploading, d.pipeline.uploading.length));
      setStat("sPeople", d.totals.people);
      setStat("sWaiting", d.totals.directory?.waiting ?? 0);
      setStat("sQueue", d.pipeline.comingDown.waiting + d.pipeline.comingDown.transferring);
      const pages = Object.entries(d.presence.byPage).sort((a, b) => b[1] - a[1]).map(([p, n]) => (PAGE_NAMES[p] || p) + " " + n);
      $("pages").textContent = pages.length ? "Right now: " + pages.join(" · ") + (d.presence.submitted ? " · just submitted " + d.presence.submitted : "") : "Nobody on the site right now.";
      $("feed").replaceChildren(...(d.activity.length ? d.activity.slice(0, 25).map((a) => el("li", { class: a.kind }, el("time", { datetime: a.at, title: ADL.format(new Date(a.at)), text: HM.format(new Date(a.at)) }), a.text)) : [el("li", { text: "Nothing yet since the last restart." })]));
      const pipe = [];
      for (const u of d.pipeline.uploading) pipe.push(el("li", {}, u.name + " · " + u.mb + " MB · started " + ago(u.since)));
      if (d.pipeline.comingDown.waiting || d.pipeline.comingDown.transferring) pipe.push(el("li", { text: d.pipeline.comingDown.waiting + " waiting to come down from R2 (" + d.pipeline.comingDown.waitingMB + " MB), " + d.pipeline.comingDown.transferring + " coming down now" }));
      if (d.pipeline.lastTransferError) pipe.push(el("li", { class: "failed", text: "Last transfer error " + ago(d.pipeline.lastTransferError.at) + ": " + d.pipeline.lastTransferError.error }));
      if (d.totals.flagged) pipe.push(el("li", { class: "failed", text: d.totals.flagged + " file(s) flagged: see Problems" }));
      $("pipeline").replaceChildren(...(pipe.length ? pipe : [el("li", { text: "Idle. Nothing uploading or waiting." })]));
      $("usage").textContent = d.usage ? d.usage.devices24h + " devices in the last 24 h · " + d.usage.visits + " page views since " + ADL.format(new Date(d.usage.startedAt)) : "Counters unavailable.";
      if (d.version !== version) { version = d.version; await loadSubs(); }
    } catch (err) {
      if (err.quiet) return;
    }
    paintPulse();
  }
  function paintPulse() {
    const p = $("pulse"), age = (Date.now() - lastOk) / 1000;
    const on = lastOk && age < 12;
    p.className = "pulse " + (on ? "on" : "off");
    $("pulseText").textContent = on ? "Live · updated " + (age < 2 ? "just now" : Math.round(age) + " s ago") : "Not updating. Check your connection.";
  }
  setInterval(paintPulse, 1000);
  function startLive() { stopLive(); tick(); liveTimer = setInterval(tick, 3000); }
  function stopLive() { clearInterval(liveTimer); liveTimer = null; }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("app").hidden) tick(); });

  // ------------------------------------------------------------ submissions
  let subs = [], filter = "latest", known = new Set();
  const IMAGES = [["poster", "posterWeb", "Image 1"], ["poster2", "posterWeb2", "Image 2"], ["poster3", "posterWeb3", "Image 3"]];
  const imagesOf = (s) => IMAGES.filter(([k]) => s.files[k]).length;
  const problemsOf = (s) => Object.entries(s.files).filter(([, f]) => f.problem).map(([k, f]) => k + ": " + f.problem);
  const STATE = { uploading: "Uploading", uploaded: "Coming down", stored: "Saved", failed: "Failed", abandoned: "Abandoned" };
  const DIR = { live: ["In directory", "ok"], waiting: ["Waiting review", "red"], hidden: ["Hidden", "mute"], private: ["Not listed", "mute"] };
  const FILTERS = {
    latest: (s) => s.latest,
    exhibit: (s) => s.latest && s.exhibit,
    waiting: (s) => s.latest && s.status === "waiting",
    live: (s) => s.latest && s.status === "live",
    declined: (s) => s.latest && s.declined,
    problems: (s) => (s.latest && problemsOf(s).length) || s.state === "failed",
    all: () => true,
  };
  async function loadSubs() {
    const d = await api("GET", "/api/submissions");
    const fresh = new Set();
    if (!first) for (const s of d.submissions) if (!known.has(s.id)) fresh.add(s.id);
    known = new Set(d.submissions.map((s) => s.id));
    subs = d.submissions;
    first = false;
    render(fresh);
    if ($("drawer").open && current) {
      const s = subs.find((x) => x.id === current.id);
      if (!s) { $("drawer").close(); return; }
      if (!dirty()) fill(s); else current = s;
    }
  }
  function render(fresh = new Set()) {
    const q = $("search").value.trim().toLowerCase();
    for (const b of $("chips").querySelectorAll("button")) {
      const n = subs.filter(FILTERS[b.dataset.f]).length;
      let span = b.querySelector(".n");
      if (!span) { span = el("span", { class: "n" }); b.append(span); }
      span.textContent = n;
      b.setAttribute("aria-pressed", String(b.dataset.f === filter));
    }
    const list = subs.filter(FILTERS[filter]).filter((s) => !q || [s.name, s.email, s.title, s.degree].join(" ").toLowerCase().includes(q));
    $("empty").hidden = list.length > 0;
    $("rows").replaceChildren(...list.map((s) => {
      const probs = problemsOf(s);
      const dir = s.declined ? ["—", "mute"] : s.state === "stored" ? (DIR[s.status] || (s.listed ? ["Asked", "red"] : ["Not listed", "mute"])) : [s.listed ? "Asked" : "No", "mute"];
      const tr = el("tr", { class: fresh.has(s.id) ? "fresh" : "", tabindex: "0", "aria-label": "Open " + s.name },
        el("td", { class: "name" }, s.name, s.title ? el("span", { class: "sub", text: s.title }) : null, !s.latest && s.state === "stored" ? el("span", { class: "sub", text: "earlier attempt" }) : null),
        el("td", { text: s.email }),
        el("td", {}, s.declined ? el("span", { class: "tag mute", text: "No to both" }) : el("span", { class: "tag " + (s.exhibit ? "ok" : "mute"), text: s.exhibit ? "Yes" : "No" })),
        el("td", {}, el("span", { class: "tag " + dir[1], text: dir[0] })),
        el("td", { text: s.declined ? "—" : (s.files.photo ? "Headshot" : "No headshot") + ", " + imagesOf(s) + " img" }),
        el("td", {}, el("span", { class: "tag " + (s.state === "stored" ? (probs.length ? "red" : "ok") : s.state === "failed" || s.state === "abandoned" ? "red" : "mute"), text: probs.length ? "Problem" : STATE[s.state] || s.state })),
        el("td", { title: ADL.format(new Date(s.completedAt || s.submittedAt)), text: ago(s.completedAt || s.submittedAt) }),
      );
      const open = () => openDrawer(s.id);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      return tr;
    }));
  }
  $("search").addEventListener("input", () => render());
  $("chips").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (b) { filter = b.dataset.f; render(); } });

  // ------------------------------------------------------------ editor
  let current = null, original = null;
  const form = $("edit");
  const FIELDS = ["name", "email", "exhibit", "listed", "degree", "title", "overview", "linkedin", "instagram", "website", "from"];
  const read = () => Object.fromEntries(FIELDS.map((k) => [k, form.elements[k].type === "checkbox" ? form.elements[k].checked : form.elements[k].value]));
  const dirty = () => original && FIELDS.some((k) => read()[k] !== original[k]);

  function openDrawer(id) {
    const s = subs.find((x) => x.id === id);
    if (!s) return;
    $("dMsg").textContent = ""; $("dMsg").className = "msg";
    $("dConfirm").value = "";
    form.querySelector(".danger").open = false;
    fill(s);
    if (!$("drawer").open) $("drawer").showModal();
    $("dClose").focus();
  }
  function fill(s) {
    current = s;
    $("dState").textContent = (STATE[s.state] || s.state) + (s.latest ? "" : s.state === "stored" ? " · an earlier attempt (the sheet uses their latest)" : "");
    $("dName").textContent = s.name;
    $("dMeta").textContent = "Submitted " + ADL.format(new Date(s.completedAt || s.submittedAt)) + (s.editedAt ? " · last edited " + ago(s.editedAt) + " by " + s.editedBy : "") + " · " + s.id;
    for (const k of FIELDS) {
      const f = form.elements[k];
      if (f.type === "checkbox") f.checked = !!s[k]; else f.value = s[k] ?? "";
      f.removeAttribute("aria-invalid");
    }
    original = read();
    // Files
    const figs = [];
    const photo = s.files.photo;
    figs.push(el("figure", {}, photo && photo.viewable ? el("img", { src: "/api/media/" + s.id + "/photo", alt: "Headshot of " + s.name }) : el("div", { class: "noimg", text: photo ? (photo.problem || "Still coming down") : "No headshot" }), el("figcaption", { text: "Headshot" })));
    for (const [k, web, label] of IMAGES) {
      const f = s.files[k];
      if (!f) continue;
      const w = s.files[web];
      figs.push(el("figure", {},
        w && w.viewable ? el("img", { class: "wide", src: "/api/media/" + s.id + "/" + web, alt: label + " of " + s.name }) : el("div", { class: "noimg", text: f.problem || (f.stored ? "No web copy" : "Still coming down") }),
        el("figcaption", {}, label + (f.size ? " · " + (f.size / 1048576).toFixed(1) + " MB" : "")),
        f.viewable ? el("a", { href: "/api/media/" + s.id + "/" + k, text: "Download PNG" }) : null,
        el("button", { type: "button", class: "link", text: "Remove", onclick: () => removeImage(k, label) }),
      ));
    }
    $("dMedia").replaceChildren(...(s.declined ? [el("p", { class: "hint", text: "Said no to exhibiting and to the directory, so nothing else was asked." })] : figs));
    // Review
    const rv = [];
    if (s.state === "stored" && s.listed) {
      const word = s.decision === "approved" ? "Approved: in the directory" : s.decision === "hidden" ? "Hidden from the directory" : "Waiting for review";
      rv.push(el("span", { class: "tag " + (s.decision === "approved" ? "ok" : s.decision === "hidden" ? "mute" : "red"), text: word }));
      if (s.decision !== "approved") rv.push(el("button", { type: "button", class: "btn", text: "[ Approve ]", onclick: () => decide("approve") }));
      if (s.decision !== "hidden") rv.push(el("button", { type: "button", class: "btn ghost", text: "[ Hide ]", onclick: () => decide("hide") }));
      if (s.decision) rv.push(el("button", { type: "button", class: "link", text: "Back to waiting", onclick: () => decide("clear") }));
      if (!s.latest) rv.push(el("span", { class: "hint", text: "The directory follows their latest submission." }));
    } else if (s.state === "stored") rv.push(el("span", { class: "hint", text: "Not asking to be in the Student Directory." }));
    $("dReview").replaceChildren(...rv);
    // History
    const others = subs.filter((x) => x.id !== s.id && x.name.toLowerCase() === s.name.toLowerCase());
    $("dHistory").hidden = !others.length;
    $("dHistory").querySelector("ul").replaceChildren(...others.map((o) => el("li", {}, el("button", { type: "button", class: "link", text: ADL.format(new Date(o.completedAt || o.submittedAt)) + " · " + (STATE[o.state] || o.state) + (o.latest ? " · latest" : ""), onclick: () => openDrawer(o.id) }))));
  }
  function say(text, ok) { $("dMsg").textContent = text; $("dMsg").className = "msg" + (ok ? " ok" : ""); }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const now = read(), changes = {};
    for (const k of FIELDS) if (now[k] !== original[k]) changes[k] = now[k];
    if (!Object.keys(changes).length) { say("Nothing has changed."); return; }
    for (const k of FIELDS) form.elements[k].removeAttribute("aria-invalid");
    try {
      const r = await api("PATCH", "/api/submissions/" + current.id, changes);
      original = now;
      say("Saved: " + r.changed.join(", ") + ".", true);
      await loadSubs();
    } catch (err) {
      if (err.quiet) return;
      if (err.data?.fields) for (const [k, m] of Object.entries(err.data.fields)) { form.elements[k]?.setAttribute("aria-invalid", "true"); }
      say(err.data?.fields ? Object.entries(err.data.fields).map(([k, m]) => k + ": " + m).join(" ") : err.message);
    }
  });
  $("dRevert").addEventListener("click", () => { fill(current); say(""); });
  async function decide(action) {
    try { await api("POST", "/api/submissions/" + current.id + "/" + action); say(action === "approve" ? "Approved." : action === "hide" ? "Hidden." : "Back to waiting.", true); await loadSubs(); }
    catch (err) { if (!err.quiet) say(err.message); }
  }
  async function removeImage(kind, label) {
    const fig = [...$("dMedia").querySelectorAll("figure")].find((f) => f.textContent.includes(label));
    const btn = fig && [...fig.querySelectorAll("button")].find((b) => b.textContent.startsWith("Remove"));
    if (btn && btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Remove for good?"; setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = "Remove"; } }, 4000); return; }
    try { await api("DELETE", "/api/submissions/" + current.id + "/files/" + kind); say(label + " removed.", true); await loadSubs(); }
    catch (err) { if (!err.quiet) say(err.message); }
  }
  $("dDelete").addEventListener("click", async () => {
    if ($("dConfirm").value !== current.name) { say("Type the name exactly as shown to delete."); $("dConfirm").focus(); return; }
    try { await api("DELETE", "/api/submissions/" + current.id, { confirm: $("dConfirm").value }); $("drawer").close(); await loadSubs(); }
    catch (err) { if (!err.quiet) say(err.message); }
  });
  const UNSAVED = "You have unsaved edits. Save them, or press Undo my edits, then close.";
  $("dClose").addEventListener("click", () => { if (dirty()) say(UNSAVED); else $("drawer").close(); });
  $("drawer").addEventListener("cancel", (e) => { if (dirty()) { e.preventDefault(); say(UNSAVED); } });
  $("drawer").addEventListener("click", (e) => { if (e.target === $("drawer")) $("dClose").click(); });

  // ------------------------------------------------------------ change log
  $("auditBtn").addEventListener("click", async () => {
    const list = $("audit");
    if (!list.hidden) { list.hidden = true; return; }
    try {
      const d = await api("GET", "/api/audit");
      list.replaceChildren(...(d.entries.length ? d.entries.slice(0, 100).map((a) => el("li", { class: "admin" },
        el("time", { text: ADL.format(new Date(a.at)) }),
        a.by.split("@")[0] + " " + a.action + (a.name ? " " + a.name : "") + (a.after ? ": " + Object.keys(a.after).join(", ") : ""))) : [el("li", { text: "No changes yet." })]));
      list.hidden = false;
    } catch {}
  });

  // ------------------------------------------------------------ start
  async function start() {
    const me = await api("GET", "/api/me").catch(() => ({}));
    if (!me.email) return showSignin();
    $("me").textContent = me.email;
    $("signin").hidden = true; $("app").hidden = false;
    first = true; version = -1;
    startLive();
  }
  start();
})();
