(() => {
  const UNITS = [...new Set(VOCABULARY.flatMap((w) => w.units))].sort((a, b) => a - b);
  const byWord = new Map(VOCABULARY.map((w) => [w.en, w]));

  const $ = (id) => document.getElementById(id);
  const card = $("card");
  const cardInner = card.querySelector(".card-inner");

  // ---------- Server ----------
  // Word statuses and test results live in the user's CSV file on the server.
  // The current practice/test position is kept per tab in sessionStorage.
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = "/login.html";
      throw new Error("unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function showSyncError(err) {
    if (err.message === "unauthorized") return;
    const box = $("sync-error");
    box.textContent = `השמירה נכשלה (${err.message === "Failed to fetch" ? "אין חיבור לשרת" : err.message}). ודאו שהשרת פועל.`;
    box.hidden = false;
  }

  // Fire-and-forget save that surfaces failures in the banner
  const sync = (promise) => promise.then(() => ($("sync-error").hidden = true), showSyncError);

  // Word results are batched and sent together a few seconds after the last answer, to stay well under
  // the Google Sheets API quota. They're also sent immediately when the tab is hidden or closed.
  const WORD_FLUSH_MS = 4000;
  const WORD_RETRY_MS = 15000;
  const pendingWords = new Map(); // en -> { en, he, status }; a newer answer replaces an older one
  // Sent while the page was closing/hidden but not confirmed yet (en -> word). Kept in sessionStorage together
  // with pendingWords, so a reload re-applies them before the server has caught up — and sends them again,
  // which is harmless (saving the same status twice changes nothing).
  const unconfirmed = new Map();
  let flushTimer = null;
  let flushChain = Promise.resolve(); // batches are sent one at a time so they arrive in order

  const pendingKey = () => `${sessionKey}:pending-words`;

  function persistPending() {
    if (!sessionKey) return;
    try {
      sessionStorage.setItem(pendingKey(), JSON.stringify([...unconfirmed.values(), ...pendingWords.values()]));
    } catch {
      // Storage unavailable — pending words still live in memory
    }
  }

  function loadPendingStored() {
    try {
      return JSON.parse(sessionStorage.getItem(pendingKey())) || [];
    } catch {
      return [];
    }
  }

  function queueWord(en, status) {
    unconfirmed.delete(en); // this newer answer supersedes anything sent earlier
    pendingWords.set(en, { en, he: byWord.get(en).he.join("; "), status });
    persistPending();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushWords, WORD_FLUSH_MS);
  }

  function takePending() {
    clearTimeout(flushTimer);
    const batch = [...pendingWords.values()];
    pendingWords.clear();
    return batch;
  }

  // ---------- Daily answer counter (for the progress tab) ----------
  // Every flashcard answer (practice or flashcard test) adds 1 to today's counter; counters travel with the word
  // batches and are added to a "day" row in the sheet. Unlike words they're never replayed after a reload, so a
  // counter is never added twice (the price: answers sent while a page closes offline may go uncounted).
  const pendingDays = new Map(); // local date -> { date, answered, knew }

  const localDay = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function addDayCounts(target, { date, answered, knew }) {
    const entry = target.get(date) || { date, answered: 0, knew: 0 };
    entry.answered += answered;
    entry.knew += knew;
    target.set(date, entry);
  }

  function countAnswer(success) {
    const today = { date: localDay(), answered: 1, knew: success ? 1 : 0 };
    addDayCounts(pendingDays, today);
    // Update the local view right away
    const days = new Map((state.days || []).map((d) => [d.date, { ...d }]));
    addDayCounts(days, today);
    state.days = [...days.values()];
  }

  function takeDays() {
    const days = [...pendingDays.values()];
    pendingDays.clear();
    return days;
  }

  // Sends pending word results; resolves once they're saved (never rejects — failures are retried)
  function flushWords() {
    flushChain = flushChain.then(async () => {
      const batch = takePending();
      const days = takeDays();
      if (!batch.length && !days.length) return;
      try {
        await api("POST", "/api/words", { words: batch, days });
        $("sync-error").hidden = true;
      } catch (err) {
        // Put the batch back, unless the word was answered again in the meantime
        batch.forEach((w) => pendingWords.has(w.en) || pendingWords.set(w.en, w));
        days.forEach((d) => addDayCounts(pendingDays, d));
        showSyncError(err);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushWords, WORD_RETRY_MS);
      }
      persistPending();
    });
    return flushChain;
  }

  // keepalive lets the request finish even if the page is being closed
  function sendPendingOnExit() {
    const batch = takePending();
    const days = takeDays();
    if (!batch.length && !days.length) return;
    batch.forEach((w) => unconfirmed.set(w.en, w));
    persistPending();
    fetch("/api/words", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: batch, days }),
    }).then(
      (res) => {
        if (!res.ok) return;
        batch.forEach((w) => unconfirmed.get(w.en) === w && unconfirmed.delete(w.en));
        persistPending();
      },
      () => {} // page closed or offline: the words stay stored and are re-sent on the next load
    );
  }

  // Re-applies answers that may not have reached the server yet (e.g. right after a reload) and re-sends them
  function restorePendingWords() {
    for (const w of loadPendingStored()) {
      if (!byWord.has(w.en)) continue;
      state.known = state.known.filter((en) => en !== w.en);
      state.failed = state.failed.filter((en) => en !== w.en);
      (w.status === "succeeded" ? state.known : state.failed).push(w.en);
      pendingWords.set(w.en, w);
    }
    if (pendingWords.size) flushWords();
  }

  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && sendPendingOnExit());
  window.addEventListener("pagehide", sendPendingOnExit);

  let sessionKey = "";

  function loadSession() {
    try {
      return JSON.parse(sessionStorage.getItem(sessionKey));
    } catch {
      return null;
    }
  }

  function saveState() {
    try {
      sessionStorage.setItem(sessionKey, JSON.stringify(state));
    } catch {
      // Storage unavailable (e.g. private mode) — app keeps working in memory
    }
  }

  function freshState() {
    return {
      tab: "practice",
      known: [],
      failed: [],
      practice: { deck: "all", unit: "all", queue: shuffle(pool("all")), index: 0, round: { known: 0, failed: 0 } },
      test: {
        phase: "setup", type: "flashcards", source: "all", unit: "all", size: 20,
        queue: [], index: 0, answers: {}, options: {}, chosen: {}, startedAt: null,
      },
      // Finished tests whose save hasn't succeeded yet (retried automatically); and the result open in history
      unsaved: [],
      openResult: null,
    };
  }

  let state = null;
  let history = [];

  // ---------- Helpers ----------
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function inUnit(en, unit) {
    const w = byWord.get(en);
    return !!w && (unit === "all" || w.units.includes(Number(unit)));
  }

  function pool(unit) {
    return VOCABULARY.filter((w) => inUnit(w.en, unit)).map((w) => w.en);
  }

  function deckWords(deck, unit = "all") {
    if (deck === "known") return state.known.filter((en) => inUnit(en, unit));
    if (deck === "failed") return state.failed.filter((en) => inUnit(en, unit));
    return pool(unit);
  }

  const unitLabel = (unit) => (unit === "all" ? "כל היחידות" : `יחידה ${unit}`);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => (k === "class" ? (node.className = v) : node.setAttribute(k, v)));
    children.flat().forEach((c) => node.append(c));
    return node;
  }

  function downloadCsv(filename, rows) {
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    // BOM so Excel shows Hebrew correctly
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  const formatDate = (iso) =>
    new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });

  // ---------- Active flashcard session ----------
  const isMcTest = () => state.test.type === "mc";
  const mcRunning = () => state.tab === "test" && state.test.phase === "running" && isMcTest();

  // The flashcard session currently on screen (practice, or a flashcard test); multiple-choice tests use #mc instead
  function active() {
    if (state.tab === "practice") return state.practice;
    if (state.tab === "test" && state.test.phase === "running" && !isMcTest()) return state.test;
    return null;
  }

  function flip() {
    if (active()) card.classList.toggle("flipped");
  }

  // Unflip instantly so the next card's translation isn't revealed mid-animation
  function resetFlip() {
    cardInner.style.transition = "none";
    card.classList.remove("flipped");
    void cardInner.offsetWidth;
    cardInner.style.transition = "";
  }

  function answer(success) {
    const s = active();
    const current = s && s.queue[s.index];
    if (!current) return;

    state.known = state.known.filter((w) => w !== current);
    state.failed = state.failed.filter((w) => w !== current);
    (success ? state.known : state.failed).push(current);
    queueWord(current, success ? "succeeded" : "failed");
    countAnswer(success);

    if (s === state.practice) {
      s.round[success ? "known" : "failed"]++;
    } else {
      s.answers[current] = success;
    }
    s.index++;
    if (s === state.practice && !success) storeForNextSession(current);
    if (s === state.test && s.index >= s.queue.length) return finishTest();

    saveState();
    resetFlip();
    render();
  }

  // ---------- Practice ----------
  // A word the user didn't know is stored and will come back near the start of the next session.
  const REQUEUE_MIN = 20;
  const REQUEUE_MAX = 30;

  const nextSessionKey = () => sessionKey.replace("flashcards-session:", "flashcards-next-session-failed:");

  function storeForNextSession(en) {
    try {
      const stored = new Set(JSON.parse(localStorage.getItem(nextSessionKey()) || "[]"));
      stored.add(en);
      localStorage.setItem(nextSessionKey(), JSON.stringify([...stored]));
    } catch {}
  }

  // In the "all words" deck, known words are kept out of the first KNOWN_FREE_START cards and shuffled
  // randomly into the rest, so a session starts with words still worth practising.
  const KNOWN_FREE_START = 50;

  function practiceQueue(deck, unit) {
    const words = deckWords(deck, unit);
    if (deck !== "all") return shuffle(words);
    const known = new Set(state.known);
    const others = shuffle(words.filter((en) => !known.has(en)));
    const head = others.slice(0, KNOWN_FREE_START);
    return [...head, ...shuffle([...others.slice(KNOWN_FREE_START), ...words.filter((en) => known.has(en))])];
  }

  function startPractice(deck, unit = state.practice.unit) {
    state.practice = { deck, unit, queue: practiceQueue(deck, unit), index: 0, round: { known: 0, failed: 0 } };
    saveState();
    resetFlip();
    render();
  }

  // ---------- Test ----------
  const sourceLabel = (source) => (source === "failed" ? "מילים שלא ידעתי" : "כל המילים");

  // Words a new test can draw from: every word, or only the ones the user didn't know
  function testPool() {
    const { source = "all", unit } = state.test;
    return source === "failed" ? deckWords("failed", unit) : pool(unit);
  }

  // Saved tests from before test types existed have no type
  const typeLabel = (type) => ({ mc: "אמריקאי", flashcards: "כרטיסיות" })[type] || "";

  const testLabel = () =>
    [isMcTest() && typeLabel("mc"), state.test.source === "failed" && sourceLabel("failed"), unitLabel(state.test.unit)]
      .filter(Boolean)
      .join(" · ");

  function startTest(words) {
    const queue = shuffle(words);
    state.test = {
      ...state.test,
      phase: "running",
      queue,
      index: 0,
      answers: {},
      chosen: {},
      // Built up front and kept in the session, so a page reload shows the same answers
      options: isMcTest() ? Object.fromEntries(queue.map((en) => [en, buildOptions(en)])) : {},
      startedAt: new Date().toISOString(),
    };
    saveState();
    resetFlip();
    render();
  }

  function testResult() {
    const t = state.test;
    const mc = isMcTest();
    const words = t.queue.filter((en) => en in t.answers).map((en) => {
      const word = { en, he: byWord.get(en)?.he.join("; ") ?? "", ok: t.answers[en] };
      if (mc && !word.ok && t.chosen?.[en]) word.chosen = t.chosen[en];
      return word;
    });
    return {
      id: t.startedAt,
      date: t.startedAt,
      unit: t.unit,
      type: t.type || "flashcards",
      total: words.length,
      correct: words.filter((w) => w.ok).length,
      words,
    };
  }

  // A finished test (or one ended early) is saved right away and its results open in the history tab.
  // The test tab goes back to the setup screen.
  function finishTest() {
    const r = testResult();
    state.test.phase = "setup";
    if (r.total) {
      state.unsaved.push(r);
      state.tab = "history";
      state.openResult = r.id;
    }
    saveState();
    resetFlip();
    render();
    window.scrollTo(0, 0);
    saveResults();
  }

  // Saves finished tests one by one. A failed save keeps the result (in the session) for a retry.
  let savingResults = false;

  async function saveResults() {
    if (savingResults) return;
    savingResults = true;
    render();
    try {
      while (state.unsaved.length) {
        const r = state.unsaved[0];
        const saved = await api("POST", "/api/tests", { date: r.date, unit: r.unit, type: r.type, words: r.words });
        state.unsaved.shift();
        if (!history.some((h) => h.id === saved.id)) history.push(saved);
        if (state.openResult === r.id) state.openResult = saved.id;
        saveState();
      }
      $("sync-error").hidden = true;
    } catch (err) {
      showSyncError(err);
    }
    savingResults = false;
    render();
  }

  function resultRows(results) {
    const rows = [["תאריך", "סוג מבחן", "יחידה", "English", "עברית", "תוצאה", "התשובה שנבחרה"]];
    results.forEach((r) =>
      r.words.forEach((w) =>
        rows.push([
          formatDate(r.date), typeLabel(r.type), unitLabel(r.unit), w.en, w.he, w.ok ? "ידעתי" : "לא ידעתי", w.chosen || "",
        ])
      )
    );
    return rows;
  }

  // ---------- Multiple-choice ("American") tests ----------
  // Never changes the known/failed lists — those come only from flashcards.
  const meaningsText = (w) => w.he.join("; ");

  // The correct meaning plus 3 wrong ones, using each word's topic and part of speech (vocabulary.js):
  //   - 2 SIMILAR: same topic and same part of speech (fallback: same topic, any part of speech);
  //   - 1 DIFFERENT: another topic, same part of speech — so it's unrelated in meaning, but grammar doesn't give it away.
  // A wrong answer never shares an individual meaning with the correct one (e.g. "לזנוח" vs "לנטוש, לזנוח"),
  // no two options are the same, and the "different" one never repeats a Hebrew text used in the word's own topic.
  const meaningParts = (w) => new Set(w.he.flatMap((m) => m.split(/[,;/]/)).map((s) => s.trim()).filter(Boolean));
  const groupBy = (key) => {
    const groups = new Map();
    for (const w of VOCABULARY) {
      if (!groups.has(w[key])) groups.set(w[key], []);
      groups.get(w[key]).push(w);
    }
    return groups;
  };
  const byTopic = groupBy("topic");
  const byPos = groupBy("pos");
  const topicTexts = new Map([...byTopic].map(([topic, words]) => [topic, new Set(words.map(meaningsText))]));

  function buildOptions(en) {
    const word = byWord.get(en);
    const own = meaningParts(word);
    const options = [meaningsText(word)];
    const usable = (c) => c.en !== en && !options.includes(meaningsText(c)) && ![...meaningParts(c)].some((m) => own.has(m));
    // Adds up to `count` usable candidates (in random order); returns how many are still missing
    const pick = (candidates, count) => {
      for (const c of shuffle(candidates)) {
        if (!count) break;
        if (usable(c)) {
          options.push(meaningsText(c));
          count--;
        }
      }
      return count;
    };

    const sameTopic = byTopic.get(word.topic);
    let similar = pick(sameTopic.filter((w) => w.pos === word.pos), 2);
    if (similar) similar = pick(sameTopic, similar);

    const unrelated = (w) => w.topic !== word.topic && !topicTexts.get(word.topic).has(meaningsText(w));
    if (pick(byPos.get(word.pos).filter(unrelated), 1)) pick(VOCABULARY.filter(unrelated), 1);

    if (similar) pick(byPos.get(word.pos), similar); // never needed with the current word list, but keeps 4 options
    return shuffle(options);
  }

  function chooseOption(i) {
    const t = state.test;
    const en = t.queue[t.index];
    const text = t.options[en]?.[i];
    if (!en || en in t.answers || text === undefined) return;
    t.answers[en] = text === meaningsText(byWord.get(en));
    t.chosen[en] = text;
    saveState();
    render();
  }

  function nextQuestion() {
    const t = state.test;
    const en = t.queue[t.index];
    if (!en || !(en in t.answers)) return; // answer first
    t.index++;
    if (t.index >= t.queue.length) return finishTest();
    saveState();
    render();
  }

  function renderMc() {
    const t = state.test;
    const en = t.queue[t.index];
    const w = byWord.get(en);
    if (!t.options[en]) {
      t.options[en] = buildOptions(en);
      saveState();
    }

    const total = t.queue.length;
    $("mc-progress-fill").style.width = `${(t.index / total) * 100}%`;
    $("mc-progress-text").textContent = `${t.index} / ${total}`;
    $("mc-word").textContent = w.en;
    $("mc-unit-badge").textContent = w.units.map((u) => `Unit ${u}`).join(" · ");

    const correct = meaningsText(w);
    const answered = en in t.answers;
    $("mc-options").replaceChildren(
      ...t.options[en].map((text, i) => {
        const button = el("button", { class: "mc-option", type: "button" }, el("span", { class: "mc-key" }, String(i + 1)), el("span", {}, text));
        if (answered) {
          button.disabled = true;
          if (text === correct) button.classList.add("correct");
          else if (text === t.chosen[en]) button.classList.add("wrong");
        }
        button.addEventListener("click", () => chooseOption(i));
        return button;
      })
    );
    $("mc-next").hidden = !answered;
    $("mc-next").textContent = t.index === total - 1 ? "לתוצאות ←" : "הבא ←";
  }

  // ---------- Rendering ----------
  function render() {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
    ["practice", "test", "history", "progress"].forEach((t) => ($(`view-${t}`).hidden = state.tab !== t));
    hideTip();

    if (state.tab === "practice") renderPractice();
    if (state.tab === "test") renderTest();
    if (state.tab === "history") renderHistory();
    if (state.tab === "progress") renderProgress();

    const s = active();
    const studying = !!s && s.index < s.queue.length;
    $("study").hidden = !studying;
    if (studying) renderCard(s);

    const mc = mcRunning() && state.test.index < state.test.queue.length;
    $("mc").hidden = !mc;
    if (mc) renderMc();

    renderDrawer();
  }

  // ---------- Side panel: the words the user didn't know ----------
  let drawerOpen = false;

  function setDrawer(open) {
    drawerOpen = open;
    $("failed-drawer").hidden = !open;
    $("drawer-backdrop").hidden = !open;
    renderDrawer();
    (open ? $("close-drawer") : $("open-failed-list")).focus();
  }

  // Same effect as answering "knew" on a flashcard: the word moves to the known list and is saved
  function markKnown(en) {
    state.failed = state.failed.filter((w) => w !== en);
    if (!state.known.includes(en)) state.known.push(en);
    queueWord(en, "succeeded");
    saveState();
    render();
  }

  // Count color in the top bar: 0–5 green, 6–20 yellow, 21+ red
  const countClass = (n) => (n <= 5 ? "count-low" : n <= 20 ? "count-mid" : "count-high");

  // "Show translation" toggle — a per-browser preference, so localStorage is enough
  const TRANSLATION_PREF = "flashcards-drawer-show-translation";

  function showTranslation() {
    try {
      return localStorage.getItem(TRANSLATION_PREF) !== "0";
    } catch {
      return true;
    }
  }

  function setShowTranslation(show) {
    try {
      localStorage.setItem(TRANSLATION_PREF, show ? "1" : "0");
    } catch {
      // Storage unavailable: the toggle still works until the page is reloaded
    }
    $("failed-drawer").classList.toggle("hide-translation", !show);
  }

  // The unit filter at the top of the panel (in memory only; "all" = every unit)
  let drawerUnit = "all";
  const unitsText = (w) => (w.units.length > 1 ? `(יחידות ${w.units.join(", ")})` : `(יחידה ${w.units[0]})`);

  function renderDrawer() {
    const all = deckWords("failed", "all").slice().reverse(); // every failed word, most recent first
    $("failed-list-count").textContent = `(${all.length})`;
    $("failed-list-count").className = countClass(all.length);
    if (!drawerOpen) return;

    const words = all.filter((en) => inUnit(en, drawerUnit));
    $("drawer-unit").value = drawerUnit;
    $("drawer-count").textContent = drawerUnit === "all" ? `(${all.length})` : `(${words.length} מתוך ${all.length})`;
    $("drawer-empty").hidden = words.length > 0;
    $("drawer-empty").textContent = all.length ? `אין מילים שלא ידעתם ב${unitLabel(drawerUnit)}.` : "אין כרגע מילים שלא ידעתם.";
    $("drawer-list").replaceChildren(
      ...words.map((en) => {
        const w = byWord.get(en);
        const button = el("button", { class: "mark-known", type: "button" }, "✓ ידעתי");
        button.addEventListener("click", () => markKnown(en));
        return el(
          "li",
          {},
          el(
            "div",
            { class: "drawer-word" },
            el("div", { class: "drawer-word-line" }, el("span", { class: "en", dir: "ltr" }, en), el("bdi", { class: "drawer-units", dir: "rtl" }, unitsText(w))),
            el("span", { class: "he" }, w.he.join("; "))
          ),
          button
        );
      })
    );
  }

  // ---------- Progress tab ----------
  // A practice day: at least PRACTICE_DAY_WORDS flashcard answers that day, or a finished test of PRACTICE_DAY_TEST+ words
  const PRACTICE_DAY_WORDS = 25;
  const PRACTICE_DAY_TEST = 20;
  const HEATMAP_WEEKS = 12;

  const STATUS = [
    { key: "known", label: "ידעתי", cls: "seg-known" },
    { key: "failed", label: "לא ידעתי", cls: "seg-failed" },
    { key: "unseen", label: "עוד לא נבחנו", cls: "seg-unseen" },
  ];
  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);
  const fmt = (n) => n.toLocaleString("he-IL");
  const atNoon = (date) => new Date(`${date}T12:00:00`); // noon avoids daylight-saving edge cases
  const shiftDay = (date, n) => {
    const d = atNoon(date);
    d.setDate(d.getDate() + n);
    return localDay(d);
  };
  const dayLabel = (date) => atNoon(date).toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "numeric" });

  function unitCounts(unit) {
    const total = pool(unit).length;
    const known = deckWords("known", unit).length;
    const failed = deckWords("failed", unit).length;
    return { total, known, failed, unseen: total - known - failed };
  }

  // Per local day: words answered + knew (recorded "day" rows; before recording began, estimated from each word's
  // last-answer day — knew unknown), the tests finished that day, and whether it counts as a practice day
  function activityByDay() {
    const days = new Map();
    const recorded = state.days || [];
    const firstRecorded = recorded.reduce((min, d) => (!min || d.date < min ? d.date : min), "");
    for (const d of recorded) days.set(d.date, { answered: d.answered, knew: d.knew, tests: [], estimated: false });
    for (const [date, n] of Object.entries(state.wordDays || {})) {
      if (days.has(date) || (firstRecorded && date >= firstRecorded)) continue;
      days.set(date, { answered: n, knew: null, tests: [], estimated: true });
    }
    for (const r of [...history, ...state.unsaved]) {
      const date = localDay(new Date(r.date));
      if (!days.has(date)) days.set(date, { answered: 0, knew: null, tests: [], estimated: false });
      days.get(date).tests.push(r);
    }
    for (const d of days.values()) {
      d.practice = d.answered >= PRACTICE_DAY_WORDS || d.tests.some((t) => t.total >= PRACTICE_DAY_TEST);
    }
    return days;
  }

  function streaks(days) {
    const isPractice = (date) => !!days.get(date)?.practice;
    const today = localDay();
    let current = 0;
    // Today still counts as "on track" until it's over, so the streak may run up to yesterday
    for (let date = isPractice(today) ? today : shiftDay(today, -1); isPractice(date); date = shiftDay(date, -1)) current++;
    const practiceDates = [...days].filter(([, d]) => d.practice).map(([date]) => date).sort();
    let longest = 0;
    let run = 0;
    practiceDates.forEach((date, i) => {
      run = i && shiftDay(practiceDates[i - 1], 1) === date ? run + 1 : 1;
      longest = Math.max(longest, run);
    });
    return { current, longest, total: practiceDates.length };
  }

  // Heat level: 0 nothing, 1 some activity, 2–4 practice days by words answered
  const heatLevel = (d) =>
    !d || (!d.answered && !d.tests.length) ? 0 : !d.practice ? 1 : d.answered >= 120 ? 4 : d.answered >= 60 ? 3 : 2;

  // One tooltip for every chart: value first, details after; on hover and on keyboard focus
  const tooltip = $("viz-tooltip");
  const hideTip = () => (tooltip.hidden = true);

  function showTip(target, lines, x, y) {
    tooltip.replaceChildren(el("strong", {}, lines[0]), ...lines.slice(1).map((line) => el("div", {}, line)));
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const px = x ?? rect.left + rect.width / 2;
    const py = y ?? rect.top;
    const { offsetWidth: w, offsetHeight: h } = tooltip;
    tooltip.style.left = `${Math.min(Math.max(8, px - w / 2), innerWidth - w - 8)}px`;
    tooltip.style.top = `${py - h - 12 < 8 ? py + 18 : py - h - 12}px`;
  }

  function withTip(node, lines, focusable = true) {
    if (focusable) node.tabIndex = 0;
    node.setAttribute("aria-label", lines.join(", "));
    node.addEventListener("pointermove", (e) => showTip(node, lines, e.clientX, e.clientY));
    node.addEventListener("pointerleave", hideTip);
    node.addEventListener("focus", () => showTip(node, lines));
    node.addEventListener("blur", hideTip);
    return node;
  }

  function stackBar(node, counts, title) {
    node.replaceChildren(
      ...STATUS.filter((st) => counts[st.key] > 0).map((st) => {
        const seg = el("div", { class: `seg ${st.cls}` });
        seg.style.flex = `${counts[st.key]} 1 0`;
        return withTip(seg, [`${fmt(counts[st.key])} מילים (${pct(counts[st.key], counts.total)}%)`, `${st.label} · ${title}`]);
      })
    );
  }

  const kpi = (label, value, sub, swatch) =>
    el(
      "div",
      { class: "kpi" },
      el("div", { class: "kpi-label" }, swatch ? el("span", { class: `swatch ${swatch}` }) : "", label),
      el("div", { class: "kpi-value" }, value),
      sub ? el("div", { class: "kpi-sub" }, sub) : ""
    );

  function fillTable(table, head, rows) {
    table.replaceChildren(
      el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))),
      el("tbody", {}, rows.map((row) => el("tr", {}, row.map((cell) => el("td", {}, String(cell))))))
    );
  }

  function renderProgress() {
    // Word status, overall and per unit
    const all = unitCounts("all");
    $("status-kpis").replaceChildren(
      ...STATUS.map((st) => kpi(st.label, fmt(all[st.key]), `${pct(all[st.key], all.total)}% מהמילים`, st.cls))
    );
    $("status-legend").replaceChildren(
      ...STATUS.map((st) => el("li", {}, el("span", { class: `swatch ${st.cls}` }), st.label))
    );
    stackBar($("status-bar"), all, unitLabel("all"));
    const seen = all.known + all.failed;
    $("status-coverage").textContent = `נבחנתם על ${pct(seen, all.total)}% מאוצר המילים (${fmt(seen)} מתוך ${fmt(all.total)}).`;

    $("unit-bars").replaceChildren(
      ...UNITS.map((u) => {
        const c = unitCounts(u);
        const bar = el("div", { class: "stack-bar" });
        stackBar(bar, c, unitLabel(u));
        return el(
          "div",
          { class: "unit-row" },
          el("span", { class: "unit-name" }, unitLabel(u)),
          bar,
          el("span", { class: "unit-value" }, `${pct(c.known, c.total)}% ידעתי`)
        );
      })
    );
    fillTable(
      $("unit-table"),
      ["יחידה", "מילים", "ידעתי", "לא ידעתי", "עוד לא נבחנו"],
      [...UNITS.map((u) => unitCounts(u)).map((c, i) => [unitLabel(UNITS[i]), c.total, c.known, c.failed, c.unseen]),
        ["כל המילים", all.total, all.known, all.failed, all.unseen]]
    );

    // Today, streaks, calendar
    const days = activityByDay();
    const todayKey = localDay();
    const today = days.get(todayKey) || { answered: 0, tests: [], practice: false };
    const fill = el("div", { class: "meter-fill" });
    fill.style.width = `${Math.min(100, pct(today.answered, PRACTICE_DAY_WORDS))}%`;
    $("today").replaceChildren(
      el("div", { class: "today-head" }, el("span", {}, "היום"), el("strong", {}, `${fmt(today.answered)} / ${PRACTICE_DAY_WORDS} מילים`)),
      el("div", { class: "meter", role: "img", "aria-label": `היום: ${today.answered} מתוך ${PRACTICE_DAY_WORDS} מילים` }, fill),
      el(
        "p",
        { class: today.practice ? "progress-note today-done" : "progress-note muted" },
        today.practice
          ? `✓ היום נחשב יום תרגול${today.answered < PRACTICE_DAY_WORDS ? " (מבחן של 20+ מילים)" : ""}`
          : `עוד ${PRACTICE_DAY_WORDS - today.answered} מילים, או מבחן של ${PRACTICE_DAY_TEST} מילים, כדי שהיום ייחשב יום תרגול`
      )
    );

    const st = streaks(days);
    const daysText = (n) => (n === 1 ? "יום אחד" : `${fmt(n)} ימים`);
    $("streak-kpis").replaceChildren(
      kpi("רצף נוכחי", daysText(st.current)),
      kpi("הרצף הארוך ביותר", daysText(st.longest)),
      kpi("ימי תרגול בסך הכול", fmt(st.total))
    );

    // Weeks run Sunday–Saturday; the grid fills column by column (RTL puts the oldest week on the right)
    const thisSunday = shiftDay(todayKey, -atNoon(todayKey).getDay());
    const start = shiftDay(thisSunday, -7 * (HEATMAP_WEEKS - 1));
    const cells = [];
    let practiceInRange = 0;
    for (let i = 0; i < HEATMAP_WEEKS * 7; i++) {
      const date = shiftDay(start, i);
      const d = days.get(date);
      const cell = el("div", { class: `cell lvl${heatLevel(d)}` });
      if (date > todayKey) {
        cell.classList.add("future");
      } else {
        if (d?.practice) practiceInRange++;
        const tests = d?.tests || [];
        withTip(
          cell,
          [
            d?.answered ? `${fmt(d.answered)} מילים${d.estimated ? " (הערכה)" : ""}` : tests.length ? "מבחן" : "אין פעילות",
            dayLabel(date),
            d?.knew != null && d.answered ? `ידעתי ${fmt(d.knew)} · לא ידעתי ${fmt(d.answered - d.knew)}` : "",
            tests.length ? `מבחנים: ${tests.map((t) => `${t.total} מילים`).join(", ")}` : "",
            d?.practice ? "✓ יום תרגול" : "",
          ].filter(Boolean),
          false // 84 cells would be too many tab stops — the table view below is the keyboard path
        );
      }
      cells.push(cell);
    }
    $("heatmap").replaceChildren(...cells);
    $("heatmap").setAttribute("aria-label", `${practiceInRange} ימי תרגול ב-${HEATMAP_WEEKS} השבועות האחרונים`);

    const active = [...days].filter(([, d]) => d.answered || d.tests.length).sort(([a], [b]) => (a < b ? 1 : -1));
    fillTable(
      $("days-table"),
      ["תאריך", "מילים", "ידעתי", "מבחנים", "יום תרגול"],
      active.map(([date, d]) => [
        dayLabel(date),
        d.answered ? `${d.answered}${d.estimated ? " (הערכה)" : ""}` : "—",
        d.knew ?? "—",
        d.tests.length ? d.tests.map((t) => t.total).join(", ") : "—",
        d.practice ? "✓" : "—",
      ])
    );
  }

  function renderCard(s) {
    const total = s.queue.length;
    $("progress-fill").style.width = `${(s.index / total) * 100}%`;
    $("progress-text").textContent = `${s.index} / ${total}`;

    const w = byWord.get(s.queue[s.index]);
    $("word").textContent = w.en;
    $("unit-badge").textContent = w.units.map((u) => `Unit ${u}`).join(" · ");
    $("translation").replaceChildren(...w.he.map((m) => el("div", { class: "meaning" }, m)));
  }

  function renderPractice() {
    const p = state.practice;
    $("practice-unit").value = p.unit;
    $("count-all").textContent = `(${deckWords("all", p.unit).length})`;
    $("count-known").textContent = `(${deckWords("known", p.unit).length})`;
    $("count-failed").textContent = `(${deckWords("failed", p.unit).length})`;

    document.querySelectorAll(".deck-btn").forEach((btn) => {
      const deck = btn.dataset.deck;
      btn.classList.toggle("active", deck === p.deck);
      btn.disabled = deckWords(deck, p.unit).length === 0;
    });

    const finished = p.index >= p.queue.length;
    $("practice-done").hidden = !finished;
    if (finished) {
      const known = deckWords("known", p.unit).length;
      const failed = deckWords("failed", p.unit).length;
      $("practice-summary").textContent = p.queue.length
        ? `בסבב הזה: ידעתם ${p.round.known} מילים, לא ידעתם ${p.round.failed}.`
        : "אין מילים בחפיסה הזו.";
      $("repeat-known").disabled = known === 0;
      $("repeat-known").textContent = `חזרה על המילים שידעתי (${known})`;
      $("repeat-failed").disabled = failed === 0;
      $("repeat-failed").textContent = `תרגול המילים שלא ידעתי (${failed})`;
    }
  }

  function renderTest() {
    const t = state.test;
    $("test-setup").hidden = t.phase !== "setup";
    $("test-status").hidden = t.phase !== "running";

    if (t.phase === "setup") {
      const available = testPool().length;
      $("test-type").value = t.type ?? "flashcards";
      $("test-type-note").hidden = !isMcTest();
      $("test-source").value = t.source ?? "all";
      $("test-unit").value = t.unit;
      $("test-size").max = available;
      $("test-size").value = Math.min(t.size, available);
      $("test-pool").textContent = available
        ? `${available} מילים זמינות (${sourceLabel(t.source)}, ${unitLabel(t.unit)}).`
        : `אין מילים שלא ידעתם ב${unitLabel(t.unit)}. תרגלו קודם, או בחרו "כל המילים".`;
      $("start-test").disabled = available === 0;
    }

    if (t.phase === "running") {
      const answers = Object.values(t.answers);
      $("test-status-text").textContent = `${testLabel()} · ידעתם ${answers.filter(Boolean).length} מתוך ${answers.length}`;
    }
  }

  function wordLists(words, type) {
    const [wrongTitle, rightTitle] = type === "mc" ? ["טעויות", "תשובות נכונות"] : ["לא ידעתי", "ידעתי"];
    const item = (w) =>
      el(
        "li",
        {},
        el("span", { dir: "ltr", class: "en" }, w.en),
        el("span", { class: "he" }, el("span", {}, w.he), w.chosen ? el("span", { class: "chosen" }, `בחרתם: ${w.chosen}`) : "")
      );
    const section = (title, list, cls) =>
      list.length
        ? el("div", { class: `word-list ${cls}` }, el("h3", {}, `${title} (${list.length})`), el("ul", {}, list.map(item)))
        : "";
    return [
      section(wrongTitle, words.filter((w) => !w.ok), "failed"),
      section(rightTitle, words.filter((w) => w.ok), "known"),
    ];
  }

  // ---------- History: list of tests, or one test's results ----------
  const percent = (r) => (r.total ? Math.round((r.correct / r.total) * 100) : 0);
  const resultSummary = (r) => [typeLabel(r.type), unitLabel(r.unit)].filter(Boolean).join(" · ");
  const isUnsaved = (r) => state.unsaved.includes(r);
  const openedResult = () =>
    state.openResult ? state.unsaved.find((r) => r.id === state.openResult) || history.find((r) => r.id === state.openResult) : null;
  const missedWords = (r) => r.words.filter((w) => !w.ok && byWord.has(w.en)).map((w) => w.en);

  function showResult(id) {
    state.openResult = id;
    saveState();
    render();
    window.scrollTo(0, 0);
  }

  function renderHistory() {
    const opened = openedResult();
    $("history-list-view").hidden = !!opened;
    $("result-view").hidden = !opened;
    if (opened) return renderResult(opened);

    const all = [...state.unsaved, ...history.slice().reverse()];
    $("history-empty").hidden = all.length > 0;
    $("export-history").disabled = history.length === 0;
    $("history-list").replaceChildren(
      ...all.map((r) => {
        const row = el(
          "button",
          { class: "history-row", type: "button" },
          el("span", { class: "history-score" }, `${percent(r)}%`),
          el("span", {}, [`${r.correct}/${r.total}`, resultSummary(r)].join(" · ")),
          el("span", { class: "muted" }, isUnsaved(r) ? "לא נשמר עדיין" : formatDate(r.date))
        );
        row.addEventListener("click", () => showResult(r.id));
        return row;
      })
    );
  }

  function renderResult(r) {
    const unsaved = isUnsaved(r);
    $("result-score").textContent = `${percent(r)}%`;
    $("result-detail").textContent = `ידעתם ${r.correct} מתוך ${r.total} מילים · ${resultSummary(r)} · ${formatDate(r.date)}`;
    $("result-status").textContent = !unsaved ? "✓ התוצאות נשמרו" : savingResults ? "שומר את התוצאות..." : "התוצאות עדיין לא נשמרו";
    $("result-status").classList.toggle("warn", unsaved && !savingResults);
    $("result-retry").hidden = !unsaved || savingResults;
    $("result-delete").hidden = unsaved;
    const missed = missedWords(r).length;
    $("result-retest").textContent =
      r.type === "mc" ? `מבחן חוזר על הטעויות (${missed})` : `מבחן חוזר על המילים שלא ידעתי (${missed})`;
    $("result-retest").disabled = missed === 0;
    $("result-word-lists").replaceChildren(...wordLists(r.words, r.type));
  }

  function buildUnitSelects() {
    document.querySelectorAll(".unit-select").forEach((sel) => {
      sel.replaceChildren(
        el("option", { value: "all" }, unitLabel("all")),
        ...UNITS.map((u) => el("option", { value: String(u) }, unitLabel(u)))
      );
    });
  }

  // ---------- Events ----------
  document.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      if (state.tab === "history") state.openResult = null;
      saveState();
      resetFlip();
      render();
    })
  );

  $("open-failed-list").addEventListener("click", () => setDrawer(true));
  $("close-drawer").addEventListener("click", () => setDrawer(false));
  $("drawer-backdrop").addEventListener("click", () => setDrawer(false));
  $("toggle-translation").addEventListener("change", (e) => setShowTranslation(e.target.checked));
  $("drawer-unit").addEventListener("change", (e) => {
    drawerUnit = e.target.value;
    renderDrawer();
  });
  $("toggle-translation").checked = showTranslation();
  setShowTranslation(showTranslation());

  card.addEventListener("click", flip);
  $("btn-success").addEventListener("click", () => answer(true));
  $("btn-fail").addEventListener("click", () => answer(false));

  // Practice
  document.querySelectorAll(".deck-btn").forEach((b) => b.addEventListener("click", () => startPractice(b.dataset.deck)));
  $("practice-unit").addEventListener("change", (e) => startPractice("all", e.target.value));
  $("repeat-known").addEventListener("click", () => startPractice("known"));
  $("repeat-failed").addEventListener("click", () => startPractice("failed"));
  $("restart-all").addEventListener("click", () => startPractice("all"));

  // Test setup
  $("test-type").addEventListener("change", (e) => {
    state.test.type = e.target.value;
    saveState();
    render();
  });
  $("test-source").addEventListener("change", (e) => {
    state.test.source = e.target.value;
    saveState();
    render();
  });
  $("test-unit").addEventListener("change", (e) => {
    state.test.unit = e.target.value;
    saveState();
    render();
  });
  $("test-size").addEventListener("input", (e) => {
    const n = parseInt(e.target.value, 10);
    if (n > 0) state.test.size = n;
    saveState();
  });
  document.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => {
      state.test.size = Number(c.dataset.size);
      saveState();
      render();
    })
  );
  $("start-test").addEventListener("click", () => {
    const available = testPool();
    if (!available.length) return;
    const size = Math.max(1, Math.min(state.test.size, available.length));
    startTest(shuffle(available).slice(0, size));
  });

  // Test running / results
  $("mc-next").addEventListener("click", nextQuestion);
  $("quit-test").addEventListener("click", finishTest);

  // Results (history tab)
  $("result-back").addEventListener("click", () => showResult(null));
  $("result-retry").addEventListener("click", saveResults);
  $("result-download").addEventListener("click", () => {
    const r = openedResult();
    if (r) downloadCsv(`test-${r.date.slice(0, 10)}.csv`, resultRows([r]));
  });
  // Retest on the words missed in this test, as the same kind of test
  $("result-retest").addEventListener("click", () => {
    const r = openedResult();
    const words = r ? missedWords(r) : [];
    if (!words.length) return;
    state.test.type = r.type === "mc" ? "mc" : "flashcards";
    state.test.unit = r.unit || "all";
    state.tab = "test";
    startTest(words);
  });
  $("result-delete").addEventListener("click", () => {
    const r = openedResult();
    if (!r || isUnsaved(r) || !confirm("למחוק את המבחן הזה?")) return;
    history = history.filter((h) => h.id !== r.id);
    sync(api("DELETE", `/api/tests/${encodeURIComponent(r.id)}`));
    showResult(null);
  });
  $("export-history").addEventListener("click", () => downloadCsv("all-test-results.csv", resultRows(history)));

  $("logout").addEventListener("click", async () => {
    await flushWords();
    try {
      await api("POST", "/api/logout");
    } finally {
      sessionStorage.removeItem(sessionKey);
      sessionStorage.removeItem(pendingKey());
      location.href = "/login.html";
    }
  });

  document.addEventListener("keydown", (e) => {
    // While the side panel is open, only Esc (close) is handled — no flashcard/test shortcuts behind it
    if (drawerOpen) {
      if (e.key === "Escape") setDrawer(false);
      return;
    }
    if (["INPUT", "SELECT"].includes(e.target.tagName)) return;

    // Multiple-choice: 1–4 picks an answer, Enter/Space goes to the next question
    if (!$("mc").hidden) {
      if (/^[1-4]$/.test(e.key)) {
        chooseOption(Number(e.key) - 1);
      } else if (e.key === "Enter" || e.key === " ") {
        if (e.target.tagName === "BUTTON") return; // let buttons handle their own activation
        e.preventDefault();
        nextQuestion();
      }
      return;
    }

    if ($("study").hidden) return;
    if (e.key === " " || e.key === "Enter") {
      if (e.target.tagName === "BUTTON") return; // let buttons handle their own activation
      e.preventDefault();
      flip();
    } else if (e.key === "ArrowLeft") {
      answer(true);
    } else if (e.key === "ArrowRight") {
      answer(false);
    }
  });

  async function init() {
    let data;
    try {
      data = await api("GET", `/api/data?tz=${new Date().getTimezoneOffset()}`);
    } catch (err) {
      if (err.message !== "unauthorized") {
        document.body.textContent = "לא ניתן לטעון את הנתונים מהשרת. נסו לרענן את הדף בעוד רגע.";
      }
      return;
    }
    sessionKey = `flashcards-session:${data.username}`;
    const saved = loadSession();
    state = saved || freshState();
    state.unsaved ??= [];
    state.practice.unit ??= "all"; // sessions saved while there was no unit selector
    state.test.unit ??= "all";
    state.openResult ??= null;
    if (state.test.phase === "done") state.test.phase = "setup"; // sessions from before results moved to history
    state.days = data.days;
    state.wordDays = data.wordDays;
    state.known = data.known;
    state.failed = data.failed;
    restorePendingWords();
    history = data.tests;
    // A new session's first deck can only keep known words out of the start once the lists are loaded
    if (!saved) {
      state.practice.queue = practiceQueue(state.practice.deck, state.practice.unit);
      // Words the user failed last session come back near the front of this session's queue
      try {
        const prevFailed = JSON.parse(localStorage.getItem(nextSessionKey()) || "[]");
        if (prevFailed.length) {
          const inQueue = new Set(prevFailed.filter((en) => state.practice.queue.includes(en)));
          if (inQueue.size) {
            state.practice.queue = state.practice.queue.filter((en) => !inQueue.has(en));
            const insertAt = REQUEUE_MIN + Math.floor(Math.random() * (REQUEUE_MAX - REQUEUE_MIN + 1));
            state.practice.queue.splice(Math.min(insertAt, state.practice.queue.length), 0, ...shuffle([...inQueue]));
          }
          localStorage.removeItem(nextSessionKey());
        }
      } catch {}
      saveState();
    }

    $("username").textContent = data.username;
    $("app").hidden = false;
    buildUnitSelects();
    render();
    if (state.unsaved.length) saveResults(); // e.g. the page was reloaded while a save was in progress
  }

  init();
})();
