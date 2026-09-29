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
  let flushTimer = null;
  let flushChain = Promise.resolve(); // batches are sent one at a time so they arrive in order

  function queueWord(en, status) {
    pendingWords.set(en, { en, he: byWord.get(en).he.join("; "), status });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushWords, WORD_FLUSH_MS);
  }

  function takePending() {
    clearTimeout(flushTimer);
    const batch = [...pendingWords.values()];
    pendingWords.clear();
    return batch;
  }

  // Sends pending word results; resolves once they're saved (never rejects — failures are retried)
  function flushWords() {
    flushChain = flushChain.then(async () => {
      const batch = takePending();
      if (!batch.length) return;
      try {
        await api("POST", "/api/words", { words: batch });
        $("sync-error").hidden = true;
      } catch (err) {
        // Put the batch back, unless the word was answered again in the meantime
        batch.forEach((w) => pendingWords.has(w.en) || pendingWords.set(w.en, w));
        showSyncError(err);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flushWords, WORD_RETRY_MS);
      }
    });
    return flushChain;
  }

  // keepalive lets the request finish even if the page is being closed
  function sendPendingOnExit() {
    const batch = takePending();
    if (!batch.length) return;
    fetch("/api/words", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: batch }),
    });
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
      test: { phase: "setup", unit: "all", size: 20, queue: [], index: 0, answers: {}, startedAt: null, saved: false },
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

  function deckWords(deck, unit) {
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
  function active() {
    if (state.tab === "practice") return state.practice;
    if (state.tab === "test" && state.test.phase === "running") return state.test;
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

    if (s === state.practice) {
      s.round[success ? "known" : "failed"]++;
    } else {
      s.answers[current] = success;
    }
    s.index++;
    if (s === state.test && s.index >= s.queue.length) s.phase = "done";

    saveState();
    resetFlip();
    render();
  }

  // ---------- Practice ----------
  function startPractice(deck, unit = state.practice.unit) {
    const words = deckWords(deck, unit);
    state.practice = { deck, unit, queue: shuffle(words), index: 0, round: { known: 0, failed: 0 } };
    saveState();
    resetFlip();
    render();
  }

  // ---------- Test ----------
  function startTest(words) {
    state.test = {
      ...state.test,
      phase: "running",
      queue: shuffle(words),
      index: 0,
      answers: {},
      startedAt: new Date().toISOString(),
      saved: false,
    };
    saveState();
    resetFlip();
    render();
  }

  function testResult() {
    const t = state.test;
    const words = t.queue.filter((en) => en in t.answers).map((en) => ({
      en,
      he: byWord.get(en)?.he.join("; ") ?? "",
      ok: t.answers[en],
    }));
    return {
      id: t.startedAt,
      date: t.startedAt,
      unit: t.unit,
      total: words.length,
      correct: words.filter((w) => w.ok).length,
      words,
    };
  }

  function resultRows(results) {
    const rows = [["תאריך", "יחידה", "English", "עברית", "תוצאה"]];
    results.forEach((r) =>
      r.words.forEach((w) => rows.push([formatDate(r.date), unitLabel(r.unit), w.en, w.he, w.ok ? "ידעתי" : "לא ידעתי"]))
    );
    return rows;
  }

  // ---------- Rendering ----------
  function render() {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
    ["practice", "test", "history"].forEach((t) => ($(`view-${t}`).hidden = state.tab !== t));

    if (state.tab === "practice") renderPractice();
    if (state.tab === "test") renderTest();
    if (state.tab === "history") renderHistory();

    const s = active();
    const studying = !!s && s.index < s.queue.length;
    $("study").hidden = !studying;
    if (studying) renderCard(s);
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
    $("test-results").hidden = t.phase !== "done";

    if (t.phase === "setup") {
      const available = pool(t.unit).length;
      $("test-unit").value = t.unit;
      $("test-size").max = available;
      $("test-size").value = Math.min(t.size, available);
      $("test-pool").textContent = `${available} מילים זמינות ב${unitLabel(t.unit)}.`;
    }

    if (t.phase === "running") {
      const correct = Object.values(t.answers).filter(Boolean).length;
      $("test-status-text").textContent = `${unitLabel(t.unit)} · ידעתם ${correct} מתוך ${t.index}`;
    }

    if (t.phase === "done") renderResults();
  }

  function renderResults() {
    const r = testResult();
    const pct = r.total ? Math.round((r.correct / r.total) * 100) : 0;
    $("test-score").textContent = `${pct}%`;
    $("test-score-detail").textContent = `ידעתם ${r.correct} מתוך ${r.total} מילים · ${unitLabel(r.unit)}`;
    $("save-results").disabled = state.test.saved || r.total === 0;
    $("save-results").textContent = state.test.saved ? "✓ התוצאות נשמרו" : "שמירת התוצאות";
    $("retest-failed").disabled = r.words.every((w) => w.ok);
    $("test-word-lists").replaceChildren(...wordLists(r.words));
  }

  function wordLists(words) {
    const section = (title, list, cls) =>
      list.length
        ? el(
            "div",
            { class: `word-list ${cls}` },
            el("h3", {}, `${title} (${list.length})`),
            el("ul", {}, list.map((w) => el("li", {}, el("span", { dir: "ltr", class: "en" }, w.en), el("span", {}, w.he))))
          )
        : "";
    return [
      section("לא ידעתי", words.filter((w) => !w.ok), "failed"),
      section("ידעתי", words.filter((w) => w.ok), "known"),
    ];
  }

  function renderHistory() {
    $("history-empty").hidden = history.length > 0;
    $("export-history").disabled = history.length === 0;
    $("clear-history").hidden = history.length === 0;

    $("history-list").replaceChildren(
      ...history
        .slice()
        .reverse()
        .map((r) => {
          const pct = r.total ? Math.round((r.correct / r.total) * 100) : 0;
          const del = el("button", { class: "link-btn" }, "מחיקה");
          del.addEventListener("click", () => {
            history = history.filter((h) => h.id !== r.id);
            sync(api("DELETE", `/api/tests/${encodeURIComponent(r.id)}`));
            render();
          });
          const dl = el("button", { class: "link-btn" }, "הורדה");
          dl.addEventListener("click", () => downloadCsv(`test-${r.date.slice(0, 10)}.csv`, resultRows([r])));
          return el(
            "details",
            { class: "history-item" },
            el(
              "summary",
              {},
              el("span", { class: "history-score" }, `${pct}%`),
              el("span", {}, `${r.correct}/${r.total} · ${unitLabel(r.unit)}`),
              el("span", { class: "muted" }, formatDate(r.date))
            ),
            el("div", { class: "history-item-actions" }, dl, del),
            ...wordLists(r.words)
          );
        })
    );
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
      saveState();
      resetFlip();
      render();
    })
  );

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
    const available = pool(state.test.unit);
    const size = Math.max(1, Math.min(state.test.size, available.length));
    startTest(shuffle(available).slice(0, size));
  });

  // Test running / results
  $("quit-test").addEventListener("click", () => {
    state.test.phase = "done";
    saveState();
    resetFlip();
    render();
  });
  $("save-results").addEventListener("click", async () => {
    const r = testResult();
    if (!r.total || state.test.saved) return;
    const button = $("save-results");
    button.disabled = true;
    button.textContent = "שומר...";
    try {
      history.push(await api("POST", "/api/tests", { date: r.date, unit: r.unit, words: r.words }));
      $("sync-error").hidden = true;
      state.test.saved = true;
      saveState();
    } catch (err) {
      showSyncError(err);
    }
    render();
  });
  $("download-results").addEventListener("click", () => {
    const r = testResult();
    downloadCsv(`test-${r.date.slice(0, 10)}.csv`, resultRows([r]));
  });
  $("retest-failed").addEventListener("click", () =>
    startTest(testResult().words.filter((w) => !w.ok).map((w) => w.en))
  );
  $("new-test").addEventListener("click", () => {
    state.test.phase = "setup";
    saveState();
    render();
  });

  // History
  $("export-history").addEventListener("click", () => downloadCsv("all-test-results.csv", resultRows(history)));
  $("clear-history").addEventListener("click", () => {
    if (!confirm("למחוק את כל התוצאות השמורות?")) return;
    history = [];
    sync(api("DELETE", "/api/tests"));
    render();
  });

  $("reset-session").addEventListener("click", async () => {
    if (!confirm("לאפס את רשימות ידעתי / לא ידעתי? (תוצאות מבחנים שמורות לא יימחקו)")) return;
    takePending(); // unsent answers are being reset anyway
    await flushChain; // don't let a batch already in flight land after the reset
    sync(api("DELETE", "/api/words"));
    state = freshState();
    saveState();
    resetFlip();
    render();
  });

  $("logout").addEventListener("click", async () => {
    await flushWords();
    try {
      await api("POST", "/api/logout");
    } finally {
      sessionStorage.removeItem(sessionKey);
      location.href = "/login.html";
    }
  });

  document.addEventListener("keydown", (e) => {
    if ($("study").hidden || ["INPUT", "SELECT"].includes(e.target.tagName)) return;
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
      data = await api("GET", "/api/data");
    } catch (err) {
      if (err.message !== "unauthorized") {
        document.body.textContent = "לא ניתן לטעון את הנתונים מהשרת. ודאו שהשרת פועל (node server.js) ורעננו את הדף.";
      }
      return;
    }
    sessionKey = `flashcards-session:${data.username}`;
    state = loadSession() || freshState();
    state.known = data.known;
    state.failed = data.failed;
    history = data.tests;

    $("username").textContent = data.username;
    $("app").hidden = false;
    buildUnitSelects();
    render();
  }

  init();
})();
