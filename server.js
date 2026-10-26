import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import db, {
  STATUSES,
  OUTCOME_STATUSES,
  FINAL_STATUSES,
  ACTIONS,
  ACTION_VALUES,
  resetLienProgress,
  importCsvLiens,
  getState,
  setState,
} from "./db.js";
import { pickAttorneyReply } from "./replies.js";
import {
  senderVerified,
  emailConfigured,
  fromAddress,
  missingEmailConfig,
  isOwnAddress,
  isUndeliverable,
  makeReplyToken,
  replyAddressFor,
  sendEmail,
  parseEmail,
  startGmailWatcher,
  POLL_SECONDS,
} from "./email.js";
import { parse as parseCsv } from "csv-parse/sync";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// JSON for the UI's own calls; CSV uploads arrive as raw text.
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const FOLLOWUP_THRESHOLD_DAYS = 30;

// ---- Clinic roster ---------------------------------------------------------
// clinic_contacts.json lists the clinic employees LienPilot can loop in and the
// request categories each one handles. Every category routes to exactly one
// person; anything unclaimed goes to the contact marked "default". Without the
// file, the single CLINIC_CONTACT_* contact from .env handles everything.
function loadClinicRoster() {
  let contacts = [];
  let staff = [];
  try {
    const file = JSON.parse(fs.readFileSync(ROSTER_FILE, "utf8"));
    contacts = (file.contacts || []).filter((c) => c?.email);
    staff = (Array.isArray(file.staff) ? file.staff : []).map((e) => String(e).trim()).filter(Boolean);
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`  Warning: clinic_contacts.json unreadable (${err.message}); using .env contact.`);
  }
  if (!contacts.length) {
    contacts = [{
      id: "clinic",
      name: process.env.CLINIC_CONTACT_NAME || "Jordan Lee",
      email: process.env.CLINIC_CONTACT_EMAIL || "jordan.lee@clinic.example",
      handles: [],
      default: true,
    }];
  }
  contacts = contacts.map((c, i) => {
    const role = CLINIC_ROLES.find((r) => r.id === c.id);
    return {
      id: c.id || `contact${i + 1}`,
      name: c.name || c.email,
      email: String(c.email).trim(),
      // A known role's categories are defined in code; the file only says who fills it.
      handles: role ? role.handles : Array.isArray(c.handles) ? c.handles : [],
      default: Boolean(c.default),
    };
  });
  for (const c of contacts) {
    for (const h of c.handles) {
      if (!ACTION_VALUES.includes(h)) console.warn(`  Warning: ${c.name} handles unknown category "${h}" (clinic_contacts.json).`);
    }
  }
  const fallback = contacts.find((c) => c.default) || contacts[0];
  const route = Object.fromEntries(
    ACTION_VALUES.map((a) => [a, contacts.find((c) => c.handles.includes(a)) || fallback])
  );
  return { contacts, fallback, route, staff };
}

const ROSTER_FILE = path.join(__dirname, "clinic_contacts.json");

// The three hand-off roles onboarding asks for. Each owns a fixed set of
// request categories; Reductions is the default for anything unclaimed.
const CLINIC_ROLES = [
  {
    id: "payments",
    label: "Payments",
    description: "Confirming payments arrived, and payment problems (wrong amount, missing or returned check).",
    handles: [ACTIONS.PAYMENT_ISSUE],
  },
  {
    id: "records",
    label: "Medical records",
    description: "Medical records and chart notes, other documents (LOPs, W-9s), and corrections.",
    handles: [ACTIONS.MEDICAL_RECORDS, ACTIONS.OTHER_DOCUMENTS, ACTIONS.CORRECTION_NEEDED],
  },
  {
    id: "bills",
    label: "Itemized bills",
    description: "Itemized bills, ledgers, and billing statements.",
    handles: [ACTIONS.ITEMIZED_BILL],
  },
  {
    id: "treatment",
    label: "Treatment status",
    description: "Dates of service, appointments and visit history, whether treatment is complete, diagnoses, and treating provider.",
    handles: [ACTIONS.TREATMENT_STATUS],
  },
  {
    id: "reductions",
    label: "Reductions & balances",
    description: "Reduction and payoff decisions, balance questions, and case or contact issues.",
    handles: [ACTIONS.REDUCTION_PAYOFF_DECISION, ACTIONS.BALANCE_QUESTION, ACTIONS.CASE_CONTACT_ISSUE],
    default: true,
  },
];

let CLINIC = loadClinicRoster();

/** The clinic employee who owns a request category. */
function contactFor(category) {
  return CLINIC.route[category] || CLINIC.fallback;
}

// ---- Simulated clock -------------------------------------------------------
let clockOffsetDays = 0;

function today() {
  const d = new Date();
  d.setDate(d.getDate() + clockOffsetDays);
  return d;
}
// Local calendar date. toISOString() is UTC, which stamps evening activity
// (in US time zones) with tomorrow's date and makes days-since-contact -1.
function todayISO() {
  const d = today();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysBetween(fromISO, toDate) {
  const from = new Date(fromISO + "T00:00:00");
  const ms = toDate.setHours(0, 0, 0, 0) - from.getTime();
  return Math.floor(ms / 86_400_000);
}

// null last_contact_date = never contacted → days_since_contact is null.
function withDaysSinceContact(row) {
  return {
    ...row,
    days_since_contact: row.last_contact_date ? daysBetween(row.last_contact_date, today()) : null,
  };
}

/**
 * Due for a status request: any non-final status (blank included), no open
 * clinic action, and never contacted (blank/null date) or 30+ days of silence.
 *
 * An open clinic action pauses the chase: the attorney is waiting on the
 * clinic, so an "any update?" email to them would be backwards.
 */
function isDueForFollowup(lien) {
  if (FINAL_STATUSES.includes(lien.status)) return false;
  if (lien.action_needed) return false;
  if (!lien.last_contact_date) return true;
  return daysBetween(lien.last_contact_date, today()) >= FOLLOWUP_THRESHOLD_DAYS;
}

function appendNote(existing, entry) {
  const line = `[${todayISO()}] ${entry}`;
  return existing ? `${existing}\n${line}` : line;
}

// The ask depends on where the lien is: case status early on, payoff while
// settling, payment timing once the amount is agreed.
function statusRequestAsk(lien) {
  switch (lien.status) {
    case STATUSES.SETTLEMENT_PENDING:
      return `Checking in on the payoff. Where do things stand on finalizing the clinic's payment, and is there anything else you need from us?`;
    case STATUSES.PAYMENT_PENDING:
      return `Following up on payment. Could you confirm when the clinic's payment was or will be sent?`;
    default:
      return `Could you provide an update on the current status of the case when you get a chance?`;
  }
}

function buildStatusRequest(lien) {
  return {
    lien_id: lien.id,
    to: lien.attorney_email,
    subject: `${lien.patient_name} - Case Status`,
    body:
      `Hi ${lien.attorney_name.split(" ")[0]},\n\n` +
      `Just following up regarding ${lien.patient_name}. Our records show an outstanding balance of ` +
      `$${Number(lien.lien_amount).toLocaleString()}.\n\n` +
      `${statusRequestAsk(lien)}\n\n` +
      `Thank you,\n` +
      `${lien.clinic_name}`,
  };
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function joinList(items) {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * One email to one clinic contact covering everything on this reply that's
 * theirs. "intro" pulls them into the thread for the first time; "follow-up"
 * is for someone already looped in earlier who isn't on this particular email.
 */
/**
 * The thread so far, quoted under a clinic email the way a mail app quotes on
 * Reply All: "On <date>, <sender> wrote:" and the message with "> " lines. The
 * quoted message usually carries its own quoted history, so the clinic
 * employee sees the whole conversation they were never on.
 */
const QUOTE_LIMIT = 15000;
function quoteMessage({ fromName, from, date, body }) {
  let text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  if (text.length > QUOTE_LIMIT) text = `${text.slice(0, QUOTE_LIMIT).trimEnd()}\n[… earlier messages trimmed]`;
  const when = date && !Number.isNaN(new Date(date).getTime())
    ? new Date(date).toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      })
    : null;
  const who = fromName ? `${fromName} <${from}>` : from;
  return `${when ? `On ${when}, ` : ""}${who} wrote:\n` +
    text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
}

/**
 * The attorney's email as a Gmail-style forward: the "Forwarded message"
 * header block, then the message itself (which usually carries the earlier
 * thread in its own quoted history). Used under clinic CCs and follow-ups.
 */
function forwardBlock({ fromName, from, date, subject, to = [], cc = [], body }) {
  let text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  if (text.length > QUOTE_LIMIT) text = `${text.slice(0, QUOTE_LIMIT).trimEnd()}\n[… earlier messages trimmed]`;
  const d = date ? new Date(date) : null;
  const when = d && !Number.isNaN(d.getTime())
    ? `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })} at ` +
      d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";
  const person = (name, address) => (name ? `${name} <${address}>` : `<${address}>`);
  return [
    "---------- Forwarded message ---------",
    `From: ${person(fromName, from)}`,
    ...(when ? [`Date: ${when}`] : []),
    ...(subject ? [`Subject: ${subject}`] : []),
    ...(to.length ? [`To: ${to.join(", ")}`] : []),
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    "",
    text,
  ].join("\n");
}

// Gmail rejects messages over 25 MB after encoding; base64 adds a third.
const FORWARD_ATTACHMENT_LIMIT = 18 * 1024 * 1024;

/**
 * Files from the attorney's email to carry on the forward. Small inline
 * images (signature logos) are left out; if the rest is too big to send,
 * none are attached and their names are returned so the email can say so.
 */
function forwardableAttachments(msg) {
  const files = (msg.attachments || []).filter(
    (a) => a?.content && !(a.inline && /^image\//i.test(a.contentType || "") && a.size < 50_000)
  );
  const total = files.reduce((n, a) => n + (a.size || a.content.length), 0);
  return total > FORWARD_ATTACHMENT_LIMIT
    ? { attachments: [], tooLarge: files.map((a) => a.name), totalMb: (total / 1024 / 1024).toFixed(1) }
    : { attachments: files, tooLarge: [], totalMb: "0" };
}

function buildClinicEmail(lien, contact, { kind, added, repeated, forward = "", files = { attachments: [], tooLarge: [] } }) {
  const attorney = firstName(lien.attorney_name);
  // One new ask reads best as Claude's handoff sentence; several as a list.
  const lines =
    added.length === 1
      ? [added[0].handoff || `${attorney} is asking about ${added[0].text}.`]
      : added.length > 1
        ? [`${attorney} needs a few things:\n${added.map((r) => `- ${r.text}`).join("\n")}`]
        : [];
  if (repeated.length) {
    lines.push(`${attorney} is still waiting on ${joinList(repeated.map((r) => r.text))}.`);
  }
  // New asks: "Adding you here" for someone new to the thread, "New request"
  // for someone already on it. Only a re-asked request is "Following up".
  const lead = kind === "intro" ? "Adding you here — " : added.length ? "New request on this one — " : "Following up here — ";
  return {
    lien_id: lien.id,
    contact_id: contact.id,
    to: contact.email,
    cc_name: contact.name,
    kind,
    request_ids: [...added, ...repeated].map((r) => r.id),
    subject: `${lien.patient_name} - Need your help`,
    attachments: files.attachments,
    body:
      `Hi ${firstName(contact.name)},\n\n${lead}${lines.join(added.length > 1 ? "\n\n" : " ")}` +
      (files.tooLarge.length
        ? `\n\n${attorney}'s attachments were too large to forward (${files.totalMb} MB): ${files.tooLarge.join(", ")}.`
        : "") +
      `\n\nThanks,\nLienPilot` +
      (forward ? `\n\n${forward}` : ""),
  };
}

// ---- Thread participants and open requests ---------------------------------

function parseJsonList(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeAddress(address) {
  return String(address || "").trim().toLowerCase();
}

/** Every human address on an inbound email (From, To, Cc), LienPilot's own excluded. */
function inboundAddresses(msg) {
  const found = [msg.from, ...msg.to.map((a) => a.address), ...msg.cc.map((a) => a.address)];
  return [...new Set(found.map(normalizeAddress).filter((a) => a && !isOwnAddress(a)))];
}

function participantsOf(lien) {
  return parseJsonList(lien.thread_participants).map(normalizeAddress);
}

function withParticipants(list, addresses) {
  return [...new Set([...list, ...addresses.map(normalizeAddress).filter(Boolean)])];
}

/**
 * Open clinic requests, oldest first: { id, text, category, opened, last_asked,
 * message_id }. message_id is the email the owning employee got this request in
 * (our CC to them, or the attorney's email if they were already on it).
 */
function openRequestsOf(lien) {
  return parseJsonList(lien.open_requests)
    .filter((r) => r && Number.isFinite(Number(r.id)) && r.category)
    .map((r) => ({
      id: Number(r.id),
      text: String(r.text || r.category),
      category: ACTION_VALUES.includes(r.category) ? r.category : ACTIONS.CASE_CONTACT_ISSUE,
      opened: r.opened || "",
      last_asked: r.last_asked || r.opened || "",
      message_id: r.message_id || "",
    }));
}

/** action_needed mirrors the oldest open request; "" when nothing is open. */
function actionSummary(requests) {
  return requests[0]?.category || "";
}

function describeRequest(r) {
  return `#${r.id} ${r.text} (${r.category} → ${contactFor(r.category).name})`;
}

// ---- Anthropic triage ------------------------------------------------------
const anthropic = new Anthropic();

// NOTE: field order matters. The requests and internal_note come before the
// status verdict so the model does its reading before committing to an enum
// (reasoning-before-verdict). With verdicts first, the model would stub the
// trailing prose with "placeholder". Keep the reasoning fields at the top.
const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    clinic_requests: {
      type: "array",
      description:
        "Every NEW question or request in this reply that only the clinic can answer or fulfill. " +
        "One item per distinct ask. Do not list asks that are already open (use repeated_request_ids for those). " +
        "Empty if the reply asks the clinic for nothing new.",
      items: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "Short noun phrase naming what is needed, e.g. \"last date of service\" or \"itemized final bill\".",
          },
          handoff: {
            type: "string",
            description:
              "One short, natural sentence telling the clinic employee what the attorney needs, like a coworker looping them in. " +
              "No patient name, no law firm.",
          },
          category: { type: "string", enum: ACTION_VALUES },
        },
        required: ["request", "handoff", "category"],
        additionalProperties: false,
      },
    },
    repeated_request_ids: {
      type: "array",
      items: { type: "integer" },
      description: "Ids of already-open clinic requests the attorney asks about again or chases in this reply.",
    },
    resolved_request_ids: {
      type: "array",
      items: { type: "integer" },
      description:
        "Ids of already-open clinic requests this reply explicitly says were received, handled, or are no longer needed. Never include a request the reply doesn't mention.",
    },
    internal_note: {
      type: "string",
      description:
        "One or two short sentences recording what materially changed or was learned and why LienPilot selected this status.",
    },
    status: {
      type: "string",
      enum: OUTCOME_STATUSES,
    },
    agreed_amount: {
      type: "number",
      description:
        "The final dollar amount the clinic will be paid, ONLY when this reply shows the amount is agreed: the clinic accepted a reduction or payoff, " +
        "or the parties confirm a final figure. A proposal or counteroffer still under negotiation is not agreed. 0 when no amount is agreed in this reply.",
    },
  },
  required: ["clinic_requests", "repeated_request_ids", "resolved_request_ids", "internal_note", "status", "agreed_amount"],
  additionalProperties: false,
};

// Shared by the attorney triage and the clinic check so both use the same
// definitions when they set a status.
const STATUS_GUIDE = `STATUSES

Use exactly one:

- "Unknown"
  The case status hasn't been established yet (e.g. a fresh upload that no attorney has responded to).

- "Case Ongoing"
  The underlying PI case is active and has not settled yet.

- "Settlement Pending"
  The case is settling or has settled, but the clinic's final payment/payoff amount is not yet resolved.

- "Payment Pending"
  The clinic's final amount has been agreed or finalized and payment is expected.

- "Payment Sent"
  The attorney says the clinic's payment has gone out: check mailed, wire or ACH sent, payment issued. Not "will send" or "being processed": it has actually been sent. LienPilot stops following up here.

- "Paid"
  Payment has been received and the lien is finished.

- "Closed / Uncollectible"
  The case ended without normal payment or the lien is otherwise no longer collectible.

Preserve the current status unless the reply gives enough information to change it. A check mailed or payment sent is "Payment Sent", never "Paid"; use "Paid" only when the reply clearly says payment was received.`;

const TRIAGE_SYSTEM = `
You are the decision engine for LienPilot, an agent that manages outstanding personal-injury medical liens.

You will receive the lien's current state and an attorney's reply.

Determine:
1. Every new request the attorney makes of the clinic, its category, and a handoff sentence for the employee who handles it.
2. Which of the clinic's already-open requests this reply chases again or resolves.
3. A concise internal record of what changed.
4. The current financial/case status of the lien.

${STATUS_GUIDE}

CLINIC REQUEST CATEGORIES

Each clinic request gets exactly one category. The category decides which clinic employee handles it, so pick the most specific one. Different kinds of ask are separate requests even in one sentence: "send the records and the itemized bill" is two requests, one "Medical Records" and one "Itemized Bill".

- "Medical Records"
  Medical records, chart notes, treatment notes, narrative reports, imaging.

- "Itemized Bill"
  An itemized bill, ledger, billing statement, or list of charges.

- "Treatment Status"
  Facts about the patient's treatment: dates of service (first, last, specific visits), appointments and when the patient is or was seen next, whether treatment is complete or ongoing, diagnoses, treating provider.

- "Other Documents"
  Any other document: LOPs, W-9s, HIPAA authorizations, affidavits.

- "Correction Needed"
  Fixing inaccurate or incomplete records or bills (wrong date, wrong code, missing page).

- "Balance Question"
  The current balance or amount owed, or a request for an updated balance.

- "Reduction / Payoff Decision"
  The clinic must accept, reject, or counter a proposed reduction or payoff.

- "Payment Issue"
  A payment problem: wrong amount, missing payment, returned check, discrepancy, or payment details the clinic must supply.

- "Case / Contact Issue"
  Attorney withdrawal, changed representation, missing contact information, case closure, or anything that fits no other category.

OPEN REQUESTS

The lien context lists the clinic's open requests with ids: things the clinic was already asked for and hasn't delivered.
- If this reply asks for one of them again, or chases it ("still waiting on those records"), put its id in repeated_request_ids. Do not add it to clinic_requests again.
- If this reply explicitly says one of them was received, handled, or is no longer needed, put its id in resolved_request_ids. Resolve only the requests the reply actually mentions: a general "thanks" or silence about a request never resolves it.
- Otherwise leave it alone; it stays open.
- One reply can close an open request and make a new one, e.g. "Thanks for the records. When was the last date of service?" → resolve the records request, and add "last date of service" (Treatment Status) to clinic_requests.

DECISION RULES

- An attorney reply means there is an active case, so never return "Unknown". If the reply says nothing more about where the case stands (e.g. it only asks the clinic for something), use "Case Ongoing".

- Do not create clinic work unnecessarily. LienPilot handles routine follow-up, waiting, and status updates itself. This never applies to a question or request the attorney aims at the clinic: list every one.

- List every distinct ask separately, even when one reply has several (records AND an itemized bill are two requests with two categories).

- Preserve the existing status unless the attorney's reply provides enough information to justify changing it.

- If the attorney proposes a reduction or payoff amount requiring clinic approval: status = "Settlement Pending", and add a "Reduction / Payoff Decision" request.

- If the clinic's final amount is agreed or finalized and payment is being processed: status = "Payment Pending" Put the agreed dollar figure in agreed_amount.

- If the attorney says payment was sent or "paid" (check mailed, wire/ACH sent, payment issued): status = "Payment Sent". An attorney can't confirm the clinic received it, so an attorney reply is never "Paid". Record in internal_note the date and amount sent, and the check number or method, if the reply gives them. If they only say it will be sent or is being processed, keep "Payment Pending".

- Do not infer that payment has been received merely because a check was mailed or payment was initiated. Use "Paid" only when the reply clearly indicates payment was received.

HANDOFF SENTENCES

- Each clinic request has one handoff sentence, written to the clinic employee who handles it.
- Sound like a helpful coworker looping someone into the conversation, not a boss assigning a task.
- Prefer language such as:
  "[Attorney first name] needs..."
  "[Attorney first name] is looking for..."
  "[Attorney first name] is asking whether..."
- Avoid directive language such as "Please send...", "You need to...", "As soon as possible...".
- Refer to the clinic in the third person ("the clinic"), never "we" or "us". LienPilot is writing to the clinic, not as it.
- Do not include the patient's name or the law firm unless necessary for understanding the request.

Example:
"Kevin needs the itemized final bill and signed LOP before they can move forward."

INTERNAL NOTE

- Always provide an internal_note.
- Keep it to one or two short sentences.
- Record only what materially changed or was learned and why LienPilot selected its status.
- The note must agree with the status field; don't describe a status other than the one you return.
- Do not include generic commentary about liens, personal injury cases, or industry practices.
- Never output a placeholder, stub, or empty string.

Example:
"Attorney requested an itemized final bill and signed LOP. Case remains ongoing."

The goal is for LienPilot to handle everything it reasonably can itself and involve clinic employees only when their input or action is actually required.
`;

const TRIAGE_MODEL = "claude-haiku-4-5";

/**
 * One structured Claude call, logged end to end (the exact request and the raw
 * response). Returns the parsed JSON object.
 */
async function callClaude({ purpose, system, systemName, schema, userMessage, lien, mode = "live" }) {
  const who = { lien_id: lien.id, patient_name: lien.patient_name, mode };
  logActivity({
    type: "llm-request",
    ...who,
    detail: `${purpose}: sent to ${TRIAGE_MODEL}.`,
    data: {
      model: TRIAGE_MODEL,
      system_prompt: `${systemName} (${system.length} chars, fixed; see server.js)`,
      user_message: userMessage,
    },
  });

  const started = Date.now();
  const message = await anthropic.messages.create({
    model: TRIAGE_MODEL,
    max_tokens: 1024,
    system,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: userMessage }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  logActivity({
    type: "llm-response",
    ...who,
    detail: `${purpose}: ${TRIAGE_MODEL} responded in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
    data: {
      stop_reason: message.stop_reason,
      tokens: `${message.usage?.input_tokens ?? "?"} in / ${message.usage?.output_tokens ?? "?"} out`,
      raw_response: prettyJson(text),
    },
  });

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Could not parse ${purpose} response.`);
    return JSON.parse(match[0]);
  }
}

// Recent note lines, oldest first, without their [date] prefixes. Gives Claude
// the thread's history (e.g. exactly what the clinic was asked for).
function recentNotes(lien, count = 6) {
  return String(lien.notes || "")
    .split("\n")
    .map((line) => line.replace(/^(\[[^\]]+\]\s*)+/, "").trim())
    .filter(Boolean)
    .slice(-count)
    .map((line) => `  - ${line}`)
    .join("\n");
}

function lienContext(lien) {
  return (
    `Lien context:\n` +
    `- Patient: ${lien.patient_name}\n` +
    `- Attorney: ${lien.attorney_name}${lien.firm_name ? ` (${lien.firm_name})` : ""}\n` +
    `- Balance: ${lien.lien_amount}\n` +
    (lien.reduced_amount != null ? `- Agreed payoff: ${lien.reduced_amount}\n` : "") +
    `- Current status: ${lien.status || "Unknown (not yet recorded)"}\n` +
    `- Open clinic requests:${openRequestsBlock(lien)}\n`
  );
}

function openRequestsBlock(lien) {
  const open = openRequestsOf(lien);
  if (!open.length) return " None";
  return open
    .map((r) => `\n  #${r.id} [${r.category}] ${r.text} (asked ${r.opened || "earlier"}; handled by ${contactFor(r.category).name})`)
    .join("");
}

// ---- Money -------------------------------------------------------------------
// reduced_amount = agreed payoff; paid_amount / paid_date = what the clinic says
// it received. Only the money columns a change touches are returned.

function dollars(value) {
  const n = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Money columns after a status change. agreed: payoff agreed in this message
 * (ignored if above the lien amount: that's not a reduction, it's a misread).
 * received: amount the clinic confirmed. Entering Paid stamps paid_date; leaving
 * Paid (e.g. "the check bounced") clears both paid columns.
 */
function moneyChanges(lien, status, { agreed = null, received = null } = {}) {
  const out = {};
  if (agreed != null && agreed <= Number(lien.lien_amount)) out.reduced_amount = agreed;
  if (status === STATUSES.PAID) {
    if (lien.status !== STATUSES.PAID) out.paid_date = todayISO();
    if (received != null || lien.status !== STATUSES.PAID) out.paid_amount = received;
  } else if (lien.status === STATUSES.PAID) {
    out.paid_amount = null;
    out.paid_date = null;
  }
  return out;
}

function writeMoney(lienId, changes) {
  const cols = Object.keys(changes);
  if (!cols.length) return;
  db.prepare(`UPDATE liens SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`)
    .run(...cols.map((c) => changes[c]), lienId);
}

function describeMoney(changes) {
  const parts = [];
  if ("reduced_amount" in changes) parts.push(`Agreed payoff: ${changes.reduced_amount.toLocaleString("en-US")}.`);
  if (changes.paid_amount != null) parts.push(`Received: ${changes.paid_amount.toLocaleString("en-US")}.`);
  return parts.join(" ");
}

// ---- Attorney replies ------------------------------------------------------

async function triageReply(replyText, lien, { mode = "live" } = {}) {
  const parsed = await callClaude({
    purpose: "Attorney reply triage",
    system: TRIAGE_SYSTEM,
    systemName: "TRIAGE_SYSTEM",
    schema: TRIAGE_SCHEMA,
    userMessage: `${lienContext(lien)}\nAttorney reply:\n"""\n${replyText}\n"""\n\nReturn the JSON classification.`,
    lien,
    mode,
  });

  if (!OUTCOME_STATUSES.includes(parsed.status)) {
    throw new Error(`Model returned unknown status: ${parsed.status}`);
  }
  // An attorney replying confirms an active case: never leave it Unknown. And
  // an attorney can only know payment went out, not that it arrived ("paid via
  // ACH" means sent), so their reply never makes a lien Paid.
  const status =
    parsed.status === STATUSES.UNKNOWN ? STATUSES.CASE_ONGOING
      : parsed.status === STATUSES.PAID ? STATUSES.PAYMENT_SENT
        : parsed.status;

  const newRequests = (Array.isArray(parsed.clinic_requests) ? parsed.clinic_requests : [])
    .map((r) => ({
      text: String(r?.request || "").trim(),
      handoff: String(r?.handoff || "").trim(),
      category: r?.category,
    }))
    .filter((r) => r.text);
  for (const r of newRequests) {
    if (!ACTION_VALUES.includes(r.category)) throw new Error(`Model returned unknown category: ${r.category}`);
  }

  // Only ids that are actually open count.
  const openIds = new Set(openRequestsOf(lien).map((r) => r.id));
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number))].filter((id) => openIds.has(id));
  const resolvedIds = ids(parsed.resolved_request_ids);
  const repeatedIds = ids(parsed.repeated_request_ids).filter((id) => !resolvedIds.includes(id));

  return {
    status,
    new_requests: newRequests,
    repeated_ids: repeatedIds,
    resolved_ids: resolvedIds,
    agreed_amount: dollars(parsed.agreed_amount),
    internal_note:
      (parsed.internal_note || "") +
      (parsed.status === STATUSES.PAID
        ? " [Guard: an attorney can't confirm the clinic received payment; recorded as Payment Sent.]"
        : ""),
  };
}

// ---- Clinic replies --------------------------------------------------------
// After LienPilot CCs the clinic it stays on the thread. When the clinic
// employee replies, LienPilot only records what happened: it never answers.

const CLINIC_CHECK_SCHEMA = {
  type: "object",
  properties: {
    internal_note: {
      type: "string",
      description:
        "One or two short sentences recording what the clinic said or sent and whether it completes the open request.",
    },
    fulfilled_request_ids: {
      type: "array",
      items: { type: "integer" },
      description:
        "Ids of the open clinic requests this reply provides or clearly completes: documents sent, information given, or the decision made. Empty when it completes none.",
    },
    status: {
      type: "string",
      enum: OUTCOME_STATUSES,
      description: "The lien's status after this reply. The current status unless the reply changes where the lien stands.",
    },
    agreed_amount: {
      type: "number",
      description:
        "The final dollar amount the clinic will be paid, ONLY when this reply shows the amount is agreed: the clinic accepted a reduction or payoff, " +
        "or the parties confirm a final figure. A proposal or counteroffer still under negotiation is not agreed. 0 when no amount is agreed in this reply.",
    },
    received_amount: {
      type: "number",
      description: "Dollar amount the clinic says it received, when the reply says payment arrived and states the amount. 0 otherwise.",
    },
  },
  required: ["internal_note", "fulfilled_request_ids", "status", "agreed_amount", "received_amount"],
  additionalProperties: false,
};

const CLINIC_CHECK_SYSTEM = `
You track medical-lien follow-ups for LienPilot. Clinic employees are on an email thread with a personal-injury attorney, usually because the attorney needed something from the clinic. You will see the lien's current state (including the clinic's open requests, each with an id), recent history, and one clinic employee's reply.

1. Decide which open requests the reply fulfills, and list their ids:
- Fulfilled: the clinic sent what was asked (says documents are attached or sent), provided the requested information, or made the requested decision (accepted, rejected, or countered a reduction/payoff).
- Not fulfilled: a question, an acknowledgement or promise ("on it", "will send Friday"), a partial answer, or something unrelated.
Judge each open request on its own; a reply can fulfill one and leave another open. If nothing is open, return an empty list.

You cannot see attachment contents. If attachments are listed or the reply says documents are attached or sent, treat them as sent.

2. Decide the lien's status after this reply. The clinic's reply can move it:
- Clinic accepts a proposed reduction or payoff → the amount is agreed → "Payment Pending". Put the agreed dollar figure in agreed_amount (from the reply, or from the history when they accept "the offer" without restating it).
- Clinic rejects or counters a reduction → still negotiating → "Settlement Pending".
- Clinic says payment was received → "Paid". Put the amount in received_amount if they state it.
- Clinic says an expected payment never arrived, bounced, or was short → "Payment Pending" (the lien reopens and follow-up resumes).
Otherwise keep the current status.

${STATUS_GUIDE}

Write internal_note first: one or two short sentences recording what the clinic did or said and which requests it completes. If an amount was agreed, state the dollar figure. The note must agree with the status you return. No generic commentary. Never output a placeholder or empty string.
`;

async function triageClinicReply(replyText, lien, { attachments = [] } = {}) {
  const parsed = await callClaude({
    purpose: "Clinic reply check",
    system: CLINIC_CHECK_SYSTEM,
    systemName: "CLINIC_CHECK_SYSTEM",
    schema: CLINIC_CHECK_SCHEMA,
    userMessage:
      `${lienContext(lien)}` +
      `Recent history:\n${recentNotes(lien) || "  (none)"}\n\n` +
      `Clinic employee's reply${attachments.length ? ` (attachments: ${attachments.join(", ")})` : ""}:\n` +
      `"""\n${replyText}\n"""\n\nReturn the JSON.`,
    lien,
  });
  if (!OUTCOME_STATUSES.includes(parsed.status)) {
    throw new Error(`Model returned unknown status: ${parsed.status}`);
  }
  const openIds = new Set(openRequestsOf(lien).map((r) => r.id));
  return {
    internal_note: parsed.internal_note || "",
    fulfilled_ids: [...new Set((parsed.fulfilled_request_ids || []).map(Number))].filter((id) => openIds.has(id)),
    status: parsed.status,
    agreed_amount: dollars(parsed.agreed_amount),
    received_amount: dollars(parsed.received_amount),
  };
}

// ---- Who replied? ----------------------------------------------------------
// Addresses decide when they can; Claude decides when they can't (e.g. one
// test inbox playing both attorney and clinic, or an unknown firm paralegal).

const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com",
  "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

function splitEmail(address) {
  const [local = "", domain = ""] = String(address || "").trim().toLowerCase().split("@");
  return { address: `${local.split("+")[0]}@${domain}`, domain };
}

/** "clinic" | "attorney" by address, or null when the address can't tell. */
function senderRoleByAddress(from, lien) {
  // Exact address first: +tags distinguish roster contacts that share a mailbox.
  const exact = normalizeAddress(from);
  const exactClinic = CLINIC.contacts.some((c) => normalizeAddress(c.email) === exact);
  const exactAttorney = normalizeAddress(lien.attorney_email) === exact;
  if (exactClinic !== exactAttorney) return exactClinic ? "clinic" : "attorney";

  const sender = splitEmail(from);
  const clinic = CLINIC.contacts.map((c) => splitEmail(c.email));
  const attorney = splitEmail(lien.attorney_email);

  const isClinic = clinic.some((c) => c.address === sender.address);
  const isAttorney = sender.address === attorney.address;
  if (isClinic !== isAttorney) return isClinic ? "clinic" : "attorney";
  if (isClinic) return null; // one address plays both roles

  // Same organization domain (ignoring shared webmail like gmail.com).
  const org = FREE_MAIL_DOMAINS.has(sender.domain) ? null : sender.domain;
  const clinicDomain = Boolean(org) && clinic.some((c) => c.domain === org);
  const attorneyDomain = Boolean(org) && org === attorney.domain;
  if (clinicDomain !== attorneyDomain) return clinicDomain ? "clinic" : "attorney";
  return null;
}

const SENDER_SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string", description: "One sentence on why." },
    sender_role: { type: "string", enum: ["attorney", "clinic"] },
  },
  required: ["reason", "sender_role"],
  additionalProperties: false,
};

const SENDER_SYSTEM = `
You identify who wrote a reply in an email thread about a personal-injury medical lien. The thread has two human sides:
- attorney: the patient's attorney or anyone at their law firm (paralegal, case manager).
- clinic: any of the clinic employees who were looped in to help.

Use the sender, the content, and the context. Clinic-side replies typically send records or bills, confirm balances or treatment dates, or accept, reject, or counter a reduction. Attorney-side replies typically report case status, ask the clinic for something, or discuss settlement and payment timing.

Give a one-sentence reason first.
`;

async function identifySender({ from, fromName, replyText, lien }) {
  const byAddress = senderRoleByAddress(from, lien);
  if (byAddress) return { role: byAddress, method: "address match" };

  const parsed = await callClaude({
    purpose: "Who replied?",
    system: SENDER_SYSTEM,
    systemName: "SENDER_SYSTEM",
    schema: SENDER_SCHEMA,
    userMessage:
      `Attorney side: ${lien.attorney_name} <${lien.attorney_email}>, ${lien.firm_name || "firm unknown"}\n` +
      `Clinic side (${lien.clinic_name}): ${CLINIC.contacts.map((c) => `${c.name} <${c.email}>`).join(", ")}\n` +
      `Open clinic requests:${openRequestsBlock(lien)}\n` +
      `Recent history:\n${recentNotes(lien) || "  (none)"}\n\n` +
      `Sender: ${fromName ? `${fromName} ` : ""}<${from}>\n` +
      `Reply:\n"""\n${replyText}\n"""\n\nReturn the JSON.`,
    lien,
  });
  const role = parsed.sender_role === "clinic" ? "clinic" : "attorney";
  return { role, method: `Claude: ${parsed.reason || "content"}` };
}

// ---- Shared post-triage step ---------------------------------------------
// Used by both the simulated loop (canned replies) and the live loop (real
// inbound email), so the two can never drift apart.

/**
 * Fold a triage into the lien's open requests: drop the resolved ones, stamp
 * the repeated ones, append the new ones. A "new" ask whose wording matches an
 * open request counts as a repeat, so the list never holds the same ask twice.
 */
function planRequests(lien, triage) {
  const open = openRequestsOf(lien);
  const resolved = open.filter((r) => triage.resolved_ids.includes(r.id));
  let remaining = open.filter((r) => !triage.resolved_ids.includes(r.id));

  const repeatedIds = new Set(triage.repeated_ids);
  const added = [];
  let nextId = Math.max(0, ...open.map((r) => r.id)) + 1;
  for (const n of triage.new_requests) {
    const key = n.text.toLowerCase();
    const same = remaining.find((r) => r.text.toLowerCase() === key && r.category === n.category);
    if (same) {
      repeatedIds.add(same.id);
      continue;
    }
    if (added.some((r) => r.text.toLowerCase() === key && r.category === n.category)) continue;
    added.push({
      id: nextId++,
      text: n.text,
      category: n.category,
      opened: todayISO(),
      last_asked: todayISO(),
      handoff: n.handoff,
    });
  }

  remaining = remaining.map((r) => (repeatedIds.has(r.id) ? { ...r, last_asked: todayISO() } : r));
  const repeated = remaining.filter((r) => repeatedIds.has(r.id));
  // handoff is triage-only; open_requests in the DB stays {id, text, category, opened, last_asked}.
  const requests = [...remaining, ...added.map(({ handoff, ...r }) => r)];
  return { requests, added, repeated, resolved };
}

/**
 * Decide which clinic contacts to email about this reply. Everything new or
 * chased again is grouped by the contact who owns its category, then per contact:
 *  - on this email already (To/Cc/From) → they have it; send nothing
 *  - on the thread before, but not on this email → short follow-up
 *  - never on the thread → intro that loops them in
 * `onThisEmail` is empty for simulated replies.
 */
function planClinicEmails(lien, plan, { onThisEmail = [], forward = "", files } = {}) {
  const participants = participantsOf(lien);
  const present = new Set(onThisEmail.map(normalizeAddress));
  const byContact = new Map();
  for (const [group, list] of [["added", plan.added], ["repeated", plan.repeated]]) {
    for (const r of list) {
      const contact = contactFor(r.category);
      if (!byContact.has(contact.id)) byContact.set(contact.id, { contact, added: [], repeated: [] });
      byContact.get(contact.id)[group].push(r);
    }
  }

  const emails = [];
  const skipped = [];
  for (const { contact, added, repeated } of byContact.values()) {
    const address = normalizeAddress(contact.email);
    if (present.has(address)) {
      skipped.push({ contact, reason: "already on this email", request_ids: [...added, ...repeated].map((r) => r.id) });
      continue;
    }
    const kind = participants.includes(address) ? "follow-up" : "intro";
    emails.push({ contact, ...buildClinicEmail(lien, contact, { kind, added, repeated, forward, files }) });
  }
  return { emails, skipped };
}

function clinicEmailNote(email) {
  const files = email.attachments || [];
  return `Clinic ${email.kind === "intro" ? "employee CC’d" : "follow-up sent"} (${email.contact.name} <${email.contact.email}>): requests ${email.request_ids.map((id) => `#${id}`).join(", ")}` +
    (files.length ? `; forwarded ${files.map((a) => a.name).join(", ")}` : "") + ".";
}

function requestNotes(plan, skipped) {
  return [
    ...plan.added.map((r) => `Opened ${describeRequest(r)}.`),
    ...plan.resolved.map((r) => `Closed #${r.id} ${r.text} (attorney says it's handled).`),
    ...plan.repeated.map((r) => `Attorney chased #${r.id} ${r.text}.`),
    ...skipped.map((s) => `${s.contact.name} is already on this email → no CC.`),
  ];
}

/**
 * Record a triaged reply: append notes, set status and open requests (with
 * action_needed mirroring the oldest), add thread participants, reset the
 * contact clock, and mark the lien no longer awaiting a reply. The reply token
 * stays: it's the lien's permanent thread id. Returns the updated row.
 */
function applyTriage(lien, triage, plan, { leadNote, trailingNotes = [], participants = [], mode = "live" } = {}) {
  const action = actionSummary(plan.requests);
  const money = moneyChanges(lien, triage.status, { agreed: triage.agreed_amount });
  const noteParts = [
    ...(leadNote ? [leadNote] : []),
    `Attorney replied. Course of action: ${triage.status}` +
      (plan.requests.length ? ` / ${plan.requests.length} open clinic request${plan.requests.length > 1 ? "s" : ""}` : " / none") +
      `. ${describeMoney(money) ? `${describeMoney(money)} ` : ""}${triage.internal_note}`,
    ...trailingNotes,
  ];

  let notes = lien.notes;
  for (const part of noteParts) notes = appendNote(notes, part);
  const threadParticipants = withParticipants(participantsOf(lien), participants);

  // Always reset contact clock after the exchange. Open requests keep action_needed set.
  db.prepare(
    `UPDATE liens
       SET status = ?, action_needed = ?, open_requests = ?, thread_participants = ?,
           last_contact_date = ?, notes = ?, awaiting_reply = 0
     WHERE id = ?`
  ).run(
    triage.status,
    action,
    JSON.stringify(plan.requests),
    JSON.stringify(threadParticipants),
    todayISO(),
    notes,
    lien.id
  );
  writeMoney(lien.id, money);

  const updated = db.prepare("SELECT * FROM liens WHERE id = ?").get(lien.id);
  logActivity({
    type: "lien-updated",
    lien_id: lien.id,
    patient_name: lien.patient_name,
    mode,
    detail:
      `Database updated: ${updated.status}` +
      (updated.action_needed ? ` / ${updated.action_needed}` : "") + ".",
    data: {
      status: `${lien.status || "unknown"} → ${updated.status}`,
      action_needed: `${lien.action_needed || "—"} → ${updated.action_needed || "—"}`,
      open_requests: plan.requests.length ? plan.requests.map(describeRequest).join("\n") : "none",
      thread_participants: threadParticipants.join(", ") || "none",
      last_contact_date: `${lien.last_contact_date || "never"} → ${updated.last_contact_date}`,
      awaiting_reply: `${lien.awaiting_reply ? "yes" : "no"} → no`,
      notes_added: noteParts.join("\n"),
    },
  });
  return updated;
}

/** Plain-JSON view of a lien for the UI (no thread token). */
/**
 * A link that opens a request's email in the employee's own Gmail. A Gmail
 * thread id only works in the mailbox that owns it, but a Message-ID is the
 * same in every copy of an email, so search for it; authuser picks the
 * employee's account when they're signed into several.
 */
function gmailMessageLink(messageId, account) {
  const id = String(messageId || "").trim().replace(/^<|>$/g, "");
  if (!id) return null;
  const who = account ? `?authuser=${encodeURIComponent(account)}` : "";
  return `https://mail.google.com/mail/${who}#search/${encodeURIComponent(`rfc822msgid:${id}`)}`;
}

/** Record which email delivered these requests to their owner (newest wins). */
function stampMessageId(plan, ids, messageId) {
  if (!messageId || !ids?.length) return;
  const set = new Set(ids);
  plan.requests = plan.requests.map((r) => (set.has(r.id) ? { ...r, message_id: messageId } : r));
}

function lienView(row) {
  const { reply_token, open_requests, thread_participants, ...rest } = row;
  return {
    ...withDaysSinceContact(rest),
    awaiting_reply: Boolean(row.awaiting_reply),
    open_requests: openRequestsOf(row).map((r) => {
      const owner = contactFor(r.category);
      return { ...r, owner: owner.name, email_link: gmailMessageLink(r.message_id, owner.email) };
    }),
    thread_participants: participantsOf(row),
  };
}

// ---- Per-lien serialization ------------------------------------------------
// Two emails on the same lien (e.g. sent seconds apart) would otherwise both
// read the same starting row, and the second write would erase the first's
// changes. Each lien gets a promise chain, so work on one lien runs strictly
// one at a time; different liens still run in parallel.
const lienQueues = new Map();

function withLienLock(lienId, task) {
  const previous = lienQueues.get(lienId) || Promise.resolve();
  const run = previous.then(() => task());
  const tail = run.catch(() => {}); // a failure mustn't block the next reply
  lienQueues.set(lienId, tail);
  tail.then(() => {
    if (lienQueues.get(lienId) === tail) lienQueues.delete(lienId);
  });
  return run;
}

// Live log: every step of the agent loop (emails, Claude calls, DB changes),
// with full payloads in `data`. Shown in the UI and printed to the console.
// In-memory, resets on restart; the durable record is each lien's notes.
const activity = [];
let activitySeq = 0;

function logActivity(event) {
  const entry = { id: ++activitySeq, at: new Date().toISOString(), ...event };
  activity.unshift(entry);
  if (activity.length > 200) activity.length = 200;
  printLog(entry);
}

function printLog(e) {
  const time = new Date(e.at).toLocaleTimeString();
  const tag = (e.mode === "simulated" ? "sim " : "") + e.type.toUpperCase();
  const who = e.patient_name ? `${e.patient_name} — ` : "";
  console.log(`[${time}] ${tag.padEnd(16)} ${who}${e.detail || ""}`);
  for (const [key, value] of Object.entries(e.data || {})) {
    const lines = String(value ?? "").split("\n");
    console.log(`    ${key}: ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`      ${line}`);
  }
}

function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function emailLogData({ from, to, cc, replyTo, subject, body, messageId, attachments = [] }) {
  return {
    ...(attachments.length ? { attachments: attachments.map((a) => a.name).join(", ") } : {}),
    ...(from ? { from } : {}),
    to,
    ...(cc ? { cc } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    subject,
    body,
    ...(messageId ? { message_id: messageId } : {}),
  };
}

// ---- Routes ----------------------------------------------------------------
app.get("/api/liens", (_req, res) => {
  const rows = db.prepare("SELECT * FROM liens ORDER BY id").all();
  res.json({
    today: todayISO(),
    clock_offset_days: clockOffsetDays,
    threshold_days: FOLLOWUP_THRESHOLD_DAYS,
    clinic_contacts: CLINIC.contacts,
    live_email: emailConfigured(),
    email_provider: "Gmail",
    liens: rows.map((row) => ({
      ...lienView(row),
      reply_template_id: pickAttorneyReply(row).template_id,
    })),
    // Every status change (UTC), for the dashboard's collected-vs-outstanding-over-time chart.
    status_history: db.prepare("SELECT lien_id, from_status, to_status, changed_at FROM status_history ORDER BY id").all(),
  });
});

app.post("/api/liens", (req, res) => {
  const {
    patient_name, clinic_name, attorney_name, attorney_email, firm_name,
    date_of_service, lien_amount,
  } = req.body || {};

  if (!patient_name || !clinic_name || !attorney_name || !attorney_email) {
    return res.status(400).json({ error: "Missing required lien fields." });
  }

  const info = db
    .prepare(
      `INSERT INTO liens
         (patient_name, clinic_name, attorney_name, attorney_email, firm_name,
          date_of_service, lien_amount, status, action_needed, last_contact_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '')`
    )
    .run(
      patient_name, clinic_name, attorney_name, attorney_email, firm_name || "",
      date_of_service || todayISO(), Number(lien_amount) || 0,
      STATUSES.CASE_ONGOING, todayISO()
    );

  const row = db.prepare("SELECT * FROM liens WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(lienView(row));
});

/**
 * Email-agent demo loop:
 * for each overdue Case Ongoing lien → send status request → canned reply →
 * Claude triage → update DB → CC clinic or schedule next follow-up.
 * Optional body.lien_id scopes the run to a single lien.
 */
app.post("/api/run-followups", async (req, res) => {
  const lienIdFilter =
    req.body?.lien_id != null && req.body.lien_id !== ""
      ? Number(req.body.lien_id)
      : null;
  if (lienIdFilter != null && !Number.isFinite(lienIdFilter)) {
    return res.status(400).json({ error: "lien_id must be a number." });
  }

  const rows = db.prepare("SELECT * FROM liens ORDER BY id").all();
  const results = [];

  for (const lien of rows) {
    if (lienIdFilter != null && lien.id !== lienIdFilter) continue;

    if (!isDueForFollowup(lien)) {
      if (lienIdFilter != null) {
        return res.status(400).json({
          error: `Lien ${lienIdFilter} isn't due for a follow-up (final status, open clinic action, or contacted in the last 30 days).`,
        });
      }
      continue;
    }

    const outbound = buildStatusRequest(lien);
    const { body: reply, template_id } = pickAttorneyReply(lien);
    const sim = { lien_id: lien.id, patient_name: lien.patient_name, mode: "simulated" };
    logActivity({
      type: "email-sent",
      ...sim,
      detail: `Status request drafted for ${outbound.to} (simulated, not sent).`,
      data: emailLogData({ to: outbound.to, subject: outbound.subject, body: outbound.body }),
    });
    logActivity({
      type: "email-received",
      ...sim,
      detail: `Canned attorney reply injected (template: ${template_id}).`,
      data: { body: reply },
    });

    let triage;
    try {
      triage = await triageReply(reply, lien, { mode: "simulated" });
    } catch (err) {
      return res.status(502).json({
        error: `Triage failed on ${lien.patient_name}: ${err.message}`,
        hint: "Set ANTHROPIC_API_KEY in .env (see .env.example), then restart the server.",
        partial_results: results,
      });
    }

    const plan = planRequests(lien, triage);
    // Simulated thread: the canned reply (quoting our status request), forwarded.
    const forward = forwardBlock({
      fromName: lien.attorney_name,
      from: lien.attorney_email,
      date: today(),
      subject: `Re: ${outbound.subject}`,
      to: [`LienPilot <${fromAddress() || "lienpilot"}>`],
      body: `${reply}\n\n${quoteMessage({ fromName: "LienPilot", from: fromAddress() || "lienpilot", date: today(), body: outbound.body })}`,
    });
    const { emails } = planClinicEmails(lien, plan, { forward });
    for (const email of emails) {
      logActivity({
        type: "cc-sent",
        ...sim,
        detail: `Clinic ${email.kind === "intro" ? "CC" : "follow-up"} drafted for ${email.contact.name} <${email.to}> (simulated, not sent).`,
        data: emailLogData({ to: email.to, subject: email.subject, body: email.body }),
      });
    }
    const updated = applyTriage(lien, triage, plan, {
      leadNote: `Follow-up email sent to ${lien.attorney_name} <${lien.attorney_email}>.`,
      trailingNotes: [...requestNotes(plan, []), ...emails.map(clinicEmailNote)],
      participants: [lien.attorney_email, ...emails.map((e) => e.to)],
      mode: "simulated",
    });
    const clinic_ccs = emails.map(({ contact, ...email }) => email);
    results.push({
      lien_id: lien.id,
      patient_name: lien.patient_name,
      outbound,
      reply,
      triage: {
        status: triage.status,
        action_needed: updated.action_needed || "",
        clinic_required: plan.requests.length > 0,
        internal_note: triage.internal_note,
        handoff_message: plan.added.map((r) => r.handoff).join(" "),
        new_requests: plan.added,
      },
      clinic_cc: clinic_ccs[0] || null,
      clinic_ccs,
      lien: lienView(updated),
    });
  }

  if (lienIdFilter != null && results.length === 0) {
    return res.status(404).json({ error: `Lien ${lienIdFilter} not found.` });
  }

  res.json({
    processed: results.length,
    clinic_contacts: CLINIC.contacts,
    results,
  });
});

/**
 * Live loop, outbound half: email a real status request to every overdue
 * Case Ongoing lien. Replies come back later through the Gmail watcher.
 * Sending resets the contact clock, so a lien awaiting a reply isn't chased
 * again until another 30 days of silence — and a re-chase reuses the same
 * reply token, so a late answer to either email still matches.
 * One lien's failure never aborts the batch. Optional body.lien_id scopes it.
 */
app.post("/api/send-followups", async (req, res) => {
  if (!emailConfigured()) {
    return res.status(400).json({
      error: `Live email isn't configured. Missing: ${missingEmailConfig().join(", ")}.`,
      hint: "See .env.example and the README's live email setup section.",
    });
  }

  const lienIdFilter =
    req.body?.lien_id != null && req.body.lien_id !== "" ? Number(req.body.lien_id) : null;

  const rows = db.prepare("SELECT * FROM liens ORDER BY id").all();
  const sent = [];
  const skipped = [];
  const failed = [];

  for (const row of rows) {
    if (lienIdFilter != null && row.id !== lienIdFilter) continue;
    // Wait for any reply being processed on this lien, then work from a fresh read.
    await withLienLock(row.id, async () => {
      const lien = db.prepare("SELECT * FROM liens WHERE id = ?").get(row.id);
      if (!isDueForFollowup(lien)) return;

      if (isUndeliverable(lien.attorney_email)) {
        skipped.push({ lien_id: lien.id, patient_name: lien.patient_name, reason: `placeholder address ${lien.attorney_email}` });
        return;
      }

      const email = buildStatusRequest(lien);
      const token = lien.reply_token || makeReplyToken(lien.id);
      try {
        const messageId = await sendEmail({
          to: email.to,
          subject: email.subject,
          body: email.body,
          replyTo: replyAddressFor(token),
        });
        db.prepare(
          `UPDATE liens
             SET reply_token = ?, last_outbound_message_id = ?, last_contact_date = ?, notes = ?, awaiting_reply = 1,
                 thread_participants = ?
           WHERE id = ?`
        ).run(
          token,
          messageId,
          todayISO(),
          appendNote(lien.notes, `Status request emailed to ${lien.attorney_name} <${lien.attorney_email}>. Awaiting reply.`),
          JSON.stringify(withParticipants(participantsOf(lien), [lien.attorney_email])),
          lien.id
        );
        sent.push({ lien_id: lien.id, patient_name: lien.patient_name, to: email.to, subject: email.subject });
        logActivity({
          type: "email-sent",
          lien_id: lien.id,
          patient_name: lien.patient_name,
          detail: `Status request emailed to ${email.to} via ${"Gmail"}.`,
          data: emailLogData({
            from: fromAddress(),
            to: email.to,
            replyTo: replyAddressFor(token),
            subject: email.subject,
            body: email.body,
            messageId,
          }),
        });
      } catch (err) {
        failed.push({ lien_id: lien.id, patient_name: lien.patient_name, error: err.message });
        logActivity({ type: "error", lien_id: lien.id, patient_name: lien.patient_name, detail: `Send failed: ${err.message}` });
      }
    });
  }

  res.json({ sent: sent.length, results: sent, skipped, errors: failed });
});


/**
 * A clinic employee replied on the thread (usually Reply All after being CC'd).
 * LienPilot never answers; it works out which open requests the reply fulfills
 * (each one closes on its own; chasing resumes once none are left) and whether
 * the reply moves the lien's status (e.g. clinic accepts a reduction → Payment
 * Pending), and records both.
 */
async function handleClinicReply({ lien, from, replyText, attachments, onThisEmail }) {
  const who = { lien_id: lien.id, patient_name: lien.patient_name };

  let check;
  try {
    check = await triageClinicReply(replyText, lien, { attachments });
  } catch (err) {
    logActivity({ type: "error", ...who, detail: `Clinic reply check failed (will retry): ${err.message}` });
    return retry(`Clinic reply check failed: ${err.message}`);
  }

  const open = openRequestsOf(lien);
  const done = open.filter((r) => check.fulfilled_ids.includes(r.id));
  const remaining = open.filter((r) => !check.fulfilled_ids.includes(r.id));
  const newAction = actionSummary(remaining);
  const statusChanged = check.status !== lien.status;
  const money = moneyChanges(lien, check.status, { agreed: check.agreed_amount, received: check.received_amount });

  const outcome = [
    !open.length
      ? "nothing was open for the clinic"
      : [
          done.length ? `fulfilled ${done.map((r) => `#${r.id} ${r.text}`).join(", ")}` : "fulfilled nothing",
          remaining.length ? `still open ${remaining.map((r) => `#${r.id} ${r.text}`).join(", ")}` : "nothing left open",
        ].join("; "),
    statusChanged ? `status ${lien.status} → ${check.status}` : null,
  ].filter(Boolean).join("; ");
  logActivity({ type: "decision", ...who, detail: `Clinic reply: ${outcome}. No email sent.` });

  const note =
    `Clinic replied (${from}).` +
    (done.length ? ` Done: ${done.map((r) => `#${r.id} ${r.text}`).join(", ")}.` : "") +
    (remaining.length ? ` Still open: ${remaining.map((r) => `#${r.id} ${r.text}`).join(", ")}.` : "") +
    (statusChanged ? ` Status → ${check.status}.` : "") +
    (describeMoney(money) ? ` ${describeMoney(money)}` : "") +
    ` ${check.internal_note}`;
  const participants = withParticipants(participantsOf(lien), onThisEmail);

  // Thread activity with the attorney cc'd counts as contact.
  db.prepare(
    `UPDATE liens
        SET status = ?, action_needed = ?, open_requests = ?, thread_participants = ?, last_contact_date = ?, notes = ?
      WHERE id = ?`
  ).run(
    check.status, newAction, JSON.stringify(remaining), JSON.stringify(participants),
    todayISO(), appendNote(lien.notes, note), lien.id
  );
  writeMoney(lien.id, money);

  logActivity({
    type: "lien-updated",
    ...who,
    detail: `Database updated: ${check.status}${newAction ? ` / ${newAction}` : ""}.`,
    data: {
      status: `${lien.status || "Unknown"} → ${check.status}`,
      action_needed: `${lien.action_needed || "—"} → ${newAction || "—"}`,
      open_requests: remaining.length ? remaining.map(describeRequest).join("\n") : "none",
      last_contact_date: `${lien.last_contact_date || "never"} → ${todayISO()}`,
      notes_added: note,
    },
  });

  return handled({ role: "clinic", fulfilled: check.fulfilled_ids, status: check.status });
}

// Inbound handlers return { status, body }: 2xx = handled (or deliberately
// ignored), 5xx = nothing written and the Gmail watcher should retry.
const handled = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const retry = (error) => ({ status: 500, body: { error } });

/**
 * Live loop, inbound half: one email from the agent's inbox (parseEmail's
 * object). Thread replies (+token) go to triage; mail to the plain address is a
 * staff question. Fully autonomous: no approval step.
 */
async function receiveInbound(msg) {
  const from = msg.from || "unknown sender";
  const autoReply =
    msg.autoSubmitted || /^(auto(matic)? ?reply|out of (the )?office)\b/i.test(String(msg.subject || ""));
  if (isOwnAddress(from) || autoReply || msg.bulk) {
    const kind = autoReply ? "Auto-reply" : msg.bulk ? "Automated/bulk email" : "Our own email";
    logActivity({ type: "ignored", detail: `${kind} from ${from} ignored.` });
    return handled({ ignored: true });
  }

  const token = msg.token;
  // Mail to the agent's plain address (no thread tag): a staff question, an
  // attorney writing in fresh, or someone unknown.
  if (!token) return routeUntagged(msg, { from });

  const match = db.prepare("SELECT id, patient_name FROM liens WHERE reply_token = ?").get(token);
  if (!match) {
    logActivity({ type: "ignored", detail: `Email from ${from} matched no lien thread.` });
    return handled({ ignored: true });
  }

  if (lienQueues.has(match.id)) {
    logActivity({
      type: "queued",
      lien_id: match.id,
      patient_name: match.patient_name,
      detail: `Another reply on this lien is still being processed; this one (from ${from}) waits its turn.`,
    });
  }

  try {
    return await withLienLock(match.id, () => processInboundReply({ msg, from, token, lienId: match.id }));
  } catch (err) {
    logActivity({ type: "error", lien_id: match.id, patient_name: match.patient_name, detail: `Unexpected error: ${err.message}` });
    return retry(err.message);
  }
}

// ---- Mail without a thread tag -------------------------------------------------
// Who sent it decides where it goes: clinic staff → a question; an attorney on
// file (or someone at their firm's domain) → attorney-initiated; anyone else →
// forwarded to the default clinic contact for a person to handle.

/** Liens whose attorney is this sender: same address, or same firm domain (not webmail). */
function liensForAttorney(address) {
  const sender = splitEmail(address);
  const org = FREE_MAIL_DOMAINS.has(sender.domain) ? null : sender.domain;
  return db.prepare("SELECT * FROM liens ORDER BY patient_name").all().filter((l) => {
    const attorney = splitEmail(l.attorney_email);
    return attorney.address === sender.address || (org && attorney.domain === org);
  });
}

const UNTAGGED_SENDER_SYSTEM = `
Someone emailed a medical clinic's lien agent directly (not replying on a lien thread). Their address belongs both to clinic staff and to an attorney on file (for example, one test inbox playing both roles). Decide which role they're writing in from the content:
- clinic: asking LienPilot about a patient or the liens ("what's going on with...", "any updates...").
- attorney: writing on behalf of a law firm about a client's case, settlement, payment, or asking the clinic for records or information.
Give a one-sentence reason first.
`;

async function routeUntagged(msg, { from }) {
  const staff = staffMember(from);
  const attorneyLiens = liensForAttorney(from);

  let role = staff && !attorneyLiens.length ? "clinic" : !staff && attorneyLiens.length ? "attorney" : null;
  if (!staff && !attorneyLiens.length) {
    logActivity({ type: "decision", detail: `Email from ${from} to LienPilot's address: not clinic staff or an attorney on file → forward to ${CLINIC.fallback.name}.` });
    return forwardToClinic(msg, { from, reason: `it's from ${from}, who isn't clinic staff or an attorney on file` });
  }
  if (!role) {
    try {
      const parsed = await callClaude({
        purpose: "Who emailed LienPilot?",
        system: UNTAGGED_SENDER_SYSTEM,
        systemName: "UNTAGGED_SENDER_SYSTEM",
        schema: SENDER_SCHEMA,
        userMessage:
          `Sender: ${msg.fromName ? `${msg.fromName} ` : ""}<${from}>\nSubject: ${msg.subject || ""}\n` +
          `Email:\n"""\n${String(msg.reply || msg.text || "").slice(0, 4000)}\n"""\n\nReturn the JSON.`,
        lien: { id: null, patient_name: "" },
      });
      role = parsed.sender_role === "clinic" ? "clinic" : "attorney";
      logActivity({ type: "decision", detail: `Sender ${from} is both staff and an attorney on file; writing as ${role} (Claude: ${parsed.reason || "content"}).` });
    } catch (err) {
      logActivity({ type: "error", detail: `Couldn't tell whether ${from} wrote as staff or attorney (will retry): ${err.message}` });
      return retry(err.message);
    }
  }
  return role === "clinic"
    ? handleStaffQuery(msg, { from })
    : handleAttorneyInitiated(msg, { from, liens: attorneyLiens });
}

const ATTORNEY_LOOKUP_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "One sentence: which patient the email is about and why." },
    lien_ids: { type: "array", items: { type: "integer" }, description: "answer: the one lien. multiple: each lien mentioned. Otherwise empty." },
    outcome: { type: "string", enum: ["answer", "clarify", "multiple", "not_found", "not_about_a_patient"] },
  },
  required: ["reasoning", "lien_ids", "outcome"],
  additionalProperties: false,
};

const ATTORNEY_LOOKUP_SYSTEM = `
A personal-injury attorney (or someone at their firm) emailed a medical clinic's lien agent directly instead of replying on an existing thread. You get the email and the liens LienPilot has on file for that attorney or firm (id | patient | date of service | status). Decide which lien it's about.
- Names may be misspelled, shortened, or last-name-only. The email may quote an earlier LienPilot message asking which patient they meant; use it.
- outcome "answer": it's clearly about exactly one of these liens.
- outcome "clarify": it's about a patient but you can't tell which of these liens (no name, or a name that fits several).
- outcome "multiple": it clearly discusses more than one of these liens.
- outcome "not_found": it names a patient who isn't in the list.
- outcome "not_about_a_patient": not about any patient's lien (a general note, a firm change, an introduction).
`;

/**
 * An attorney wrote in fresh. Acting on it changes a lien, and a fresh email
 * has no secret thread tag vouching for it, so the sender must authenticate;
 * otherwise a person at the clinic reviews it. One lien → handled exactly like
 * a reply on that lien's thread. Unclear → ask the attorney which patient
 * (without listing any names). Anything else → the default clinic contact.
 */
async function handleAttorneyInitiated(msg, { from, liens }) {
  const auth = senderVerified(msg);
  if (!auth.verified) {
    logActivity({ type: "decision", detail: `Email from attorney address ${from} couldn't be verified (${auth.detail}) → forward to ${CLINIC.fallback.name} instead of acting on it.` });
    return forwardToClinic(msg, { from, reason: `it claims to be from ${from} but the sender couldn't be verified (${auth.detail}), so LienPilot didn't act on it` });
  }

  let lookup;
  try {
    lookup = await callClaude({
      purpose: "Attorney email: which lien?",
      system: ATTORNEY_LOOKUP_SYSTEM,
      systemName: "ATTORNEY_LOOKUP_SYSTEM",
      schema: ATTORNEY_LOOKUP_SCHEMA,
      userMessage:
        `Liens on file for this attorney/firm:\n` +
        liens.map((l) => `#${l.id} | ${l.patient_name} | DOS ${l.date_of_service || "—"} | ${l.status}`).join("\n") +
        `\n\nEmail from ${msg.fromName ? `${msg.fromName} ` : ""}<${from}>, subject "${msg.subject || ""}":\n"""\n${String(msg.text || msg.reply || "").slice(0, 8000)}\n"""\n\nReturn the JSON.`,
      lien: { id: null, patient_name: "" },
    });
  } catch (err) {
    logActivity({ type: "error", detail: `Attorney email lookup failed (will retry): ${err.message}` });
    return retry(err.message);
  }

  const byId = new Map(liens.map((l) => [l.id, l]));
  const ids = [...new Set((lookup.lien_ids || []).map(Number))].filter((id) => byId.has(id));
  let outcome = lookup.outcome;
  if (outcome === "answer" && ids.length !== 1) outcome = ids.length > 1 ? "multiple" : "clarify";
  logActivity({
    type: "decision",
    detail: `Attorney email from ${from} (${auth.detail}) → ${outcome}${ids.length ? ` (${ids.map((id) => byId.get(id).patient_name).join(", ")})` : ""}. ${lookup.reasoning || ""}`,
  });

  if (outcome === "answer") {
    const lien = byId.get(ids[0]);
    // Give the lien a thread if it never had one, so the CCs and later replies share it.
    let token = lien.reply_token;
    if (!token) {
      token = makeReplyToken(lien.id);
      db.prepare("UPDATE liens SET reply_token = ? WHERE id = ? AND reply_token IS NULL").run(token, lien.id);
      token = db.prepare("SELECT reply_token FROM liens WHERE id = ?").get(lien.id).reply_token;
    }
    try {
      return await withLienLock(lien.id, () => processInboundReply({ msg: { ...msg, token }, from, token, lienId: lien.id }));
    } catch (err) {
      logActivity({ type: "error", lien_id: lien.id, patient_name: lien.patient_name, detail: `Unexpected error: ${err.message}` });
      return retry(err.message);
    }
  }

  try {
    if (outcome === "clarify") {
      await sendStaffReply({
        to: from, name: msg.fromName, msg,
        body: "Thanks for reaching out. Which patient is this about? Reply with the patient's full name and date of service, and LienPilot will get it to the right person at the clinic.",
      });
      return handled({ outcome });
    }
    const reason = {
      multiple: "it covers more than one patient, so it needs a person to split it up",
      not_found: "it's about a patient who isn't in LienPilot",
      not_about_a_patient: "it isn't about a specific patient's lien",
    }[outcome] || "LienPilot couldn't tell what it's about";
    return await forwardToClinic(msg, { from, reason });
  } catch (err) {
    logActivity({ type: "error", detail: `Attorney email from ${from} not handled (will retry): ${err.message}` });
    return retry(err.message);
  }
}

const CLINIC_FORWARD_LIMIT = 10; // per sender per hour, so a stream of junk can't flood the clinic
const clinicForwardTimes = new Map();

/** Hand an email LienPilot can't handle to the default clinic contact. Replying goes straight to the sender. */
async function forwardToClinic(msg, { from, reason }) {
  const key = splitEmail(from).address;
  const now = Date.now();
  const recent = (clinicForwardTimes.get(key) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= CLINIC_FORWARD_LIMIT) {
    logActivity({ type: "ignored", detail: `Email from ${from} not forwarded: over ${CLINIC_FORWARD_LIMIT} forwards from this sender this hour.` });
    return handled({ ignored: true });
  }
  recent.push(now);
  clinicForwardTimes.set(key, recent);

  const contact = CLINIC.fallback;
  const person = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const forward = forwardBlock({
    fromName: msg.fromName, from, date: msg.date, subject: msg.subject,
    to: msg.to.map(person), cc: msg.cc.map(person), body: msg.text || msg.reply,
  });
  const files = forwardableAttachments(msg);
  const subject = `Fwd: ${msg.subject || "(no subject)"}`;
  const body =
    `Hi ${firstName(contact.name)},\n\nThis came to LienPilot, but ${reason}. ` +
    `Forwarding it so someone can take a look; replying goes straight to ${msg.fromName || from}.` +
    (files.tooLarge.length ? `\n\nThe attachments were too large to forward (${files.totalMb} MB): ${files.tooLarge.join(", ")}.` : "") +
    `\n\nThanks,\nLienPilot\n\n${forward}`;
  try {
    if (isUndeliverable(contact.email)) throw new Error(`${contact.name}'s address is a placeholder (${contact.email})`);
    const messageId = await sendEmail({ to: contact.email, subject, body, replyTo: from, attachments: files.attachments });
    logActivity({
      type: "cc-sent",
      detail: `Forwarded ${from}'s email to ${contact.name} <${contact.email}>.`,
      data: emailLogData({ from: fromAddress(), to: contact.email, replyTo: from, subject, body, messageId, attachments: files.attachments }),
    });
    return handled({ forwarded: contact.email });
  } catch (err) {
    logActivity({ type: "error", detail: `Couldn't forward ${from}'s email to ${contact.name} (will retry): ${err.message}` });
    return retry(err.message);
  }
}

// ---- Staff questions ---------------------------------------------------------
// A clinic employee emails the agent's plain address ("what's going on with
// Lucas Reed?"). Only roster contacts and the staff list get answers, and only
// when the sender's domain authenticated the email: the reply carries patient
// data. Read-only: nothing is written to the lien.

const STAFF_RATE_LIMIT = 20; // questions per sender per hour
const staffQuestionTimes = new Map();

function staffMember(address) {
  const a = splitEmail(address).address;
  const contact = CLINIC.contacts.find((c) => splitEmail(c.email).address === a);
  if (contact) return { name: contact.name };
  if (CLINIC.staff.some((e) => splitEmail(e).address === a)) return { name: "" };
  return null;
}

function overRateLimit(address, limit = STAFF_RATE_LIMIT) {
  const now = Date.now();
  const recent = (staffQuestionTimes.get(address) || []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  staffQuestionTimes.set(address, recent);
  return recent.length > limit;
}

const STAFF_LOOKUP_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "One sentence: who they're asking about and which liens match." },
    question: { type: "string", description: "Their question, restated in one short sentence." },
    lien_ids: {
      type: "array",
      items: { type: "integer" },
      description: "answer: the lien(s) asked about. clarify: every plausible match. Otherwise empty.",
    },
    outcome: { type: "string", enum: ["answer", "clarify", "not_found", "portfolio", "not_a_question"] },
    window_days: {
      type: "integer",
      description: "portfolio only: the period they ask about in days (today 1, this week 7, this month 30). 7 if they don't say.",
    },
    group_firm: {
      type: "string",
      description: "portfolio only: the law firm or attorney they ask about, as written in the index. Empty if they don't narrow by firm.",
    },
    group_status: {
      type: "string",
      enum: [...OUTCOME_STATUSES, ""],
      description: "portfolio only: the one status they ask about (e.g. \"what's in Payment Pending?\"). Empty otherwise.",
    },
    group_owner: {
      type: "string",
      description: "portfolio only: the clinic contact or role whose open requests they ask about (\"what does Records owe?\"). Empty otherwise.",
    },
  },
  required: ["reasoning", "question", "lien_ids", "outcome", "window_days", "group_firm", "group_status", "group_owner"],
  additionalProperties: false,
};

const STAFF_LOOKUP_SYSTEM = `
You route questions that clinic staff email to LienPilot, an agent that follows up on personal-injury medical liens. You get the staff member's email and an index of every lien (id | patient | firm | date of service | status). Decide which lien(s) they mean.

- Names may be misspelled, shortened, last-name-only, or in "Last, First" form. Use any firm, attorney, or date details to narrow it down.
- The email may quote an earlier LienPilot message (for example a numbered list of possible matches). Use it to resolve follow-ups like "the second one" or "the Rivera one".
- outcome "answer": you can tell exactly which lien(s) they mean (at most 3, only ones they asked about).
- outcome "clarify": several liens fit one patient and nothing picks between them. List them all.
- outcome "not_found": they're asking about a patient but no lien fits.
- outcome "portfolio": a question about their liens in general or a group of them rather than one patient: "any updates this week?", "how many are waiting on attorneys?", "what's overdue?", "what does Records owe?", "how are Rivera Law's liens doing?". lien_ids empty. When they narrow to one firm/attorney, one status, or one clinic contact's open requests, fill group_firm / group_status / group_owner; otherwise leave them empty.
- outcome "not_a_question": no question at all (a thank-you, an FYI, an unrelated message). Nobody is replied to, so use this only when there is truly nothing to answer.
`;

const STAFF_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "The answer to their question from the facts, in the length and format the instructions ask for. No greeting, no sign-off.",
    },
  },
  required: ["answer"],
  additionalProperties: false,
};

const STAFF_ANSWER_SYSTEM = `
You answer a clinic staff member's question about a patient's lien for LienPilot, using ONLY the facts provided. The facts are the complete record; if they don't contain the answer, say what is known and that LienPilot doesn't have the rest. Never guess.

- Lead with the direct answer to what they asked, then the most useful context (what's open, what the attorney is waiting on, what happens next).
- Open requests: the attorney asked, the named clinic employee still has to send it. Phrase as "the attorney is waiting on [employee] for [item]." Never "[employee] is waiting on [item]." The firm does not complete those requests, but it is waiting on them: if any are open, do not say the firm "doesn't need anything from the clinic."
- Meeting a firm: lead with what that firm is waiting on from the clinic, plus settlement/payment status. "The firm has nothing to do" is only if they asked about the firm's own tasks, and even then say "they're waiting on us for …" if requests are open.
- Money flows one way: a lien is money the clinic expects to collect from the patient's case settlement, paid by the attorney. The clinic never pays the attorney, so a lien amount is never the clinic's obligation or debt.
- "Lien amount on file" is the amount uploaded to LienPilot, not a live balance; call it that.
- "Payment Sent" means the attorney said payment went out; LienPilot doesn't see it arrive.
- Contacting the attorney is LienPilot's job, done automatically. Say "LienPilot hasn't contacted the attorney yet", never "the clinic hasn't".
- Plain sentences, like a helpful coworker. Two to four sentences. No markdown, no greeting, no sign-off.
`;

function lienIndex(liens, text) {
  let pool = liens;
  if (pool.length > 300) {
    const words = new Set(String(text).toLowerCase().match(/[a-z]{3,}/g) || []);
    const hits = pool.filter((l) => l.patient_name.toLowerCase().split(/[^a-z]+/).some((w) => words.has(w)));
    pool = (hits.length ? hits : pool).slice(0, 300);
  }
  return pool
    .map((l) => `#${l.id} | ${l.patient_name} | ${l.firm_name || l.attorney_name} | DOS ${l.date_of_service || "—"} | ${l.status}`)
    .join("\n");
}

function nextFollowupText(lien) {
  if (FINAL_STATUSES.includes(lien.status)) return `none (${lien.status} is final)`;
  if (openRequestsOf(lien).length) return "paused until the clinic finishes its open request(s)";
  if (!lien.last_contact_date) return "due now (next Send follow-ups run)";
  const due = new Date(lien.last_contact_date + "T00:00:00");
  due.setDate(due.getDate() + FOLLOWUP_THRESHOLD_DAYS);
  return due <= today() ? "due now (next Send follow-ups run)" : due.toISOString().slice(0, 10);
}

/** The fixed facts block: straight from the database, so a bad sentence from Claude can't hide the record. */
function lienFacts(lien) {
  const days = lien.last_contact_date ? daysBetween(lien.last_contact_date, today()) : null;
  const open = openRequestsOf(lien);
  const notes = String(lien.notes || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-5);
  return [
    `Patient: ${lien.patient_name}`,
    `Attorney: ${lien.attorney_name}${lien.firm_name ? ` (${lien.firm_name})` : ""} <${lien.attorney_email}>`,
    `Status: ${lien.status}`,
    `Lien amount on file: $${Number(lien.lien_amount || 0).toLocaleString()} (as uploaded; not a live balance)`,
    `Date of service: ${lien.date_of_service || "not on file"}`,
    `Last contact with the attorney: ${lien.last_contact_date ? `${lien.last_contact_date} (${days} day${days === 1 ? "" : "s"} ago)` : "never"}`,
    `Waiting on an attorney reply: ${lien.awaiting_reply ? "yes" : "no"}`,
    `Open requests (attorney asked; clinic employee still has to send these to the attorney): ${open.length ? "" : "none"}`,
    ...open.map((r) => `  - Attorney is waiting on ${contactFor(r.category).name} (clinic) for ${r.text} (${r.category}), asked ${r.opened || "earlier"}`),
    `Next follow-up: ${nextFollowupText(lien)}`,
    `Recent activity:${notes.length ? "" : " none"}`,
    ...notes.map((n) => `  ${n}`),
  ];
}

const PORTFOLIO_ANSWER_SYSTEM = `
You answer a clinic staff member's question about their liens as a group for LienPilot, an agent that follows up with personal-injury attorneys on medical liens. Use ONLY the data provided: computed totals, one row per lien, and the activity log for the period. If the data doesn't answer it, say what it does show. Never guess.

- Open requests are things the attorney requested from the clinic (records, dates, a reduction decision); the named clinic employee handles it. Phrase it as "<patient>'s attorney is waiting on the <item> from <employee>" or "<attorney> requested the <item> for <patient> (<employee>)". Never "[employee] is waiting on [item]." Never use "owe", "owes", or "owed", even when the question does ("what does Records owe?" → "Here's what attorneys are waiting on from Records: ..."). Staff often mean those employees by role ("Records", "Scheduling", "billing"); the clinic contacts list maps names to roles.
- The firm does not complete open requests, but it is waiting on them. If any are open for that firm, never say the firm "does not need anything from the clinic." Meeting or lunch with a firm: lead with what they are waiting on from the clinic, plus settlement/payment status. "The firm has nothing to do" is only if they asked about the firm's own tasks, and even then follow with what the clinic still has to send.
- Following up with attorneys is LienPilot's job, done automatically; it is never a task for a clinic employee. A clinic employee is only responsible for the open requests assigned to them. If they have none, say plainly that they have nothing open right now.
- For counts, use the computed totals when one fits. If you must count rows yourself, count carefully and name the patients.
- Lead with the direct answer, then the most useful specifics (patient names, what attorneys are waiting on, what's next).
- Money flows one way: a lien is money the clinic expects to collect from the patient's case settlement, paid by the attorney. The clinic never pays the attorney, so a lien amount is never the clinic's obligation or debt.
- "Lien amount on file" is the uploaded amount, not a live balance. "Payment Sent" means the attorney said payment went out.
- Plain text for an email: up to six sentences, or a short intro line plus "- " bullet lines when listing several liens. No other markdown, no greeting, no sign-off.
`;

/**
 * Narrow a group question to the liens it's about. Matching is done here, not
 * by Claude, so "Rivera Law" counts are exact. Returns { liens, label, owner }.
 */
function groupFilter(liens, { firm, status, owner }) {
  let picked = liens;
  const labels = [];
  const f = String(firm || "").trim().toLowerCase();
  if (f) {
    const key = f.replace(/\b(law|legal|llp|llc|pc|pllc|firm|group|associates|&|and|the|office|offices)\b/g, " ").replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
    picked = picked.filter((l) => {
      const hay = `${l.firm_name} ${l.attorney_name}`.toLowerCase();
      return hay.includes(f) || (key.length && key.every((w) => hay.includes(w)));
    });
    labels.push(firm.trim());
  }
  if (status && OUTCOME_STATUSES.includes(status)) {
    picked = picked.filter((l) => l.status === status);
    labels.push(status);
  }
  let contact = null;
  const o = String(owner || "").trim().toLowerCase();
  if (o) {
    const roleWords = {
      records: "records",
      bills: "bills", itemized: "bills",
      treatment: "treatment", appointment: "treatment", schedule: "treatment", scheduling: "treatment",
      payment: "payments", payments: "payments", paid: "payments", check: "payments",
      reduction: "reductions", reductions: "reductions", balance: "reductions", balances: "reductions",
    };
    contact =
      CLINIC.contacts.find((c) => c.name.toLowerCase() === o) ||
      CLINIC.contacts.find((c) => c.name.toLowerCase().includes(o) || o.includes(c.name.toLowerCase())) ||
      CLINIC.contacts.find((c) => Object.entries(roleWords).some(([w, id]) => o.includes(w) && c.id === id)) ||
      null;
    if (contact) {
      picked = picked.filter((l) => openRequestsOf(l).some((r) => contactFor(r.category).id === contact.id));
      labels.push(`open with ${contact.name}`);
    }
  }
  return { liens: picked, label: labels.join(", "), owner: contact };
}

function isoDaysAgo(n) {
  const d = today();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Everything a group question can need, computed in code so the counts are
 * right: totals (also the email's fixed facts block), one row per lien, and
 * every dated note line from the last `windowDays`.
 */
function portfolioFacts(liens, windowDays, { label = "", owner = null } = {}) {
  const since = isoDaysAgo(Math.max(1, windowDays) - 1);
  const byStatus = new Map();
  const byOwner = new Map();
  const activity = [];
  let awaiting = 0;
  let due = 0;

  const rows = liens.map((l) => {
    byStatus.set(l.status, (byStatus.get(l.status) || 0) + 1);
    const open = openRequestsOf(l);
    for (const r of open) {
      const c = contactFor(r.category);
      if (owner && c.id !== owner.id) continue;
      if (!byOwner.has(c.name)) byOwner.set(c.name, []);
      byOwner.get(c.name).push(`${r.text} for ${l.patient_name}`);
    }
    if (l.awaiting_reply) awaiting++;
    if (isDueForFollowup(l)) due++;
    for (const line of String(l.notes || "").split("\n")) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
      if (m && m[1] >= since) activity.push({ date: m[1], patient: l.patient_name, text: m[2] });
    }
    const days = l.last_contact_date ? daysBetween(l.last_contact_date, today()) : null;
    return `${l.patient_name} | ${l.firm_name || l.attorney_name} | ${l.status} | $${Number(l.lien_amount || 0).toLocaleString()} on file | ` +
      `last contact ${l.last_contact_date ? `${l.last_contact_date} (${days}d ago)` : "never"} | ` +
      `${l.awaiting_reply ? "waiting on attorney" : "not waiting"} | ` +
      `attorney waiting on: ${open.length ? open.map((r) => `${r.text} (from ${contactFor(r.category).name})`).join("; ") : "nothing"} | ` +
      `next follow-up: ${nextFollowupText(l)}`;
  });

  const touched = new Set(activity.map((a) => a.patient)).size;
  const period = windowDays <= 1 ? "today" : `the last ${windowDays} days`;
  const summary = [
    `Liens${label ? ` (${label})` : ""}: ${liens.length}`,
    `By status: ${[...byStatus].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `Waiting on an attorney reply: ${awaiting}`,
    `Due for a follow-up now: ${due}`,
    `Open requests (attorney asked; clinic employee still has to send these to the attorney): ${byOwner.size ? "" : "none"}`,
    ...[...byOwner].map(([owner, items]) => `  - Attorney is waiting on ${owner} (clinic) for: ${items.join("; ")}`),
    `Activity in ${period}: ${activity.length} update${activity.length === 1 ? "" : "s"} on ${touched} lien${touched === 1 ? "" : "s"}`,
  ];
  activity.sort((a, b) => a.date.localeCompare(b.date));
  const log = activity.slice(-150).map((a) => `[${a.date}] ${a.patient}: ${a.text.slice(0, 240)}`);
  return { summary, rows, log, period };
}

async function sendStaffReply({ to, name, body, msg }) {
  const fullBody =
    `Hi ${name ? firstName(name) : "there"},\n\n${body}\n\nLienPilot` +
    (msg.text ? `\n\n${quoteMessage({ fromName: msg.fromName, from: to, date: msg.date, body: msg.text })}` : "");
  const replySubject = msg.subject ? (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`) : "LienPilot";
  const messageId = await sendEmail({ to, subject: replySubject, body: fullBody, inReplyTo: msg.messageId || null });
  logActivity({
    type: "email-sent",
    detail: `Answer emailed to ${to} via ${"Gmail"}.`,
    data: emailLogData({ from: fromAddress(), to, subject: replySubject, body: fullBody, messageId }),
  });
}

/**
 * The staff Q&A core, shared by emailed questions and the dashboard chat.
 * Read-only: it answers from the database and never changes a lien. Returns
 * { outcome, answer, facts: [blocks], lien_ids }. Throws on a Claude error;
 * callers decide whether that means "retry" (email) or an error message (chat).
 */
async function answerStaffQuestion({ text, askedBy, subject = "", channel = "email" }) {
  const noLien = { id: null, patient_name: "" };
  const liens = db.prepare("SELECT * FROM liens ORDER BY patient_name").all();
  const source =
    channel === "chat"
      ? `Chat message from ${askedBy} on the clinic dashboard`
      : `Email from ${askedBy}, subject "${subject}"`;

  const lookup = await callClaude({
    purpose: "Staff question: which lien?",
    system: STAFF_LOOKUP_SYSTEM,
    systemName: "STAFF_LOOKUP_SYSTEM",
    schema: STAFF_LOOKUP_SCHEMA,
    userMessage:
      `Clinic contacts: ${CLINIC.contacts.map((c) => `${c.name} (${c.handles.join(", ") || "everything"})`).join("; ")}\n\n` +
      `Lien index:\n${lienIndex(liens, text) || "(no liens)"}\n\n` +
      `${source}:\n"""\n${text}\n"""\n\nReturn the JSON.`,
    lien: noLien,
  });

  const byId = new Map(liens.map((l) => [l.id, l]));
  const ids = [...new Set((lookup.lien_ids || []).map(Number))].filter((id) => byId.has(id));
  let outcome = lookup.outcome;
  if (outcome === "answer" && !ids.length) outcome = "not_found";
  if (outcome === "answer" && ids.length > 3) outcome = "clarify";
  if (outcome === "clarify" && ids.length === 1) outcome = "answer";
  if (outcome === "clarify" && !ids.length) outcome = "not_found";
  logActivity({ type: "decision", detail: `Staff question → ${outcome}${ids.length ? ` (${ids.map((id) => byId.get(id).patient_name).join(", ")})` : ""}. ${lookup.reasoning || ""}` });

  if (outcome === "not_a_question") return { outcome, answer: "", facts: [], lien_ids: [] };

  if (outcome === "portfolio") {
    const windowDays = Math.min(365, Math.max(1, Number(lookup.window_days) || 7));
    const group = groupFilter(liens, { firm: lookup.group_firm, status: lookup.group_status, owner: lookup.group_owner });
    const pf = portfolioFacts(group.liens, windowDays, group);
    if (group.label) {
      logActivity({ type: "decision", detail: `Group question narrowed to ${group.label}: ${group.liens.length} lien(s).` });
    }
    const answer = await callClaude({
      purpose: "Staff question: answer (all liens)",
      system: PORTFOLIO_ANSWER_SYSTEM,
      systemName: "PORTFOLIO_ANSWER_SYSTEM",
      schema: STAFF_ANSWER_SCHEMA,
      userMessage:
        `Question: ${lookup.question}\nToday: ${todayISO()}\n` +
        (group.label
          ? `These are only the liens matching: ${group.label} (${group.liens.length} of ${liens.length}). If none match, say so.\n\n`
          : "\n") +
        `Clinic contacts (who handles what):\n${CLINIC.contacts.map((c) => `- ${c.name}: ${c.handles.join(", ") || "everything"}${c.default ? " (and anything else)" : ""}`).join("\n")}\n\n` +
        `Computed totals:\n${pf.summary.join("\n")}\n\n` +
        `One row per lien (patient | firm | status | amount | last contact | waiting | what the attorney is waiting on from the clinic | next follow-up):\n${pf.rows.join("\n")}\n\n` +
        `Activity log for ${pf.period}:\n${pf.log.join("\n") || "(none)"}\n\nReturn the JSON.`,
      lien: noLien,
    });
    return { outcome, answer: String(answer.answer || "").trim(), facts: [pf.summary.join("\n")], lien_ids: [] };
  }

  if (outcome === "not_found") {
    return {
      outcome,
      answer:
        "I couldn't find any liens matching that. If you're asking about one patient, reply with their full name, " +
        "and the attorney or date of service if you have it. For a firm, use the name as it appears on the lien.",
      facts: [],
      lien_ids: [],
    };
  }

  if (outcome === "clarify") {
    const options = ids.slice(0, 10).map((id, i) => {
      const l = byId.get(id);
      return `${i + 1}. ${l.patient_name} (${l.firm_name || l.attorney_name}, date of service ${l.date_of_service || "not on file"})`;
    });
    return {
      outcome,
      answer: `A few liens could match. Which one do you mean?\n\n${options.join("\n")}\n\nReply with the number or name.`,
      facts: [],
      lien_ids: ids,
    };
  }

  const picked = ids.map((id) => byId.get(id));
  const facts = picked.map((l) => lienFacts(l).join("\n"));
  const answer = await callClaude({
    purpose: "Staff question: answer",
    system: STAFF_ANSWER_SYSTEM,
    systemName: "STAFF_ANSWER_SYSTEM",
    schema: STAFF_ANSWER_SCHEMA,
    userMessage: `Question: ${lookup.question}\n\nFacts:\n${facts.join("\n\n")}\n\nReturn the JSON.`,
    lien: picked.length === 1 ? picked[0] : noLien,
  });
  return { outcome, answer: String(answer.answer || "").trim(), facts, lien_ids: ids };
}

/** An emailed staff question: verify the sender, answer, reply by email. */
async function handleStaffQuery(msg, { from }) {
  const member = staffMember(from);
  if (!member) {
    logActivity({ type: "ignored", detail: `Email from ${from} to LienPilot's address: not on the clinic roster or staff list, so no answer.` });
    return handled({ ignored: true });
  }
  const auth = senderVerified(msg);
  if (!auth.verified) {
    logActivity({ type: "ignored", detail: `Question from ${from} not answered: the sender couldn't be verified (${auth.detail}), and the answer would contain patient data.` });
    return handled({ ignored: true });
  }
  if (overRateLimit(splitEmail(from).address)) {
    logActivity({ type: "ignored", detail: `Question from ${from} not answered: over ${STAFF_RATE_LIMIT} questions this hour.` });
    return handled({ ignored: true });
  }

  // The full body, not just the new text: a follow-up ("the second one")
  // needs the quoted list LienPilot sent before.
  const text = String(msg.text || msg.reply || "").trim().slice(0, 8000);
  logActivity({
    type: "staff-question",
    detail: `Question from ${member.name || from} (${auth.detail}).`,
    data: { from, subject: msg.subject || "", body: msg.reply || text },
  });
  if (!text) return handled({ ignored: true });

  let result;
  try {
    result = await answerStaffQuestion({ text, askedBy: member.name || from, subject: msg.subject || "" });
  } catch (err) {
    logActivity({ type: "error", detail: `Staff question not answered (will retry): ${err.message}` });
    return retry(err.message);
  }
  if (result.outcome === "not_a_question") return handled({ ignored: true });

  try {
    await sendStaffReply({
      to: from, name: member.name, msg,
      body: result.answer + (result.facts.length ? `\n\n${result.facts.map((f) => `---\n${f}`).join("\n\n")}` : ""),
    });
  } catch (err) {
    logActivity({ type: "error", detail: `Staff question not answered (will retry): ${err.message}` });
    return retry(err.message);
  }
  return handled({ outcome: result.outcome, ...(result.lien_ids.length ? { lien_ids: result.lien_ids } : {}) });
}

/** Everything after the thread match. Runs inside the lien's lock. */
async function processInboundReply({ msg, from, token, lienId }) {
  // Read the lien fresh: a reply processed just before this one may have
  // changed it while this one was queued.
  const lien = db.prepare("SELECT * FROM liens WHERE id = ?").get(lienId);

  // The new text only; the quoted thread history below it is dropped.
  const replyText = String(msg.reply || msg.text || "").trim();
  if (!replyText) {
    logActivity({ type: "ignored", lien_id: lien.id, patient_name: lien.patient_name, detail: `Empty reply from ${from}; nothing to process.` });
    return handled({ ignored: true });
  }

  const attachments = (msg.attachments || []).map((a) => a.name).filter(Boolean);
  logActivity({
    type: "email-received",
    lien_id: lien.id,
    patient_name: lien.patient_name,
    detail: `Reply received from ${from} via ${"Gmail"}; matched to this lien's thread.`,
    data: {
      from,
      to: msg.to.map((a) => a.address).join(", "),
      subject: msg.subject || "",
      reply_token: token,
      ...(attachments.length ? { attachments: attachments.join(", ") } : {}),
      body: replyText,
    },
  });

  let sender;
  try {
    sender = await identifySender({ from, fromName: msg.fromName, replyText, lien });
  } catch (err) {
    logActivity({ type: "error", lien_id: lien.id, patient_name: lien.patient_name, detail: `Couldn't identify the sender (will retry): ${err.message}` });
    return retry(`Sender identification failed: ${err.message}`);
  }
  logActivity({
    type: "decision",
    lien_id: lien.id,
    patient_name: lien.patient_name,
    detail: `Sender is the ${sender.role === "clinic" ? "clinic" : "attorney's side"} (${sender.method}).`,
  });

  // Everyone who got this email, e.g. a clinic contact the attorney kept on Reply All.
  const onThisEmail = inboundAddresses(msg);

  if (sender.role === "clinic") {
    return handleClinicReply({ lien, from, replyText, attachments, onThisEmail });
  }

  let triage;
  try {
    triage = await triageReply(replyText, lien);
  } catch (err) {
    logActivity({ type: "error", lien_id: lien.id, patient_name: lien.patient_name, detail: `Triage failed (will retry): ${err.message}` });
    return retry(`Triage failed: ${err.message}`);
  }

  const plan = planRequests(lien, triage);
  // Forward the attorney's email: full body (not the stripped reply, since it
  // carries the attorney's own quoted history) plus their attachments.
  const person = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const forward = forwardBlock({
    fromName: msg.fromName,
    from,
    date: msg.date,
    subject: msg.subject,
    to: msg.to.map(person),
    cc: msg.cc.map(person),
    body: msg.text || replyText,
  });
  const files = forwardableAttachments(msg);
  const subject = msg.subject
    ? /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`
    : null;

  // Every new or chased request goes to the clinic employee who owns it.
  const { emails, skipped } = planClinicEmails(lien, plan, { onThisEmail, forward, files });
  const trailingNotes = requestNotes(plan, skipped);
  // Owners already on the attorney's email got the requests in that email.
  for (const k of skipped) stampMessageId(plan, k.request_ids, msg.messageId);
  const handedOff = [...emails.map((e) => e.contact.name), ...skipped.map((k) => k.contact.name)];

  logActivity({
    type: "decision",
    lien_id: lien.id,
    patient_name: lien.patient_name,
    detail: [
      plan.added.length ? `New for the clinic: ${plan.added.map(describeRequest).join("; ")}.` : null,
      plan.repeated.length ? `Attorney chased: ${plan.repeated.map((r) => `#${r.id} ${r.text}`).join(", ")}.` : null,
      plan.resolved.length ? `Attorney says handled: ${plan.resolved.map((r) => `#${r.id} ${r.text}`).join(", ")}.` : null,
      ...emails.map((e) => `${e.contact.name} ${e.kind === "intro" ? "isn't on the thread yet → CC them in" : "is on the thread but not this email → follow-up"}.`),
      ...skipped.map((k) => `${k.contact.name} is already on this email → no CC.`),
      !handedOff.length
        ? plan.requests.length
          ? `Nothing new for the clinic; ${plan.requests.length} request(s) still open.`
          : `No clinic action needed → reset contact clock; next chase in ${FOLLOWUP_THRESHOLD_DAYS} days.`
        : null,
    ].filter(Boolean).join(" "),
  });

  const sentTo = [];
  for (const email of emails) {
    try {
      if (isUndeliverable(email.to)) {
        throw new Error(`${email.contact.name}'s address is a placeholder (${email.to}); set a real inbox in clinic_contacts.json`);
      }
      const messageId = await sendEmail({
        to: email.to,
        cc: lien.attorney_email,
        subject: subject || email.subject,
        body: email.body,
        // Keeps LienPilot on the thread: Reply and Reply All come back here.
        replyTo: replyAddressFor(lien.reply_token),
        inReplyTo: msg.messageId || null,
        attachments: email.attachments,
      });
      stampMessageId(plan, email.request_ids, messageId);
      sentTo.push(email.to);
      trailingNotes.push(clinicEmailNote(email));
      logActivity({
        type: "cc-sent",
        lien_id: lien.id,
        patient_name: lien.patient_name,
        detail: `Clinic ${email.kind === "intro" ? "CC" : "follow-up"} emailed to ${email.contact.name} <${email.to}> (attorney cc'd) via ${"Gmail"}.`,
        data: emailLogData({
          from: fromAddress(),
          to: email.to,
          cc: lien.attorney_email,
          replyTo: replyAddressFor(lien.reply_token),
          subject: subject || email.subject,
          body: email.body,
          messageId,
          attachments: email.attachments,
        }),
      });
    } catch (err) {
      trailingNotes.push(`Clinic email to ${email.contact.name} failed (${err.message}); requests ${email.request_ids.map((id) => `#${id}`).join(", ")} still need them.`);
      logActivity({ type: "error", lien_id: lien.id, patient_name: lien.patient_name, detail: `Clinic email to ${email.contact.name} failed: ${err.message}` });
    }
  }

  applyTriage(lien, triage, plan, { trailingNotes, participants: [...onThisEmail, ...sentTo] });
  return handled({
    lien_id: lien.id,
    triage,
    open_requests: plan.requests,
    emailed: sentTo,
    skipped: skipped.map((k) => k.contact.email),
  });
}

// Local testing only (never set in .env): feed a raw email through the same
// path as the inbox, without Gmail. Off unless LIENPILOT_DEV_INBOUND=1.
if (process.env.LIENPILOT_DEV_INBOUND === "1") {
  app.post("/api/dev/inbound", express.text({ type: "message/rfc822", limit: "50mb" }), async (req, res) => {
    const result = await receiveInbound(await parseEmail(String(req.body || "")));
    res.status(result.status).json(result.body);
  });
}

/** Onboarding: the three hand-off roles and who fills each one today. */
app.get("/api/clinic-contacts", (_req, res) => {
  const configured = fs.existsSync(ROSTER_FILE);
  res.json({
    configured,
    lien_count: db.prepare("SELECT COUNT(*) AS c FROM liens").get().c,
    roles: CLINIC_ROLES.map((role) => {
      const current = configured ? CLINIC.contacts.find((c) => c.id === role.id) : null;
      return { ...role, name: current?.name || "", email: current?.email || "" };
    }),
    staff: CLINIC.staff,
    agent_address: emailConfigured() ? fromAddress() : "",
  });
});

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** Onboarding: save one email (and optional name) per role to clinic_contacts.json. */
app.put("/api/clinic-contacts", (req, res) => {
  const input = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  const errors = [];
  const contacts = CLINIC_ROLES.map((role) => {
    const entry = input.find((c) => c?.id === role.id) || {};
    const email = String(entry.email || "").trim();
    if (!EMAIL_RE.test(email)) errors.push(`${role.label}: enter a valid email address.`);
    return {
      id: role.id,
      name: String(entry.name || "").trim() || role.label,
      email,
      handles: role.handles,
      ...(role.default ? { default: true } : {}),
    };
  });
  const staff = [...new Set(
    (Array.isArray(req.body?.staff) ? req.body.staff : String(req.body?.staff || "").split(/[\s,;]+/))
      .map((e) => String(e).trim().toLowerCase())
      .filter(Boolean)
  )];
  const badStaff = staff.filter((e) => !EMAIL_RE.test(e));
  if (badStaff.length) errors.push(`Staff: ${badStaff.join(", ")} ${badStaff.length === 1 ? "isn't a" : "aren't"} valid email address${badStaff.length === 1 ? "" : "es"}.`);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  fs.writeFileSync(ROSTER_FILE, JSON.stringify({ contacts, staff }, null, 2) + "\n");
  CLINIC = loadClinicRoster();
  logActivity({
    type: "setup",
    detail:
      `Clinic contacts saved: ${CLINIC.contacts.map((c) => `${c.name} <${c.email}>`).join(", ")}.` +
      (CLINIC.staff.length ? ` Staff who can ask: ${CLINIC.staff.join(", ")}.` : ""),
  });
  res.json({ ok: true, contacts: CLINIC.contacts, staff: CLINIC.staff });
});

/** Real intake: append a spreadsheet of liens (raw CSV body, header row required), or replace the book with ?mode=replace. */
app.post("/api/import-liens", (req, res) => {
  const text = typeof req.body === "string" ? req.body : "";
  if (!text.trim()) {
    return res.status(400).json({ error: "Send the CSV as the request body (Content-Type: text/csv)." });
  }

  let records;
  try {
    records = parseCsv(text, {
      // "Patient Name" / "Lien Amount ($)" → patient_name / lien_amount
      columns: (header) =>
        header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")),
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not parse CSV: ${err.message}` });
  }

  // ?mode=replace (onboarding): the file becomes the whole book.
  const replace = req.query.mode === "replace";
  const result = importCsvLiens(records, { today: todayISO(), replace });
  logActivity({
    type: "import",
    detail:
      (result.replaced ? `Replaced ${result.replaced} existing lien(s). ` : "") +
      `Imported ${result.imported} lien(s) from CSV` + (result.skipped ? `; skipped ${result.skipped}.` : "."),
  });
  res.json(result);
});

/**
 * Dashboard chat: the same read-only Q&A as emailed staff questions. The client
 * sends the question plus the last few turns, so follow-ups ("the second one",
 * "what about Rivera Law?") resolve the same way a quoted email thread does.
 * No login yet: fine on localhost; needs auth before this is hosted anywhere.
 */
const CHAT_RATE_LIMIT = 60; // questions per hour, all dashboard users together
app.post("/api/ask", async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 2000);
  if (!question) return res.status(400).json({ error: "Ask a question." });
  if (overRateLimit("dashboard-chat", CHAT_RATE_LIMIT)) {
    return res.status(429).json({ error: `Over ${CHAT_RATE_LIMIT} questions this hour. Try again shortly.` });
  }

  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((t) => t && (t.role === "staff" || t.role === "lienpilot") && t.text)
    .slice(-6)
    .map((t) => `${t.role === "staff" ? "Staff" : "LienPilot"}: ${String(t.text).slice(0, 1500)}`);
  const text = history.length
    ? `Earlier in this chat:\n${history.join("\n\n")}\n\nNew question: ${question}`
    : question;

  logActivity({ type: "staff-question", detail: "Question from the dashboard chat.", data: { body: question } });
  try {
    const result = await answerStaffQuestion({ text, askedBy: "a clinic employee", channel: "chat" });
    if (result.outcome === "not_a_question") {
      return res.json({ ...result, answer: "Ask me about a patient's lien, a firm, or your liens overall (e.g. \"What's going on with Nina Patel?\")." });
    }
    res.json(result);
  } catch (err) {
    logActivity({ type: "error", detail: `Dashboard chat question failed: ${err.message}` });
    res.status(502).json({ error: "LienPilot couldn't answer that right now. Try again in a moment." });
  }
});

/**
 * Case summary for the dashboard's case panel: where the lien stands and what
 * happens next, in two short lines, so staff don't have to read the whole log.
 * Read-only. Cached per lien until anything it's built from changes (or the day
 * rolls over, since "days ago" is in the facts), so the 15-second refresh and
 * reopening a case cost nothing. Same-key requests share one in-flight call.
 */
const CASE_SUMMARY_RATE_LIMIT = 120; // fresh summaries per hour, all dashboard users together
const caseSummaries = new Map(); // lien id → { key, promise }

const CASE_SUMMARY_SYSTEM = `
You write a two-part status summary of one medical lien for the staff of the personal-injury clinic that holds it. LienPilot is the clinic's agent: it emails the patient's attorney for status and hands attorney requests to the right clinic employee. Use ONLY the facts given. Never guess.

- "summary": one or two plain sentences on where the case stands now: the stage, the latest thing the attorney said, and any agreed reduction or payment. Lead with the current state, not history.
- "next": one sentence on what happens next and who it's waiting on: the attorney (LienPilot is following up), a named clinic employee (say what the attorney is waiting on from them), or nobody (paid or closed). Say what LienPilot will do only if the "Next follow-up" fact says it; never promise anything else.
- Money flows one way: the attorney pays the clinic out of the settlement. "Payment Sent" means the attorney says it went out; only the clinic can confirm it arrived.
- Following up with the attorney is LienPilot's job, never a task for clinic staff.
- No markdown, no greeting, no dates unless they matter.
`;

const CASE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    next: { type: "string" },
  },
  required: ["summary", "next"],
  additionalProperties: false,
};

app.get("/api/liens/:id/summary", async (req, res) => {
  const lien = db.prepare("SELECT * FROM liens WHERE id = ?").get(Number(req.params.id));
  if (!lien) return res.status(404).json({ error: "No such lien." });

  const key = JSON.stringify([todayISO(), lien.status, lien.notes, lien.open_requests, lien.awaiting_reply,
    lien.last_contact_date, lien.reduced_amount, lien.paid_amount, lien.paid_date, CLINIC.contacts.map((c) => c.name)]);
  let entry = caseSummaries.get(lien.id);
  if (!entry || entry.key !== key) {
    if (overRateLimit("case-summary", CASE_SUMMARY_RATE_LIMIT)) {
      return res.status(429).json({ error: "Too many summaries this hour. Try again shortly." });
    }
    const allNotes = String(lien.notes || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const facts = [
      ...lienFacts(lien).filter((line) => !line.startsWith("Recent activity") && !/^\s{2}\[/.test(line)),
      `Agreed payoff: ${lien.reduced_amount != null ? `$${Number(lien.reduced_amount).toLocaleString()}` : "none (full lien owed)"}`,
      ...(lien.status === "Paid" ? [`Paid: ${lien.paid_amount != null ? `$${Number(lien.paid_amount).toLocaleString()}` : "amount not recorded"}${lien.paid_date ? ` on ${lien.paid_date}` : ""}`] : []),
      `Today: ${todayISO()}`,
      `Full activity log, oldest first:${allNotes.length ? "" : " none"}`,
      ...allNotes.map((n) => `  ${n}`),
    ];
    entry = {
      key,
      promise: callClaude({
        purpose: "Case summary",
        system: CASE_SUMMARY_SYSTEM,
        systemName: "CASE_SUMMARY_SYSTEM",
        schema: CASE_SUMMARY_SCHEMA,
        userMessage: `${facts.join("\n")}\n\nReturn the JSON.`,
        lien,
      }),
    };
    caseSummaries.set(lien.id, entry);
    entry.promise.catch(() => { if (caseSummaries.get(lien.id) === entry) caseSummaries.delete(lien.id); }); // retry next time
  }

  try {
    const { summary, next } = await entry.promise;
    res.json({ summary, next });
  } catch (err) {
    logActivity({ type: "error", lien_id: lien.id, patient_name: lien.patient_name, detail: `Case summary failed: ${err.message}` });
    res.status(502).json({ error: "Summary isn't available right now." });
  }
});

app.get("/api/activity", (_req, res) => {
  res.json({ live_email: emailConfigured(), activity });
});

/**
 * Clinic dashboard: "Received payment?" on a Payment Pending / Payment Sent lien.
 * Only the clinic can confirm money arrived (an attorney reply never sets Paid).
 *  - yes → Paid: the case closes, any open requests are cleared, chasing stops.
 *          Requires { amount }: what actually arrived (paid_amount; paid_date = today).
 *  - no  → Payment Pending: a "sent" payment that never arrived reopens, so
 *          LienPilot follows up again.
 * No login yet: like the rest of the dashboard, localhost only until auth exists.
 */
const PAYMENT_STAGES = [STATUSES.PAYMENT_PENDING, STATUSES.PAYMENT_SENT];
app.post("/api/liens/:id/payment-received", async (req, res) => {
  const id = Number(req.params.id);
  if (typeof req.body?.received !== "boolean") {
    return res.status(400).json({ error: "Send { received: true } or { received: false }." });
  }
  const received = req.body.received;
  const amount = received ? dollars(req.body.amount) : null;

  const result = await withLienLock(id, () => {
    const lien = db.prepare("SELECT * FROM liens WHERE id = ?").get(id);
    if (!lien) return { status: 404, body: { error: "Lien not found." } };
    if (!PAYMENT_STAGES.includes(lien.status)) {
      return { status: 409, body: { error: `${lien.patient_name} is ${lien.status}, not waiting on payment.` } };
    }
    if (received && (amount == null || amount > Number(lien.lien_amount))) {
      return { status: 400, body: { error: `Enter the amount received, up to the $${Number(lien.lien_amount).toLocaleString("en-US")} lien.` } };
    }

    const status = received ? STATUSES.PAID : STATUSES.PAYMENT_PENDING;
    const note = received
      ? `Clinic confirmed payment received (clinic dashboard): $${amount.toLocaleString("en-US")}. Case closed.`
      : `Clinic says payment has not been received (clinic dashboard)${lien.status === STATUSES.PAYMENT_SENT ? "; reopened to Payment Pending so LienPilot follows up" : ""}.`;
    if (received) {
      db.prepare(
        "UPDATE liens SET status = ?, action_needed = '', open_requests = '[]', awaiting_reply = 0, notes = ?, paid_amount = ?, paid_date = ? WHERE id = ?"
      ).run(status, appendNote(lien.notes, note), amount, todayISO(), id);
    } else {
      db.prepare("UPDATE liens SET status = ?, notes = ? WHERE id = ?").run(status, appendNote(lien.notes, note), id);
    }

    logActivity({
      type: "lien-updated",
      lien_id: id,
      patient_name: lien.patient_name,
      detail: received ? `Payment received: $${amount.toLocaleString("en-US")} (confirmed on the clinic dashboard) → Paid.` : `Payment not received (clinic dashboard) → ${status}.`,
      data: { status: `${lien.status} → ${status}`, notes_added: note },
    });
    return { status: 200, body: { ok: true, lien: lienView(db.prepare("SELECT * FROM liens WHERE id = ?").get(id)) } };
  });
  res.status(result.status).json(result.body);
});

app.post("/api/advance-clock", (req, res) => {
  const days = Number(req.body?.days);
  clockOffsetDays += Number.isFinite(days) ? days : 15;
  res.json({ clock_offset_days: clockOffsetDays, today: todayISO() });
});

// Restart simulation: keep the liens, clear their progress, zero the clock,
// and clear the live log.
app.post("/api/reset-simulation", (_req, res) => {
  try {
    const result = resetLienProgress();
    clockOffsetDays = 0;
    activity.length = 0;
    res.json({
      ...result,
      clock_offset_days: clockOffsetDays,
      today: todayISO(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Reset failed." });
  }
});

app.listen(PORT, () => {
  console.log(`LienPilot running at http://localhost:${PORT}`);
  if (emailConfigured()) {
    console.log(`Live email: ON (Gmail, ${fromAddress()}). New mail is pushed over IMAP IDLE; backup check every ${POLL_SECONDS}s.`);
    startGmailWatcher(async (msg) => (await receiveInbound(msg)).status, {
      loadCursor: () => getState("gmail_cursor"),
      saveCursor: (cursor) => setState("gmail_cursor", cursor),
      log: (detail) => {
        const failed = /failed|gave up|rejected/i.test(detail);
        if (failed) logActivity({ type: "error", detail });
        else console.log(`  ${detail}`);
      },
    });
    for (const c of CLINIC.contacts) {
      if (isUndeliverable(c.email)) {
        console.log(`  Warning: ${c.name}'s address is a placeholder (${c.email}); clinic emails to them will fail.`);
      }
    }
  } else {
    console.log(`Live email: OFF (missing ${missingEmailConfig().join(", ")}). Simulate mode only.`);
  }
});
