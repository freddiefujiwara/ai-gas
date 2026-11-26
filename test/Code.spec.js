import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Code from '../src/Code.js';

// All fixtures are dummy data. Never copy real mail content,
// real addresses of the owner, or real request text into tests.
// The only real value is Muse's own public mailbox address,
// which the code itself defaults to.

const MUSE = 'freddiefujiwara@muse.ai';
const TOKEN = 'dummy-token';

let props;
let sheets;
let threads;
let sentMail;
let triggers;
let uuidCounter;
let driveFiles;
let driveFolders;
let fileCounter;

function makeSheet(name) {
  return {
    name,
    rows: [],
    appendRow(row) { this.rows.push([...row]); },
    getDataRange() {
      const self = this;
      return { getValues: () => self.rows.map((r) => [...r]) };
    },
    getRange(row, col) {
      const self = this;
      return { setValue: (v) => { self.rows[row - 1][col - 1] = v; } };
    },
    deleteRow(row) { this.rows.splice(row - 1, 1); },
  };
}

function makeAttachment({ name, contentType, size }) {
  return {
    getName: () => name,
    getContentType: () => contentType,
    getSize: () => size,
  };
}

function makeMessage({ id, from, body, date, attachments = [] }) {
  const msg = {
    getId: () => id,
    getFrom: () => from,
    getPlainBody: () => body,
    getDate: () => new Date(date),
    getAttachments: () => attachments,
    replies: [],
    _thread: null,
    // Mirrors GmailMessage.reply: the reply is addressed to this
    // message's sender and stays in the same thread.
    reply(text) {
      msg.replies.push(text);
      if (msg._thread) {
        msg._thread.messages.push(makeMessage({ id: `out-${msg._thread.messages.length}`, from: 'owner@example.com', body: text, date: new Date() }));
      }
    },
  };
  return msg;
}

function makeThread(subject) {
  return {
    subject,
    messages: [],
    replies: [],
    archived: false,
    read: false,
    getMessages() { return this.messages; },
    addMessage(msg) { msg._thread = this; this.messages.push(msg); return msg; },
    markRead() { this.read = true; },
    moveToArchive() { this.archived = true; },
    reply(text) {
      this.replies.push(text);
      this.messages.push(makeMessage({ id: `out-${this.messages.length}`, from: 'owner@example.com', body: text, date: new Date() }));
    },
  };
}

function makeDriveFile(name) {
  const file = {
    id: `file-${++fileCounter}`,
    name,
    trashed: false,
    sharing: null,
    getId: () => file.id,
    getName: () => file.name,
    setSharing(access, permission) { file.sharing = { access, permission }; },
    setTrashed(value) { file.trashed = value; },
  };
  return file;
}

function folderIterator(matches) {
  return { hasNext: () => matches.length > 0, next: () => matches[0] };
}

function makeDriveFolder(name, parent = null) {
  const folder = {
    name,
    parent,
    files: [],
    createFile(blob) {
      const file = makeDriveFile(blob.getName());
      folder.files.push(file);
      driveFiles[file.id] = file;
      return file;
    },
    getFoldersByName(childName) {
      return folderIterator(driveFolders.filter((f) => f.parent === folder && f.name === childName));
    },
    createFolder(childName) {
      const child = makeDriveFolder(childName, folder);
      driveFolders.push(child);
      return child;
    },
  };
  return folder;
}

beforeEach(() => {
  props = { API_TOKEN: TOKEN, SPREADSHEET_ID: 'dummy-sheet-id' };
  sheets = {};
  threads = [];
  sentMail = [];
  triggers = [];
  uuidCounter = 0;
  driveFiles = {};
  driveFolders = [];
  fileCounter = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-25T00:00:00Z'));

  global.ContentService = {
    createTextOutput: vi.fn((text) => {
      const out = { text, setMimeType: vi.fn(() => out) };
      return out;
    }),
    MimeType: { JSON: 'application/json' },
  };
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => props[k] ?? null,
      setProperty: (k, v) => { props[k] = v; },
    }),
  };
  global.Utilities = {
    formatDate: vi.fn((date, _tz, pattern) => {
      const jst = new Date(new Date(date).getTime() + 9 * 60 * 60 * 1000);
      if (pattern === 'yyyy-MM-dd') return jst.toISOString().slice(0, 10);
      return jst.toISOString();
    }),
    getUuid: vi.fn(() => `uuid-${++uuidCounter}`),
  };
  global.SpreadsheetApp = {
    openById: vi.fn(() => ({
      getSheetByName: (name) => sheets[name] ?? null,
      insertSheet: (name) => { sheets[name] = makeSheet(name); return sheets[name]; },
    })),
    create: vi.fn(() => ({ getId: () => 'created-id', getUrl: () => 'https://example.invalid/sheet' })),
  };
  global.GmailApp = {
    sendEmail: vi.fn((to, subject, body) => {
      sentMail.push({ to, subject, body });
      const t = makeThread(subject);
      t.messages.push(makeMessage({ id: `sent-${threads.length}`, from: 'owner@example.com', body, date: new Date() }));
      threads.push(t);
    }),
    search: vi.fn((query) => threads.filter((t) => t.subject.includes(query))),
  };
  global.ScriptApp = {
    getProjectTriggers: vi.fn(() => triggers),
    newTrigger: vi.fn(() => ({
      timeBased: () => ({
        everyMinutes: () => ({
          create: () => { const t = { getHandlerFunction: () => 'collectReplies' }; triggers.push(t); return t; },
        }),
      }),
    })),
    deleteTrigger: vi.fn((t) => { triggers = triggers.filter((x) => x !== t); }),
  };
  global.DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    getFoldersByName: vi.fn((name) =>
      folderIterator(driveFolders.filter((f) => f.parent === null && f.name === name))),
    createFolder: vi.fn((name) => {
      const folder = makeDriveFolder(name);
      driveFolders.push(folder);
      return folder;
    }),
    getFileById: vi.fn((id) => {
      const file = driveFiles[id];
      if (!file) throw new Error('file not found');
      return file;
    }),
  };
  global.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
  };
  global.Logger = { log: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
});

function post(body) {
  const out = Code.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.text);
}

function get(params) {
  const out = Code.doGet({ parameter: params });
  return JSON.parse(out.text);
}

describe('authorization', () => {
  it('refuses every call while API_TOKEN is unset', () => {
    props = {};
    expect(post({ token: TOKEN, action: 'ask', prompt: 'hi' }).ok).toBe(false);
    expect(get({ token: TOKEN, action: 'list' }).ok).toBe(false);
  });

  it('refuses a wrong token', () => {
    expect(post({ token: 'nope', action: 'ask', prompt: 'hi' }).ok).toBe(false);
    expect(sentMail.length).toBe(0);
  });
});

describe('ask', () => {
  it('sends the prompt to Muse with the id in the subject and stores it', () => {
    const res = post({ token: TOKEN, action: 'ask', prompt: 'What is on today?' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('pending');
    expect(sentMail.length).toBe(1);
    expect(sentMail[0].to).toBe(MUSE);
    expect(sentMail[0].subject).toContain(`[ai-gas:${res.id}]`);
    expect(sentMail[0].body).toBe('What is on today?');
    // adaptive polling: the 1-minute trigger is created while pending
    expect(triggers.length).toBe(1);
  });

  it('rejects an empty or over-long prompt', () => {
    expect(post({ token: TOKEN, action: 'ask', prompt: '  ' }).ok).toBe(false);
    expect(post({ token: TOKEN, action: 'ask', prompt: 'x'.repeat(4001) }).ok).toBe(false);
  });
});

describe('collectReplies', () => {
  it('stores Muse reply, marks replied and stops the polling trigger', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({ id: 'reply-1', from: MUSE, body: 'Answer', date: new Date() }));

    Code.collectReplies();

    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.status).toBe('replied');
    expect(res.messages.map((m) => [m.direction, m.text])).toEqual([
      ['out', 'Question'],
      ['in', 'Answer'],
    ]);
    expect(triggers.length).toBe(0);
  });

  it('does not collect the same reply twice', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({ id: 'reply-1', from: MUSE, body: 'Answer', date: new Date() }));
    Code.collectReplies();
    // simulate a later pending round on the same thread
    post({ token: TOKEN, action: 'answer', id, text: 'Follow-up' });
    Code.collectReplies();
    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.messages.filter((m) => m.direction === 'in').length).toBe(1);
  });

  it('marks a request as timeout after 10 minutes without a reply', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    vi.setSystemTime(new Date('2026-11-25T00:11:00Z'));
    Code.collectReplies();
    expect(get({ token: TOKEN, action: 'result', id }).status).toBe('timeout');
    expect(triggers.length).toBe(0);
  });
});

describe('answer', () => {
  it('replies to Muse\'s latest message and returns to pending with round 2', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    const claudeMsg = threads[0].addMessage(makeMessage({ id: 'reply-1', from: MUSE, body: 'Which day?', date: new Date() }));
    Code.collectReplies();

    const res = post({ token: TOKEN, action: 'answer', id, text: 'Tomorrow' });
    expect(res.ok).toBe(true);
    expect(res.round).toBe(2);
    // the reply rides Muse's message, so it is addressed to Muse;
    // no fresh send is made and the bare thread reply is not used
    expect(claudeMsg.replies).toEqual(['Tomorrow']);
    expect(threads[0].replies).toEqual([]);
    expect(sentMail.length).toBe(1);
    expect(get({ token: TOKEN, action: 'result', id }).status).toBe('pending');
    expect(triggers.length).toBe(1);
  });

  it('sends explicitly to Muse when Muse has not replied yet (recipient regression)', () => {
    // Regression: the thread's latest (only) message is the owner's
    // own ask. A bare thread reply would be addressed to the owner
    // himself and never reach Muse.
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    const res = post({ token: TOKEN, action: 'answer', id, text: 'Please wait a moment' });
    expect(res.ok).toBe(true);
    expect(res.round).toBe(2);
    expect(sentMail.length).toBe(2);
    expect(sentMail[1].to).toBe(MUSE);
    expect(sentMail[1].subject).toBe(`Re: [ai-gas:${id}] Question`);
    expect(sentMail[1].body).toBe('Please wait a moment');
    expect(sentMail.every((m) => m.to === MUSE)).toBe(true);
    expect(get({ token: TOKEN, action: 'result', id }).status).toBe('pending');
  });

  it('marks every thread with the tag read and archived after answering', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].addMessage(makeMessage({ id: 'reply-1', from: MUSE, body: 'Which day?', date: new Date() }));
    Code.collectReplies();
    post({ token: TOKEN, action: 'answer', id, text: 'Tomorrow' });
    expect(threads[0].read).toBe(true);
    expect(threads[0].archived).toBe(true);
  });

  it('archives the sibling thread started by an explicit send too', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    post({ token: TOKEN, action: 'answer', id, text: 'Follow-up before any reply' });
    // the explicit send created a second thread carrying the tag
    expect(threads.length).toBe(2);
    expect(threads.every((t) => t.read && t.archived)).toBe(true);
  });

  it('fails for an unknown id', () => {
    expect(post({ token: TOKEN, action: 'answer', id: 'missing', text: 'x' }).ok).toBe(false);
  });
});

describe('collectReplies across sibling threads', () => {
  it('collects a Muse reply that landed in a sibling thread with the same tag', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    const sibling = makeThread(`Re: [ai-gas:${id}] Question`);
    sibling.addMessage(makeMessage({ id: 'reply-sibling', from: MUSE, body: 'Sibling answer', date: new Date() }));
    threads.push(sibling);

    Code.collectReplies();

    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.status).toBe('replied');
    expect(res.messages.map((m) => [m.direction, m.text])).toEqual([
      ['out', 'Question'],
      ['in', 'Sibling answer'],
    ]);
  });
});

describe('reply attachments', () => {
  it('saves an image attachment to the Drive folder, shares it and returns its lh3 URL in result', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'See attached', date: new Date(),
      attachments: [makeAttachment({ name: 'dummy.png', contentType: 'image/png', size: 1234 })],
    }));

    Code.collectReplies();

    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.status).toBe('replied');
    expect(res.messages[0].attachments).toEqual([]);
    expect(res.messages[1].attachments).toEqual([
      { name: 'dummy.png', url: 'https://lh3.googleusercontent.com/d/file-1', fileId: 'file-1' },
    ]);
    // saved into API/muse (API at the root, muse inside it), shared
    // with anyone with the link
    expect(driveFolders.map((f) => f.name)).toEqual(['API', 'ai']);
    expect(driveFolders[1].parent).toBe(driveFolders[0]);
    expect(driveFolders[1].files.map((f) => f.id)).toEqual(['file-1']);
    expect(driveFiles['file-1'].sharing).toEqual({ access: 'ANYONE_WITH_LINK', permission: 'VIEW' });
    // and recorded as JSON in the messages sheet
    const stored = JSON.parse(sheets.messages.rows[2][6]);
    expect(stored).toEqual(res.messages[1].attachments);
  });

  it('reuses an existing API folder and only creates the muse subfolder', () => {
    const api = makeDriveFolder('API');
    driveFolders.push(api);
    api.createFolder('other-app');
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'See attached', date: new Date(),
      attachments: [makeAttachment({ name: 'dummy.png', contentType: 'image/png', size: 10 })],
    }));

    Code.collectReplies();

    expect(driveFolders.map((f) => f.name)).toEqual(['API', 'other-app', 'ai']);
    const museFolder = driveFolders.find((f) => f.name === 'ai');
    expect(museFolder.parent).toBe(api);
    expect(museFolder.files.map((f) => f.id)).toEqual(['file-1']);
    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.messages[1].attachments[0].url).toBe('https://lh3.googleusercontent.com/d/file-1');
  });

  it('ignores non-image attachments', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'Document attached', date: new Date(),
      attachments: [
        makeAttachment({ name: 'dummy.pdf', contentType: 'application/pdf', size: 100 }),
        makeAttachment({ name: 'dummy.txt', contentType: 'text/plain', size: 100 }),
      ],
    }));

    Code.collectReplies();

    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.status).toBe('replied');
    expect(res.messages[1].attachments).toEqual([]);
    expect(driveFolders).toEqual([]);
    expect(Object.keys(driveFiles)).toEqual([]);
  });

  it('returns an empty attachments array when a reply has none', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({ id: 'reply-1', from: MUSE, body: 'Answer', date: new Date() }));
    Code.collectReplies();
    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.messages.map((m) => m.attachments)).toEqual([[], []]);
  });

  it('skips oversized images and caps the import at 4 per message', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    const images = [makeAttachment({ name: 'huge.png', contentType: 'image/png', size: 10 * 1024 * 1024 + 1 })];
    for (let i = 1; i <= 6; i++) {
      images.push(makeAttachment({ name: `dummy-${i}.jpg`, contentType: 'image/jpeg', size: 100 }));
    }
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'Many images', date: new Date(), attachments: images,
    }));

    Code.collectReplies();

    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.messages[1].attachments.map((a) => a.name)).toEqual([
      'dummy-1.jpg', 'dummy-2.jpg', 'dummy-3.jpg', 'dummy-4.jpg',
    ]);
  });

  it('keeps collecting the reply when one attachment is broken', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    const broken = { getName: () => 'broken.png', getContentType: () => { throw new Error('boom'); }, getSize: () => 1 };
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'Mixed attachments', date: new Date(),
      attachments: [broken, makeAttachment({ name: 'fine.png', contentType: 'image/png', size: 10 })],
    }));

    Code.collectReplies();

    const res = get({ token: TOKEN, action: 'result', id });
    expect(res.status).toBe('replied');
    expect(res.messages[1].text).toBe('Mixed attachments');
    expect(res.messages[1].attachments.map((a) => a.name)).toEqual(['fine.png']);
  });

  it('trashes the Drive files when the conversation is deleted', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Question' });
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'With image', date: new Date(),
      attachments: [makeAttachment({ name: 'dummy.png', contentType: 'image/png', size: 10 })],
    }));
    Code.collectReplies();
    expect(driveFiles['file-1'].trashed).toBe(false);

    expect(post({ token: TOKEN, action: 'delete', id })).toEqual({ ok: true, id });
    expect(driveFiles['file-1'].trashed).toBe(true);
  });

  it('trashes the Drive files when the 30-day purge removes the reply', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Old question' });
    threads[0].messages.push(makeMessage({
      id: 'reply-1', from: MUSE, body: 'With image', date: new Date(),
      attachments: [makeAttachment({ name: 'dummy.png', contentType: 'image/png', size: 10 })],
    }));
    Code.collectReplies();
    vi.setSystemTime(new Date('2026-12-26T00:00:00Z'));
    Code.collectReplies();
    expect(get({ token: TOKEN, action: 'result', id }).ok).toBe(false);
    expect(driveFiles['file-1'].trashed).toBe(true);
  });

  it('reads a pre-migration messages sheet (no attachments column) as no attachments', () => {
    const legacy = makeSheet('messages');
    legacy.appendRow(['id', 'round', 'direction', 'text', 'at', 'msg_id']);
    legacy.appendRow(['legacy-1', 1, 'out', 'Legacy dummy prompt', '2026-11-25T00:00:00.000Z', '']);
    legacy.appendRow(['legacy-1', 1, 'in', 'Legacy dummy reply', '2026-11-25T00:01:00.000Z', 'legacy-msg']);
    sheets.messages = legacy;
    const req = makeSheet('requests');
    req.appendRow(['id', 'created_at', 'status', 'round', 'last_activity_at', 'title']);
    req.appendRow(['legacy-1', '2026-11-25T00:00:00.000Z', 'replied', 1, '2026-11-25T00:01:00.000Z', '']);
    sheets.requests = req;

    const res = get({ token: TOKEN, action: 'result', id: 'legacy-1' });
    expect(res.ok).toBe(true);
    expect(legacy.rows[0]).toContain('attachments');
    expect(res.messages.map((m) => m.attachments)).toEqual([[], []]);
  });
});

describe('list', () => {
  it('returns recent requests without message bodies', () => {
    post({ token: TOKEN, action: 'ask', prompt: 'One' });
    const res = get({ token: TOKEN, action: 'list' });
    expect(res.ok).toBe(true);
    expect(res.requests.length).toBe(1);
    expect(res.requests[0].status).toBe('pending');
    expect(res.requests[0].text).toBeUndefined();
  });
});

describe('rename', () => {
  it('sets and clears a title without touching last_activity_at', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Dummy question' });
    const before = get({ token: TOKEN, action: 'result', id });
    const res = post({ token: TOKEN, action: 'rename', id, title: '  Dummy title  ' });
    expect(res).toEqual({ ok: true, id, title: 'Dummy title' });
    const after = get({ token: TOKEN, action: 'result', id });
    expect(after.title).toBe('Dummy title');
    expect(after.last_activity_at).toBe(before.last_activity_at);
    expect(post({ token: TOKEN, action: 'rename', id, title: '' }).title).toBe('');
    expect(get({ token: TOKEN, action: 'result', id }).title).toBe('');
  });
  it('rejects an over-long title and an unknown id', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Dummy' });
    expect(post({ token: TOKEN, action: 'rename', id, title: 'x'.repeat(101) }).ok).toBe(false);
    expect(post({ token: TOKEN, action: 'rename', id, title: 'x'.repeat(100) }).ok).toBe(true);
    expect(post({ token: TOKEN, action: 'rename', id: 'missing', title: 'x' }).ok).toBe(false);
  });
});

describe('delete', () => {
  it('removes the request and all its messages', () => {
    const a = post({ token: TOKEN, action: 'ask', prompt: 'Dummy A' });
    const b = post({ token: TOKEN, action: 'ask', prompt: 'Dummy B' });
    expect(post({ token: TOKEN, action: 'delete', id: a.id })).toEqual({ ok: true, id: a.id });
    expect(get({ token: TOKEN, action: 'result', id: a.id }).ok).toBe(false);
    expect(get({ token: TOKEN, action: 'list' }).requests.map((r) => r.id)).toEqual([b.id]);
    expect(sheets.messages.rows.filter((r) => r[0] === a.id)).toHaveLength(0);
    expect(sheets.messages.rows.filter((r) => r[0] === b.id).length).toBeGreaterThan(0);
  });
  it('fails for an unknown id', () => {
    expect(post({ token: TOKEN, action: 'delete', id: 'missing' }).ok).toBe(false);
  });
  it('stops the polling trigger when the last pending request is deleted', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Dummy pending' });
    expect(triggers.length).toBe(1);
    post({ token: TOKEN, action: 'delete', id });
    expect(triggers.length).toBe(0);
  });
});

describe('list title/preview and result title', () => {
  it('returns title and the first outgoing line as preview', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'First line dummy\nsecond line' });
    post({ token: TOKEN, action: 'rename', id, title: 'Named dummy' });
    const res = get({ token: TOKEN, action: 'list' });
    expect(res.requests[0].title).toBe('Named dummy');
    expect(res.requests[0].preview).toBe('First line dummy');
    expect(get({ token: TOKEN, action: 'result', id }).title).toBe('Named dummy');
  });
  it('truncates the preview to 50 characters', () => {
    post({ token: TOKEN, action: 'ask', prompt: 'y'.repeat(80) });
    const res = get({ token: TOKEN, action: 'list' });
    expect(res.requests[0].preview).toBe('y'.repeat(50));
    expect(res.requests[0].title).toBe('');
  });
});

describe('requests sheet migration (no title column)', () => {
  it('adds the title column to a pre-existing sheet and rename/list still work', () => {
    // Simulate a sheet created before the title column existed.
    const legacy = makeSheet('requests');
    legacy.appendRow(['id', 'created_at', 'status', 'round', 'last_activity_at']);
    legacy.appendRow(['legacy-1', '2026-11-25T00:00:00.000Z', 'replied', 1, '2026-11-25T00:00:00.000Z']);
    sheets.requests = legacy;
    const msg = makeSheet('messages');
    msg.appendRow(['id', 'round', 'direction', 'text', 'at', 'msg_id']);
    msg.appendRow(['legacy-1', 1, 'out', 'Legacy dummy prompt', '2026-11-25T00:00:00.000Z', '']);
    sheets.messages = msg;

    const listed = get({ token: TOKEN, action: 'list' });
    expect(listed.ok).toBe(true);
    expect(legacy.rows[0]).toContain('title');
    expect(listed.requests[0].title).toBe('');
    expect(listed.requests[0].preview).toBe('Legacy dummy prompt');
    expect(post({ token: TOKEN, action: 'rename', id: 'legacy-1', title: 'Migrated' }).ok).toBe(true);
    expect(get({ token: TOKEN, action: 'result', id: 'legacy-1' }).title).toBe('Migrated');
  });
});

describe('retention', () => {
  it('purges rows older than 30 days', () => {
    const { id } = post({ token: TOKEN, action: 'ask', prompt: 'Old question' });
    vi.setSystemTime(new Date('2026-12-26T00:00:00Z'));
    Code.collectReplies();
    expect(get({ token: TOKEN, action: 'result', id }).ok).toBe(false);
  });
});

describe('web sessions (Google sign-in exchange)', () => {
  const { createHash } = require('node:crypto');
  const PAYLOAD = { email: 'owner@example.com', email_verified: 'true', aud: 'dummy-client' };

  beforeEach(() => {
    props.ALLOWED_EMAIL = 'owner@example.com';
    props.GOOGLE_CLIENT_ID = 'dummy-client';
    global.Utilities.computeDigest = (_algo, text) =>
      [...createHash('sha256').update(String(text)).digest()].map((b) => (b > 127 ? b - 256 : b));
    global.Utilities.DigestAlgorithm = { SHA_256: 'SHA_256' };
    global.Utilities.Charset = { UTF_8: 'UTF_8' };
    global.UrlFetchApp = {
      fetch: vi.fn(() => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(PAYLOAD),
      })),
    };
  });

  it('accepts only the allowed, verified account with the right audience', () => {
    expect(Code.isAllowedIdTokenPayload(PAYLOAD)).toBe(true);
    expect(Code.isAllowedIdTokenPayload({ ...PAYLOAD, email: 'other@example.com' })).toBe(false);
    expect(Code.isAllowedIdTokenPayload({ ...PAYLOAD, email_verified: 'false' })).toBe(false);
    expect(Code.isAllowedIdTokenPayload({ ...PAYLOAD, aud: 'another-client' })).toBe(false);
    expect(Code.isAllowedIdTokenPayload(null)).toBe(false);
  });

  it('accepts any account from a comma-separated ALLOWED_EMAIL list', () => {
    props.ALLOWED_EMAIL = 'owner@example.com, second@example.com';
    expect(Code.isAllowedIdTokenPayload({ ...PAYLOAD, email: 'second@example.com' })).toBe(true);
    expect(Code.isAllowedIdTokenPayload({ ...PAYLOAD, email: 'third@example.com' })).toBe(false);
  });

  it('fails closed while ALLOWED_EMAIL is unset', () => {
    delete props.ALLOWED_EMAIL;
    expect(Code.isAllowedIdTokenPayload(PAYLOAD)).toBe(false);
  });

  it('exchanges a valid ID token for a session that opens the API', () => {
    const res = post({ action: 'exchange_session', idToken: 'dummy-id-token' });
    expect(res.ok).toBe(true);
    expect(typeof res.sessionToken).toBe('string');
    // the session token works in place of the API token
    const asked = post({ sessionToken: res.sessionToken, action: 'ask', prompt: 'hello from web' });
    expect(asked.ok).toBe(true);
    expect(get({ sessionToken: res.sessionToken, action: 'list' }).ok).toBe(true);
    // and the stored value is a hash, not the raw token
    const rows = sheets.sessions.rows;
    expect(rows.length).toBe(2); // header + one session
    expect(rows[1][0]).not.toContain(res.sessionToken);
    expect(rows[1][0]).toBe(Code.sha256Hex(res.sessionToken));
  });

  it('rejects the exchange when Google does not verify the token', () => {
    global.UrlFetchApp.fetch = vi.fn(() => ({ getResponseCode: () => 400, getContentText: () => '{}' }));
    expect(post({ action: 'exchange_session', idToken: 'bad' }).ok).toBe(false);
  });

  it('rejects an unknown or expired session', () => {
    expect(post({ sessionToken: 'no-such-session', action: 'ask', prompt: 'hi' }).ok).toBe(false);
    const res = post({ action: 'exchange_session', idToken: 'dummy-id-token' });
    vi.setSystemTime(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    expect(post({ sessionToken: res.sessionToken, action: 'ask', prompt: 'hi' }).ok).toBe(false);
  });
});

describe('reply RSS feed', () => {
  it('escapes XML special characters', () => {
    expect(Code.xmlEscape('a & b <c> "d" \'e\'')).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;');
  });

  it('formats pubDate in RFC 822 with English names', () => {
    expect(Code.rfc822(new Date('2026-11-25T05:31:19Z'))).toBe('Wed, 25 Nov 2026 05:31:19 GMT');
    expect(Code.rfc822(new Date('2027-01-03T00:00:05Z'))).toBe('Sun, 03 Jan 2027 00:00:05 GMT');
  });

  it('refuses the feed while RSS_TOKEN is unset, and for the API token', () => {
    const unset = JSON.parse(Code.doGet({ parameter: { action: 'rss', token: 'anything' } }).text);
    expect(unset.ok).toBe(false);
    props.RSS_TOKEN = 'rss-dummy';
    const apiToken = JSON.parse(Code.doGet({ parameter: { action: 'rss', token: TOKEN } }).text);
    expect(apiToken.ok).toBe(false);
    expect(Code.isRssAuthorized('rss-dummy')).toBe(true);
    expect(Code.isRssAuthorized('nope')).toBe(false);
  });

  it('serves one item per reply, newest first, with the request as title', () => {
    props.RSS_TOKEN = 'rss-dummy';
    const asked = post({ token: TOKEN, action: 'ask', prompt: 'テストの依頼です' });
    expect(asked.ok).toBe(true);
    const messages = sheets['messages'];
    messages.appendRow([asked.id, 1, 'in', '最初の返信 <テスト> & 確認', '2026-11-25T01:00:00.000Z', 'msg-1']);
    messages.appendRow([asked.id, 1, 'in', '二件目の返信', '2026-11-25T02:00:00.000Z', 'msg-2']);

    const out = Code.doGet({ parameter: { action: 'rss', token: 'rss-dummy' } });
    expect(out.text).toContain('<rss version="2.0">');
    expect(out.text).toContain('<title>返信: テストの依頼です</title>');
    expect(out.text).toContain('最初の返信 &lt;テスト&gt; &amp; 確認');
    expect(out.text).toContain('<pubDate>Wed, 25 Nov 2026 01:00:00 GMT</pubDate>');
    expect(out.text.indexOf('二件目の返信')).toBeLessThan(out.text.indexOf('最初の返信'));
    // the outgoing prompt itself is not an item
    expect(out.text.match(/<item>/g)).toHaveLength(2);
  });

  it('links each item to its own thread URL', () => {
    props.RSS_TOKEN = 'rss-dummy';
    const first = post({ token: TOKEN, action: 'ask', prompt: '一つ目の依頼です' });
    const second = post({ token: TOKEN, action: 'ask', prompt: '二つ目の依頼です' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const messages = sheets['messages'];
    messages.appendRow([first.id, 1, 'in', '一つ目への返信', '2026-11-25T01:00:00.000Z', 'msg-a']);
    messages.appendRow([second.id, 1, 'in', '二つ目への返信', '2026-11-25T02:00:00.000Z', 'msg-b']);

    const out = Code.doGet({ parameter: { action: 'rss', token: 'rss-dummy' } });
    expect(out.text).toContain('<link>https://freddiefujiwara.com/ai/' + first.id + '</link>');
    expect(out.text).toContain('<link>https://freddiefujiwara.com/ai/' + second.id + '</link>');
    // no item link falls back to the bare front URL (the channel link
    // is the only bare one)
    expect(out.text.match(/<link>https:\/\/freddiefujiwara\.com\/ai\/<\/link>/g)).toHaveLength(1);
  });

  it('uses the rename title for the item title when one is set', () => {
    props.RSS_TOKEN = 'rss-dummy';
    const asked = post({ token: TOKEN, action: 'ask', prompt: '元の依頼文です' });
    expect(asked.ok).toBe(true);
    const renamed = post({ token: TOKEN, action: 'rename', id: asked.id, title: '付けた名前' });
    expect(renamed.ok).toBe(true);
    sheets['messages'].appendRow([asked.id, 1, 'in', '返信本文です', '2026-11-25T01:00:00.000Z', 'msg-1']);

    const out = Code.doGet({ parameter: { action: 'rss', token: 'rss-dummy' } });
    expect(out.text).toContain('<title>返信: 付けた名前</title>');
    expect(out.text).not.toContain('<title>返信: 元の依頼文です</title>');
    expect(out.text).toContain('<link>https://freddiefujiwara.com/ai/' + asked.id + '</link>');
  });

  it('cuts the name in the item title to 50 characters', () => {
    props.RSS_TOKEN = 'rss-dummy';
    const longLine = 'あ'.repeat(60);
    const asked = post({ token: TOKEN, action: 'ask', prompt: longLine + '\n二行目' });
    expect(asked.ok).toBe(true);
    sheets['messages'].appendRow([asked.id, 1, 'in', '返信本文です', '2026-11-25T01:00:00.000Z', 'msg-1']);

    const out = Code.doGet({ parameter: { action: 'rss', token: 'rss-dummy' } });
    expect(out.text).toContain('<title>返信: ' + 'あ'.repeat(50) + '</title>');
    expect(out.text).not.toContain('あ'.repeat(51));
  });
});
