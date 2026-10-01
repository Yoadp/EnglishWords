// API logic, shared by the Vercel function (api/index.js) and the local dev server (dev-server.js).
// Stateless by design (serverless): nothing is kept in memory between requests.
//   - Sessions are signed cookies.
//   - All data lives in the Google Sheet: a "users" tab (sign-up data) and one tab per user (progress).
const crypto = require("crypto");
const path = require("path");
const { SheetsClient, loadCredentials, parseSpreadsheetId } = require("./sheets");

const USERS_TAB = "users";
const USERS_HEADER = ["username", "salt", "password_hash", "created_at"];
// test_type and chosen were added later: older tabs have a 9-column header and are upgraded when a test is saved
const USER_DATA_HEADER = [
  "record_type", "test_id", "date", "unit", "english", "hebrew", "status", "correct", "total", "test_type", "chosen",
];
const LAST_COLUMN = "K"; // column of the last USER_DATA_HEADER field
const TEST_TYPES = ["flashcards", "mc"]; // mc = multiple choice ("American") test
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,30}$/u;
const MIN_PASSWORD = 4;
const STATUSES = ["succeeded", "failed"];
const SESSION_DAYS = 30;

let config = {};
try {
  config = require("./config.json");
} catch {
  // No config file: SPREADSHEET_ID must come from the environment
}

// ---------- Lazy setup (a config problem becomes an API error instead of crashing the function) ----------
let sheets = null;
let sessionSecret = null;

function setup() {
  if (sheets) return;
  const spreadsheetId = parseSpreadsheetId(process.env.SPREADSHEET_ID || config.spreadsheetId);
  if (!spreadsheetId) throw new Error("Missing spreadsheet ID: set SPREADSHEET_ID or spreadsheetId in config.json");
  const credentials = loadCredentials({ file: path.join(__dirname, config.credentialsFile || "credentials.json") });
  sheets = new SheetsClient({ credentials, spreadsheetId });
  // Derived from the private key so no extra secret has to be configured; SESSION_SECRET overrides it
  sessionSecret =
    process.env.SESSION_SECRET || crypto.createHash("sha256").update(`session:${credentials.private_key}`).digest("hex");
}

// ---------- Sessions (signed cookie: base64url(username).expiresAt.signature) ----------
const sign = (value) => crypto.createHmac("sha256", sessionSecret).update(value).digest("base64url");

function sessionUser(req) {
  const token = (req.headers.cookie || "").match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  if (!token) return null;
  const [user, expires, signature] = token.split(".");
  if (!user || !expires || !signature) return null;
  const expected = Buffer.from(sign(`${user}.${expires}`));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  if (Number(expires) < Date.now()) return null;
  return Buffer.from(user, "base64url").toString("utf8");
}

const secureFlag = (req) => (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

function setSessionCookie(req, res, username) {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${Buffer.from(username).toString("base64url")}.${expires}`;
  res.setHeader(
    "Set-Cookie",
    `sid=${payload}.${sign(payload)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureFlag(req)}`
  );
}

// ---------- Passwords ----------
const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString("hex");

function verifyPassword(user, password) {
  const expected = Buffer.from(user.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------- Sheet helpers ----------
function toObjects(rows) {
  const [header, ...rest] = rows;
  if (!header) return [];
  return rest
    .filter((r) => r.some((c) => c !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] == null ? "" : String(r[i])])));
}

const userRow = (o) => USER_DATA_HEADER.map((h) => o[h] ?? "");
const wordRow = (w) => userRow({ record_type: "word", date: w.date, english: w.en, hebrew: w.he, status: w.status });

function testRows(t) {
  return [
    userRow({
      record_type: "test", test_id: t.id, date: t.date, unit: t.unit, correct: t.correct, total: t.total, test_type: t.type,
    }),
    ...t.words.map((w) =>
      userRow({
        record_type: "test_word", test_id: t.id, date: t.date, unit: t.unit,
        english: w.en, hebrew: w.he, status: w.ok ? "succeeded" : "failed", chosen: w.chosen,
      })
    ),
  ];
}

function parseUserRows(rows) {
  const words = new Map();
  const tests = new Map();
  // Only "word" rows decide known/failed — test results (including multiple-choice) never change them
  for (const r of toObjects(rows)) {
    if (r.record_type === "word") {
      words.set(r.english, r.status);
    } else if (r.record_type === "test") {
      tests.set(r.test_id, {
        id: r.test_id, date: r.date, unit: r.unit, correct: Number(r.correct), total: Number(r.total),
        type: r.test_type || "", words: [],
      });
    } else if (r.record_type === "test_word") {
      const word = { en: r.english, he: r.hebrew, ok: r.status === "succeeded" };
      if (r.chosen) word.chosen = r.chosen;
      tests.get(r.test_id)?.words.push(word);
    }
  }
  const byStatus = (s) => [...words].filter(([, status]) => status === s).map(([en]) => en);
  return { known: byStatus("succeeded"), failed: byStatus("failed"), tests: [...tests.values()] };
}

// Reads a tab, creating it (with its header) if it doesn't exist yet
async function readOrCreateTab(title, header, cells) {
  try {
    return await sheets.readTab(title, cells);
  } catch (err) {
    if (err.status !== 400) throw err; // 400 = unknown tab name
    await sheets.addTab(title, header);
    return [header];
  }
}

const readUsers = async () => toObjects(await readOrCreateTab(USERS_TAB, USERS_HEADER));

// Keeps the header and the rows that pass `keep`, then rewrites the tab
async function rewriteUserTab(username, keep) {
  const [, ...rows] = await readOrCreateTab(username, USER_DATA_HEADER);
  await sheets.writeTab(username, [USER_DATA_HEADER, ...rows.filter(keep)]);
}

// ---------- HTTP helpers ----------
function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readBody(req) {
  // On Vercel the body is already parsed onto req.body
  if (req.body !== undefined) {
    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || "{}");
    return req.body || {};
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(httpError(413, "הבקשה גדולה מדי"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(httpError(400, "נתונים לא תקינים"));
      }
    });
    req.on("error", reject);
  });
}

const str = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");

// ---------- Routes ----------
async function route(req, res, method, routePath) {
  const key = `${method} ${routePath}`;

  if (key === "POST /signup") {
    const body = await readBody(req);
    const username = str(body.username, 100).trim().toLowerCase();
    const password = str(body.password, 200);
    if (!USERNAME_RE.test(username) || username === USERS_TAB) {
      return sendJson(res, 400, { error: "שם משתמש: 3–30 תווים, אותיות, ספרות, _ או - בלבד" });
    }
    if (password.length < MIN_PASSWORD) {
      return sendJson(res, 400, { error: `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD} תווים` });
    }
    if ((await readUsers()).some((u) => u.username === username)) {
      return sendJson(res, 409, { error: "שם המשתמש כבר תפוס" });
    }
    // Creating the tab doubles as a lock: it fails if the name is taken (tab names are unique, case-insensitive)
    try {
      await sheets.addTab(username, USER_DATA_HEADER);
    } catch (err) {
      if (err.status === 400) return sendJson(res, 409, { error: "שם המשתמש כבר תפוס" });
      throw err;
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const user = { username, salt, password_hash: hashPassword(password, salt), created_at: new Date().toISOString() };
    try {
      await sheets.appendRow(USERS_TAB, USERS_HEADER.map((h) => user[h]));
    } catch (err) {
      await sheets.deleteTab(username).catch(() => {}); // don't leave the name blocked by an orphan tab
      throw err;
    }
    setSessionCookie(req, res, username);
    return sendJson(res, 201, { username });
  }

  if (key === "POST /login") {
    const body = await readBody(req);
    const username = str(body.username, 100).trim().toLowerCase();
    const user = (await readUsers()).find((u) => u.username === username);
    if (!user || !verifyPassword(user, str(body.password, 200))) {
      return sendJson(res, 401, { error: "שם משתמש או סיסמה שגויים" });
    }
    setSessionCookie(req, res, username);
    return sendJson(res, 200, { username });
  }

  if (key === "POST /logout") {
    res.setHeader("Set-Cookie", `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag(req)}`);
    return sendJson(res, 200, {});
  }

  // Everything below requires a signed-in user
  const username = sessionUser(req);
  if (!username) return sendJson(res, 401, { error: "יש להתחבר" });

  if (key === "GET /me") return sendJson(res, 200, { username });

  if (key === "GET /data") {
    return sendJson(res, 200, { username, ...parseUserRows(await readOrCreateTab(username, USER_DATA_HEADER)) });
  }

  // Batch of word results: updates each word's existing row in place, appends rows for new words
  if (key === "POST /words") {
    const body = await readBody(req);
    const latest = new Map();
    for (const w of Array.isArray(body.words) ? body.words.slice(0, 1000) : []) {
      const en = str(w?.en, 200);
      if (en && STATUSES.includes(w.status)) latest.set(en, { en, he: str(w.he), status: w.status });
    }
    if (!latest.size) return sendJson(res, 400, { error: "נתונים לא תקינים" });

    const rows = await readOrCreateTab(username, USER_DATA_HEADER, "A:E"); // record_type … english
    const rowOf = new Map();
    rows.forEach((r, i) => r[0] === "word" && rowOf.set(r[4], i + 1));

    const date = new Date().toISOString();
    const updates = [];
    const appends = rows.length ? [] : [USER_DATA_HEADER]; // header was deleted by hand: restore it
    for (const w of latest.values()) {
      const values = wordRow({ ...w, date });
      const row = rowOf.get(w.en);
      if (row) updates.push({ title: username, cells: `A${row}:${LAST_COLUMN}${row}`, values: [values] });
      else appends.push(values);
    }
    if (updates.length) await sheets.batchWrite(updates);
    if (appends.length) await sheets.appendRows(username, appends);
    return sendJson(res, 200, {});
  }

  if (key === "POST /tests") {
    const body = await readBody(req);
    if (!Array.isArray(body.words) || body.words.length === 0) return sendJson(res, 400, { error: "אין מילים במבחן" });
    const words = body.words.slice(0, 5000).map((w) => {
      const word = { en: str(w?.en, 200), he: str(w?.he), ok: !!w?.ok };
      if (str(w?.chosen)) word.chosen = str(w.chosen); // the answer picked in a multiple-choice test
      return word;
    });
    const test = {
      id: `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
      date: str(body.date, 40) || new Date().toISOString(),
      unit: str(body.unit, 10) || "all",
      type: TEST_TYPES.includes(body.type) ? body.type : "flashcards",
      correct: words.filter((w) => w.ok).length,
      total: words.length,
      words,
    };
    // Reads the header row (and creates the tab if needed) plus columns A:C, so we can spot a repeat
    const [header = [], ...rows] = await readOrCreateTab(username, USER_DATA_HEADER, "A:C");

    // Tests are saved automatically when they finish, and the browser retries if a reload interrupted
    // the save — so a test with the same start time that's already stored is the same test: don't add it twice.
    const existing = rows.find((r) => r[0] === "test" && r[2] === test.date);
    if (existing) return sendJson(res, 200, { ...test, id: existing[1] });

    // Upgrade an older, shorter header so the new columns get parsed (the header was only read up to column C)
    const [fullHeader = []] = header[0] === USER_DATA_HEADER[0] ? await sheets.readTab(username, "1:1") : [[]];
    if (fullHeader[0] === USER_DATA_HEADER[0] && fullHeader.length < USER_DATA_HEADER.length) {
      await sheets.batchWrite([{ title: username, cells: `A1:${LAST_COLUMN}1`, values: [USER_DATA_HEADER] }]);
    }
    await sheets.appendRows(username, testRows(test));
    return sendJson(res, 201, test);
  }

  const testMatch = routePath.match(/^\/tests\/([\w-]+)$/);
  if (method === "DELETE" && testMatch) {
    await rewriteUserTab(username, (r) => r[1] !== testMatch[1]);
    return sendJson(res, 200, {});
  }

  return sendJson(res, 404, { error: "לא נמצא" });
}

// Entry point: handles any /api/* request. On Vercel, vercel.json rewrites /api/<path> to /api?route=<path>.
async function handleApi(req, res) {
  try {
    setup();
    const url = new URL(req.url, "http://localhost");
    const sub = url.searchParams.get("route") ?? url.pathname.replace(/^\/api\/?/, "");
    await route(req, res, req.method, `/${sub.replace(/^\/+|\/+$/g, "")}`);
  } catch (err) {
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: "נתונים לא תקינים" });
    if (err.status && err.status < 500 && !err.message.startsWith("Google")) {
      return sendJson(res, err.status, { error: err.message });
    }
    console.error(err);
    const sheetsProblem = err.message.startsWith("Google") || err.status;
    sendJson(res, 502, { error: sheetsProblem ? "אין גישה ל-Google Sheets כרגע, נסו שוב בעוד רגע" : "שגיאת שרת" });
  }
}

module.exports = { handleApi };
