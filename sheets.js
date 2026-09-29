// Minimal Google Sheets client for a service account (no external dependencies).
// Auth: signs a JWT with the service account's private key and exchanges it for an access token.
const crypto = require("crypto");
const fs = require("fs");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_RETRIES = 3; // backoff 1s + 2s + 4s — keeps a request well inside a serverless function's time limit

const base64url = (data) => Buffer.from(data).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sheet titles must be quoted in A1 ranges, with ' escaped as ''
const a1 = (title, cells = "") => `'${title.replace(/'/g, "''")}'${cells ? `!${cells}` : ""}`;
const range = (title, cells) => encodeURIComponent(a1(title, cells));

// Service-account credentials come from the GOOGLE_CREDENTIALS env var (the key JSON itself, or the JSON
// base64-encoded) — used in deployment, e.g. on Vercel. Without it, the local key file is read instead.
function loadCredentials({ envValue = process.env.GOOGLE_CREDENTIALS, file } = {}) {
  let credentials;
  const raw = (envValue || "").trim();
  if (raw) {
    const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    try {
      credentials = JSON.parse(json);
    } catch {
      throw new Error("GOOGLE_CREDENTIALS must contain the service account key JSON (or that JSON base64-encoded)");
    }
  } else if (file && fs.existsSync(file)) {
    credentials = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    throw new Error("No Google credentials: set the GOOGLE_CREDENTIALS env var or add the key file (credentials.json)");
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google credentials are missing client_email or private_key");
  }
  // Env var editors sometimes keep the key's line breaks as a literal "\n"
  credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  credentials.token_uri ||= "https://oauth2.googleapis.com/token";
  return credentials;
}

class SheetsClient {
  constructor({ credentials, spreadsheetId }) {
    this.credentials = credentials;
    this.spreadsheetId = spreadsheetId;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  get serviceAccountEmail() {
    return this.credentials.client_email;
  }

  async token() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;

    const { client_email, private_key, token_uri } = this.credentials;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
      JSON.stringify({ iss: client_email, scope: SCOPE, aud: token_uri, iat: now, exp: now + 3600 })
    )}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), private_key).toString("base64url");

    const res = await fetch(token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google auth failed: ${body.error_description || body.error || res.status}`);

    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  async request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}/${this.spreadsheetId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res.json();

      // Rate limits and transient server errors: back off and retry
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const err = await res.json().catch(() => ({}));
      const error = new Error(`Google Sheets ${res.status}: ${err.error?.message || res.statusText}`);
      error.status = res.status;
      throw error;
    }
  }

  async listTabs() {
    const data = await this.request("GET", "?fields=properties.title,sheets.properties(sheetId,title)");
    return { title: data.properties.title, tabs: data.sheets.map((s) => s.properties) };
  }

  // Creates a tab with a bold, frozen header row
  async addTab(title, header) {
    const reply = await this.request("POST", ":batchUpdate", {
      requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }],
    });
    const sheetId = reply.replies[0].addSheet.properties.sheetId;
    await this.writeTab(title, [header]);
    await this.request("POST", ":batchUpdate", {
      requests: [{
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      }],
    });
  }

  async deleteTab(title) {
    const { tabs } = await this.listTabs();
    const tab = tabs.find((t) => t.title === title);
    if (tab) await this.request("POST", ":batchUpdate", { requests: [{ deleteSheet: { sheetId: tab.sheetId } }] });
  }

  // Reads a whole tab, or only some columns/cells of it (e.g. cells = "A:E")
  async readTab(title, cells) {
    const data = await this.request("GET", `/values/${range(title, cells)}`);
    return data.values || [];
  }

  // Writes several ranges of one or more tabs in a single request: [{ title, cells: "A5:I5", values: [[...]] }]
  async batchWrite(updates) {
    await this.request("POST", "/values:batchUpdate", {
      valueInputOption: "RAW",
      data: updates.map((u) => ({ range: a1(u.title, u.cells), values: u.values })),
    });
  }

  // Replaces the whole tab content: write the new rows first, then clear anything left below them,
  // so a failure part-way never leaves the tab empty.
  async writeTab(title, rows) {
    await this.request("PUT", `/values/${range(title, "A1")}?valueInputOption=RAW`, { values: rows });
    await this.request("POST", `/values/${range(title, `A${rows.length + 1}:Z`)}:clear`, {});
  }

  async appendRows(title, rows) {
    await this.request("POST", `/values/${range(title, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: rows,
    });
  }

  async appendRow(title, row) {
    await this.appendRows(title, [row]);
  }
}

// Accepts either a bare spreadsheet ID or a full Google Sheets URL
function parseSpreadsheetId(value) {
  const s = String(value || "").trim();
  return s.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] || s;
}

module.exports = { SheetsClient, loadCredentials, parseSpreadsheetId };
