import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

/**
 * LienPilot's email layer: one dedicated Gmail account. Sends over SMTP with an
 * app password; receives over IMAP (see startGmailWatcher). Each lien's thread
 * replies to agent+TOKEN@gmail.com, which lands in the same inbox; mail to the
 * plain address is a staff question.
 *
 * Incoming mail is parsed into one plain object (parseEmail) that the server
 * reads:
 *   { from, fromName, to: [{ address, name }], cc: [...], subject, date,
 *     messageId, text (full body), reply (new text only), token (thread +tag),
 *     attachments: [{ name, contentType, size, content: Buffer, inline }],
 *     autoSubmitted, bulk, authResults: [Authentication-Results values] }
 */

// Backup check on the open connection, in case an IDLE notification is missed.
const POLL_SECONDS = Number(process.env.GMAIL_POLL_SECONDS) || 60;

function config() {
  const user = String(process.env.GMAIL_USER || "").trim();
  return {
    user,
    password: String(process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""),
    fromName: process.env.LIEN_FROM_NAME || "LienPilot",
  };
}

/** The agent's address: it sends from it and receives at it. */
export function fromAddress() {
  return config().user;
}

/** True when everything needed for real send + receive is configured. */
export function emailConfigured() {
  return missingEmailConfig().length === 0;
}

/** Which live-email env vars are missing (for a helpful error message). */
export function missingEmailConfig() {
  const c = config();
  return [!c.user && "GMAIL_USER", !c.password && "GMAIL_APP_PASSWORD"].filter(Boolean);
}

/**
 * Reserved TLDs (RFC 2606/6761) can never receive mail. The practice book uses
 * them, so sending there would only bounce — and bounces hurt the sender's
 * reputation. Live sends skip these addresses.
 */
export function isUndeliverable(address) {
  return /\.(test|example|invalid|localhost)$/i.test(String(address).trim());
}

/** Unguessable per-lien token; alphanumeric so it survives +tag addressing. */
export function makeReplyToken(lienId) {
  return `lien${lienId}x${crypto.randomBytes(4).toString("hex")}`;
}

/** agent@gmail.com + token → agent+token@gmail.com */
export function replyAddressFor(token) {
  const [local, domain] = config().user.split("@");
  return `${local}+${token}@${domain}`;
}

/** LienPilot's own addresses: the agent address and any agent+token address. */
export function isOwnAddress(address) {
  const a = String(address || "").trim().toLowerCase();
  if (!a) return true;
  const own = config().user.toLowerCase();
  if (!own) return false;
  const [local, domain] = own.split("@");
  const [aLocal = "", aDomain] = a.split("@");
  return aDomain === domain && aLocal.split("+")[0] === local;
}

/** The +tag on one of our addresses, or null. */
function tagOf(address) {
  const a = String(address || "").trim().toLowerCase();
  if (!isOwnAddress(a)) return null;
  const match = a.match(/^[^@+]+\+([a-z0-9]+)@/i);
  return match ? match[1] : null;
}

/**
 * Did the sender's domain vouch for this email? The From line is trivially
 * forged, so anything that hands out patient data checks Gmail's verdict
 * first: its own Authentication-Results header (DMARC pass, or DKIM/SPF pass
 * for the From domain). Results stamped by anyone else are ignored.
 */
export function senderVerified(msg) {
  const fromDomain = String(msg?.from || "").trim().toLowerCase().split("@")[1] || "";
  const results = (msg?.authResults || []).filter((v) => /^\s*mx\.google\.com\s*;/i.test(v));
  for (const r of results) {
    if (/\bdmarc=pass\b/i.test(r)) return { verified: true, detail: "DMARC pass" };
    const dkim = r.match(/\bdkim=pass\b[^;]*?header\.(?:i=@?|d=)([^\s;]+)/i);
    if (dkim && (dkim[1].toLowerCase() === fromDomain || dkim[1].toLowerCase().endsWith(`.${fromDomain}`))) {
      return { verified: true, detail: "DKIM pass" };
    }
    const spf = r.match(/\bspf=pass\b[^;]*?smtp\.mailfrom=(?:[^@\s;]*@)?([^\s;]+)/i);
    if (spf && spf[1].toLowerCase() === fromDomain) return { verified: true, detail: "SPF pass" };
  }
  return { verified: false, detail: results.length ? "authentication failed" : "no Google authentication results" };
}

// ---- Sending -----------------------------------------------------------------

let smtp = null;
function transport() {
  const c = config();
  if (!smtp) {
    smtp = nodemailer.createTransport({
      host: process.env.GMAIL_SMTP_HOST || "smtp.gmail.com",
      port: Number(process.env.GMAIL_SMTP_PORT) || 465,
      secure: (Number(process.env.GMAIL_SMTP_PORT) || 465) === 465,
      auth: { user: c.user, pass: c.password },
      ...(process.env.GMAIL_SMTP_HOST ? { tls: { rejectUnauthorized: false } } : {}), // local test server only
    });
  }
  return smtp;
}

/**
 * Send one plain-text email from the agent's Gmail. attachments are
 * [{ name, contentType, content: Buffer }] (parseEmail's shape). Returns the
 * Message-ID; throws with Gmail's error on failure.
 */
export async function sendEmail({ to, cc, subject, body, replyTo, inReplyTo, attachments = [] }) {
  const c = config();
  const files = attachments.filter((a) => a?.content);
  try {
    const info = await transport().sendMail({
      from: { name: c.fromName, address: c.user },
      to,
      ...(cc ? { cc } : {}),
      subject,
      text: body,
      ...(replyTo ? { replyTo } : {}),
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
      ...(files.length
        ? { attachments: files.map((a) => ({ filename: a.name, content: a.content, contentType: a.contentType })) }
        : {}),
    });
    return info.messageId;
  } catch (err) {
    throw new Error(`Gmail: ${err.response || err.message}`);
  }
}

// ---- Receiving ---------------------------------------------------------------

/**
 * Cut the quoted thread history off a reply, keeping only the new message.
 * Handles Gmail/Apple "On … wrote:", Outlook "From: … Sent:" headers and
 * separators, and ">" quotes.
 */
export function stripQuotedReply(text) {
  const full = String(text || "").replace(/\r\n/g, "\n");
  const markers = [
    /^On [^\n]*(\n[^\n]*)?\bwrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}/im,
    /^_{10,}\s*$/m,
    /^From:\s[^\n]+\n(?:[^\n]+\n){0,3}?(?:Sent|Date):\s/m,
    /^>/m,
  ];
  let cut = full.length;
  for (const re of markers) {
    const m = re.exec(full);
    if (m && m.index < cut) cut = m.index;
  }
  const stripped = full.slice(0, cut).trim();
  return stripped || full.trim();
}

function htmlToText(html) {
  const plain = (fragment) =>
    fragment
      .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "");
  // Quoted history (Gmail/Apple wrap it in <blockquote>) becomes "> " lines,
  // innermost first, so nested replies keep their depth.
  let text = String(html || "");
  const innermost = /<blockquote[^>]*>((?:(?!<blockquote)[\s\S])*?)<\/blockquote>/i;
  while (innermost.test(text)) {
    text = text.replace(innermost, (_m, inner) =>
      "\n" + plain(inner).trim().split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") + "\n");
  }
  return plain(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n");
}

function addresses(field) {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list
    .flatMap((f) => f.value || [])
    .filter((a) => a?.address)
    .map((a) => ({ address: a.address, name: a.name || "" }));
}

/** A raw email (RFC 822) → the message object the server reads (see top of file). */
export async function parseEmail(source) {
  const mail = await simpleParser(source);
  const from = addresses(mail.from)[0] || { address: "", name: "" };
  const to = addresses(mail.to);
  const cc = addresses(mail.cc);
  // Raw header lines (mailparser's parsed forms drop parts of these).
  const rawHeaders = (name) =>
    (mail.headerLines || [])
      .filter((h) => h.key === name)
      .map((h) => h.line.slice(h.line.indexOf(":") + 1).replace(/\r?\n\s+/g, " ").trim());
  // Delivered-To carries the +tag even when we were Bcc'd.
  const token =
    [...to, ...cc].map((a) => tagOf(a.address)).find(Boolean) ||
    [...rawHeaders("delivered-to"), ...rawHeaders("x-original-to")].map(tagOf).find(Boolean) ||
    "";
  const text = mail.text || htmlToText(mail.html);
  const autoSubmitted = String(mail.headers.get("auto-submitted") || "").toLowerCase();
  const precedence = String(mail.headers.get("precedence") || "").toLowerCase();

  return {
    from: from.address,
    fromName: from.name,
    to,
    cc,
    subject: mail.subject || "",
    date: mail.date ? mail.date.toISOString() : "",
    messageId: mail.messageId || "",
    text,
    reply: stripQuotedReply(text),
    token,
    // Inline parts (signature logos, embedded images) are flagged so forwards
    // can leave them out.
    attachments: (mail.attachments || []).map((a) => ({
      name: a.filename || "attachment",
      contentType: a.contentType || "application/octet-stream",
      size: a.size ?? a.content?.length ?? 0,
      content: a.content ? Buffer.from(a.content) : null,
      inline: Boolean(a.related || a.contentDisposition === "inline" || a.cid),
    })),
    autoSubmitted: Boolean(autoSubmitted && autoSubmitted !== "no"),
    // Newsletters, notifications, bounces: never a person writing to the clinic.
    bulk:
      rawHeaders("list-unsubscribe").length > 0 ||
      rawHeaders("list-id").length > 0 ||
      /^(bulk|list|junk)$/.test(precedence) ||
      /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)([+.@-]|$)/i.test(from.address),
    authResults: rawHeaders("authentication-results"),
  };
}

/**
 * Watch the Gmail inbox and hand each new message to `handle` (parsed
 * message → status code: 2xx handled, 5xx retry).
 *
 * One IMAP connection stays open in IDLE, so Gmail pushes an "exists" event
 * the moment mail lands; LienPilot fetches and handles it right away. The
 * connection is re-established with backoff whenever it drops (Gmail closes
 * long idles, laptops sleep, Wi-Fi changes). A light backup check runs every
 * POLL_SECONDS on the same connection in case a notification is missed.
 *
 * "New" means a higher IMAP UID than the last one handled, kept via
 * loadCursor/saveCursor so it survives restarts. Read/unread doesn't matter,
 * so opening the agent's inbox in Gmail can't hide mail from LienPilot. On the
 * very first run (or if Gmail resets the mailbox's UIDs) the cursor starts at
 * the current end of the inbox, so old mail is never replayed. On a 5xx the
 * message is retried on the next check, up to 3 times; later messages wait
 * behind it so order is kept.
 * Returns a stop() function; stop.pollNow() checks immediately.
 */
export function startGmailWatcher(
  handle,
  { log = console.log, loadCursor = () => null, saveCursor = () => {}, createClient = (opts) => new ImapFlow(opts) } = {}
) {
  const c = config();
  const attempts = new Map();
  let client = null;
  let connecting = false;
  let stopped = false;
  let checking = false;
  let recheck = false;
  let retryDelay = 0;
  let retryTimer = null;
  let lastError = null;

  const usable = () => Boolean(client && client.usable !== false);

  function reportError(err) {
    const message =
      err?.authenticationFailed
        ? "Gmail rejected the login (check GMAIL_USER and GMAIL_APP_PASSWORD; IMAP must be allowed)"
        : err?.responseText || err?.message || err?.code || String(err);
    if (message !== lastError) log(`Gmail inbound: connection failed: ${message}`);
    lastError = message;
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    retryDelay = retryDelay ? Math.min(retryDelay * 2, 60_000) : 2_000;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelay);
    retryTimer.unref?.();
  }

  async function connect() {
    if (stopped || connecting || usable()) return;
    connecting = true;
    const next = createClient({
      host: process.env.GMAIL_IMAP_HOST || "imap.gmail.com",
      port: Number(process.env.GMAIL_IMAP_PORT) || 993,
      secure: true,
      auth: { user: c.user, pass: c.password },
      logger: false,
      maxIdleTime: 10 * 60_000, // re-issue IDLE well before Gmail's ~29-minute cutoff
    });
    // Socket errors also arrive as 'close'; without a listener an 'error'
    // event would crash the server.
    next.on("error", () => {});
    next.on("exists", () => check());
    next.on("close", () => {
      if (client !== next) return;
      client = null;
      if (!stopped) {
        log("Gmail inbound: connection closed; reconnecting.");
        scheduleReconnect();
      }
    });
    try {
      await next.connect();
      await next.mailboxOpen("INBOX"); // left open with no lock held, so imapflow idles on it
      client = next;
      retryDelay = 0;
      log(lastError ? "Gmail inbound: reconnected; waiting for new mail." : `Gmail inbound: connected to ${c.user}; waiting for new mail.`);
      lastError = null;
      check(); // catch up on anything that arrived while disconnected
    } catch (err) {
      reportError(err);
      try { next.close(); } catch {}
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  /** Handle everything past the cursor. Serialized: a check requested mid-run runs again after. */
  async function check() {
    if (stopped) return;
    if (!usable()) return connect();
    if (checking) {
      recheck = true;
      return;
    }
    checking = true;
    try {
      do {
        recheck = false;
        await checkOnce(client);
      } while (recheck && usable() && !stopped);
    } catch (err) {
      reportError(err);
      if (client) {
        try { client.close(); } catch {}
      }
    } finally {
      checking = false;
    }
  }

  async function checkOnce(conn) {
    const lock = await conn.getMailboxLock("INBOX");
    try {
      const box = conn.mailbox;
      const validity = String(box.uidValidity);
      let cursor = loadCursor();
      if (!cursor || cursor.uidValidity !== validity) {
        cursor = { uidValidity: validity, lastUid: Math.max(0, Number(box.uidNext) - 1) };
        saveCursor(cursor);
        log(`Gmail inbound: watching ${c.user} for new mail (starting after message ${cursor.lastUid}).`);
      }

      const found = (await conn.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })) || [];
      const uids = found.map(Number).filter((uid) => uid > cursor.lastUid).sort((x, y) => x - y);
      for (const uid of uids) {
        const msg = await conn.fetchOne(String(uid), { source: true }, { uid: true });
        let status = 500;
        if (!msg?.source) {
          status = 200; // nothing to read; move past it
        } else {
          try {
            status = await handle(await parseEmail(msg.source));
          } catch (err) {
            log(`Gmail inbound: message ${uid} failed: ${err.message}`);
          }
        }
        const tries = (attempts.get(uid) || 0) + 1;
        if (status >= 500 && tries < 3) {
          attempts.set(uid, tries);
          break; // retry on the next check, keeping order
        }
        if (status >= 500) log(`Gmail inbound: gave up on message ${uid} after ${tries} tries.`);
        attempts.delete(uid);
        cursor = { uidValidity: validity, lastUid: uid };
        saveCursor(cursor);
        await conn.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});
      }
    } finally {
      lock.release(); // back to IDLE
    }
  }

  connect();
  const backup = setInterval(() => check(), POLL_SECONDS * 1000);
  backup.unref?.();

  const stop = () => {
    stopped = true;
    clearInterval(backup);
    clearTimeout(retryTimer);
    if (client) {
      try { client.close(); } catch {}
    }
  };
  stop.pollNow = () => check();
  return stop;
}

export { POLL_SECONDS };
