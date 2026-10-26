# LienPilot (v1)

An email agent for personal-injury clinics: chase medical-lien status, triage attorney
replies with Claude, CC the clinic only when they must act, otherwise schedule the next
follow-up.

It runs in two modes against the same database:

- **Send follow-ups (live)** — emails real status requests from the agent's Gmail
  account. Attorney replies land in its inbox and are triaged automatically; if the
  clinic must act, the right clinic contact is emailed into the thread. Fully autonomous.
- **Simulate follow-ups (demo)** — canned attorney replies from `replies.js`, instant,
  nothing sent. **Present** walks one follow-up step by step for stakeholder demos.

## Run it

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (live email keys are optional)
npm start
```

Open http://localhost:3000. Without the Gmail settings the app runs in Simulate-only mode;
the header pill shows **Live email: off**.

## Adding liens

**Import CSV** (liens panel) appends a spreadsheet to the book — it never deletes
existing liens. Required columns: `patient_name`, `clinic_name`, `attorney_name`,
`attorney_email`. Optional: `firm_name`, `date_of_service`, `lien_amount`, `status`
(defaults to Case Ongoing), `action_needed`, `last_contact_date` (defaults to today),
`notes`. Headers are forgiving (`Patient Name` works), as are `$8,400` amounts and
`8/1/2026` dates. Bad rows are skipped and reported by line number.

`sample_liens.csv` is a ready-made example. Its attorney addresses are `.example`
placeholders — replace them with inboxes you control before sending for real.

## Live email setup (Gmail)

A dedicated Gmail account sends over SMTP. LienPilot keeps one IMAP connection open in
IDLE, so Gmail pushes new mail the moment it lands (a second or two), with a backup check
every 60 seconds. Nothing has to be reachable from the internet.

1. **Account.** Create a Gmail account for the agent (e.g. `lienpilot.yourclinic@gmail.com`).
2. **2-Step Verification.** Google Account → Security → turn it on (required for app passwords).
3. **App password.** Google Account → Security → App passwords → create one named "LienPilot".
4. **`.env`.** Set `GMAIL_USER` to the address and `GMAIL_APP_PASSWORD` to the 16-character
   password (spaces are fine). Setting `GMAIL_USER` switches LienPilot to Gmail.
5. **Clinic contacts.** Clinic setup in the UI (or `clinic_contacts.json`).
6. Restart `npm start`. The header pill should read **Live email: on (Gmail)**.

Each lien's thread replies to `youraccount+TOKEN@gmail.com`, which lands in the same
inbox. LienPilot remembers the last message it handled (by IMAP UID, stored in the DB),
so reading the agent's inbox yourself doesn't hide anything from it. It starts with mail
that arrives after its first run; older mail is never processed.
Consumer Gmail sends about 500 emails a day and has no HIPAA BAA: test data only.

## Testing the live loop

1. Import a CSV whose `attorney_email` values are inboxes you control, with
   `last_contact_date` 30+ days ago.
2. **Send follow-ups** → a status request lands in that inbox; the lien shows
   **Awaiting reply**.
3. Reply from that inbox (e.g. "The case settled — would the clinic accept 65%?").
   Within seconds the **Live log** shows the reply, the triage, and — for anything
   the clinic must handle — a real email to whichever contact owns that request, with the attorney CC'd.
4. A "still ongoing, nothing needed" reply resets the contact clock instead; the lien
   is chased again after another 30 days of silence.

## Coming after the MVP

Near-term features under consideration (not implemented yet):

- **Balance questions:** help answer attorney questions about the clinic's current
  outstanding balance, once a reliable source of balance information is connected.
- **Scheduling questions:** help answer availability questions and coordinate
  scheduling if we can sync with the clinic's calendars. Calendar integration and
  the scope of scheduling actions still need to be evaluated.

These are follow-on features; the MVP remains focused on lien-status follow-ups,
reply triage, and clinic handoffs.

## Notes

- Sends to reserved domains (`.test`, `.example`, …) are skipped, not bounced — bounces
  hurt the Gmail account's sender reputation. The practice book uses these, so it's safe to click
  Send with it loaded.
- **Restart simulation** keeps every lien but clears its progress (status, action
  needed, activity, contact date, email thread), zeroes the clock, and clears the
  live log — as if the liens were just uploaded.
- The clock is simulated (**+15 days**) so the 30-day threshold is easy to demo.
- Test data only. Nothing here is HIPAA-ready yet (no auth, no encryption at rest,
  no BAAs); don't load real patient data.
