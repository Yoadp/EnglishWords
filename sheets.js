// Minimal Google Sheets client for a service account (no external dependencies).
// Auth: signs a JWT with the service account's private key and exchanges it for an access token.
const crypto = require("crypto");
const fs = require("fs");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
const MAX_RETRIES = 4;

const base64url = (data) => Buffer.from(data).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sheet titles must be quoted in A1 ranges, with ' escaped as ''
const range = (title, cells = "") => encodeURIComponent(`'${title.replace(/'/g, "''")}'${cells ? `!${cells}` : ""}`);

class SheetsClient {
  constructor({ credentialsFile, spreadsheetId }) {
    this.credentials = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
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

  async readTab(title) {
    const data = await this.request("GET", `/values/${range(title)}`);
    return data.values || [];
  }

  // Replaces the whole tab content: write the new rows first, then clear anything left below them,
  // so a failure part-way never leaves the tab empty.
  async writeTab(title, rows) {
    await this.request("PUT", `/values/${range(title, "A1")}?valueInputOption=RAW`, { values: rows });
    await this.request("POST", `/values/${range(title, `A${rows.length + 1}:Z`)}:clear`, {});
  }

  async appendRow(title, row) {
    await this.request("POST", `/values/${range(title, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: [row],
    });
  }
}

// Accepts either a bare spreadsheet ID or a full Google Sheets URL
function parseSpreadsheetId(value) {
  const s = String(value || "").trim();
  return s.match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] || s;
}

module.exports = { SheetsClient, parseSpreadsheetId };
