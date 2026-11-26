import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Code from '../src/Code.js';

// Tests for the merged ai-gas behavior: the engine column, Groq
// conversations through the ask/answer API, the HTTP dispatch
// between the Muse side (JSON bodies naming an action) and the
// legacy Groq window, and the separation of the two tokens.
// All fixtures are dummy data.

const TOKEN = 'dummy-api-token';
const GROQ_TOKEN = 'dummy-groq-token';
const RSS_TOKEN = 'dummy-rss-token';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

let props;
let sheets;
let sentMail;
let uuidCounter;
let groqAnswer;

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

beforeEach(() => {
  props = {
    API_TOKEN: TOKEN,
    GROQ_TOKEN,
    RSS_TOKEN,
    GROQ_API_KEY: 'dummy-groq-key',
    MUSE_EMAIL: 'claude@example.com',
    SPREADSHEET_ID: 'dummy-sheet-id',
  };
  sheets = {};
  sentMail = [];
  uuidCounter = 0;
  groqAnswer = 'groq answer';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T00:00:00Z'));

  global.ContentService = {
    createTextOutput: vi.fn((text) => {
      const out = { text, setMimeType: vi.fn(() => out) };
      return out;
    }),
    MimeType: { JSON: 'application/json', XML: 'application/xml' },
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
    computeDigest: vi.fn(() => [1, 2, 3]),
    base64Encode: vi.fn(() => 'cachekey'),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
  };
  global.SpreadsheetApp = {
    openById: vi.fn(() => ({
      getSheetByName: (name) => sheets[name] ?? null,
      insertSheet: (name) => { sheets[name] = makeSheet(name); return sheets[name]; },
    })),
    create: vi.fn(() => ({ getId: () => 'created-id', getUrl: () => 'https://example.invalid/sheet' })),
  };
  global.GmailApp = {
    sendEmail: vi.fn((to, subject, body) => { sentMail.push({ to, subject, body }); }),
    search: vi.fn(() => []),
  };
  global.ScriptApp = {
    getProjectTriggers: vi.fn(() => []),
    newTrigger: vi.fn(() => ({
      timeBased: () => ({ everyMinutes: () => ({ create: () => ({}) }) }),
    })),
    deleteTrigger: vi.fn(),
  };
  global.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
  };
  global.CacheService = {
    getScriptCache: () => ({ get: () => null, put: vi.fn() }),
  };
  global.UrlFetchApp = {
    fetch: vi.fn((url) => {
      if (url === GROQ_URL) {
        return {
          getContentText: () =>
            JSON.stringify({ choices: [{ message: { content: groqAnswer } }] }),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    }),
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

describe('groq conversations through the ask/answer API', () => {
  it('answers a groq ask on the spot and stores the exchange', () => {
    const res = post({ token: TOKEN, action: 'ask', engine: 'groq', prompt: 'hello groq' });
    expect(res).toEqual({ ok: true, id: 'uuid-1', status: 'replied', round: 1, engine: 'groq' });
    expect(sentMail).toHaveLength(0);

    const detail = get({ token: TOKEN, action: 'result', id: res.id });
    expect(detail.engine).toBe('groq');
    expect(detail.status).toBe('replied');
    expect(detail.messages.map((m) => [m.direction, m.text])).toEqual([
      ['out', 'hello groq'],
      ['in', 'groq answer'],
    ]);

    const list = get({ token: TOKEN, action: 'list' });
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].engine).toBe('groq');
  });

  it('sends the stored history with a groq follow-up', () => {
    const first = post({ token: TOKEN, action: 'ask', engine: 'groq', prompt: 'first' });
    groqAnswer = 'second answer';
    const res = post({ token: TOKEN, action: 'answer', id: first.id, text: 'follow up' });
    expect(res).toEqual({ ok: true, id: first.id, status: 'replied', round: 2, engine: 'groq' });

    const payload = JSON.parse(global.UrlFetchApp.fetch.mock.calls.at(-1)[1].payload);
    expect(payload.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'groq answer' },
      { role: 'user', content: 'follow up' },
    ]);

    const detail = get({ token: TOKEN, action: 'result', id: first.id });
    expect(detail.messages.map((m) => m.text)).toEqual([
      'first',
      'groq answer',
      'follow up',
      'second answer',
    ]);
  });

  it('stores nothing when the groq call fails', () => {
    global.UrlFetchApp.fetch.mockImplementation(() => ({
      getContentText: () => JSON.stringify({ error: { message: 'groq is down' } }),
    }));
    const res = post({ token: TOKEN, action: 'ask', engine: 'groq', prompt: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('groq is down');
    expect(sheets.requests?.rows ?? []).toHaveLength(0);
  });

  it('applies the groq length limit, not the mail one', () => {
    const long = 'x'.repeat(5000);
    const res = post({ token: TOKEN, action: 'ask', engine: 'groq', prompt: long });
    expect(res.ok).toBe(true);
    const tooLong = post({ token: TOKEN, action: 'ask', engine: 'groq', prompt: 'x'.repeat(20001) });
    expect(tooLong.ok).toBe(false);
  });
});

describe('engine column migration', () => {
  it('adds the engine column to a pre-merge requests sheet and reads old rows as muse', () => {
    const sheet = makeSheet('requests');
    sheet.rows.push(['id', 'created_at', 'status', 'round', 'last_activity_at', 'title']);
    sheet.rows.push(['old-1', '2026-11-25T00:00:00.000Z', 'replied', 1, '2026-11-25T00:00:00.000Z', '']);
    sheets.requests = sheet;

    const list = get({ token: TOKEN, action: 'list' });
    expect(sheet.rows[0]).toContain('engine');
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].engine).toBe('muse');
  });
});

describe('rss excludes groq conversations', () => {
  it('lists only Muse replies', () => {
    post({ token: TOKEN, action: 'ask', engine: 'groq', prompt: 'groq question' });
    const muse = post({ token: TOKEN, action: 'ask', prompt: 'muse question' });
    // Simulate a collected Muse reply.
    sheets.messages.appendRow([
      muse.id, 1, 'in', 'claude reply', new Date().toISOString(), 'msg-1', '',
    ]);

    const out = Code.doGet({ parameter: { action: 'rss', token: RSS_TOKEN } });
    expect(out.text).toContain('claude reply');
    expect(out.text).not.toContain('groq answer');
    expect(out.text).toContain('https://freddiefujiwara.com/ai/' + muse.id);
  });
});

describe('HTTP dispatch between the Muse side and the Groq window', () => {
  it('routes a GET with a prompt to the Groq window', () => {
    const res = get({ p: 'hello', token: GROQ_TOKEN });
    expect(res).toEqual({ prompt: 'hello', answer: 'groq answer', cached: false });
  });

  it('routes a GET without an action but no prompt to the Groq validation', () => {
    const res = get({});
    expect(res).toEqual({ error: "Parameter 'p' is required." });
  });

  it('routes a JSON body without an action to the Groq window', () => {
    const res = post({ p: 'hello', token: GROQ_TOKEN });
    expect(res).toEqual({ prompt: 'hello', answer: 'groq answer', cached: false });
  });

  it('routes a raw text body to the Groq window with the query token', () => {
    const out = Code.doPost({
      postData: { contents: 'raw prompt' },
      parameter: { token: GROQ_TOKEN },
    });
    expect(JSON.parse(out.text)).toEqual({
      prompt: 'raw prompt',
      answer: 'groq answer',
      cached: false,
    });
  });

  it('keeps the two tokens separate', () => {
    // The Groq window refuses the Muse-side API token.
    expect(get({ p: 'hello', token: TOKEN })).toEqual({ error: 'Unauthorized.' });
    // The Muse side refuses the Groq token.
    expect(post({ token: GROQ_TOKEN, action: 'ask', prompt: 'hi' }).ok).toBe(false);
    expect(get({ token: GROQ_TOKEN, action: 'list' }).ok).toBe(false);
  });

  it('fails closed on the Groq window while GROQ_TOKEN is unset', () => {
    delete props.GROQ_TOKEN;
    expect(get({ p: 'hello', token: GROQ_TOKEN })).toEqual({ error: 'Unauthorized.' });
  });
});
