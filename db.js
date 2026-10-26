import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, "liens.db"));
db.exec("PRAGMA journal_mode = WAL");

// The statuses a lien can hold.
export const STATUSES = {
  UNKNOWN: "Unknown", // not established yet (e.g. a fresh clinic upload)
  CASE_ONGOING: "Case Ongoing",
  SETTLEMENT_PENDING: "Settlement Pending",
  PAYMENT_PENDING: "Payment Pending",
  PAYMENT_SENT: "Payment Sent", // attorney says it went out; LienPilot's job is done
  PAID: "Paid",
  CLOSED_UNCOLLECTIBLE: "Closed / Uncollectible",
};

// Clinic work items — the category of each open request an attorney makes of
// the clinic. Each category routes to one clinic contact (clinic_contacts.json).
export const ACTIONS = {
  MEDICAL_RECORDS: "Medical Records",
  ITEMIZED_BILL: "Itemized Bill",
  TREATMENT_STATUS: "Treatment Status",
  OTHER_DOCUMENTS: "Other Documents",
  CORRECTION_NEEDED: "Correction Needed",
  BALANCE_QUESTION: "Balance Question",
  REDUCTION_PAYOFF_DECISION: "Reduction / Payoff Decision",
  PAYMENT_ISSUE: "Payment Issue",
  CASE_CONTACT_ISSUE: "Case / Contact Issue",
};

export const ACTION_VALUES = Object.values(ACTIONS);

// The statuses Claude may assign after reading an attorney reply.
export const OUTCOME_STATUSES = [
  STATUSES.UNKNOWN,
  STATUSES.CASE_ONGOING,
  STATUSES.SETTLEMENT_PENDING,
  STATUSES.PAYMENT_PENDING,
  STATUSES.PAYMENT_SENT,
  STATUSES.PAID,
  STATUSES.CLOSED_UNCOLLECTIBLE,
];

// Only "Case Ongoing" is a non-alert outcome. Everything else Claude can
// assign is a real development the clinic should be told about.
export function shouldAlertClinic(status) {
  return status !== STATUSES.CASE_ONGOING;
}

// Final statuses: the lien is done, stop chasing. Everything else (including a
// blank status from a raw clinic upload) gets followed up. Payment Sent is
// final because receipt is confirmed in the clinic's billing system, not by
// email; a clinic reply on the thread ("never got it") reopens it.
export const FINAL_STATUSES = [
  STATUSES.PAYMENT_SENT,
  STATUSES.PAID,
  STATUSES.CLOSED_UNCOLLECTIBLE,
];

// Full current schema. Used for fresh databases and for the rebuild below.
// last_contact_date NULL = never contacted (typical for a clinic's CSV) and
// counts as due for follow-up immediately.
const liensTableSql = (target) => `
  CREATE TABLE ${target} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_name TEXT NOT NULL,
    clinic_name TEXT NOT NULL,
    attorney_name TEXT NOT NULL,
    attorney_email TEXT NOT NULL,
    firm_name TEXT NOT NULL DEFAULT '',
    date_of_service TEXT NOT NULL,
    lien_amount REAL NOT NULL,
    status TEXT NOT NULL,
    action_needed TEXT NOT NULL DEFAULT '',
    last_contact_date TEXT,
    notes TEXT NOT NULL DEFAULT '',
    reply_token TEXT,
    last_outbound_message_id TEXT,
    awaiting_reply INTEGER NOT NULL DEFAULT 0,
    open_requests TEXT NOT NULL DEFAULT '[]',
    thread_participants TEXT NOT NULL DEFAULT '[]',
    reduced_amount REAL,
    paid_amount REAL,
    paid_date TEXT
  );
`;

db.exec(liensTableSql("IF NOT EXISTS liens"));

// Columns added after the original schema.
const lienCols = db.prepare("PRAGMA table_info(liens)").all().map((c) => c.name);
if (!lienCols.includes("action_needed")) {
  db.exec("ALTER TABLE liens ADD COLUMN action_needed TEXT NOT NULL DEFAULT ''");
}
if (!lienCols.includes("firm_name")) {
  db.exec("ALTER TABLE liens ADD COLUMN firm_name TEXT NOT NULL DEFAULT ''");
}
// Live email: set when a real status request is sent and we're awaiting the
// attorney's reply; incoming mail is matched to the lien by this token.
if (!lienCols.includes("reply_token")) {
  db.exec("ALTER TABLE liens ADD COLUMN reply_token TEXT");
}
if (!lienCols.includes("last_outbound_message_id")) {
  db.exec("ALTER TABLE liens ADD COLUMN last_outbound_message_id TEXT");
}
// reply_token is now the lien's permanent thread id; awaiting_reply tracks
// whether we're waiting on the attorney. Before this column existed, a token
// was only present while awaiting, so backfill from that.
if (!lienCols.includes("awaiting_reply")) {
  db.exec("ALTER TABLE liens ADD COLUMN awaiting_reply INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE liens SET awaiting_reply = 1 WHERE reply_token IS NOT NULL");
}
// Each thing the clinic owes, as a JSON array of
// { id, text, category, opened, last_asked }. action_needed mirrors the oldest.
if (!lienCols.includes("open_requests")) {
  db.exec("ALTER TABLE liens ADD COLUMN open_requests TEXT NOT NULL DEFAULT '[]'");
}
// Lowercased addresses that have been on the lien's email thread.
if (!lienCols.includes("thread_participants")) {
  db.exec("ALTER TABLE liens ADD COLUMN thread_participants TEXT NOT NULL DEFAULT '[]'");
}
// Money: reduced_amount = the agreed payoff when a reduction was accepted (null =
// none agreed, so the full lien_amount is owed); paid_amount / paid_date = what the
// clinic confirmed it received (null on Paid liens marked before these existed).
for (const [col, type] of [["reduced_amount", "REAL"], ["paid_amount", "REAL"], ["paid_date", "TEXT"]]) {
  if (!lienCols.includes(col)) db.exec(`ALTER TABLE liens ADD COLUMN ${col} ${type}`);
}

// Older databases have last_contact_date NOT NULL. SQLite can't drop a
// constraint in place, so rebuild the table once, keeping every row and id.
const lastContactCol = db
  .prepare("PRAGMA table_info(liens)")
  .all()
  .find((c) => c.name === "last_contact_date");
if (lastContactCol?.notnull) {
  const cols = db.prepare("PRAGMA table_info(liens)").all().map((c) => c.name).join(", ");
  db.exec("BEGIN");
  try {
    db.exec(liensTableSql("liens_rebuild"));
    db.exec(`INSERT INTO liens_rebuild (${cols}) SELECT ${cols} FROM liens`);
    db.exec("DROP TABLE liens");
    db.exec("ALTER TABLE liens_rebuild RENAME TO liens");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Every status change, from any code path: SQLite triggers write it, so no
// UPDATE can forget to. from_status is null for a lien's first row (upload).
// Starts empty for liens that existed before this table: no backfill is invented.
db.exec(`
  CREATE TABLE IF NOT EXISTS status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lien_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS status_history_lien ON status_history (lien_id, id);
  CREATE TRIGGER IF NOT EXISTS lien_status_insert AFTER INSERT ON liens
  BEGIN
    INSERT INTO status_history (lien_id, from_status, to_status) VALUES (NEW.id, NULL, NEW.status);
  END;
  CREATE TRIGGER IF NOT EXISTS lien_status_update AFTER UPDATE OF status ON liens
    WHEN OLD.status IS NOT NEW.status
  BEGIN
    INSERT INTO status_history (lien_id, from_status, to_status) VALUES (NEW.id, OLD.status, NEW.status);
  END;
  CREATE TRIGGER IF NOT EXISTS lien_status_delete AFTER DELETE ON liens
  BEGIN
    DELETE FROM status_history WHERE lien_id = OLD.id;
  END;
`);

// Backfill firm names from known demo attorneys / emails.
db.prepare(`
  UPDATE liens SET firm_name = 'Okafor Law'
  WHERE (firm_name = '' OR firm_name IS NULL)
    AND (attorney_email LIKE '%okaforlaw%' OR attorney_name = 'David Okafor')
`).run();
db.prepare(`
  UPDATE liens SET firm_name = 'Kim & Associates'
  WHERE (firm_name = '' OR firm_name IS NULL)
    AND (attorney_email LIKE '%kimassociates%' OR attorney_name = 'Rachel Kim')
`).run();
db.prepare(`
  UPDATE liens SET firm_name = 'Nadar Legal'
  WHERE (firm_name = '' OR firm_name IS NULL)
    AND (attorney_email LIKE '%nadarlegal%' OR attorney_name = 'Priya Nadar')
`).run();

// Migrate legacy statuses from the previous 8-status model.
const LEGACY_STATUS_MAP = {
  "Treatment Complete": STATUSES.CASE_ONGOING,
  "Awaiting Case Update": STATUSES.CASE_ONGOING,
  "Reduction Pending": STATUSES.SETTLEMENT_PENDING,
  "Problem / Escalated": STATUSES.CLOSED_UNCOLLECTIBLE,
};
// A blank status used to mean "unknown"; it's an explicit status now.
db.prepare("UPDATE liens SET status = ? WHERE status = '' OR status IS NULL").run(STATUSES.UNKNOWN);

for (const [from, to] of Object.entries(LEGACY_STATUS_MAP)) {
  db.prepare("UPDATE liens SET status = ? WHERE status = ?").run(to, from);
}

// Older category names, split so each kind of ask can go to its own desk:
// "Documents Needed" → Medical Records / Itemized Bill / Other Documents (by
// what the request says); "Treatment Info Needed" and the even older
// "Information Needed" → Treatment Status. Only old names are touched, so this
// is a no-op once migrated.
function splitDocumentsRequest(text) {
  const t = String(text || "").toLowerCase();
  if (/\bbill|ledger|statement|itemi[sz]ed|charges|invoice/.test(t)) return ACTIONS.ITEMIZED_BILL;
  if (/record|chart|note|report|imaging|x-?ray|mri|narrative/.test(t)) return ACTIONS.MEDICAL_RECORDS;
  return ACTIONS.OTHER_DOCUMENTS;
}
// "Scheduling Request" lost its desk (2026-10-16): appointments are treatment facts now.
const OLD_TREATMENT = new Set(["Treatment Info Needed", "Information Needed", "Scheduling Request"]);
function migrateCategory(category, text) {
  if (category === "Documents Needed") return splitDocumentsRequest(text);
  if (OLD_TREATMENT.has(category)) return ACTIONS.TREATMENT_STATUS;
  return category;
}
for (const row of db.prepare("SELECT id, action_needed, open_requests FROM liens").all()) {
  let requests = [];
  try { requests = JSON.parse(row.open_requests || "[]"); } catch { requests = []; }
  if (!Array.isArray(requests)) requests = [];
  const migrated = requests.map((r) => ({ ...r, category: migrateCategory(r?.category, r?.text) }));
  const requestsChanged = JSON.stringify(migrated) !== JSON.stringify(requests);
  // action_needed mirrors the oldest open request; with no list, map the name alone.
  const action = migrated.length ? migrated[0].category : migrateCategory(row.action_needed, "records");
  if (requestsChanged || action !== row.action_needed) {
    db.prepare("UPDATE liens SET open_requests = ?, action_needed = ? WHERE id = ?")
      .run(JSON.stringify(migrated), action || "", row.id);
  }
}

/**
 * A lien with an action but no request list (older rows, CSV uploads, demo
 * seeds) gets one request standing in for that action, so every open action
 * is a trackable, routable request.
 */
function backfillOpenRequests() {
  db.exec(`
    UPDATE liens
       SET open_requests = json_array(json_object(
             'id', 1, 'text', action_needed, 'category', action_needed,
             'opened', COALESCE(last_contact_date, ''), 'last_asked', COALESCE(last_contact_date, '')))
     WHERE action_needed != '' AND open_requests IN ('', '[]')
  `);
}
backfillOpenRequests();

// If every lien has no action set (e.g. upgraded DB), stamp a few demo actions.
const actioned = db.prepare(
  "SELECT COUNT(*) AS c FROM liens WHERE action_needed IS NOT NULL AND action_needed != ''"
).get().c;
if (actioned === 0) {
  const byPatient = db.prepare("UPDATE liens SET action_needed = ? WHERE patient_name = ?");
  byPatient.run(ACTIONS.MEDICAL_RECORDS, "Maria Gonzalez");
  byPatient.run(ACTIONS.TREATMENT_STATUS, "James Whitfield");
  byPatient.run(ACTIONS.REDUCTION_PAYOFF_DECISION, "Leon Alvarez");
  byPatient.run(ACTIONS.PAYMENT_ISSUE, "Grace Chen");
}

// Small key/value store for app state that must survive restarts (e.g. how far
// the Gmail poller has read).
db.exec("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

export function getState(key) {
  const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function setState(key, value) {
  db.prepare(
    "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, JSON.stringify(value));
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Seed a spread of statuses and actions on first run so the demo works immediately.
const seedCount = db.prepare("SELECT COUNT(*) AS c FROM liens").get().c;
if (seedCount === 0) {
  const insert = db.prepare(`
    INSERT INTO liens
      (patient_name, clinic_name, attorney_name, attorney_email, firm_name,
       date_of_service, lien_amount, status, action_needed, last_contact_date, notes)
    VALUES
      (@patient_name, @clinic_name, @attorney_name, @attorney_email, @firm_name,
       @date_of_service, @lien_amount, @status, @action_needed, @last_contact_date, @notes)
  `);

  const seeds = [
    {
      patient_name: "Maria Gonzalez", clinic_name: "Summit Spine & Injury",
      attorney_name: "David Okafor", attorney_email: "dokafor@okaforlaw.example",
      firm_name: "Okafor Law",
      date_of_service: daysAgo(120), lien_amount: 8400,
      status: STATUSES.CASE_ONGOING,
      action_needed: ACTIONS.MEDICAL_RECORDS,
      last_contact_date: daysAgo(42),
      notes: "Okafor Law needs the itemized final bill, complete chart notes, and a signed LOP before they can send the demand.",
    },
    {
      patient_name: "James Whitfield", clinic_name: "Summit Spine & Injury",
      attorney_name: "Rachel Kim", attorney_email: "rkim@kimassociates.example",
      firm_name: "Kim & Associates",
      date_of_service: daysAgo(95), lien_amount: 15250,
      status: STATUSES.CASE_ONGOING,
      action_needed: ACTIONS.TREATMENT_STATUS,
      last_contact_date: daysAgo(18),
      notes: "Kim & Associates asked us to confirm the date treatment was completed and the exact balance still outstanding.",
    },
    {
      patient_name: "Tanya Brooks", clinic_name: "Riverbend Physical Therapy",
      attorney_name: "David Okafor", attorney_email: "dokafor@okaforlaw.example",
      firm_name: "Okafor Law",
      date_of_service: daysAgo(60), lien_amount: 4300,
      status: STATUSES.CASE_ONGOING,
      action_needed: ACTIONS.CORRECTION_NEEDED,
      last_contact_date: daysAgo(9),
      notes: "Firm flagged that DOS on the bill shows 7/12 but their file has 7/14, and CPT 97110 units don’t match the records.",
    },
    {
      patient_name: "Leon Alvarez", clinic_name: "Riverbend Physical Therapy",
      attorney_name: "Priya Nadar", attorney_email: "pnadar@nadarlegal.example",
      firm_name: "Nadar Legal",
      date_of_service: daysAgo(210), lien_amount: 22100,
      status: STATUSES.SETTLEMENT_PENDING,
      action_needed: ACTIONS.REDUCTION_PAYOFF_DECISION,
      last_contact_date: daysAgo(6),
      notes: "Nadar Legal settled the case and is asking the clinic to accept $14,500 on the $22,100 lien — accept, counter, or decline.",
    },
    {
      patient_name: "Grace Chen", clinic_name: "Summit Spine & Injury",
      attorney_name: "Rachel Kim", attorney_email: "rkim@kimassociates.example",
      firm_name: "Kim & Associates",
      date_of_service: daysAgo(150), lien_amount: 9800,
      status: STATUSES.PAYMENT_PENDING,
      action_needed: ACTIONS.PAYMENT_ISSUE,
      last_contact_date: daysAgo(3),
      notes: "Trust check arrived for $9,200; agreed payoff was $9,800. Need a corrected check or written explanation of the $600 shortfall.",
    },
    {
      patient_name: "Marcus Bell", clinic_name: "Riverbend Physical Therapy",
      attorney_name: "Priya Nadar", attorney_email: "pnadar@nadarlegal.example",
      firm_name: "Nadar Legal",
      date_of_service: daysAgo(300), lien_amount: 5600,
      status: STATUSES.CLOSED_UNCOLLECTIBLE,
      action_needed: ACTIONS.CASE_CONTACT_ISSUE,
      last_contact_date: daysAgo(11),
      notes: "Nadar Legal withdrew — client hired new counsel (unknown firm). Need updated attorney contact or direction on whether to write off.",
    },
    {
      patient_name: "Alicia Nguyen", clinic_name: "Summit Spine & Injury",
      attorney_name: "David Okafor", attorney_email: "dokafor@okaforlaw.example",
      firm_name: "Okafor Law",
      date_of_service: daysAgo(75), lien_amount: 6120,
      status: STATUSES.CASE_ONGOING,
      action_needed: "",
      last_contact_date: daysAgo(14),
      notes: "Case still in negotiation with the carrier. No clinic action required right now.",
    },
    {
      patient_name: "Samuel Ortiz", clinic_name: "Riverbend Physical Therapy",
      attorney_name: "Rachel Kim", attorney_email: "rkim@kimassociates.example",
      firm_name: "Kim & Associates",
      date_of_service: daysAgo(280), lien_amount: 7450,
      status: STATUSES.PAID,
      action_needed: "",
      last_contact_date: daysAgo(22),
      notes: "Full payoff of $7,450 received by ACH on 8/25. Account closed.",
    },
  ];

  db.exec("BEGIN");
  try {
    for (const r of seeds) insert.run(r);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  backfillOpenRequests();
}
backfillOpenRequests(); // the demo actions stamped above

/** Wipe liens and re-import practice_liens.json (demo reset). */
// Spreadsheet / legacy values mapped onto the canonical enums.
const STATUS_ALIASES = {
  Settled: STATUSES.SETTLEMENT_PENDING,
};
const ACTION_ALIASES = {
  None: "",
  "Information Needed": ACTIONS.TREATMENT_STATUS,
  "Treatment Info Needed": ACTIONS.TREATMENT_STATUS,
  "Documents Needed": ACTIONS.MEDICAL_RECORDS, // old spreadsheets and the practice book
  "Updated Balance Needed": ACTIONS.BALANCE_QUESTION,
  "Reduction Request": ACTIONS.REDUCTION_PAYOFF_DECISION,
  "Payment Follow-Up": ACTIONS.PAYMENT_ISSUE,
  "Attorney Follow-Up": ACTIONS.CASE_CONTACT_ISSUE,
};
const VALID_STATUSES = new Set(Object.values(STATUSES));
const VALID_ACTIONS = new Set(ACTION_VALUES);
const REQUIRED_FIELDS = ["patient_name", "clinic_name", "attorney_name", "attorney_email"];

// Accepts YYYY-MM-DD or spreadsheet-style M/D/YYYY (or M/D/YY). Returns ISO or null.
function toISODate(value) {
  const s = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * Validate one incoming lien row (practice JSON or uploaded CSV) and map it onto
 * the table's columns. Returns { row } on success or { error } explaining why the
 * row was skipped. A missing last_contact_date is stored as null (never
 * contacted); `today` only dates the imported note.
 */
export function normalizeLienRow(r, { today } = {}) {
  const missing = REQUIRED_FIELDS.filter((f) => !String(r[f] ?? "").trim());
  if (missing.length) return { error: `missing ${missing.join(", ")}` };

  const rawStatus = String(r.status ?? "").trim();
  const status = rawStatus ? STATUS_ALIASES[rawStatus] || rawStatus : STATUSES.UNKNOWN;
  if (!VALID_STATUSES.has(status)) return { error: `unknown status "${rawStatus}"` };

  let action = String(r.action_needed ?? "").trim();
  if (action in ACTION_ALIASES) action = ACTION_ALIASES[action];
  if (action && !VALID_ACTIONS.has(action)) return { error: `unknown action_needed "${action}"` };

  const amount = Number(String(r.lien_amount ?? "0").replace(/[$,\s]/g, "") || 0);
  if (!Number.isFinite(amount)) return { error: `bad lien_amount "${r.lien_amount}"` };

  // Blank (or a spreadsheet placeholder like "N/A") = never contacted: stored
  // NULL, due for follow-up right away. Present but unparseable = error.
  const rawContact = String(r.last_contact_date ?? "").trim();
  const neverContacted = !rawContact || /^(n\/?a|none|never|null|-+)$/i.test(rawContact);
  const lastContact = neverContacted ? null : toISODate(rawContact);
  if (!neverContacted && !lastContact) return { error: `bad last_contact_date "${rawContact}"` };

  let dateOfService = "";
  if (String(r.date_of_service ?? "").trim()) {
    dateOfService = toISODate(r.date_of_service);
    if (!dateOfService) return { error: `bad date_of_service "${r.date_of_service}"` };
  }

  const rawNote = String(r.notes ?? "").trim();
  const noteDate = lastContact || today;
  const notes = rawNote && !/^\[/.test(rawNote) && noteDate ? `[${noteDate}] ${rawNote}` : rawNote;

  return {
    row: {
      patient_name: String(r.patient_name).trim(),
      clinic_name: String(r.clinic_name).trim(),
      attorney_name: String(r.attorney_name).trim(),
      attorney_email: String(r.attorney_email).trim(),
      firm_name: String(r.firm_name ?? "").trim(),
      date_of_service: dateOfService,
      lien_amount: amount,
      status,
      action_needed: action,
      last_contact_date: lastContact,
      notes,
    },
  };
}

const insertLien = db.prepare(`
  INSERT INTO liens
    (patient_name, clinic_name, attorney_name, attorney_email, firm_name,
     date_of_service, lien_amount, status, action_needed, last_contact_date, notes)
  VALUES
    (@patient_name, @clinic_name, @attorney_name, @attorney_email, @firm_name,
     @date_of_service, @lien_amount, @status, @action_needed, @last_contact_date, @notes)
`);

function insertAll(rows, { replace = false } = {}) {
  db.exec("BEGIN");
  try {
    if (replace) db.exec("DELETE FROM liens");
    for (const r of rows) insertLien.run(r);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  backfillOpenRequests();
}

/**
 * Demo reset: keep every lien (patient, attorney, amount…) but wipe what
 * LienPilot has learned or done — status, clinic action, activity notes,
 * contact date, and email-thread state — so each lien looks freshly uploaded.
 * Status goes back to Unknown; notes is NOT NULL, so "empty" is ''.
 */
export function resetLienProgress() {
  const result = db
    .prepare(
      `UPDATE liens
         SET status = 'Unknown', action_needed = '', notes = '', last_contact_date = NULL,
             reply_token = NULL, awaiting_reply = 0, last_outbound_message_id = NULL,
             open_requests = '[]', thread_participants = '[]',
             reduced_amount = NULL, paid_amount = NULL, paid_date = NULL`
    )
    .run();
  db.exec("DELETE FROM status_history");
  return { reset: Number(result.changes) };
}

/** Wipe the table and reload practice_liens.json (not wired to the UI). */
export function importPracticeBook() {
  const file = path.join(__dirname, "practice_liens.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));

  const normalized = [];
  let skipped = 0;
  for (const r of rows) {
    const { row } = normalizeLienRow(r);
    if (row) normalized.push(row);
    else skipped++;
  }

  insertAll(normalized, { replace: true });
  return { imported: normalized.length, skipped };
}

/**
 * Real intake: add uploaded spreadsheet rows to the book. Bad rows are skipped
 * and reported with their spreadsheet line number. replace: true (onboarding)
 * swaps the whole book for this file, but only when at least one row is valid,
 * so a broken file never wipes the existing liens.
 */
export function importCsvLiens(rows, { today, replace = false } = {}) {
  const normalized = [];
  const errors = [];
  rows.forEach((r, i) => {
    const { row, error } = normalizeLienRow(r, { today });
    if (row) normalized.push(row);
    else errors.push({ line: i + 2, error }); // +2: header is line 1
  });

  const replaced = replace && normalized.length > 0
    ? db.prepare("SELECT COUNT(*) AS c FROM liens").get().c
    : 0;
  insertAll(normalized, { replace: replace && normalized.length > 0 });
  return { imported: normalized.length, skipped: errors.length, errors, replaced };
}

export default db;
