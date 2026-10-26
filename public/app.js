const $ = (sel) => document.querySelector(sel);

const PRESENT_STEPS = [
  { title: "Full book of business" },
  { title: "Cases needing follow-up" },
  { title: "Focus on one case" },
  { title: "Run follow-up" },
  { title: "Thread: status request" },
  { title: "Thread: attorney reply" },
  { title: "Thread: LienPilot decision" },
  { title: "Thread: clinic CC" },
  { title: "Updated case" },
];

let state = { liens: [], threshold: 30 };

let present = {
  active: false,
  step: 0,
  focusSnapshot: null,
  result: null,
  running: false,
};

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function money(n) {
  return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const STATUS_CLASS = {
  "Unknown": "neutral",
  "Case Ongoing": "neutral",
  "Settlement Pending": "amber",
  "Payment Pending": "blue",
  "Payment Sent": "green",
  "Paid": "green",
  "Closed / Uncollectible": "red",
};

function badge(status) {
  if (!status) return `<span class="badge badge-neutral">—</span>`;
  const cls = STATUS_CLASS[status] || "neutral";
  return `<span class="badge badge-${cls}">${escapeHtml(status)}</span>`;
}

function actionPill(action) {
  const a = (action || "").trim();
  if (!a || a === "None") return `<span class="muted">—</span>`;
  return `<span class="action-pill">${escapeHtml(a)}</span>`;
}

/** Open clinic requests, each with the contact who owns it; falls back to the action pill. */
function requestsHtml(l) {
  const open = l.open_requests || [];
  if (!open.length) return actionPill(l.action_needed);
  return `<ul class="request-list">${open.map((r) => `
    <li title="Asked ${escapeHtml(r.opened || "earlier")}${r.last_asked && r.last_asked !== r.opened ? `, chased ${escapeHtml(r.last_asked)}` : ""}">
      <span class="action-pill">${escapeHtml(r.category)}</span>
      <span class="request-text">${escapeHtml(r.text === r.category ? "" : r.text)}</span>
      <span class="request-owner">→ ${escapeHtml(r.owner)}</span>
    </li>`).join("")}</ul>`;
}

function formatNotes(raw) {
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function notesPreview(raw) {
  const lines = formatNotes(raw).split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const FINAL_STATUSES = ["Payment Sent", "Paid", "Closed / Uncollectible"];

function isOverdue(l) {
  // Mirrors isDueForFollowup on the server: any non-final status (blank
  // included), no open clinic action, and never contacted or 30+ days.
  if (FINAL_STATUSES.includes(l.status) || l.action_needed) return false;
  return l.days_since_contact == null || l.days_since_contact >= state.threshold;
}

function pickFeaturedLien(overdue) {
  if (!overdue.length) return null;

  // One representative per reply template, then rotate which template Present deep-dives.
  const byTemplate = new Map();
  for (const l of overdue) {
    const key = l.reply_template_id || `id:${l.id}`;
    if (!byTemplate.has(key)) byTemplate.set(key, l);
  }
  const keys = [...byTemplate.keys()].sort();
  const idx = Number(localStorage.getItem("lienpilot_present_template_i") || 0);
  const key = keys[idx % keys.length];
  localStorage.setItem("lienpilot_present_template_i", String(idx + 1));
  return byTemplate.get(key) || overdue[0];
}

function lienRowHtml(l, { forceDays } = {}) {
  const days = forceDays != null ? forceDays : l.days_since_contact;
  const overdue = forceDays == null && isOverdue(l);
  const daysLabel = days == null ? "Never" : days;
  const daysCell = overdue
    ? `<span class="days-flag">${daysLabel} ⚠</span>`
    : daysLabel;
  const noteText = formatNotes(l.notes || "");
  const preview = notesPreview(l.notes || "");
  const notes = noteText
    ? `<details class="notes"><summary class="notes-preview" title="${escapeHtml(noteText)}">${escapeHtml(preview)}</summary><pre>${escapeHtml(noteText)}</pre></details>`
    : `<span class="muted">—</span>`;
  const actions = overdue
    ? `<td class="row-actions">
         <button type="button" class="btn ghost btn-row" data-sim-one="${l.id}" title="Simulate one follow-up (canned reply)">Sim</button>
         <button type="button" class="btn primary btn-row" data-send-one="${l.id}" title="Send one real status request" ${liveEmail ? "" : "disabled"}>Send</button>
       </td>`
    : `<td class="row-actions muted">—</td>`;
  return `
    <tr class="${overdue ? "overdue" : ""}">
      <td>${escapeHtml(l.patient_name)}</td>
      <td>${escapeHtml(l.clinic_name)}</td>
      <td>${escapeHtml(l.firm_name || l.attorney_name)}</td>
      <td class="num">${money(l.lien_amount)}</td>
      <td class="num">${daysCell}</td>
      <td>${badge(l.status)}${l.awaiting_reply ? ` <span class="await-pill" title="Real status request sent; waiting on the attorney">Awaiting reply</span>` : ""}</td>
      <td>${requestsHtml(l)}</td>
      <td class="notes-cell">${notes}</td>
      ${actions}
    </tr>`;
}

function renderTable(liens, { hint, countLabel } = {}) {
  const list = liens || state.liens;
  $("#lien-count").textContent = countLabel || `(${list.length})`;
  if (hint != null) {
    $(".panel-hint").innerHTML = hint;
  }
  $("#liens-body").innerHTML = list.map((l) => lienRowHtml(l)).join("");
}

function focusCardHtml(l, { daysOverride, statusOverride, actionOverride } = {}) {
  const days = daysOverride != null ? daysOverride : l.days_since_contact;
  const status = statusOverride != null ? statusOverride : l.status;
  const action = actionOverride != null ? actionOverride : (l.action_needed || "");
  return `
    <div class="focus-card">
      <dl>
        <dt>Patient</dt><dd>${escapeHtml(l.patient_name)}</dd>
        <dt>Clinic</dt><dd>${escapeHtml(l.clinic_name)}</dd>
        <dt>Firm</dt><dd>${escapeHtml(l.firm_name || l.attorney_name)}</dd>
        <dt>Amount</dt><dd>${money(l.lien_amount)}</dd>
        <dt>Days since contact</dt><dd><strong>${days == null ? "Never contacted" : days}</strong></dd>
        <dt>Status</dt><dd>${badge(status)}</dd>
        <dt>Action needed</dt><dd>${actionPill(action)}</dd>
        <dt>Activity</dt><dd><pre>${escapeHtml(formatNotes(l.notes || "") || "—")}</pre></dd>
      </dl>
    </div>`;
}

/** Growing email thread for present steps 5–8 (indices 4–7). */
function emailThreadHtml(r, { showReply = false, showDecision = false, showCc = false } = {}) {
  const focus = present.focusSnapshot || {};
  const subject = r.outbound?.subject || "(no subject)";
  const attorneyFrom = focus.attorney_email || focus.attorney_name || "attorney";
  const attorneyName = focus.attorney_name || "Attorney";
  const internalNote = (r.triage && r.triage.internal_note) || "";

  let messages = "";

  messages += `
    <article class="thread-msg thread-msg-out ${showReply || showDecision || showCc ? "" : "thread-msg-new"}">
      <div class="thread-msg-head">
        <span class="thread-from">LienPilot</span>
        <span class="sep">→</span>
        <span class="thread-to">${escapeHtml(r.outbound.to)}</span>
      </div>
      <pre class="thread-body">${escapeHtml(r.outbound.body)}</pre>
    </article>`;

  if (showReply) {
    messages += `
    <article class="thread-msg thread-msg-reply ${showDecision || showCc ? "" : "thread-msg-new"}">
      <div class="thread-msg-head">
        <span class="thread-from">${escapeHtml(attorneyName)}</span>
        <span class="sep">→</span>
        <span class="thread-to">LienPilot</span>
      </div>
      <div class="thread-meta">From: ${escapeHtml(attorneyFrom)}</div>
      <pre class="thread-body">${escapeHtml(r.reply)}</pre>
    </article>`;
  }

  if (showDecision) {
    messages += `
    <aside class="internal-note ${showCc ? "" : "thread-msg-new"}">
      <div class="internal-note-label">LienPilot internal note</div>
      <p class="internal-note-text">${escapeHtml(internalNote || "—")}</p>
    </aside>`;
  }

  if (showCc) {
    const ccs = r.clinic_ccs || (r.clinic_cc ? [r.clinic_cc] : []);
    if (ccs.length) {
      for (const cc of ccs) {
        messages += `
    <article class="thread-msg thread-msg-out thread-msg-cc thread-msg-new">
      <div class="thread-msg-head">
        <span class="thread-from">LienPilot</span>
        <span class="sep">→</span>
        <span class="thread-to">${escapeHtml(cc.cc_name ? `${cc.cc_name} <${cc.to}>` : cc.to)}</span>
        <span class="muted">(${cc.kind === "follow-up" ? "following up" : "adding clinic to thread"})</span>
      </div>
      <div class="thread-meta">Subject: ${escapeHtml(cc.subject || subject)}</div>
      <pre class="thread-body">${escapeHtml(cc.body)}</pre>
    </article>`;
      }
    } else {
      messages += `
    <aside class="internal-note thread-msg-new">
      <div class="internal-note-label">No clinic CC</div>
      <p class="internal-note-text">Nothing required from the clinic. Contact clock will reset.</p>
    </aside>`;
    }
  }

  return `
    <div class="email-thread">
      <div class="thread-subject">Subject: ${escapeHtml(subject)}</div>
      <div class="thread-stream">${messages}</div>
    </div>`;
}

function renderRunReport(data) {
  const panel = $("#run-report");
  const box = $("#run-results");
  const count = $("#run-count");

  if (!data.results?.length) {
    panel.classList.remove("hidden");
    count.textContent = "";
    box.innerHTML = `<p class="hint">No liens are due (open, no pending clinic action, and never contacted or ${state.threshold}+ days since contact). Try “+15 days”, then run again.</p>`;
    return;
  }

  count.textContent = `(${data.results.length})`;
  panel.classList.remove("hidden");
  box.innerHTML = data.results.map((r) => {
    const triage = r.triage || {};
    const actionTag = triage.action_needed && triage.action_needed !== "None"
      ? actionPill(triage.action_needed) : "";
    const ccs = r.clinic_ccs || (r.clinic_cc ? [r.clinic_cc] : []);
    const next = ccs.length
      ? ccs.map((cc) => `<div class="run-next run-next-cc"><span class="run-next-label">Next</span>
           ${cc.kind === "follow-up" ? "Follow up with" : "CC"} ${escapeHtml(cc.cc_name || "clinic contact")} — <strong>${escapeHtml(cc.to)}</strong>
           <pre>${escapeHtml(cc.body)}</pre></div>`).join("")
      : `<div class="run-next"><span class="run-next-label">Next</span>
           No clinic action — contact clock reset (chase again after ${state.threshold} days).</div>`;

    return `
      <article class="run-card">
        <div class="run-card-head">
          <strong class="run-patient">${escapeHtml(r.patient_name)}</strong>
          ${badge(triage.status || r.lien?.status || "—")}${actionTag}
        </div>
        <div class="run-block">
          <div class="run-label">Status request sent</div>
          <div class="meta">To: ${escapeHtml(r.outbound.to)} · ${escapeHtml(r.outbound.subject)}</div>
          <pre>${escapeHtml(r.outbound.body)}</pre>
        </div>
        <div class="run-block">
          <div class="run-label">Attorney reply (simulated)</div>
          <pre>${escapeHtml(r.reply)}</pre>
        </div>
        <div class="run-block">
          <div class="run-label">LienPilot decision</div>
          <div class="decision">
            <div class="decision-tags">${badge(triage.status)}${actionTag}</div>
            <p class="decision-note">${escapeHtml(triage.internal_note || "—")}</p>
          </div>
        </div>
        ${next}
      </article>`;
  }).join("");
}

async function load() {
  const data = await api("/api/liens");
  state.liens = data.liens;
  state.threshold = data.threshold_days;
  $("#clock-label").textContent =
    `Today: ${data.today}` + (data.clock_offset_days ? ` (+${data.clock_offset_days}d simulated)` : "");
  setLiveStatus(data.live_email, data.email_provider);
  if (!present.active) {
    renderTable(state.liens, {
      hint: "LienPilot emails every open lien that's gone quiet, triages each reply with Claude, CCs the clinic when they must act, and tracks the clinic's follow-through.",
    });
  }
  return data;
}

async function ensureOverdueLiens() {
  const maxAdvances = 8;
  for (let i = 0; i < maxAdvances; i++) {
    const overdue = state.liens.filter(isOverdue);
    if (overdue.length) return overdue;
    await api("/api/advance-clock", { method: "POST", body: JSON.stringify({ days: 15 }) });
    await load();
  }
  return state.liens.filter(isOverdue);
}

function setPresentChrome() {
  const step = present.step;
  const meta = PRESENT_STEPS[step];
  $("#present-step-label").textContent =
    `Step ${step + 1} of ${PRESENT_STEPS.length} — ${meta.title}`;
  $("#present-back").disabled = step === 0 || present.running;
  const nextBtn = $("#present-next");
  if (step >= PRESENT_STEPS.length - 1) {
    nextBtn.textContent = "Done";
  } else if (step === 3 && !present.result) {
    nextBtn.textContent = present.running ? "Running…" : "Run & Next";
  } else {
    nextBtn.textContent = "Next";
  }
  nextBtn.disabled = present.running;
}

function showLiensPanel(show) {
  $(".liens-panel").classList.toggle("hidden", !show);
}

function showPresentStage(html) {
  const stage = $("#present-stage");
  stage.classList.remove("hidden");
  $("#present-stage-body").innerHTML = html;
}

function hidePresentStage() {
  $("#present-stage").classList.add("hidden");
  $("#present-stage-body").innerHTML = "";
}

async function renderPresentStep() {
  const step = present.step;
  setPresentChrome();
  $("#run-report").classList.add("hidden");

  if (step === 0) {
    hidePresentStage();
    showLiensPanel(true);
    renderTable(state.liens, {
      hint: "Full practice book — every open lien LienPilot tracks.",
      countLabel: `(${state.liens.length})`,
    });
    return;
  }

  if (step === 1) {
    hidePresentStage();
    showLiensPanel(true);
    const overdue = state.liens.filter(isOverdue);
    renderTable(overdue, {
      hint: `Only liens due for follow-up (open, never contacted or ≥ ${state.threshold} days of silence) — the ones LienPilot will chase.`,
      countLabel: `(${overdue.length} overdue)`,
    });
    return;
  }

  if (step === 2) {
    showLiensPanel(false);
    const overdue = state.liens.filter(isOverdue);
    if (!present.focusSnapshot) {
      present.focusSnapshot = pickFeaturedLien(overdue);
    }
    const focus = present.focusSnapshot;
    if (!focus) {
      showPresentStage(`<p class="hint">No liens due for follow-up to focus on.</p>`);
      return;
    }
    showPresentStage(`
      <p class="hint">Deep dive — one overdue case LienPilot will follow up on.</p>
      ${focusCardHtml(focus)}
    `);
    return;
  }

  if (step === 3) {
    showLiensPanel(false);
    const focus = present.focusSnapshot;
    if (present.result) {
      showPresentStage(`
        <p class="hint">Follow-up complete for <strong>${escapeHtml(focus.patient_name)}</strong>. Next steps reveal each artifact.</p>
        ${focusCardHtml(focus)}
      `);
    } else if (present.running) {
      showPresentStage(`<p class="hint">Running follow-up for <strong>${escapeHtml(focus.patient_name)}</strong>…</p>`);
    } else {
      showPresentStage(`
        <p class="hint">Ready to run the follow-up on this case (status request → simulated reply → Claude triage → update).</p>
        ${focusCardHtml(focus)}
      `);
    }
    return;
  }

  const r = present.result;
  if (!r && step >= 4) {
    showLiensPanel(false);
    showPresentStage(`<p class="hint">No follow-up result yet. Go back to step 4 and run.</p>`);
    return;
  }

  if (step === 4) {
    showLiensPanel(false);
    showPresentStage(`
      <p class="hint">LienPilot opens the thread with a status request.</p>
      ${emailThreadHtml(r, {})}
    `);
    return;
  }

  if (step === 5) {
    showLiensPanel(false);
    showPresentStage(`
      <p class="hint">Attorney replies in the same thread.</p>
      ${emailThreadHtml(r, { showReply: true })}
    `);
    return;
  }

  if (step === 6) {
    showLiensPanel(false);
    showPresentStage(`
      <p class="hint">LienPilot triages the reply (internal — not sent as email).</p>
      ${emailThreadHtml(r, { showReply: true, showDecision: true })}
    `);
    return;
  }

  if (step === 7) {
    showLiensPanel(false);
    showPresentStage(`
      <p class="hint">${r.clinic_cc ? "Clinic contact is pulled into the thread." : "No clinic action — thread ends here; contact clock resets."}</p>
      ${emailThreadHtml(r, { showReply: true, showDecision: true, showCc: true })}
    `);
    return;
  }

  if (step === 8) {
    showLiensPanel(false);
    await load();
    const updated =
      state.liens.find((l) => l.id === present.focusSnapshot.id) || r.lien;
    showPresentStage(`
      <p class="hint">Same case after the exchange — days since contact is back to 0.</p>
      ${focusCardHtml(updated, {
        daysOverride: updated.days_since_contact,
        statusOverride: updated.status,
        actionOverride: updated.action_needed || "",
      })}
    `);
  }
}

async function runPresentFollowup() {
  const focus = present.focusSnapshot;
  if (!focus) throw new Error("No focused lien.");
  present.running = true;
  setPresentChrome();
  await renderPresentStep();
  try {
    const data = await api("/api/run-followups", {
      method: "POST",
      body: JSON.stringify({ lien_id: focus.id }),
    });
    if (!data.results?.length) throw new Error("No result returned for this lien.");
    present.result = data.results[0];
  } finally {
    present.running = false;
  }
}

async function enterPresent() {
  $("#run-report").classList.add("hidden");
  await load();
  const overdue = await ensureOverdueLiens();
  if (!overdue.length) {
    alert("Could not find any liens due for follow-up after advancing the clock.");
    return;
  }
  present = {
    active: true,
    step: 0,
    focusSnapshot: null,
    result: null,
    running: false,
  };
  document.body.classList.add("presenting");
  $("#present-bar").classList.remove("hidden");
  await renderPresentStep();
}

function exitPresent() {
  present = {
    active: false,
    step: 0,
    focusSnapshot: null,
    result: null,
    running: false,
  };
  document.body.classList.remove("presenting");
  $("#present-bar").classList.add("hidden");
  hidePresentStage();
  showLiensPanel(true);
  load();
}

$("#advance-clock").addEventListener("click", async () => {
  await api("/api/advance-clock", { method: "POST", body: JSON.stringify({ days: 15 }) });
  await load();
});

$("#reset-simulation").addEventListener("click", async () => {
  const btn = $("#reset-simulation");
  btn.disabled = true;
  try {
    await api("/api/reset-simulation", { method: "POST", body: "{}" });
    $("#run-report").classList.add("hidden");
    $("#run-results").innerHTML = "";
    $("#run-count").textContent = "";
    await load();
  } catch (err) {
    alert(`Reset failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

$("#run-followups").addEventListener("click", async () => {
  const btn = $("#run-followups");
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    const data = await api("/api/run-followups", { method: "POST", body: "{}" });
    renderRunReport(data);
    await load();
  } catch (err) {
    const panel = $("#run-report");
    panel.classList.remove("hidden");
    $("#run-count").textContent = "";
    $("#run-results").innerHTML =
      `<p class="hint" style="color:#b91c1c"><strong>Error:</strong> ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
});

// ---- Live email loop -------------------------------------------------------

let liveEmail = false;

function setLiveStatus(on, provider = "") {
  liveEmail = Boolean(on);
  const pill = $("#live-status");
  pill.textContent = liveEmail ? `Live email: on${provider ? ` (${provider})` : ""}` : "Live email: off";
  pill.classList.toggle("on", liveEmail);
  pill.title = liveEmail
    ? `${provider || "Email"} is configured: Send follow-ups emails attorneys and replies are triaged automatically.`
    : "Add GMAIL_USER and GMAIL_APP_PASSWORD to .env to enable real email. Simulate follow-ups still works.";
  const send = $("#send-followups");
  if (!send.classList.contains("loading")) send.disabled = !liveEmail;
  // Refresh row Send buttons when live email flips.
  if (state.liens.length && !present.active) renderTable(state.liens);
}

const ACTIVITY_LABEL = {
  "email-sent": "Email out",
  "email-received": "Email in",
  "llm-request": "Claude call",
  "llm-response": "Claude reply",
  decision: "Decision",
  "cc-sent": "Clinic CC",
  "lien-updated": "DB update",
  error: "Error",
  ignored: "Ignored",
  queued: "Queued",
  import: "Import",
};

// Log entries the user has expanded; kept open across re-renders.
const openLogIds = new Set();

function renderActivity(events) {
  const list = $("#activity-list");
  if (!events.length) {
    list.innerHTML = `<li class="activity-empty hint">${
      liveEmail
        ? "Nothing yet. Send follow-ups, then reply from the attorney's inbox — every step (emails, Claude call, database change) shows up here."
        : "Live email is off. Add GMAIL_USER and GMAIL_APP_PASSWORD to .env to send real status requests; Simulate follow-ups still logs here."
    }</li>`;
    return;
  }
  list.innerHTML = events.map((e) => {
    const type = escapeHtml(e.type);
    const head = `
      <span class="activity-tag">${escapeHtml(ACTIVITY_LABEL[e.type] || e.type)}${e.mode === "simulated" ? ` <span class="sim-tag">sim</span>` : ""}</span>
      <span class="activity-text">${e.patient_name ? `<strong>${escapeHtml(e.patient_name)}</strong> — ` : ""}${escapeHtml(e.detail || "")}</span>
      <time class="activity-time">${new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>`;
    const fields = Object.entries(e.data || {});
    if (!fields.length) {
      return `<li class="activity-item activity-${type}"><div class="activity-row">${head}</div></li>`;
    }
    const rows = fields.map(([key, value]) => `
      <div class="log-key">${escapeHtml(key.replace(/_/g, " "))}</div>
      <pre class="log-val">${escapeHtml(String(value ?? ""))}</pre>`).join("");
    return `
      <li class="activity-item activity-${type}">
        <details data-log-id="${e.id}"${openLogIds.has(e.id) ? " open" : ""}>
          <summary class="activity-row">${head}</summary>
          <div class="log-data">${rows}</div>
        </details>
      </li>`;
  }).join("");
}

// `toggle` doesn't bubble, so listen in the capture phase.
$("#activity-list").addEventListener("toggle", (ev) => {
  const id = Number(ev.target.dataset?.logId);
  if (!id) return;
  if (ev.target.open) openLogIds.add(id);
  else openLogIds.delete(id);
}, true);

// Polls the activity feed; when something new lands (a reply got triaged,
// a send finished) it also refreshes the liens table.
let lastActivityAt; // undefined until the first poll
async function pollActivity({ force = false } = {}) {
  if (!force && (document.hidden || present.active)) return;
  try {
    const data = await api("/api/activity");
    const newest = data.activity[0]?.at || null;
    if (newest === lastActivityAt) return;
    const firstPoll = lastActivityAt === undefined;
    lastActivityAt = newest;
    renderActivity(data.activity);
    if (!firstPoll) await load();
  } catch {
    // server restarting; try again next tick
  }
}

$("#send-followups").addEventListener("click", async () => {
  const btn = $("#send-followups");
  const summary = $("#send-summary");
  btn.disabled = true;
  btn.classList.add("loading");
  try {
    const data = await api("/api/send-followups", { method: "POST", body: "{}" });
    const parts = [`Sent ${data.sent}`];
    if (data.skipped.length) {
      parts.push(`skipped ${data.skipped.length} placeholder address${data.skipped.length === 1 ? "" : "es"}`);
    }
    if (data.errors.length) parts.push(`${data.errors.length} failed`);
    summary.textContent =
      data.sent || data.skipped.length || data.errors.length
        ? parts.join(" · ")
        : `No liens due (open, no pending clinic action, and never contacted or ${state.threshold}+ days since contact).`;
    await load();
    await pollActivity();
  } catch (err) {
    summary.textContent = `Error: ${err.message}`;
  } finally {
    btn.classList.remove("loading");
    btn.disabled = !liveEmail;
  }
});

$("#liens-body").addEventListener("click", async (ev) => {
  // Open notes hide their <summary>, so a second click lands on the <pre>.
  const openNotes = ev.target.closest("details.notes[open]");
  if (openNotes && !ev.target.closest("summary")) {
    openNotes.open = false;
    return;
  }

  const simBtn = ev.target.closest("[data-sim-one]");
  const sendBtn = ev.target.closest("[data-send-one]");
  if (!simBtn && !sendBtn) return;

  const btn = simBtn || sendBtn;
  const lienId = Number(btn.dataset.simOne || btn.dataset.sendOne);
  if (!Number.isFinite(lienId)) return;

  btn.disabled = true;
  try {
    if (simBtn) {
      const data = await api("/api/run-followups", {
        method: "POST",
        body: JSON.stringify({ lien_id: lienId }),
      });
      renderRunReport(data);
      await load();
    } else {
      const data = await api("/api/send-followups", {
        method: "POST",
        body: JSON.stringify({ lien_id: lienId }),
      });
      const summary = $("#send-summary");
      if (summary) {
        if (data.sent) summary.textContent = `Sent 1 — ${data.results?.[0]?.patient_name || "lien"}`;
        else if (data.skipped?.length) summary.textContent = `Skipped: ${data.skipped[0].reason}`;
        else if (data.errors?.length) summary.textContent = `Failed: ${data.errors[0].error}`;
        else summary.textContent = "That lien isn't due for follow-up.";
      }
      await load();
      await pollActivity();
    }
  } catch (err) {
    if (simBtn) {
      const panel = $("#run-report");
      panel.classList.remove("hidden");
      $("#run-count").textContent = "";
      $("#run-results").innerHTML =
        `<p class="hint" style="color:#b91c1c"><strong>Error:</strong> ${escapeHtml(err.message)}</p>`;
    } else {
      const summary = $("#send-summary");
      if (summary) summary.textContent = `Error: ${err.message}`;
      else alert(err.message);
    }
  } finally {
    btn.disabled = false;
  }
});

$("#import-csv").addEventListener("click", () => $("#csv-file").click());

$("#csv-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-importing the same file
  if (!file) return;

  const box = $("#import-result");
  box.classList.remove("hidden", "error");
  box.textContent = `Importing ${file.name}…`;
  try {
    const data = await api("/api/import-liens", {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: await file.text(),
    });
    const shown = data.errors.slice(0, 5)
      .map((x) => `<li>Line ${x.line}: ${escapeHtml(x.error)}</li>`).join("");
    const more = data.errors.length > 5 ? `<li>…and ${data.errors.length - 5} more</li>` : "";
    box.innerHTML =
      `<strong>${data.imported}</strong> lien${data.imported === 1 ? "" : "s"} imported from ${escapeHtml(file.name)}` +
      (data.skipped ? `; <strong>${data.skipped}</strong> skipped:<ul>${shown}${more}</ul>` : ".");
    box.classList.toggle("error", data.imported === 0);
    await load();
    await pollActivity();
  } catch (err) {
    box.classList.add("error");
    box.textContent = `Import failed: ${err.message}`;
  }
});

$("#present-mode").addEventListener("click", () => {
  enterPresent().catch((err) => alert(err.message));
});

$("#present-exit").addEventListener("click", () => exitPresent());

$("#present-back").addEventListener("click", async () => {
  if (!present.active || present.running || present.step === 0) return;
  present.step -= 1;
  await renderPresentStep();
});

$("#present-next").addEventListener("click", async () => {
  if (!present.active || present.running) return;

  if (present.step >= PRESENT_STEPS.length - 1) {
    exitPresent();
    return;
  }

  // Leaving step 3 → run follow-up once if needed, then advance to reveal steps
  if (present.step === 3 && !present.result) {
    try {
      await runPresentFollowup();
    } catch (err) {
      present.running = false;
      setPresentChrome();
      showPresentStage(`<p class="hint" style="color:#b91c1c"><strong>Error:</strong> ${escapeHtml(err.message)}</p>`);
      return;
    }
  }

  present.step += 1;
  await renderPresentStep();
});

load().then(() => pollActivity({ force: true }));
setInterval(pollActivity, 4000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollActivity();
});

// First run (no clinic roster, no liens yet) starts at setup.
fetch("/api/clinic-contacts")
  .then((r) => r.json())
  .then((d) => {
    if (!d.configured && d.lien_count === 0) window.location.replace("/onboarding.html");
  })
  .catch(() => {});
