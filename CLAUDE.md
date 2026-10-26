# Sandbox: LienPilot — Claude Context

MVP of a Sandbox product: **LienPilot**, an email agent that chases medical-lien
status for personal-injury clinics. Not a clinic dashboard — clinics only appear
when the agent CCs them.

## What the agent does
1. Decide which liens need follow-up and send a status-request email.
2. Read attorney replies and update the lien’s internal status/notes.
3. When the attorney asks the clinic for something (records, bills, balances,
   treatment status, dates of service, reductions…), hand it to the clinic
   employee who owns that category. LienPilot never answers those itself
   (removed 2026-10-16: records/billing/treatment is the clinic's job).
4. If nothing is required, schedule the next follow-up.

## Stack
- Node.js (ESM) + Express, SQLite via Node’s built-in `node:sqlite`.
- Anthropic API (`@anthropic-ai/sdk`, model `claude-haiku-4-5`) for reply triage only.
- Vanilla-JS stage UI in `public/` so you can watch the agent work.

## Layout
- `clinic_contacts.json` — clinic roster: name, email, and the request categories each
  person handles (one `default`). Missing file → single `CLINIC_CONTACT_*` from `.env`.
- `db.js` — SQLite setup, 5 statuses, 8 request categories, `normalizeLienRow()`
  (shared validation), `importPracticeBook()` (demo reset), `importCsvLiens()` (additive intake; `?mode=replace` from onboarding replaces the book).
- `email.js` — the agent's Gmail account (`GMAIL_USER` + `GMAIL_APP_PASSWORD`; Postmark
  was removed 2026-09-25). nodemailer SMTP out + `startGmailWatcher()` in: one IMAP connection held open in IDLE (Gmail pushes
  `exists` on new mail → handled immediately), reconnect with backoff 2s→60s on any drop,
  IDLE re-issued every 10 min, backup check every `GMAIL_POLL_SECONDS` (default 60) on the
  same connection. It tracks the last handled IMAP UID in `app_state.gmail_cursor`, not
  read/unread, so reading the inbox by hand hides nothing; first run starts at the inbox's
  end; a 5xx is retried up to 3 checks, later mail waits behind it. `parseEmail()`
  turns a raw message into one plain object (`from`, `to`, `cc`, `subject`, `text`,
  `reply` = new text via `stripQuotedReply()`, `token`, `attachments` with content,
  `authResults`…; documented at the top of the file). Plus `+tag` reply-token helpers,
  `isOwnAddress()`, `senderVerified()`.
- `replies.js` — deterministic simulated attorney replies for Simulate/Present.
- `server.js` — Express routes. Live loop: `POST /api/send-followups` (outbound) and
  `receiveInbound(msg)` (fed by the Gmail watcher; returns `{ status, body }`, 5xx = retry;
  ignores auto-replies and our own mail). `POST /api/dev/inbound` (raw email in) exists only
  with `LIENPILOT_DEV_INBOUND=1`, for local tests. Simulated loop: `POST /api/run-followups`.
  Both funnel through `triageReply()` → `applyTriage()` so they can't drift apart.
- `public/` — liens table, CSV import, Live activity feed, Simulate/Present demo.
  `dashboard.html` — clinic dashboard in LienPilot brand colors (2026-10-22: navy `#0A1C34` header
  with `public/logo.png` + Lien/Pilot wordmark, white cards on warm off-white, Pilot blue `#0088FE`
  = actions / collected, leather brown `#825133` = needs attention, grey `#8A929E` = outstanding
  (chart + strip key); tokens at the top
  of the file, dark mode re-stepped on navy), cut down 2026-10-21 to the core job
  (every lien followed up, nothing slipping): a three-number money strip: Outstanding
  (open liens at `reduced_amount ?? lien_amount`) · Collected (Paid only, `paid_amount`; Payment
  Sent shown beside it, never added) · Average reduction (mean % off across liens with an agreed
  payoff, or Paid with an amount); then three columns: cases (by attorney) | by stage (widest
  column: a bar per open stage, length = lien count, balance beside the name, zeros included;
  under it "Collected vs outstanding": stacked areas, daily from the first day on record to
  today. Stage per day comes from `status_history` (sent in `/api/liens`; before a lien's first
  change, that change's from-stage; no history → current stage); a Paid lien is outstanding until
  `paid_date`, then collected at `paid_amount`; dollars use today's agreed payoff (reductions aren't
  historized), so today's point matches the strip. Hover crosshair + tooltip, "Show table") | actions needed (by desk; each links to its email
  in the owner's Gmail via `rfc822msgid` search) + Ask LienPilot chat. Clicking a case opens a
  case panel (dialog, from the `/api/liens` row, live on refresh): facts, open clinic requests,
  payment buttons when relevant, and the notes log newest first as the activity timeline. On top,
  "Where it stands": an AI summary + next step (`GET /api/liens/:id/summary`, read-only, triage
  model, built from `lienFacts()` + the full notes; cached per lien until its record changes or the
  day rolls over; 120 fresh summaries/hour; no login: localhost only until auth exists). The aging grid and the
  waiting-on / overdue counts were removed.
  `onboarding.html` — clinic setup: one email (+ optional name) per hand-off role
  (Payments, Medical records, Itemized bills, Treatment status, Reductions & balances; `CLINIC_ROLES` in server.js fixes which
  categories each owns), then CSV upload. `GET/PUT /api/clinic-contacts` rewrites
  `clinic_contacts.json` and reloads the roster live. First run (no roster file and
  no liens) redirects there.
- `practice_liens.json` — practice book (`importPracticeBook()`; not wired to the UI).
- `sample_liens.csv` — example import file (placeholder `.example` attorney addresses).

## Core model
**Statuses:** Unknown (not established yet; the default for uploads and after
Restart simulation; any attorney reply moves it to at least Case Ongoing), Case Ongoing, Settlement Pending, Payment Pending,
Payment Sent, Paid, Closed / Uncollectible. **Payment Sent** = the attorney says payment went
out; it's final (chasing stops) because receipt isn't confirmed by email, the clinic's billing
system is the record. An attorney reply never sets Paid (code guard → Payment Sent); only the
clinic can: by email reply, or the dashboard's "Received payment? Yes/No" on Payment Pending /
Payment Sent cases (`POST /api/liens/:id/payment-received`: yes + `amount` (asked in a dialog,
prefilled with the agreed payoff) → Paid, `paid_amount`/`paid_date` set, open requests cleared;
no → Payment Pending, so chasing resumes). A clinic "never got it" reply reopens it to Payment Pending. Definitions live in `STATUS_GUIDE` (server.js), shared by
both Claude prompts.

**Money** (added 2026-10-16): `reduced_amount` = agreed payoff (null = full lien owed),
filled from `agreed_amount` in either triage (attorney says the clinic agreed; clinic accepts a
reduction; a proposal is not agreed; ignored if above the lien). `paid_amount`/`paid_date` =
what the clinic confirmed (dashboard dialog, or `received_amount` from a clinic email); leaving
Paid clears them. `moneyChanges()` in server.js. Paid liens from before this have null
`paid_amount` and count at the full amount (the dashboard says so).
**Status history** (`status_history`: lien_id, from/to, changed_at UTC): written by SQLite
triggers on every status insert/update, so no code path can skip it; deleted with the lien;
cleared by Restart simulation. Not backfilled; drives the dashboard's collected-vs-outstanding chart.

**Clinic requests** (`liens.open_requests`, JSON array `{id, text, category, opened,
last_asked, message_id}`): each thing the clinic owes, one category each: Medical Records,
Itemized Bill, Treatment Status, Other Documents, Correction Needed,
Balance Question, Reduction / Payoff Decision, Payment Issue, Case / Contact Issue. The
category picks the owner: `CLINIC_ROLES` (server.js) fixes each role's categories (records,
payments, records, bills, treatment, reductions = default; Scheduling was removed 2026-10-16 and
appointment questions fold into Treatment Status); `clinic_contacts.json` only says who fills
each role. `action_needed` mirrors the oldest open request. (Split 2026-10-16: "Documents
Needed" → Medical Records / Itemized Bill / Other Documents by wording, "Treatment Info
Needed" and older "Information Needed" → Treatment Status; `db.js` migrates old rows.)

**Thread participants** (`liens.thread_participants`): every address seen on the
thread (attorney on send, each contact emailed, all From/To/Cc on inbound mail).

## Live loop (v1)
**Send follow-ups** emails a real status request (from the agent's Gmail) to every lien that's
due: any non-final status (blank included; only Payment Sent / Paid / Closed stop it), no open
clinic action, and never contacted (null date) or 30+ days of silence. Wording
fits the stage (case status / payoff / payment timing).

Each lien's thread has a permanent reply address `agent+TOKEN@gmail.com`
(`liens.reply_token`, never cleared); `awaiting_reply` tracks waiting on the attorney.
Every reply goes through `receiveInbound()`, which matches the token and identifies the
sender (address match first; Claude decides when ambiguous, e.g. one test inbox
playing both roles):
- **Attorney** → triage (sees open requests by id) returns new requests (with
  category + handoff sentence), ids it chases again, ids it resolves →
  `planRequests()` → `planClinicEmails()` groups new + chased requests by owner,
  then per owner:
  on this email's To/Cc already → no email; on the thread before → "Following up here";
  never on it → "Adding you here". One email per owner (attorney CC'd, Reply-To =
  the thread, so LienPilot stays on it).
  Each one forwards the attorney's email Gmail-style (`forwardBlock()`: "Forwarded
  message" header + full body, which carries the earlier thread) with its attachments
  (`forwardableAttachments()`: small inline images dropped; over 18 MB total → none
  attached, names listed). Subject stays "Re:" so the attorney's conversation doesn't split.
- **Clinic** (any roster address) → Claude marks which open requests the reply
  fulfills (each closes on its own) and whether it moves the status (accepts a
  reduction → Payment Pending; "we received the check" → Paid). LienPilot never
  replies to the clinic.

**Mail to the agent's plain address (no `+token`)** goes to `routeUntagged()`, which sorts
by sender in code (auto-replies, bulk/newsletter and no-reply mail are ignored earlier):
- roster contact or staff list → staff question (below);
- attorney on file (same address, or same firm domain unless webmail) → `handleAttorneyInitiated()`;
- both (e.g. one test inbox) → Claude decides from the content;
- neither → `forwardToClinic()`: forwarded to the default contact with Reply-To = the sender
  (10/sender/hour cap).

**Attorney-initiated:** must pass `senderVerified()` (no thread token vouches for it), else
forwarded to the default contact and nothing changes. Claude picks the lien from that
attorney/firm's liens only. One lien → handled exactly like a thread reply (the lien gets a
`reply_token` if it had none, so CCs and later replies share the thread). Unclear → LienPilot
asks the attorney "which patient?" without listing names. Several patients / not on file /
not about a patient → forwarded to the default contact.

**Staff questions** (email): `handleStaffQuery()` → shared core `answerStaffQuestion()`, which the
dashboard chat (`POST /api/ask`, "Ask LienPilot" drawer on `dashboard.html`; read-only, last 6 turns as
context, 60/hour, no login: localhost only until auth exists) also uses. Answered only if the sender is a roster contact or on the `staff`
list in `clinic_contacts.json` (set in Clinic setup) AND `senderVerified()` passes (Gmail's
own `mx.google.com` Authentication-Results: DMARC, or DKIM/SPF for the From domain). Anyone else, or unverified: logged, no reply. 20 questions/hour
per sender. Claude call 1 picks the lien(s) from an index of all liens (answer / clarify /
not_found / portfolio / not_a_question; portfolio = a question about liens in general or a
group, answered from `portfolioFacts()`: code-computed totals (also the email's facts block),
one row per lien, the roster's roles, and every note line in the asked window, default 7 days;
narrowed first by `groupFilter()` when the lookup names a firm, status, or contact (code-matched,
so the totals block and rows cover only that group); the full body is used so "the second one" resolves against
LienPilot's quoted list). Call 2 answers from `lienFacts()` only; the facts block is
appended verbatim under the answer. Open requests: the attorney asked, the clinic
employee sends it; if any are open, that firm is waiting on the clinic (never "the
firm doesn't need anything"). Read-only: nothing is written to the lien.

Replies are processed one at a time per lien (`withLienLock`): a reply that
arrives while another on the same lien is in flight is queued, then re-reads the
lien fresh. Send follow-ups takes the same lock.

Fully autonomous. Sends to reserved domains (`.test`, `.example`) are skipped.
Nothing has to be reachable from the internet (IMAP IDLE). Consumer Gmail has no BAA: test data only; real
PHI needs Google Workspace on an own domain (same code, new credentials).

## Demo loop
Show current liens → optional **+15 days** → **Simulate follow-ups**. For each overdue
*Case Ongoing* lien the agent drafts a status request, injects a canned attorney
reply, Claude triages it, updates the DB, then either drafts the clinic CC or resets
the contact clock. Nothing is sent.

**Present** walks through one follow-up in nine Next-driven steps (filter overdue →
focus one case → run → reveal request / reply / decision / CC → show days reset).
`POST /api/run-followups` accepts optional `{ lien_id }` to scope a single lien.

## Near-term post-MVP features (not implemented)
- Keep broader product work (patient card as a first-class object, cron follow-ups)
  outside the current MVP until taken up explicitly.

## Deliberate v1 shortcuts (not bugs)
- The follow-up run is a manual button, not a cron.
- The clock is simulated (**+15 days**) for demoing the 30-day threshold.
- One clinic roster for all liens (`clinic_contacts.json`), not per-lien or per-clinic.
- Live log (UI panel + console) is in-memory, last 200 events, resets on restart; lien notes are the durable record.
- Test data only. No auth, no encryption at rest, no BAAs — not HIPAA-ready.
- Single-tenant, no tests yet.
