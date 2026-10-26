/**
 * Deterministic attorney replies for the email-agent demo.
 *
 * BY_PATIENT covers the four seeded Case-Ongoing liens in db.js (Maria
 * Gonzalez, James Whitfield, Tanya Brooks, Alicia Nguyen) and continues each
 * one's existing note/situation, so the "Present" walkthrough has a reliable,
 * narratively-consistent reply for whichever seed lien you focus on.
 *
 * TEMPLATES is the fallback rotation (picked by lien.id % length) for
 * everything else — mainly the 19 Case-Ongoing liens in practice_liens.json.
 * It's deliberately wider than the 6 action categories so a full bulk-import
 * demo run shows the triage model handling routine cases, all six action
 * types, every terminal status, and a couple of deliberately ambiguous /
 * mixed-signal replies that are good for showing how the reasoning holds up
 * under something less clean-cut than the happy path.
 */

const BY_PATIENT = {
  "Maria Gonzalez":
    "Still pulling the full file together on our end. In the meantime, yes — we still need the clinic's itemized final bill, complete chart notes, and a signed LOP before I can put the demand package together. Nothing else needed from you right now.",
  "James Whitfield":
    "Thanks for checking in. Before I can finalize the demand, can you confirm whether treatment is complete and, if so, the exact balance outstanding as of today?",
  "Tanya Brooks":
    "Our file doesn't match what the clinic sent — the bill lists date of service as 7/12 but our records (and the client's account) show 7/14, and the units billed for CPT 97110 are higher than what's in the treatment notes. Need the clinic to correct or explain those before this goes into the demand.",
  "Alicia Nguyen":
    "No real update — still negotiating with the carrier, they're slow-walking it. Nothing needed from the clinic right now, I'll reach back out when there's movement.",
};

const TEMPLATES = [
  {
    id: "ongoing-vague",
    body:
      "Case is still active, nothing new to report. We're waiting on the insurer to respond to our demand. No clinic action needed at this time.",
  },
  {
    id: "ongoing-trial-delay",
    body:
      "Trial got pushed to next quarter due to the court's calendar, so this one's going to run longer than we hoped. Nothing needed from the clinic in the meantime — will update when we're closer.",
  },
  {
    id: "documents-needed",
    body:
      "Before we can send the demand, we need the itemized final bill, complete medical records, and a signed LOP from the clinic. Please send those over when you get a chance.",
  },
  {
    id: "information-needed",
    body:
      "Quick ask — can the clinic confirm whether treatment is complete and the exact balance still outstanding as of today? Want to make sure the demand package reflects the current number.",
  },
  {
    id: "correction-dates",
    body:
      "Something's off on the bill the clinic sent — it lists two dates of service that don't line up with our client's account of treatment, and the total doesn't match the itemized charges underneath it. Can the clinic double check and send a corrected version?",
  },
  {
    id: "correction-duplicate-charge",
    body:
      "Client says they were only seen once that week, but the clinic's bill has two separate visit charges four days apart. Might just be a data entry error on the clinic's end, but we need it corrected before this goes into the demand — carrier will flag it otherwise.",
  },
  {
    id: "reduction-standard",
    body:
      "Good news — the case settled. Once you factor in the policy limits and the other liens on this file, would the clinic accept 65% of the current balance to close this out?",
  },
  {
    id: "reduction-hardship",
    body:
      "Case settled but it's not a great outcome — total recovery is a lot thinner than we hoped once you account for the other providers' liens and our fee. We can offer $4,200 against the current balance. I know that's a steep ask, but it's genuinely what's left after everyone else in line.",
  },
  {
    id: "payment-pending-remit-info",
    body:
      "We're finalized on numbers and the trust account is cutting checks this week. Can you confirm the clinic's current remittance address (or ACH details if you've got them) so the check doesn't bounce back to us?",
  },
  {
    id: "payment-issue-short",
    body:
      "Client mentioned the clinic flagged that the check came in short. We show it went out for the full agreed amount — can you send over what the clinic actually received so we can figure out where the gap is?",
  },
  {
    id: "payment-issue-missing",
    body:
      "Our trust account shows the check to the clinic cleared three weeks ago. If it hasn't shown up on your end, let us know and we'll get a stop-payment filed and reissue — don't want this sitting in limbo.",
  },
  {
    id: "paid-confirmed",
    body:
      "Wanted to follow up and confirm — I checked with our trust account and the payment to the clinic cleared last week. This one should be fully closed out on your end now. Thanks for your patience on this one, it took a while.",
  },
  {
    id: "closed-withdrawn",
    body:
      "Wanted to give you a heads up before you hear it secondhand — we're no longer representing this client, they retained new counsel about a month ago. I don't have the new firm's contact info offhand. You'll want to track that down or get direction on how to proceed.",
  },
  {
    id: "closed-no-recovery",
    body:
      "Tough update — we lost at trial. No recovery, no settlement, nothing to distribute. I know that's not what anyone wants to hear on a case this old. There's no fund here to pay any of the liens out of.",
  },
  {
    id: "closed-priority-liens",
    body:
      "Case resolved, but between the health insurer's subrogation claim and the other treating providers ahead of you in priority, there's nothing left for this lien — settlement didn't cover everyone. Wanted to be upfront about it rather than let this drag on.",
  },
  {
    id: "mixed-settled-and-documents",
    body:
      "Case just settled this week, so this one's moving. Before I can finalize the payoff calculation though, I still need the clinic's final itemized bill and updated chart notes — haven't gotten those from anyone on the treatment side yet.",
  },
];

export function pickAttorneyReply(lien) {
  const named = BY_PATIENT[lien.patient_name];
  let core;
  let template_id;

  if (named) {
    core = named;
    template_id = `patient:${lien.patient_name}`;
  } else {
    // Stable by patient name (not autoincrement id) so resets don't reshuffle templates.
    const s = lien.patient_name || String(lien.id || 0);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const template = TEMPLATES[h % TEMPLATES.length];
    core = template.body;
    template_id = template.id;
  }

  const signOff = lien.firm_name
    ? `${lien.attorney_name}\n${lien.firm_name}`
    : (lien.attorney_name || "Counsel");

  const body =
    `Hi,\n\n` +
    `${core}\n\n` +
    `Best,\n` +
    `${signOff}`;

  return { body, template_id };
}
