// One-time migration: copies accounts and progress from the old CSV storage (./data) into the Google Sheet.
// Run while the server is stopped (the server caches users at startup): node migrate-csv-to-sheets.js
// Users that already exist in the sheet are skipped, so it's safe to run more than once.
const fs = require("fs");
const path = require("path");
const { SheetsClient, parseSpreadsheetId } = require("./sheets");

const DATA_DIR = path.join(__dirname, "data");
const USERS_HEADER = ["username", "salt", "password_hash", "created_at"];
const USER_DATA_HEADER = ["record_type", "test_id", "date", "unit", "english", "hebrew", "status", "correct", "total"];

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some(Boolean));
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const sheets = new SheetsClient({
    credentialsFile: path.resolve(__dirname, config.credentialsFile || "credentials.json"),
    spreadsheetId: parseSpreadsheetId(config.spreadsheetId),
  });

  const { tabs } = await sheets.listTabs();
  if (!tabs.some((t) => t.title === "users")) await sheets.addTab("users", USERS_HEADER);
  const existing = new Set(parseCsvRowsToNames(await sheets.readTab("users")));

  const [header, ...users] = parseCsv(fs.readFileSync(path.join(DATA_DIR, "users.csv"), "utf8"));
  for (const values of users) {
    const user = Object.fromEntries(header.map((h, i) => [h, values[i] ?? ""]));
    if (existing.has(user.username)) {
      console.log(`skip ${user.username} (already in the sheet)`);
      continue;
    }
    const file = path.join(DATA_DIR, "users", `${user.username}.csv`);
    const rows = fs.existsSync(file) ? parseCsv(fs.readFileSync(file, "utf8")).slice(1) : [];

    if (!tabs.some((t) => t.title.toLowerCase() === user.username)) await sheets.addTab(user.username, USER_DATA_HEADER);
    // Numeric columns (correct, total) are written as numbers
    const typed = rows.map((r) => r.map((v, i) => (["correct", "total"].includes(USER_DATA_HEADER[i]) && v !== "" ? Number(v) : v)));
    await sheets.writeTab(user.username, [USER_DATA_HEADER, ...typed]);
    await sheets.appendRow("users", USERS_HEADER.map((h) => user[h]));
    console.log(`migrated ${user.username} (${rows.length} rows)`);
  }
}

function parseCsvRowsToNames(rows) {
  const [header, ...rest] = rows;
  const i = header ? header.indexOf("username") : -1;
  return i < 0 ? [] : rest.map((r) => r[i]);
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
