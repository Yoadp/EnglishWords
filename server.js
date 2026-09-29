// Flashcards server: serves the app from ./public and stores all user data in a Google Sheet.
//   "users" tab        – sign-up data (username, salt, password hash)
//   one tab per user   – named after the username: word statuses + test results
// Config: config.json { spreadsheetId, credentialsFile } (or env SPREADSHEET_ID / GOOGLE_CREDENTIALS).
// No external dependencies. Run with: node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SheetsClient, parseSpreadsheetId } = require("./sheets");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_FILE = path.join(__dirname, "config.json");

const USERS_TAB = "users";
const USERS_HEADER = ["username", "salt", "password_hash", "created_at"];
const USER_DATA_HEADER = ["record_type", "test_id", "date", "unit", "english", "hebrew", "status", "correct", "total"];
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,30}$/u;
const MIN_PASSWORD = 4;
const STATUSES = ["succeeded", "failed"];
// Word answers are batched: a user's tab is rewritten this long after their last change.
// Keeps us well under the Sheets API write quota (~60 writes/min per service account).
const FLUSH_DELAY_MS = 3000;
const RETRY_DELAY_MS = 15000;

// ---------- Config ----------
const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
const spreadsheetId = parseSpreadsheetId(process.env.SPREADSHEET_ID || config.spreadsheetId);
const credentialsFile = path.resolve(__dirname, process.env.GOOGLE_CREDENTIALS || config.credentialsFile || "credentials.json");
if (!spreadsheetId || !fs.existsSync(credentialsFile)) {
  console.error("Missing Google Sheets config: set spreadsheetId in config.json and put the service account key in credentials.json");
  process.exit(1);
}
const sheets = new SheetsClient({ credentialsFile, spreadsheetId });

// ---------- Sheet <-> memory ----------
// All users (small) are loaded at startup. Each user's progress is loaded on first use and cached;
// the cache is the source of truth while the server runs and is flushed back to the user's tab.
const users = new Map(); // username -> { username, salt, password_hash, created_at }
const cache = new Map(); // username -> { data: { words, tests }, dirty, timer, flushing, error }

const toObjects = (rows) => {
  const [header, ...rest] = rows;
  if (!header) return [];
  return rest
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] == null ? "" : String(r[i])])));
};

function parseUserRows(rows) {
  const words = new Map();
  const tests = new Map();
  for (const r of toObjects(rows)) {
    if (r.record_type === "word") {
      words.set(r.english, { he: r.hebrew, status: r.status, date: r.date });
    } else if (r.record_type === "test") {
      tests.set(r.test_id, { id: r.test_id, date: r.date, unit: r.unit, correct: Number(r.correct), total: Number(r.total), words: [] });
    } else if (r.record_type === "test_word") {
      tests.get(r.test_id)?.words.push({ en: r.english, he: r.hebrew, ok: r.status === "succeeded" });
    }
  }
  return { words, tests: [...tests.values()] };
}

function userRows({ words, tests }) {
  const rows = [USER_DATA_HEADER];
  const row = (o) => USER_DATA_HEADER.map((h) => o[h] ?? "");
  for (const [en, w] of words) {
    rows.push(row({ record_type: "word", date: w.date, english: en, hebrew: w.he, status: w.status }));
  }
  for (const t of tests) {
    rows.push(row({ record_type: "test", test_id: t.id, date: t.date, unit: t.unit, correct: t.correct, total: t.total }));
    for (const w of t.words) {
      rows.push(row({
        record_type: "test_word", test_id: t.id, date: t.date, unit: t.unit,
        english: w.en, hebrew: w.he, status: w.ok ? "succeeded" : "failed",
      }));
    }
  }
  return rows;
}

async function userEntry(username) {
  if (!cache.has(username)) {
    let rows;
    try {
      rows = await sheets.readTab(username);
    } catch (err) {
      if (err.status !== 400) throw err;
      // The user's tab is missing (e.g. deleted by hand in the sheet): recreate it empty
      await sheets.addTab(username, USER_DATA_HEADER);
      rows = [];
    }
    // Another request may have loaded it while we were waiting
    if (!cache.has(username)) {
      cache.set(username, { data: parseUserRows(rows), dirty: false, timer: null, flushing: null, error: null });
    }
  }
  return cache.get(username);
}

function scheduleFlush(username, delay = FLUSH_DELAY_MS) {
  const entry = cache.get(username);
  entry.dirty = true;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flush(username).catch(() => {}), delay);
}

// Writes the user's tab if there are unsaved changes. Flushes for the same user never overlap.
async function flush(username) {
  const entry = cache.get(username);
  while (entry.flushing) await entry.flushing.catch(() => {});
  if (!entry.dirty) return;

  entry.dirty = false;
  clearTimeout(entry.timer);
  entry.flushing = sheets
    .writeTab(username, userRows(entry.data))
    .then(
      () => {
        entry.error = null;
      },
      (err) => {
        console.error(`Saving ${username} to Google Sheets failed:`, err.message);
        entry.error = err;
        scheduleFlush(username, RETRY_DELAY_MS); // keep the changes and try again later
        throw err;
      }
    )
    .finally(() => {
      entry.flushing = null;
    });
  return entry.flushing;
}

async function flushAll() {
  await Promise.allSettled([...cache.keys()].map((u) => flush(u)));
}

// ---------- Auth ----------
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");

function verifyPassword(user, password) {
  const expected = Buffer.from(user.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Sessions live in memory: restarting the server signs everyone out
const sessions = new Map();

function sessionUser(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter(([k]) => k)
  );
  return sessions.get(cookies.sid) || null;
}

function startSession(res, username) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, username);
  res.setHeader("Set-Cookie", `sid=${token}; HttpOnly; SameSite=Lax; Path=/`);
}

// ---------- HTTP helpers ----------
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(Object.assign(new Error("הבקשה גדולה מדי"), { status: 413 }));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error("נתונים לא תקינים"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const str = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const sheetsError = () => Object.assign(new Error("השמירה ל-Google Sheets נכשלה, נסו שוב בעוד רגע"), { status: 502 });

// ---------- API ----------
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "POST /api/signup") {
    const body = await readBody(req);
    const username = str(body.username, 100).trim().toLowerCase();
    const password = str(body.password, 200);
    if (!USERNAME_RE.test(username) || username === USERS_TAB) {
      return sendJson(res, 400, { error: "שם משתמש: 3–30 תווים, אותיות, ספרות, _ או - בלבד" });
    }
    if (password.length < MIN_PASSWORD) {
      return sendJson(res, 400, { error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD} תווים` });
    }
    // Tab names are unique case-insensitively, so also avoid clashing with any other existing tab
    const { tabs } = await sheets.listTabs();
    if (users.has(username) || tabs.some((t) => t.title.toLowerCase() === username)) {
      return sendJson(res, 409, { error: "שם המשתמש כבר תפוס" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const user = { username, salt, password_hash: hashPassword(password, salt), created_at: new Date().toISOString() };
    users.set(username, user); // reserve the name while we write to the sheet
    try {
      await sheets.addTab(username, USER_DATA_HEADER);
      await sheets.appendRow(USERS_TAB, USERS_HEADER.map((h) => user[h]));
    } catch (err) {
      users.delete(username);
      console.error("Sign-up failed:", err.message);
      throw sheetsError();
    }
    cache.set(username, { data: { words: new Map(), tests: [] }, dirty: false, timer: null, flushing: null, error: null });
    startSession(res, username);
    return sendJson(res, 201, { username });
  }

  if (route === "POST /api/login") {
    const body = await readBody(req);
    const username = str(body.username, 100).trim().toLowerCase();
    const user = users.get(username);
    if (!user || !verifyPassword(user, str(body.password, 200))) {
      return sendJson(res, 401, { error: "שם משתמש או סיסמה שגויים" });
    }
    startSession(res, username);
    return sendJson(res, 200, { username });
  }

  if (route === "POST /api/logout") {
    const sid = (req.headers.cookie || "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
    const username = sessions.get(sid);
    sessions.delete(sid);
    if (username && cache.has(username)) flush(username).catch(() => {});
    res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return sendJson(res, 200, {});
  }

  // Everything below requires a signed-in user
  const username = sessionUser(req);
  if (!username) return sendJson(res, 401, { error: "יש להתחבר" });
  const entry = await userEntry(username);
  const { data } = entry;

  if (route === "GET /api/data") {
    const byStatus = (s) => [...data.words].filter(([, w]) => w.status === s).map(([en]) => en);
    return sendJson(res, 200, { username, known: byStatus("succeeded"), failed: byStatus("failed"), tests: data.tests });
  }

  if (route === "POST /api/words") {
    const body = await readBody(req);
    const en = str(body.en, 200);
    if (!en || !STATUSES.includes(body.status)) return sendJson(res, 400, { error: "נתונים לא תקינים" });
    data.words.set(en, { he: str(body.he), status: body.status, date: new Date().toISOString() });
    scheduleFlush(username);
    // The change is kept and retried, but let the user know the sheet is currently not being updated
    if (entry.error) throw sheetsError();
    return sendJson(res, 200, {});
  }

  if (route === "DELETE /api/words") {
    data.words.clear();
    scheduleFlush(username, 0);
    return sendJson(res, 200, {});
  }

  if (route === "POST /api/tests") {
    const body = await readBody(req);
    if (!Array.isArray(body.words) || body.words.length === 0) return sendJson(res, 400, { error: "אין מילים במבחן" });
    const words = body.words.slice(0, 5000).map((w) => ({ en: str(w.en, 200), he: str(w.he), ok: !!w.ok }));
    const test = {
      id: `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
      date: str(body.date, 40) || new Date().toISOString(),
      unit: str(body.unit, 10) || "all",
      correct: words.filter((w) => w.ok).length,
      total: words.length,
      words,
    };
    // Test results are saved right away so the user knows they're stored
    data.tests.push(test);
    entry.dirty = true;
    try {
      await flush(username);
    } catch {
      data.tests = data.tests.filter((t) => t !== test); // not saved: let the user retry without duplicates
      throw sheetsError();
    }
    return sendJson(res, 201, test);
  }

  if (route === "DELETE /api/tests") {
    data.tests = [];
    scheduleFlush(username, 0);
    return sendJson(res, 200, {});
  }

  const testMatch = url.pathname.match(/^\/api\/tests\/([\w-]+)$/);
  if (req.method === "DELETE" && testMatch) {
    data.tests = data.tests.filter((t) => t.id !== testMatch[1]);
    scheduleFlush(username, 0);
    return sendJson(res, 200, {});
  }

  return sendJson(res, 404, { error: "לא נמצא" });
}

// ---------- Static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  // Send visitors to the right page depending on whether they're signed in
  const signedIn = !!sessionUser(req);
  if (pathname === "/index.html" && !signedIn) return redirect(res, "/login.html");
  if ((pathname === "/login.html" || pathname === "/signup.html") && signedIn) return redirect(res, "/");

  const file = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

// ---------- Startup ----------
async function loadUsers() {
  const { title, tabs } = await sheets.listTabs();
  if (!tabs.some((t) => t.title === USERS_TAB)) await sheets.addTab(USERS_TAB, USERS_HEADER);
  for (const u of toObjects(await sheets.readTab(USERS_TAB))) users.set(u.username, u);
  return title;
}

async function main() {
  let title;
  try {
    title = await loadUsers();
  } catch (err) {
    console.error(`Cannot open the Google Sheet: ${err.message}`);
    if (err.status === 403 || err.status === 404) {
      console.error(`Check the spreadsheet ID and share the sheet (Editor) with ${sheets.serviceAccountEmail}`);
    }
    process.exit(1);
  }

  const server = http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      try {
        if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
        else serveStatic(req, res, url);
      } catch (err) {
        if (!err.status) console.error(err);
        sendJson(res, err.status || 500, { error: err.status ? err.message : "שגיאת שרת" });
      }
    })
    .listen(PORT, () => {
      console.log(`Google Sheet "${title}" connected (${users.size} users)`);
      console.log(`Flashcards running at http://localhost:${PORT}`);
    });

  // Write pending changes before exiting
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      server.close();
      await flushAll();
      process.exit(0);
    });
  }
}

main();
