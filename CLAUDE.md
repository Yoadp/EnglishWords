# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

English→Hebrew vocabulary flashcards for Hebrew-speaking university students (psychometric-style word list). Multi-user: sign up / sign in, and each user's progress and test results are stored in a Google Sheet. The UI is entirely in Hebrew (RTL); card fronts are English (LTR).

## Commands

```bash
node dev-server.js      # or: npm start — local dev server on http://localhost:3000 (override with PORT=...)
node --check dev-server.js backend.js sheets.js api/index.js public/main.js public/auth.js   # quick syntax check
```

There are no dependencies, no build step, no linter, and no test suite. The app must be run through a server — opening `public/index.html` directly from disk will not work (all data comes from `/api/*`). Running locally uses the user's real spreadsheet, so remove any test users you create (their tab and their row in `users`).

## Deployment (Vercel)

Deployed on Vercel with no build step: `vercel.json` serves `public/` as static output and rewrites `/api/<path>` to the single function `api/index.js` as `/api?route=<path>`. Env vars: `GOOGLE_CREDENTIALS` (required), plus optionally `SPREADSHEET_ID` (otherwise read from `config.json`) and `SESSION_SECRET`. Don't name files `app.js`, `index.js` or `server.js` outside `api/`: Vercel's zero-config detection treats such files as a Node server entrypoint and runs them as the backend. That happened once with `public/app.js` (a 500 error with `VOCABULARY is not defined`), which is why the files are `public/main.js` and `dev-server.js`, and why `vercel.json` sets `"framework": null`. The backend must stay **stateless** — nothing may be kept in memory between requests, and nothing may run after a response is sent (the function can be frozen at that point).

## Architecture

**`backend.js`** — all API logic (`handleApi`), shared by the Vercel function and the local `dev-server.js` (which just serves `public/` and forwards `/api/*`). It:
- Reads the route from the `route` query param (the Vercel rewrite) or from the path (local), and reads the body from `req.body` when Vercel has already parsed it, otherwise from the stream.
- Implements `signup`, `login`, `logout`, `GET me`, `GET data`, `POST words`, `POST tests`, `DELETE tests/:id`. There's deliberately no way to wipe the known/failed lists or delete all tests at once. Error messages returned to the client are in Hebrew.
- Uses signed-cookie sessions: `sid = base64url(username).expiresAt.HMAC`, valid for 30 days. The HMAC key is `SESSION_SECRET`, or else is derived from the service-account private key, so changing either signs everyone out. Logout only clears the cookie.
- Signs users up by creating their tab first — `addTab` fails if the name exists, which acts as a lock — then appending to `users`; the tab is deleted if that append fails.
- Saves word results in batches: `POST /api/words` takes `{words: [...]}`, reads only columns A:E to find existing `word` rows, updates them in place with one `values:batchUpdate`, and appends rows for new words. Saving a test appends its rows (`POST /api/tests` takes `type` and optional `words[].chosen`). It's idempotent: if a test with the same `date` (the client's start time) already exists, it returns that one's id instead of appending, because the client retries saves after a reload. Deleting a test rewrites the whole tab.

**Google Sheets storage.** `GOOGLE_CREDENTIALS` holds the service-account key JSON itself (not a path; base64-encoded JSON also works). If it's unset, `loadCredentials` in `sheets.js` falls back to the local `credentials.json`, which is in `.gitignore`/`.vercelignore` and must never be committed or deployed. The sheet must be shared as Editor with the service account's `client_email`. **`sheets.js`** is a dependency-free REST client: it signs an RS256 JWT with Node `crypto`, retries 429/5xx with a short backoff, and `writeTab` replaces a whole tab (write the rows first, then clear leftover rows below). The Sheets API quota (roughly 60 reads and 60 writes per minute for the one service account, shared by all users) is the main scaling limit — keep API calls per request minimal.

Sheet layout:
- `users` tab — `username,salt,password_hash,created_at` (scrypt hash). Usernames are lowercased, validated by `USERNAME_RE`, and double as tab names (`users` is reserved).
- One tab per user, named after the username, with columns `record_type,test_id,date,unit,english,hebrew,status,correct,total,test_type,chosen` (`USER_DATA_HEADER`; `LAST_COLUMN` must match its last column, because word rows are rewritten in place across `A:LAST_COLUMN`). `record_type` is `word` (latest `succeeded`/`failed` status per English word; one row per word), `test` (test summary; `test_type` is `flashcards` or `mc`, empty for old tests), or `test_word` (each word in a test, sharing its `test_id`; `chosen` is the wrong answer picked in a multiple-choice test). Only `word` rows determine known/failed. A missing user tab is recreated automatically. `test_type`/`chosen` were added later: older tabs have a 9-column header, which `POST /api/tests` upgrades in place before appending (rows are parsed by each tab's own header row).

`migrate-csv-to-sheets.js` imported the old CSV storage and is kept only for reference (its `data/` source has been deleted).

**`public/vocabulary.js`** — generated data: `const VOCABULARY = [{en, he: [meanings...], units: [n...]}]` (~3,700 unique words, units 1–10 from the source book), extracted from `english_words.pdf` (pages 17+; pages 1–16 are an alphabetical index with unit numbers). Duplicate English entries were merged into one entry with multiple Hebrew meanings. The extraction script is not in the repo; it used `pypdf`, and needed fixes for bidi artifacts in the Hebrew (mirrored parentheses, dropped trailing hyphens such as `ש-`, `…` moved to the wrong side). The English `en` string is the word's identity everywhere (client state, API, sheet).

**`public/main.js`** — the main app (single IIFE, no framework). Key ideas:
- `init()` fetches `/api/data`, then builds `state`. The server is the source of truth for `state.known`, `state.failed` (arrays of `en`) and `history` (saved tests). Practice/test *position* (queues, index, current tab) lives in `sessionStorage` under `flashcards-session:<username>`.
- **Units are never shown to the user**: there's no unit selector, badge or label anywhere, and practice and tests always use the whole word list. `units` in `vocabulary.js` is only used internally, so multiple-choice wrong answers come from a similar part of the list. The `unit` column in the sheet is a leftover; new tests leave it as `all`.
- Three tabs: practice (decks all/known/failed), test (setup → running), and saved results (history). When a test finishes (or is ended early), `finishTest()` puts the test back on its setup screen, adds the result to `state.unsaved`, switches to the history tab with that result open (`state.openResult`), and saves it automatically (`saveResults()`). Unsaved results stay in the session and are retried with a button and on the next load, so a failed save never loses a test. The history tab shows either the list of tests (`renderHistory`) or one test's results (`renderResult`: CSV download, retest on the missed words as the same test type, and delete); clicking the tab always shows the list.
- Practice decks are built by `practiceQueue()`. In the "all" deck, known words are kept out of the first `KNOWN_FREE_START` (50) cards and shuffled randomly into the rest; the known/failed decks are plain shuffles. A brand-new session rebuilds (and saves) its first deck in `init()` once the lists are loaded, because `freshState()` runs before they are.
- Practice only: a card answered "didn't know" is re-inserted 20–30 cards ahead (`requeueSoon`, `REQUEUE_MIN`/`REQUEUE_MAX`), so the queue can grow while practising. A test's queue is fixed: each word is asked once.
- A test draws from `testPool()`: `state.test.source` is `"all"` (every word) or `"failed"` (the user's failed words). The source is not sent to the server; saved tests store the test type.
- `state.test.type` is `"flashcards"` or `"mc"` (multiple choice: English word → pick the Hebrew meaning out of 4). An `mc` test runs in its own `#mc` section (`renderMc`, `chooseOption`, `nextQuestion`; a "Next" button appears after answering) instead of the flashcard. Its options are built up front by `buildOptions` — 3 wrong answers from other words, preferring the same (hidden) unit and never sharing a meaning with the correct one — and stored in `state.test.options` so a reload shows the same choices. **Multiple-choice answers never call `queueWord` and never change known/failed**: the lists are meant to come from flashcards only. Results record `type`, and `chosen` for each wrong answer.
- One shared flashcard DOM (`#study`) serves both practice and a running flashcard test; `active()` returns whichever session object is current (never an `mc` test), and `answer()` updates it plus the known/failed lists.
- Word results are batched on the client (`queueWord` → `flushWords`, which runs `WORD_FLUSH_MS` after the last answer; batches are serialized through `flushChain`, and failed batches are re-queued and retried). They're also sent with `fetch(..., {keepalive: true})` on `visibilitychange`/`pagehide`. Pending and not-yet-confirmed words are mirrored in sessionStorage (`<session key>:pending-words`). `restorePendingWords()` re-applies them on load and sends them again; this is safe because saving the same status twice changes nothing, and without it a reload right after answering would show stale lists. Logout waits for pending words to be sent.
- Rendering is imperative: every change calls `render()`, which re-renders the active tab. Saves go through `api()` / `sync()`; failures show the `#sync-error` banner, and a 401 redirects to the login page.
- Keyboard: Space/Enter flips, ArrowLeft = knew, ArrowRight = didn't know (matches button positions in RTL). In an `mc` test: 1–4 picks an answer, Enter/Space goes to the next question.

**`public/auth.js`** — shared by `login.html` and `signup.html`; the form's `data-mode` selects the endpoint. Redirects between the app and the login page happen client-side: `main.js` goes to login on a 401, and `auth.js` goes to the app if `/api/me` succeeds.

**`public/styles.css`** — theme colors are CSS variables on `:root`, with a dark-mode override. `[hidden] { display: none !important; }` is deliberate: several elements set `display: flex`, which would otherwise override the `hidden` attribute that the JS relies on for showing and hiding views.
