# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

English→Hebrew vocabulary flashcards for Hebrew-speaking university students (psychometric-style word list). Multi-user: sign up / sign in, and each user's progress and test results are stored in a Google Sheet. The UI is entirely in Hebrew (RTL); card fronts are English (LTR).

## Commands

```bash
node server.js          # or: npm start — serves on http://localhost:3000 (override with PORT=...)
node --check server.js sheets.js public/app.js public/auth.js   # quick syntax check
node migrate-csv-to-sheets.js   # one-time import of the old CSV storage (data/) into the sheet; skips existing users
```

There are no dependencies, no build step, no linter, and no test suite. The app must be run through the server — opening `public/index.html` directly from disk will not work (all data comes from `/api/*`). The server exits at startup if it can't open the sheet.

Stop the server with Ctrl+C / SIGTERM, not `kill -9`: the shutdown handler flushes unsaved changes to the sheet. Running the server against the real sheet writes to the user's real spreadsheet, so remove any test users you create (their tab and their row in `users`).

## Architecture

**Google Sheets storage.** `config.json` holds `spreadsheetId` (a bare ID or a full URL) and `credentialsFile` (the service-account key, `credentials.json`); these can be overridden with the env vars `SPREADSHEET_ID` / `GOOGLE_CREDENTIALS`. The sheet must be shared as Editor with the service account's `client_email`. **`sheets.js`** is a dependency-free REST client: it signs an RS256 JWT with Node `crypto`, exchanges it for an access token, and retries on 429/5xx. `writeTab` replaces a whole tab (write the rows first, then clear leftover rows below).

Sheet layout:
- `users` tab — `username,salt,password_hash,created_at` (scrypt hash). Usernames are lowercased, validated by `USERNAME_RE`, and double as tab names (`users` is reserved, and names are also checked case-insensitively against existing tabs).
- One tab per user, named after the username, with columns `record_type,test_id,date,unit,english,hebrew,status,correct,total`. `record_type` is `word` (latest `succeeded`/`failed` status per English word), `test` (test summary), or `test_word` (each word in a test, written after its `test` row). A missing user tab is recreated automatically.

**`server.js`** — single-file Node HTTP server. It:
- Loads all users at startup (creating the `users` tab if needed). Each user's tab is read on first use into an in-memory `cache`, which is the source of truth while the server runs. Changes mark the entry dirty and are flushed by rewriting the whole tab (`flush`; flushes for the same user never overlap). Word answers are debounced (`FLUSH_DELAY_MS`) to stay under the Sheets write quota; saved tests flush immediately and are rolled back if the write fails. Failed flushes are retried, and `POST /api/words` returns 502 while a user's last flush is failing so the client shows its error banner. Because the cache is only loaded once, edits made by hand in the sheet while the server runs may be overwritten.
- Serves static files from `public/` only (never `config.json`, `credentials.json`, `data/` or server code; path traversal is guarded). `/` and `/index.html` redirect to `/login.html` when signed out; login/signup redirect to `/` when signed in.
- Implements a JSON API under `/api/`: `signup`, `login`, `logout`, `GET data`, `POST/DELETE words`, `POST/DELETE tests`, `DELETE tests/:id`. Error messages returned to the client are in Hebrew.
- Sessions are an in-memory `Map` keyed by an `sid` HttpOnly cookie, so restarting the server signs everyone out (data is unaffected).

The old CSV storage (`data/`) has been migrated and deleted; `migrate-csv-to-sheets.js` is kept only for reference.

**`public/vocabulary.js`** — generated data: `const VOCABULARY = [{en, he: [meanings...], units: [n...]}]` (~3,700 unique words, units 1–10), extracted from `english_words.pdf` (pages 17+; pages 1–16 are an alphabetical index with unit numbers). Duplicate English entries were merged into one entry with multiple Hebrew meanings. The extraction script is not in the repo; it used `pypdf`, and needed fixes for bidi artifacts in the Hebrew (mirrored parentheses, dropped trailing hyphens such as `ש-`, `…` moved to the wrong side). The English `en` string is the word's identity everywhere (client state, API, CSV).

**`public/app.js`** — the main app (single IIFE, no framework). Key ideas:
- `init()` fetches `/api/data`, then builds `state`. The server is the source of truth for `state.known`, `state.failed` (arrays of `en`) and `history` (saved tests). Practice/test *position* (queues, index, current tab) lives in `sessionStorage` under `flashcards-session:<username>`.
- Three tabs: practice (decks all/known/failed, filtered by unit), test (setup → running → done), and saved results (history).
- One shared flashcard DOM (`#study`) serves both practice and a running test; `active()` returns whichever session object is current, and `answer()` updates it plus the known/failed lists and POSTs the word status.
- Rendering is imperative: every change calls `render()`, which re-renders the active tab. Saves go through `api()` / `sync()`; failures show the `#sync-error` banner, and a 401 redirects to the login page.
- Keyboard: Space/Enter flips, ArrowLeft = knew, ArrowRight = didn't know (matches button positions in RTL).

**`public/auth.js`** — shared by `login.html` and `signup.html`; the form's `data-mode` selects the endpoint.

**`public/styles.css`** — theme colors are CSS variables on `:root`, with a dark-mode override. `[hidden] { display: none !important; }` is deliberate: several elements set `display: flex`, which would otherwise override the `hidden` attribute that the JS relies on for showing and hiding views.
