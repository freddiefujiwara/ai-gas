/**
 * ai-gas
 *
 * The owner's single AI gateway, merging the former muse-gas (email
 * bridge to Muse) and groq-gas (Groq prompt proxy) into one project.
 *
 * Muse side: an HTTP bridge to Muse over email. Callers (the
 * owner's home server scripts and other GAS projects) POST a request;
 * this project sends it as an email from the owner's account to
 * Muse's own mailbox (the address is managed in the MUSE_EMAIL
 * script property, never in code), collects Muse's email reply,
 * and serves it back over HTTP. Conversations can continue in the
 * same mail thread.
 *
 * Groq side: the legacy groq-gas interface is kept unchanged for its
 * callers (xuexi-gas, time-table-gas): GET ?p=<prompt>&token=... or
 * POST {"p": "...", "token": "..."} (or a raw text body) answers with
 * {"prompt": ..., "answer": ..., "cached": ...}. It authenticates
 * with the GROQ_TOKEN script property (the value the former groq-gas
 * kept in its API_TOKEN), fails closed while unset, and caches
 * answers for 6 hours. The web front end can also hold Groq
 * conversations through the ask/answer API with engine "groq": those
 * are answered synchronously and stored in the same sheets, with the
 * conversation history resent on every turn.
 *
 * API. Script callers (ze, other GAS) authenticate with the
 * API_TOKEN script property; while the property is unset, every
 * such call is refused. The web front end (/ai) instead signs in
 * with Google and exchanges the ID token for a session (below);
 * ask/answer/result/list then accept "sessionToken" in place of
 * "token". Sessions last 30 days and are stored hashed.
 *
 *   POST {token, action:"ask", prompt}
 *     -> {"ok":true,"id":"<uuid>","status":"pending"}
 *   POST {token, action:"ask", prompt, engine:"groq"}
 *     -> {"ok":true,"id":"<uuid>","status":"replied","engine":"groq"}
 *     Answered by Groq on the spot; no mail is sent.
 *   POST {token, action:"answer", id, text}
 *     -> {"ok":true,"id":"<uuid>","status":"pending","round":2}
 *   POST {token, action:"rename", id, title}
 *     -> {"ok":true,"id":"<uuid>","title":"..."} (empty title clears the name)
 *   POST {token, action:"delete", id}
 *     -> {"ok":true,"id":"<uuid>"} (sheet rows only; the mail thread stays)
 *   GET  ?token=...&action=result&id=<uuid>
 *     -> {"ok":true,"id":"...","status":"replied","round":1,
 *         "messages":[{"round":1,"direction":"out","text":"...","at":"...",
 *                       "attachments":[]},
 *                     {"round":1,"direction":"in","text":"...","at":"...",
 *                       "attachments":[{"name":"...","url":"...","fileId":"..."}]}]}
 *   GET  ?token=...&action=list
 *     -> {"ok":true,"requests":[{id,status,round,created_at,last_activity_at}]}
 *   POST {action:"exchange_session", idToken}
 *     -> {"ok":true,"sessionToken":"...","expiresAt":"..."}
 *     The ID token is verified against Google's tokeninfo endpoint;
 *     only ALLOWED_EMAIL accounts (email_verified, and aud equal
 *     to the GOOGLE_CLIENT_ID script property) receive a session.
 *   GET  ?action=rss&token=<RSS_TOKEN>
 *     -> RSS 2.0 feed of Muse's replies (newest first), for the
 *     owner's feed reader so a reply is noticed quickly. Guarded by
 *     the dedicated RSS_TOKEN property only; fails closed while it
 *     is unset. The API token and web sessions do NOT open it.
 *     Each item links to its conversation's own /ai/<id> URL and
 *     is titled with the conversation's display name (the rename
 *     title when set, else the first outgoing line), matching the
 *     front end.
 *
 * Status flow: pending -> replied (a reply was collected) or timeout
 * (no reply within TIMEOUT_MINUTES of the last outgoing message).
 * "answer" moves a replied/timeout request back to pending.
 *
 * "answer" never uses a bare GmailThread.reply(): that addresses the
 * thread's latest sender, so a follow-up sent while the latest message
 * was the owner's own went to the owner's inbox instead of Muse
 * (two real cases). Instead it replies to Muse's latest message
 * when one exists, and otherwise sends a new mail explicitly
 * addressed to Muse. After an answer, every thread carrying the
 * tag is marked read and archived so the exchange stays out of the
 * inbox. Because an explicitly addressed send may start a sibling
 * thread, reply collection scans ALL threads carrying the subject
 * tag, not just the first search hit.
 *
 * Reply collection runs on a 1-minute time trigger that exists ONLY
 * while at least one request is pending (adaptive polling): consumer
 * accounts share a 90 min/day trigger-runtime budget across all of the
 * owner's projects, so an always-on 1-minute poll would drain it.
 *
 * Image attachments on Muse's replies are imported while
 * collecting: each image (at most 4 per message, at most 10 MB
 * each; other types are ignored) is saved into the Drive folder
 * API/ai (the shared API folder, with an ai subfolder, created
 * when missing), shared with anyone who has the link, and served
 * to the front end as an
 * https://lh3.googleusercontent.com/d/<fileId> URL (the form the
 * front end can actually render). The attachments are recorded in
 * the messages sheet as a JSON array and returned by "result".
 * A failed import never blocks the reply body. Deleting a
 * conversation, and the 30-day purge, trash its Drive files too.
 * This needs the Drive scope in appsscript.json; after the scope
 * was added the owner has to re-authorize the project once, or the
 * import fails (silently) while reply text keeps working.
 *
 * Outgoing mail carries the request id in its subject,
 * "[ai-gas:<id>] ...", so the owner's Gmail filter can archive the
 * whole exchange under one label without touching other mail, and so
 * replies can be matched back to requests.
 *
 * This project reads only its own spreadsheet (the GAS-to-GAS rule:
 * each GAS reads only the sheet it owns and talks to the others over
 * their /exec APIs).
 *
 * Script properties:
 *   API_TOKEN      shared secret (generated by setup())
 *   SPREADSHEET_ID the bridge's own spreadsheet (set by setup())
 *   MUSE_EMAIL     Muse's mailbox address (required; set manually,
 *                  never in code)
 *   ALLOWED_EMAIL  the Google account(s) allowed to sign in on the
 *                  web front end, comma-separated (set manually,
 *                  never in code)
 *   GOOGLE_CLIENT_ID OAuth client id the front end signs in with
 *                  (set manually; the same client as /reader)
 *   RSS_TOKEN      dedicated token for the reply RSS feed
 *                  (generated by setup())
 *   GROQ_TOKEN     token for the Groq window (set manually; the
 *                  value the former groq-gas used as its API_TOKEN,
 *                  so existing callers only change their URL)
 *   GROQ_API_KEY   the owner's Groq API key (set manually)
 *   GROQ_MODEL     optional Groq model override
 *
 * Run setup() once from the editor: it creates the spreadsheet and the
 * sheets, generates API_TOKEN and logs what to copy where.
 */

const TIMEOUT_MINUTES = 10;
const RETENTION_DAYS = 30;
const MAX_PROMPT_LENGTH = 4000;
const DAILY_ASK_LIMIT = 50;
const LIST_LIMIT = 20;
const THREAD_SEARCH_LIMIT = 20;
const RSS_LIMIT = 20;
const RSS_DESCRIPTION_LENGTH = 600;
const FRONT_URL = 'https://freddiefujiwara.com/ai/';
const POLL_HANDLER = 'collectReplies';
const REQUESTS_SHEET = 'requests';
const MESSAGES_SHEET = 'messages';
const SESSIONS_SHEET = 'sessions';
const REQUESTS_HEADERS = ['id', 'created_at', 'status', 'round', 'last_activity_at', 'title', 'engine'];
const MAX_TITLE_LENGTH = 100;
const MESSAGES_HEADERS = ['id', 'round', 'direction', 'text', 'at', 'msg_id', 'attachments'];
const API_FOLDER_NAME = 'API';
const ATTACHMENTS_FOLDER_NAME = 'ai';
const GROQ_MAX_PROMPT_LENGTH = 20000;
const GROQ_CACHE_TTL_SECONDS = 21600;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SESSIONS_HEADERS = ['token_hash', 'issued_at', 'expires_at'];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const TIME_ZONE = 'Asia/Tokyo';

// ---------------------------------------------------------------- props

function getProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function setProp(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

function getMuseEmail() {
  const email = getProp('MUSE_EMAIL');
  if (!email) throw new Error('MUSE_EMAIL script property is not set');
  return email;
}

function isAuthorized(token) {
  const expected = getProp('API_TOKEN');
  return Boolean(expected) && Boolean(token) && token === expected;
}

// ------------------------------------------------------------- sessions

function sha256Hex(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8,
  );
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

// Pure check of a tokeninfo payload against the configured account
// and client. Fails closed: while ALLOWED_EMAIL is unset, nobody
// passes.
function isAllowedIdTokenPayload(payload) {
  if (!payload) return false;
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!verified) return false;
  const allowed = String(getProp('ALLOWED_EMAIL') || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
  if (allowed.length === 0 || !allowed.includes(String(payload.email || '').toLowerCase())) return false;
  const clientId = getProp('GOOGLE_CLIENT_ID');
  if (clientId && payload.aud !== clientId) return false;
  return true;
}

function verifyIdToken(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch(
    TOKENINFO_URL + '?id_token=' + encodeURIComponent(String(idToken)),
    { method: 'get', muteHttpExceptions: true },
  );
  if (res.getResponseCode() !== 200) return null;
  let payload = null;
  try { payload = JSON.parse(res.getContentText()); } catch (err) { return null; }
  return isAllowedIdTokenPayload(payload) ? payload : null;
}

function issueSession() {
  const sheet = getSheet(SESSIONS_SHEET, SESSIONS_HEADERS);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  const token = Utilities.getUuid() + Utilities.getUuid();
  sheet.appendRow([sha256Hex(token), now.toISOString(), expires.toISOString()]);
  return { sessionToken: token, expiresAt: expires.toISOString() };
}

function validateSession(token) {
  if (!token) return false;
  const sheet = getSheet(SESSIONS_SHEET, SESSIONS_HEADERS);
  const hash = sha256Hex(token);
  const now = Date.now();
  return readRows(sheet).some((r) => {
    if (r.token_hash !== hash) return false;
    const exp = r.expires_at instanceof Date ? r.expires_at.getTime() : Date.parse(r.expires_at);
    return Number.isFinite(exp) && exp > now;
  });
}

// Either credential opens the API: the shared API_TOKEN (scripts)
// or a live web session token (the /ai front end).
function isAuthenticated(source) {
  if (!source) return false;
  if (isAuthorized(source.token)) return true;
  return validateSession(source.sessionToken);
}

// The RSS feed has its own token, like the owner's other feeds
// (weather, calendar): the API token must not double as the feed
// token, because the feed URL ends up in the reader's sheet.
function isRssAuthorized(token) {
  const expected = getProp('RSS_TOKEN');
  return Boolean(expected) && Boolean(token) && token === expected;
}

// ---------------------------------------------------------------- sheets

function getSpreadsheet() {
  const id = getProp('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID is not set; run setup() first');
  return SpreadsheetApp.openById(id);
}

function ensureRequestsTitleColumn(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values || values.length === 0) return;
  const headerRow = values[0] || [];
  if (headerRow.indexOf('title') >= 0) return;
  sheet.getRange(1, headerRow.length + 1).setValue('title');
}

// Same migration as the requests title column, for sheets created
// before message rows carried attachments.
function ensureMessagesAttachmentsColumn(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values || values.length === 0) return;
  const headerRow = values[0] || [];
  if (headerRow.indexOf('attachments') >= 0) return;
  sheet.getRange(1, headerRow.length + 1).setValue('attachments');
}

// Same migration as the title column, for sheets created before
// requests carried an engine (muse / groq).
function ensureRequestsEngineColumn(sheet) {
  const values = sheet.getDataRange().getValues();
  if (!values || values.length === 0) return;
  const headerRow = values[0] || [];
  if (headerRow.indexOf('engine') >= 0) return;
  sheet.getRange(1, headerRow.length + 1).setValue('engine');
}

function getSheet(name, headers) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
  if (name === REQUESTS_SHEET) {
    ensureRequestsTitleColumn(sheet);
    ensureRequestsEngineColumn(sheet);
  }
  if (name === MESSAGES_SHEET) ensureMessagesAttachmentsColumn(sheet);
  return sheet;
}

// Requests created before the engine column existed (and every
// Muse request) read back with an empty engine; they are Muse.
function engineOf(request) {
  return request && request.engine === 'groq' ? 'groq' : 'muse';
}

function readRows(sheet) {
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  return values.slice(1).map((row, i) => {
    const obj = { _row: i + 2 };
    headers.forEach((h, j) => { obj[h] = row[j]; });
    return obj;
  });
}

function findRequest(id) {
  const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  const found = readRows(sheet).find((r) => r.id === id);
  return found ? { sheet, request: found } : { sheet, request: null };
}

function updateRequest(sheet, request, patch) {
  const headers = REQUESTS_HEADERS;
  Object.entries(patch).forEach(([key, value]) => {
    const col = headers.indexOf(key) + 1;
    if (col > 0) sheet.getRange(request._row, col).setValue(value);
  });
}

function appendMessage(id, round, direction, text, at, msgId, attachments) {
  const sheet = getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  const stored = attachments && attachments.length ? JSON.stringify(attachments) : '';
  sheet.appendRow([id, round, direction, text, at.toISOString(), msgId || '', stored]);
}

// The attachments cell holds a JSON array of {name, url, fileId};
// anything else (empty cell, pre-migration rows, broken JSON) reads
// back as no attachments.
function parseAttachments(raw) {
  if (!raw) return [];
  let parsed = null;
  try { parsed = JSON.parse(String(raw)); } catch (err) { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((a) => a && a.url)
    .map((a) => ({ name: String(a.name || ''), url: String(a.url), fileId: String(a.fileId || '') }));
}

function readMessages(id) {
  const sheet = getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  return readRows(sheet)
    .filter((m) => m.id === id)
    .map((m) => ({
      round: m.round,
      direction: m.direction,
      text: m.text,
      at: m.at instanceof Date ? m.at.toISOString() : String(m.at),
      attachments: parseAttachments(m.attachments),
    }));
}

function collectedMsgIds(id) {
  const sheet = getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  return new Set(
    readRows(sheet)
      .filter((m) => m.id === id && m.direction === 'in' && m.msg_id)
      .map((m) => m.msg_id),
  );
}

// ---------------------------------------------------------------- output

function jsonOut(obj) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function fail(error) {
  return jsonOut({ ok: false, error: String(error && error.message ? error.message : error) });
}

// ---------------------------------------------------------------- mail

function subjectFor(id, prompt) {
  const firstLine = String(prompt).split('\n')[0].slice(0, 50);
  return `[ai-gas:${id}] ${firstLine}`;
}

function subjectTagOf(id) {
  return `[ai-gas:${id}]`;
}

function findThreads(id) {
  return GmailApp.search(subjectTagOf(id), 0, THREAD_SEARCH_LIMIT);
}

function findThread(id) {
  const threads = findThreads(id);
  return threads.length > 0 ? threads[0] : null;
}

// The newest message from Claude across every thread carrying the
// tag, or null when Muse has not replied yet. Replying to THIS
// message is what pins the recipient to Muse: a bare thread reply
// would go to the thread's latest sender instead.
function latestClaudeMessage(threads) {
  let latest = null;
  let latestTime = -Infinity;
  (threads || []).forEach((thread) => {
    thread.getMessages().forEach((msg) => {
      const from = msg.getFrom() || '';
      if (!from.includes(getMuseEmail())) return;
      const time = msg.getDate() ? msg.getDate().getTime() : 0;
      if (time >= latestTime) {
        latest = msg;
        latestTime = time;
      }
    });
  });
  return latest;
}

// Sends a follow-up with the recipient pinned to Muse. When Muse
// has already replied, reply to that message (Gmail addresses the
// reply to its sender, i.e. Muse, and keeps the thread). Otherwise
// send a new mail explicitly addressed to Muse with the original
// subject, so a follow-up sent before any reply still reaches Muse
// instead of the owner. Gmail may file that send in a sibling thread;
// collection scans every thread carrying the tag, so replies are
// still picked up.
function sendAnswer(id, threads, body) {
  const museMessage = latestClaudeMessage(threads);
  if (museMessage) {
    museMessage.reply(body);
    return;
  }
  const firstOut = readMessages(id).find((m) => m.direction === 'out');
  const baseSubject = firstOut ? subjectFor(id, firstOut.text) : subjectTagOf(id);
  GmailApp.sendEmail(getMuseEmail(), 'Re: ' + baseSubject, body);
}

// Keeps the exchange out of the inbox: after an answer is sent, every
// thread carrying the tag is marked read and archived. The threads
// are re-searched so a sibling thread started by the send itself is
// included.
function archiveThreads(id) {
  findThreads(id).forEach((thread) => {
    thread.markRead();
    thread.moveToArchive();
  });
}

// ---------------------------------------------------------- attachments

// Attachments live in API/ai: the API folder is shared with the
// owner's other apps (each keeps its own subfolder), so look both
// levels up and create whichever is missing.
function getAttachmentsFolder() {
  const apiFolders = DriveApp.getFoldersByName(API_FOLDER_NAME);
  const api = apiFolders.hasNext() ? apiFolders.next() : DriveApp.createFolder(API_FOLDER_NAME);
  const sub = api.getFoldersByName(ATTACHMENTS_FOLDER_NAME);
  if (sub.hasNext()) return sub.next();
  return api.createFolder(ATTACHMENTS_FOLDER_NAME);
}

// Imports the image attachments of one collected reply message into
// the API/ai Drive folder and returns [{name, url, fileId}].
// Only image/* attachments are taken, at most
// MAX_ATTACHMENTS_PER_MESSAGE per message and at most
// MAX_ATTACHMENT_BYTES each; anything else is ignored. Each file is
// shared with anyone who has the link so the front end can render
// the lh3 URL without a Drive session. Failures are swallowed per
// attachment (and for the message as a whole): a broken attachment
// must never stop the reply body from being collected.
function saveImageAttachments(msg) {
  const saved = [];
  let candidates = [];
  try {
    candidates = msg.getAttachments() || [];
  } catch (err) {
    return saved;
  }
  let folder = null;
  candidates.forEach((att) => {
    if (saved.length >= MAX_ATTACHMENTS_PER_MESSAGE) return;
    try {
      const type = att.getContentType() || '';
      if (type.indexOf('image/') !== 0) return;
      if (att.getSize() > MAX_ATTACHMENT_BYTES) return;
      if (!folder) folder = getAttachmentsFolder();
      const file = folder.createFile(att);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      saved.push({
        name: att.getName() || file.getName() || '',
        url: 'https://lh3.googleusercontent.com/d/' + file.getId(),
        fileId: file.getId(),
      });
    } catch (err) {
      // skip this attachment, keep the rest and the reply itself
    }
  });
  return saved;
}

// Trashes the Drive files behind a list of parsed attachments.
// Missing files (already trashed or deleted by hand) are fine.
function trashAttachmentFiles(attachments) {
  (attachments || []).forEach((a) => {
    if (!a || !a.fileId) return;
    try {
      DriveApp.getFileById(a.fileId).setTrashed(true);
    } catch (err) {
      // already gone; nothing to clean up
    }
  });
}

// ---------------------------------------------------------------- polling

function syncPollingTrigger(hasPending) {
  const triggers = ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === POLL_HANDLER);
  if (hasPending && triggers.length === 0) {
    ScriptApp.newTrigger(POLL_HANDLER).timeBased().everyMinutes(1).create();
  } else if (!hasPending) {
    triggers.forEach((t) => ScriptApp.deleteTrigger(t));
  }
}

function hasPendingRequests() {
  const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  return readRows(sheet).some((r) => r.status === 'pending');
}

// ---------------------------------------------------------------- actions

function doAsk(prompt, engine) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is empty');
  if (engine === 'groq') return doGroqAsk(text);
  if (text.length > MAX_PROMPT_LENGTH) throw new Error('prompt is too long');

  const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  const today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
  const todaysCount = readRows(sheet).filter((r) => {
    const created = r.created_at instanceof Date ? r.created_at : new Date(r.created_at);
    return Utilities.formatDate(created, TIME_ZONE, 'yyyy-MM-dd') === today;
  }).length;
  if (todaysCount >= DAILY_ASK_LIMIT) throw new Error('daily ask limit reached');

  const now = new Date();
  const id = Utilities.getUuid();
  GmailApp.sendEmail(getMuseEmail(), subjectFor(id, text), text);
  sheet.appendRow([id, now.toISOString(), 'pending', 1, now.toISOString(), '', 'muse']);
  appendMessage(id, 1, 'out', text, now, '');
  syncPollingTrigger(true);
  return { ok: true, id, status: 'pending' };
}

// A Groq conversation is answered on the spot: the Groq call runs
// BEFORE anything is stored, so a failed call leaves no rows behind.
// The exchange is then written to the same sheets as a Muse
// conversation, already in the replied state.
function doGroqAsk(text) {
  if (text.length > GROQ_MAX_PROMPT_LENGTH) throw new Error('prompt is too long');
  const result = fetchGroqCompletion([{ role: 'user', content: text }]);
  if (result.status !== 'success') throw new Error(result.content);
  const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  const now = new Date();
  const id = Utilities.getUuid();
  sheet.appendRow([id, now.toISOString(), 'replied', 1, now.toISOString(), '', 'groq']);
  appendMessage(id, 1, 'out', text, now, '');
  appendMessage(id, 1, 'in', result.content, new Date(), '');
  return { ok: true, id, status: 'replied', round: 1, engine: 'groq' };
}

// A follow-up on a Groq conversation: Groq itself is stateless, so
// the stored history is resent as the messages array with the new
// text appended. As with doGroqAsk, the call runs first and nothing
// is stored when it fails.
function doGroqAnswer(sheet, request, body) {
  if (body.length > GROQ_MAX_PROMPT_LENGTH) throw new Error('text is too long');
  const history = readMessages(request.id).map((m) => ({
    role: m.direction === 'out' ? 'user' : 'assistant',
    content: String(m.text || ''),
  }));
  history.push({ role: 'user', content: body });
  const result = fetchGroqCompletion(history);
  if (result.status !== 'success') throw new Error(result.content);
  const now = new Date();
  const round = Number(request.round || 1) + 1;
  appendMessage(request.id, round, 'out', body, now, '');
  appendMessage(request.id, round, 'in', result.content, new Date(), '');
  updateRequest(sheet, request, { status: 'replied', round, last_activity_at: now.toISOString() });
  return { ok: true, id: request.id, status: 'replied', round, engine: 'groq' };
}

function doAnswer(id, text) {
  const body = String(text || '').trim();
  if (!body) throw new Error('text is empty');
  const { sheet, request } = findRequest(id);
  if (!request) throw new Error('request not found');
  if (engineOf(request) === 'groq') return doGroqAnswer(sheet, request, body);
  if (body.length > MAX_PROMPT_LENGTH) throw new Error('text is too long');
  const threads = findThreads(id);
  if (threads.length === 0) throw new Error('mail thread not found');
  sendAnswer(id, threads, body);
  const now = new Date();
  const round = Number(request.round || 1) + 1;
  updateRequest(sheet, request, { status: 'pending', round, last_activity_at: now.toISOString() });
  appendMessage(id, round, 'out', body, now, '');
  archiveThreads(id);
  syncPollingTrigger(true);
  return { ok: true, id, status: 'pending', round };
}

function doResult(id) {
  const { request } = findRequest(id);
  if (!request) throw new Error('request not found');
  return {
    ok: true,
    id: request.id,
    title: request.title ? String(request.title) : '',
    engine: engineOf(request),
    status: request.status,
    round: Number(request.round || 1),
    created_at: request.created_at instanceof Date ? request.created_at.toISOString() : String(request.created_at),
    last_activity_at: request.last_activity_at instanceof Date ? request.last_activity_at.toISOString() : String(request.last_activity_at),
    messages: readMessages(id),
  };
}

function previewOf(text) {
  const line = String(text || '').split('\n')[0].trim();
  return line.slice(0, 50);
}

function firstOutPreviewById() {
  const sheet = getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  const map = new Map();
  readRows(sheet).forEach((m) => {
    if (m.direction === 'out' && !map.has(m.id)) map.set(m.id, previewOf(m.text));
  });
  return map;
}

function doList() {
  const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  const previews = firstOutPreviewById();
  const requests = readRows(sheet)
    .slice(-LIST_LIMIT)
    .reverse()
    .map((r) => ({
      id: r.id,
      title: r.title ? String(r.title) : '',
      engine: engineOf(r),
      preview: previews.get(r.id) || '',
      status: r.status,
      round: Number(r.round || 1),
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      last_activity_at: r.last_activity_at instanceof Date ? r.last_activity_at.toISOString() : String(r.last_activity_at),
    }));
  return { ok: true, requests };
}

function doRename(id, title) {
  const name = String(title == null ? '' : title).trim();
  if (name.length > MAX_TITLE_LENGTH) throw new Error('title is too long');
  const { sheet, request } = findRequest(id);
  if (!request) throw new Error('request not found');
  // Renaming is not activity: last_activity_at is left untouched.
  updateRequest(sheet, request, { title: name });
  return { ok: true, id: request.id, title: name };
}

function doDeleteRequest(id) {
  const { sheet, request } = findRequest(id);
  if (!request) throw new Error('request not found');
  const messagesSheet = getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  const messageRows = readRows(messagesSheet).filter((m) => m.id === id);
  // The conversation's imported attachment files go to the Drive
  // trash together with the rows; the mail thread itself is kept.
  messageRows.forEach((m) => trashAttachmentFiles(parseAttachments(m.attachments)));
  messageRows
    .map((m) => m._row)
    .sort((a, b) => b - a)
    .forEach((row) => messagesSheet.deleteRow(row));
  sheet.deleteRow(request._row);
  syncPollingTrigger(hasPendingRequests());
  return { ok: true, id: request.id };
}

// ---------------------------------------------------------------- rss

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const RFC822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC822_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// RSS pubDate, built from UTC getters with fixed English names so
// the output never depends on the script's locale.
function rfc822(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    RFC822_DAYS[d.getUTCDay()] + ', ' +
    pad(d.getUTCDate()) + ' ' + RFC822_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' GMT'
  );
}

function buildRssXml(items) {
  const body = items.map((item) => [
    '    <item>',
    '      <title>' + xmlEscape(item.title) + '</title>',
    '      <link>' + xmlEscape(item.link) + '</link>',
    '      <guid isPermaLink="false">' + xmlEscape(item.guid) + '</guid>',
    '      <pubDate>' + rfc822(item.pubDate) + '</pubDate>',
    '      <description>' + xmlEscape(item.description) + '</description>',
    '    </item>',
  ].join('\n')).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    '    <title>Muse 返信</title>',
    '    <link>' + FRONT_URL + '</link>',
    '    <description>ai-gas 経由で届いた Claude からの返信</description>',
    body,
    '  </channel>',
    '</rss>',
    '',
  ].join('\n');
}

function threadUrl(id) {
  return FRONT_URL + id;
}

// The conversation's display name, resolved the same way the /ai
// front end resolves its titles: the rename title when one is set,
// else the first outgoing line. Returns '' when neither exists (the
// request row may already be gone while messages remain).
function rssNameById() {
  const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  const map = new Map();
  readRows(sheet).forEach((r) => {
    const name = r.title ? String(r.title).trim() : '';
    if (name) map.set(r.id, name);
  });
  return map;
}

// One item per collected reply, newest first. The title names the
// conversation that was answered (its rename title when set, else
// the request that started it, cut to the front end's 50-char
// preview length), and each item links to that conversation's own
// /ai/<id> URL so the reader can jump straight to the thread.
// Groq conversations are excluded: this feed is for Muse's replies.
function doRss() {
  const sheet = getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  const rows = readRows(sheet);
  const names = rssNameById();
  const groqIds = new Set(
    readRows(getSheet(REQUESTS_SHEET, REQUESTS_HEADERS))
      .filter((r) => engineOf(r) === 'groq')
      .map((r) => r.id),
  );
  const firstOutById = new Map();
  rows.forEach((m) => {
    if (m.direction === 'out' && !firstOutById.has(m.id)) firstOutById.set(m.id, String(m.text || ''));
  });
  const items = rows
    .filter((m) => m.direction === 'in' && !groqIds.has(m.id))
    .map((m) => {
      const at = m.at instanceof Date ? m.at : new Date(m.at);
      const name = names.get(m.id) || previewOf(firstOutById.get(m.id) || '');
      const text = String(m.text || '');
      return {
        title: name ? '返信: ' + name.slice(0, 50) : 'Claudeからの返信',
        link: threadUrl(m.id),
        guid: m.msg_id ? String(m.msg_id) : String(m.id) + '@' + at.toISOString(),
        pubDate: at,
        description: text.length > RSS_DESCRIPTION_LENGTH ? text.slice(0, RSS_DESCRIPTION_LENGTH) + '…' : text,
      };
    })
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
    .slice(0, RSS_LIMIT);
  const output = ContentService.createTextOutput(buildRssXml(items));
  output.setMimeType(ContentService.MimeType.XML);
  return output;
}

// ---------------------------------------------------------------- collect

export function collectReplies() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const sheet = getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
    const requests = readRows(sheet);
    const now = new Date();
    let anyPending = false;

    requests.forEach((request) => {
      if (request.status !== 'pending') return;
      const seen = collectedMsgIds(request.id);
      let gotReply = false;
      // Scan every thread carrying the tag: a reply can land in a
      // sibling thread when an answer was sent as a fresh mail.
      findThreads(request.id).forEach((thread) => {
        thread.getMessages().forEach((msg) => {
          const from = msg.getFrom() || '';
          if (!from.includes(getMuseEmail())) return;
          const msgId = msg.getId();
          if (seen.has(msgId)) return;
          seen.add(msgId);
          const attachments = saveImageAttachments(msg);
          appendMessage(request.id, Number(request.round || 1), 'in', msg.getPlainBody(), msg.getDate(), msgId, attachments);
          gotReply = true;
        });
      });
      if (gotReply) {
        updateRequest(sheet, request, { status: 'replied', last_activity_at: now.toISOString() });
      } else {
        const last = request.last_activity_at instanceof Date
          ? request.last_activity_at
          : new Date(request.last_activity_at);
        if (now.getTime() - last.getTime() > TIMEOUT_MINUTES * 60 * 1000) {
          updateRequest(sheet, request, { status: 'timeout' });
        } else {
          anyPending = true;
        }
      }
    });

    purgeOldRows(now);
    syncPollingTrigger(anyPending || hasPendingRequests());
  } finally {
    lock.releaseLock();
  }
}

function purgeOldRows(now) {
  const today = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  if (getProp('LAST_PURGE_DATE') === today) return;
  setProp('LAST_PURGE_DATE', today);
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  [REQUESTS_SHEET, MESSAGES_SHEET].forEach((name) => {
    const headers = name === REQUESTS_SHEET ? REQUESTS_HEADERS : MESSAGES_HEADERS;
    const sheet = getSheet(name, headers);
    const dateCol = name === REQUESTS_SHEET ? 'created_at' : 'at';
    const rows = readRows(sheet);
    // delete from the bottom so row numbers stay valid
    rows.slice().reverse().forEach((r) => {
      const when = r[dateCol] instanceof Date ? r[dateCol] : new Date(r[dateCol]);
      if (when.getTime() < cutoff) {
        // Purged replies take their imported Drive files with them.
        if (name === MESSAGES_SHEET) trashAttachmentFiles(parseAttachments(r.attachments));
        sheet.deleteRow(r._row);
      }
    });
  });
}

// ------------------------------------------------------------- groq

// The Groq window keeps its own token (GROQ_TOKEN) so a caller of
// one window never gains the other: the Groq token cannot send mail
// as the owner, and the API token cannot spend the Groq key. Fails
// closed while GROQ_TOKEN is unset.
function isGroqAuthorized(providedToken) {
  const expected = getProp('GROQ_TOKEN');
  return (
    Boolean(expected) &&
    typeof providedToken === 'string' &&
    providedToken === expected
  );
}

function validateGroqRequest(prompt, providedToken) {
  if (typeof prompt !== 'string' || !prompt) {
    return "Parameter 'p' is required.";
  }
  if (!isGroqAuthorized(providedToken)) {
    return 'Unauthorized.';
  }
  if (prompt.length > GROQ_MAX_PROMPT_LENGTH) {
    return 'Prompt is too long.';
  }
  return null;
}

function buildCacheKey(prompt) {
  // Hash the whole prompt: truncating the encoded prompt itself makes
  // long prompts that share a prefix (e.g. templated instructions)
  // collide on the same cache key.
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    prompt,
    Utilities.Charset.UTF_8,
  );
  return 'groq_' + Utilities.base64Encode(digest);
}

function parseCachedResponse(cachedResponse) {
  if (!cachedResponse) {
    return null;
  }
  try {
    const parsed = JSON.parse(cachedResponse);
    if (
      parsed &&
      parsed.status === 'success' &&
      typeof parsed.content === 'string' &&
      parsed.content
    ) {
      return parsed;
    }
  } catch (e) {
    return null;
  }
  return null;
}

// One Groq chat completion for a messages array. Returns
// {status: "success" | "error", content} and never throws: transport
// and upstream failures come back as the error content.
function fetchGroqCompletion(messages) {
  const apiKey = getProp('GROQ_API_KEY');
  // The model is a script property so a retired model can be swapped
  // without a code change.
  const model = getProp('GROQ_MODEL') || GROQ_DEFAULT_MODEL;
  const payload = {
    model,
    messages,
    temperature: 0.7,
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  try {
    const response = UrlFetchApp.fetch(GROQ_API_URL, options);
    const json = JSON.parse(response.getContentText());
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content) {
      return { status: 'success', content };
    }
    const upstreamMessage = json?.error?.message;
    const errorMessage =
      typeof upstreamMessage === 'string' && upstreamMessage
        ? upstreamMessage
        : 'Unexpected response format';
    return { status: 'error', content: errorMessage };
  } catch (e) {
    return { status: 'error', content: errorText_(e) };
  }
}

function callGroq(prompt) {
  return fetchGroqCompletion([{ role: 'user', content: prompt }]);
}

// The legacy single-prompt answer, with the 6-hour script cache.
function answerPrompt(prompt, useCache) {
  const cache = CacheService.getScriptCache();
  const cacheKey = buildCacheKey(prompt);
  const cachedResponse = useCache ? cache.get(cacheKey) : null;
  let result = parseCachedResponse(cachedResponse);
  const isCached = result !== null;
  if (!result) {
    result = callGroq(prompt);
    if (result.status === 'success') {
      cache.put(cacheKey, JSON.stringify(result), GROQ_CACHE_TTL_SECONDS);
    }
  }
  return {
    prompt,
    answer: result.content,
    cached: isCached,
  };
}

function errorText_(e) {
  try {
    return e.toString();
  } catch (ignored) {
    return 'Unknown error';
  }
}

// ---------------------------------------------------------------- HTTP

export function doGet(e) {
  const params = (e && e.parameter) || {};
  // A GET without an action is the legacy Groq window (its callers
  // pass ?p=<prompt>&token=...); the Muse side always names an
  // action (result / list / rss).
  if (!params.action) {
    const error = validateGroqRequest(params.p, params.token);
    if (error) return jsonOut({ error });
    return jsonOut(answerPrompt(params.p, params.cache !== 'no'));
  }
  try {
    if (params.action === 'rss') {
      if (!isRssAuthorized(params.token)) return fail(new Error('unauthorized'));
      return doRss();
    }
    if (!isAuthenticated(params)) return fail(new Error('unauthorized'));
    if (params.action === 'result') return jsonOut(doResult(params.id));
    if (params.action === 'list') return jsonOut(doList());
    return fail(new Error('unknown action'));
  } catch (err) {
    return fail(err);
  }
}

export function doPost(e) {
  const contents = (e && e.postData && e.postData.contents) || '';
  const params = (e && e.parameter) || {};
  let body;
  try {
    body = JSON.parse(contents);
  } catch (err) {
    body = undefined;
  }
  const isPlainObject =
    body !== null && typeof body === 'object' && !Array.isArray(body);
  // A JSON object naming an action belongs to the Muse side.
  if (isPlainObject && body.action) {
    try {
      if (body.action === 'exchange_session') {
        const identity = verifyIdToken(body.idToken);
        if (!identity) return fail(new Error('unauthorized'));
        return jsonOut({ ok: true, ...issueSession() });
      }
      if (!isAuthenticated(body)) return fail(new Error('unauthorized'));
      if (body.action === 'ask') return jsonOut(doAsk(body.prompt, body.engine));
      if (body.action === 'answer') return jsonOut(doAnswer(body.id, body.text));
      if (body.action === 'rename') return jsonOut(doRename(body.id, body.title));
      if (body.action === 'delete') return jsonOut(doDeleteRequest(body.id));
      return fail(new Error('unknown action'));
    } catch (err) {
      return fail(err);
    }
  }
  // Everything else is the legacy Groq window. An unparseable body
  // (and a JSON null, whose fields cannot be read) is treated as a
  // raw-text prompt, exactly as groq-gas did; any other JSON body
  // goes through the {p | prompt, token} form, where missing or
  // deformed fields validate as a missing prompt.
  if (body === undefined || body === null) {
    const error = validateGroqRequest(contents, params.token);
    if (error) return jsonOut({ error });
    return jsonOut(answerPrompt(contents, true));
  }
  const prompt = isPlainObject ? body.p || body.prompt || '' : '';
  const providedToken = isPlainObject ? body.token || params.token : params.token;
  const error = validateGroqRequest(prompt, providedToken);
  if (error) return jsonOut({ error });
  return jsonOut(answerPrompt(prompt, true));
}

// ---------------------------------------------------------------- setup

export function setup() {
  if (!getProp('API_TOKEN')) {
    setProp('API_TOKEN', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!getProp('RSS_TOKEN')) {
    setProp('RSS_TOKEN', Utilities.getUuid() + Utilities.getUuid());
  }
  if (!getProp('SPREADSHEET_ID')) {
    const ss = SpreadsheetApp.create('ai-gas');
    setProp('SPREADSHEET_ID', ss.getId());
    Logger.log('Created spreadsheet: ' + ss.getUrl());
  }
  getSheet(REQUESTS_SHEET, REQUESTS_HEADERS);
  getSheet(MESSAGES_SHEET, MESSAGES_HEADERS);
  getSheet(SESSIONS_SHEET, SESSIONS_HEADERS);
  Logger.log('API_TOKEN: ' + getProp('API_TOKEN'));
  Logger.log('RSS_TOKEN: ' + getProp('RSS_TOKEN'));
  Logger.log('SPREADSHEET_ID: ' + getProp('SPREADSHEET_ID'));
  Logger.log('MUSE_EMAIL: ' + getMuseEmail());
  Logger.log('ALLOWED_EMAIL set: ' + Boolean(getProp('ALLOWED_EMAIL')));
  Logger.log('GOOGLE_CLIENT_ID set: ' + Boolean(getProp('GOOGLE_CLIENT_ID')));
  Logger.log('GROQ_TOKEN set: ' + Boolean(getProp('GROQ_TOKEN')));
  Logger.log('GROQ_API_KEY set: ' + Boolean(getProp('GROQ_API_KEY')));
  Logger.log('GROQ_MODEL: ' + (getProp('GROQ_MODEL') || GROQ_DEFAULT_MODEL));
}

export { doAsk, doAnswer, doResult, doList, doRename, doDeleteRequest, previewOf, MAX_TITLE_LENGTH, doRss, buildRssXml, xmlEscape, rfc822, isRssAuthorized, isAuthorized, isAuthenticated, isAllowedIdTokenPayload, verifyIdToken, issueSession, validateSession, sha256Hex, subjectFor, findThreads, latestClaudeMessage, syncPollingTrigger, hasPendingRequests, purgeOldRows, saveImageAttachments, parseAttachments, trashAttachmentFiles, getAttachmentsFolder, API_FOLDER_NAME, ATTACHMENTS_FOLDER_NAME, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, TIMEOUT_MINUTES, RETENTION_DAYS, MAX_PROMPT_LENGTH, DAILY_ASK_LIMIT, SESSION_TTL_MS, isGroqAuthorized, validateGroqRequest, answerPrompt, callGroq, fetchGroqCompletion, buildCacheKey, parseCachedResponse, doGroqAsk, doGroqAnswer, engineOf, GROQ_MAX_PROMPT_LENGTH, GROQ_DEFAULT_MODEL };
