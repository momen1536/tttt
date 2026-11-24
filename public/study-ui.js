/**
 * study-ui.js — the Study hub
 *
 * Everything that is not the chat itself: flashcards and spaced-repetition
 * review, a practice-exam mode with a timer and mark scheme, revision notes,
 * imported lecture notes, a formula sheet, a function plotter and a progress
 * log. The chat controller passes in a small bridge (model access, current
 * chat text, toasts) so this module stays independent of app.js internals.
 */

import {
  GRADES,
  StudyStore,
  SUBJECTS,
  cardsToCsv,
  extractFormulas,
  parseCards,
  parseExam,
} from "./study.js?v=7";
import { draw as drawPlot } from "./plot.js?v=7";
import { renderMarkdown } from "./markdown.js?v=7";

const MAX_CONTEXT = 12_000;

function byId(id) {
  return document.getElementById(id);
}

function icon(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function download(filename, text, mime = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function clip(text, limit = MAX_CONTEXT) {
  const value = String(text || "");
  return value.length > limit ? `${value.slice(0, limit)}\n\n…(cut for length)` : value;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/**
 * @param {{
 *   ask: (prompt: string, options?: {maxTokens?: number}) => Promise<string>,
 *   currentChat: () => { title: string, text: string },
 *   toast: (text: string) => void,
 *   confirm: (options: {title: string, message: string, confirmLabel?: string}) => Promise<boolean>,
 * }} bridge
 */
export function initStudy(bridge) {
  const store = new StudyStore();
  const els = {
    dialog: byId("study-dialog"),
    close: byId("study-close"),
    tabs: byId("study-tabs"),
    dueBadge: byId("study-due-badge"),
    footBadge: byId("study-badge"),

    // deck
    deckFromChat: byId("deck-from-chat"),
    deckTopic: byId("deck-topic"),
    deckCount: byId("deck-count"),
    deckGenerate: byId("deck-generate"),
    deckStatus: byId("deck-status"),
    deckTotal: byId("deck-total"),
    deckExport: byId("deck-export"),
    deckClear: byId("deck-clear"),
    deckTopics: byId("deck-topics"),
    deckList: byId("deck-list"),
    deckEmpty: byId("deck-empty"),
    cardFront: byId("card-front"),
    cardBack: byId("card-back"),
    cardAdd: byId("card-add"),

    // review
    reviewCount: byId("review-count"),
    reviewRestart: byId("review-restart"),
    reviewTopic: byId("review-topic"),
    reviewFront: byId("review-front"),
    reviewBack: byId("review-back"),
    reviewFlip: byId("review-flip"),
    reviewGrades: byId("review-grades"),
    reviewNote: byId("review-note"),

    // exam
    examTopic: byId("exam-topic"),
    examCount: byId("exam-count"),
    examGenerate: byId("exam-generate"),
    examStatus: byId("exam-status"),
    examPaper: byId("exam-paper"),
    examTitle: byId("exam-title"),
    examTimer: byId("exam-timer"),
    examQuestions: byId("exam-questions"),
    examScheme: byId("exam-scheme"),
    examMark: byId("exam-mark"),
    examResult: byId("exam-result"),

    // notes
    notesFromChat: byId("notes-from-chat"),
    notesPreview: byId("notes-preview"),
    noteTitle: byId("note-title"),
    noteSubject: byId("note-subject"),
    noteText: byId("note-text"),
    noteAdd: byId("note-add"),
    noteStatus: byId("note-status"),
    notesCount: byId("notes-count"),
    notesUse: byId("notes-use"),
    notesList: byId("notes-list"),
    formulasExtract: byId("formulas-extract"),
    formulasList: byId("formulas-list"),
    plotInput: byId("plot-input"),
    plotDraw: byId("plot-draw"),
    plotCanvas: byId("plot-canvas"),
    plotStatus: byId("plot-status"),

    // progress
    statStreak: byId("stat-streak"),
    statAnswers: byId("stat-answers"),
    statCards: byId("stat-cards"),
    statTotal: byId("stat-total"),
    weekChart: byId("week-chart"),
    statsReset: byId("stats-reset"),
  };

  if (!els.dialog) {
    // Markup missing: the chat still works, the study tools simply stay off.
    return {
      open() {},
      refreshBadge() {},
      logAnswer() {},
      contextFor() {
        return "";
      },
      showSteps() {
        return false;
      },
      useNotes() {
        return false;
      },
      setShowSteps() {},
    };
  }

  let deckFilter = "";
  let reviewQueue = [];
  let reviewIndex = 0;
  let reviewFlipped = false;
  let reviewDone = false;
  let paper = null;
  let paperTitle = "";
  let examStartedAt = 0;
  let examTimerId = 0;
  let schemeOpen = false;

  /* ---------------------------------------------------------------- */
  /* Shell                                                            */
  /* ---------------------------------------------------------------- */

  function setTab(tab) {
    for (const btn of els.tabs.querySelectorAll("[data-tab]")) {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    }
    for (const pane of els.dialog.querySelectorAll("[data-pane]")) {
      const active = pane.dataset.pane === tab;
      pane.hidden = !active;
      pane.classList.toggle("is-active", active);
      pane.setAttribute("role", "tabpanel");
    }
    if (tab === "review") startReview();
    if (tab === "progress") renderProgress();
    if (tab === "deck") renderDeck();
    if (tab === "notes") renderNotes();
  }

  function refreshBadge() {
    const { due, total } = store.counts();
    const text = due ? String(due) : "";
    for (const badge of [els.dueBadge, els.footBadge]) {
      if (!badge) continue;
      badge.textContent = total ? text : "";
      badge.hidden = !text;
    }
  }

  function open(tab = "deck") {
    if (!els.dialog.open) els.dialog.showModal();
    setTab(tab);
    refreshBadge();
    renderDeck();
  }

  /* ---------------------------------------------------------------- */
  /* Deck                                                             */
  /* ---------------------------------------------------------------- */

  function renderDeckTopics() {
    const topics = store.topics();
    els.deckTopics.innerHTML = "";
    if (!topics.length) return;
    const values = ["", ...topics];
    for (const value of values) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `cat-chip${deckFilter === value ? " is-active" : ""}`;
      btn.textContent = value || "All";
      btn.addEventListener("click", () => {
        deckFilter = value;
        renderDeck();
      });
      els.deckTopics.appendChild(btn);
    }
  }

  function renderDeck() {
    const { total, due } = store.counts();
    if (els.deckTotal) {
      els.deckTotal.textContent = total
        ? `${total} card${total === 1 ? "" : "s"}${due ? ` · ${due} due` : ""}`
        : "";
    }
    renderDeckTopics();

    const cards = store.cards.filter((card) => !deckFilter || card.topic === deckFilter);
    els.deckList.innerHTML = "";
    els.deckEmpty.hidden = cards.length > 0;
    els.deckEmpty.textContent = total
      ? "No cards in this topic."
      : "No cards yet — generate some above, or add one by hand.";

    for (const card of cards.slice(0, 200)) {
      const row = document.createElement("article");
      row.className = "deck-card";
      row.dataset.id = card.id;

      const front = document.createElement("p");
      front.className = "deck-front";
      front.textContent = card.front;

      const back = document.createElement("p");
      back.className = "deck-back";
      back.textContent = card.back;

      const meta = document.createElement("div");
      meta.className = "deck-meta";
      const bits = [];
      if (card.topic) bits.push(card.topic);
      bits.push(card.interval ? `every ${card.interval}d` : card.reps ? "learning" : "new");
      const label = document.createElement("span");
      label.textContent = bits.join(" · ");
      meta.appendChild(label);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "mini-btn icon-only";
      del.title = "Delete card";
      del.setAttribute("aria-label", `Delete card: ${card.front}`);
      del.innerHTML = icon("trash");
      del.addEventListener("click", () => {
        store.removeCard(card.id);
        renderDeck();
        refreshBadge();
        bridge.toast("Card deleted");
      });
      meta.appendChild(del);

      row.append(front, back, meta);
      els.deckList.appendChild(row);
    }
    refreshBadge();
  }

  function setDeckStatus(text, tone = "") {
    els.deckStatus.textContent = text;
    els.deckStatus.className = `study-status${tone ? ` ${tone}` : ""}`;
  }

  async function generateCards(prompt, topic) {
    setDeckStatus("Writing cards…");
    els.deckGenerate.disabled = true;
    els.deckFromChat.disabled = true;
    try {
      const reply = await bridge.ask(prompt, { maxTokens: 1400 });
      const cards = parseCards(reply, topic);
      if (!cards.length) {
        setDeckStatus("The model didn't return usable cards. Try again.", "err");
        return;
      }
      const added = store.addCards(cards, topic);
      setDeckStatus(
        added.length
          ? `Added ${added.length} card${added.length === 1 ? "" : "s"}.`
          : "Those cards are already in your deck.",
        "ok"
      );
      bridge.toast(`${added.length} card${added.length === 1 ? "" : "s"} added`);
      renderDeck();
      refreshBadge();
    } catch (err) {
      setDeckStatus(err?.message || "Could not make cards.", "err");
    } finally {
      els.deckGenerate.disabled = false;
      els.deckFromChat.disabled = false;
    }
  }

  els.deckFromChat?.addEventListener("click", () => {
    const chat = bridge.currentChat();
    if (!chat.text.trim()) {
      setDeckStatus("This conversation is empty — ask something first.", "err");
      return;
    }
    const count = Number(els.deckCount.value) || 10;
    const topic = els.deckTopic.value.trim() || chat.title.slice(0, 40);
    const prompt = [
      `Turn this study conversation into ${count} flashcards.`,
      `Topic: ${topic}.`,
      "Return ONLY a JSON array — no prose, no code fences — of objects with exactly these keys:",
      '{"front": "a single clear question or term", "back": "a short, self-contained answer"}',
      "Cover the key definitions, mechanisms and formulas. No duplicates. Keep each answer under 40 words.",
      "",
      "Conversation:",
      clip(chat.text),
    ].join("\n");
    generateCards(prompt, topic);
  });

  els.deckGenerate?.addEventListener("click", () => {
    const topic = els.deckTopic.value.trim();
    if (!topic) {
      setDeckStatus("Type a topic first, for example “deadlocks”.", "err");
      els.deckTopic.focus();
      return;
    }
    const count = Number(els.deckCount.value) || 10;
    const prompt = [
      `Create ${count} study flashcards on “${topic}” for a university student.`,
      "Return ONLY a JSON array — no prose, no code fences — of objects with exactly these keys:",
      '{"front": "a single clear question or term", "back": "a short, self-contained answer"}',
      "Mix definitions, mechanisms and one worked example. No duplicates.",
    ].join("\n");
    generateCards(prompt, topic);
  });

  els.cardAdd?.addEventListener("click", () => {
    const front = els.cardFront.value.trim();
    const back = els.cardBack.value.trim();
    if (!front || !back) {
      setDeckStatus("A card needs both a question and an answer.", "err");
      return;
    }
    store.addCard(front, back, els.deckTopic.value.trim());
    els.cardFront.value = "";
    els.cardBack.value = "";
    els.cardFront.focus();
    setDeckStatus("Card added.", "ok");
    renderDeck();
    refreshBadge();
  });

  els.deckExport?.addEventListener("click", () => {
    if (!store.cards.length) {
      setDeckStatus("There are no cards to export yet.", "err");
      return;
    }
    const scope = deckFilter ? store.cards.filter((c) => c.topic === deckFilter) : store.cards;
    download(`nova-cards-${stamp()}.csv`, cardsToCsv(scope), "text/csv;charset=utf-8");
    bridge.toast("Deck exported as CSV");
  });

  els.deckClear?.addEventListener("click", async () => {
    if (!store.cards.length) return;
    const ok = await bridge.confirm({
      title: "Clear the whole deck?",
      message: `${store.cards.length} cards will be deleted from this browser. This cannot be undone.`,
      confirmLabel: "Clear deck",
    });
    if (!ok) return;
    store.cards = [];
    store.save();
    renderDeck();
    refreshBadge();
    bridge.toast("Deck cleared");
  });

  /* ---------------------------------------------------------------- */
  /* Review                                                           */
  /* ---------------------------------------------------------------- */

  function startReview() {
    reviewQueue = store.dueCards();
    reviewIndex = 0;
    reviewFlipped = false;
    reviewDone = reviewQueue.length === 0;
    renderReview();
  }

  function renderReview() {
    const { due, total } = store.counts();
    els.reviewCount.textContent = `${due} due · ${total} in deck`;
    els.reviewRestart.hidden = !store.cards.length;

    const card = reviewQueue[reviewIndex];
    els.reviewGrades.hidden = true;
    els.reviewBack.hidden = true;
    els.reviewFlip.hidden = true;
    els.reviewTopic.textContent = "";
    els.reviewNote.textContent = "";

    if (!total) {
      els.reviewFront.textContent = "No cards yet.";
      els.reviewNote.textContent = "Make cards in the Deck tab first.";
      return;
    }
    if (!card) {
      els.reviewFront.textContent = "All done for now 🎉";
      els.reviewNote.textContent = due
        ? `${due} card${due === 1 ? "" : "s"} will be due soon.`
        : "Come back tomorrow — spacing is what makes it stick.";
      return;
    }

    els.reviewTopic.textContent = card.topic || "Card";
    els.reviewFront.textContent = card.front;
    els.reviewFlip.hidden = false;
    els.reviewNote.textContent = `${reviewIndex + 1} of ${reviewQueue.length}`;
  }

  function flipReview() {
    const card = reviewQueue[reviewIndex];
    if (!card || reviewFlipped) return;
    reviewFlipped = true;
    els.reviewBack.textContent = card.back;
    els.reviewBack.hidden = false;
    els.reviewFlip.hidden = true;
    els.reviewGrades.hidden = false;
  }

  els.reviewFlip?.addEventListener("click", flipReview);

  for (const btn of els.reviewGrades?.querySelectorAll("[data-grade]") || []) {
    btn.addEventListener("click", () => {
      const card = reviewQueue[reviewIndex];
      if (!card || !reviewFlipped) return;
      store.grade(card.id, btn.dataset.grade);
      store.log("card");
      reviewIndex += 1;
      reviewFlipped = false;
      renderReview();
      refreshBadge();
    });
  }

  els.reviewRestart?.addEventListener("click", () => {
    startReview();
    bridge.toast("Review restarted");
  });

  /* ---------------------------------------------------------------- */
  /* Practice exam                                                    */
  /* ---------------------------------------------------------------- */

  function stopTimer() {
    if (examTimerId) window.clearInterval(examTimerId);
    examTimerId = 0;
  }

  function setExamStatus(text, tone = "") {
    els.examStatus.textContent = text;
    els.examStatus.className = `study-status${tone ? ` ${tone}` : ""}`;
  }

  function renderPaper() {
    els.examQuestions.innerHTML = "";
    if (!paper) return;

    paper.forEach((question, index) => {
      const block = document.createElement("article");
      block.className = "exam-q";

      const head = document.createElement("div");
      head.className = "exam-q-head";
      const number = document.createElement("span");
      number.className = "exam-q-num";
      number.textContent = `Q${index + 1}`;
      const marks = document.createElement("span");
      marks.className = "exam-q-marks";
      marks.textContent = `${question.marks} mark${question.marks === 1 ? "" : "s"}`;
      head.append(number, marks);

      const body = document.createElement("div");
      body.className = "exam-q-body";
      body.innerHTML = renderMarkdown(question.question);

      const label = document.createElement("label");
      label.className = "sr-only";
      label.htmlFor = `exam-answer-${index}`;
      label.textContent = `Your answer to question ${index + 1}`;

      const answer = document.createElement("textarea");
      answer.className = "field-input field-textarea exam-answer";
      answer.id = `exam-answer-${index}`;
      answer.rows = 3;
      answer.placeholder = "Write your answer here…";
      answer.dataset.index = String(index);

      const scheme = document.createElement("div");
      scheme.className = "exam-scheme";
      scheme.hidden = true;
      scheme.dataset.index = String(index);
      scheme.innerHTML = question.answer
        ? `<span class="exam-scheme-label">Mark scheme</span>${renderMarkdown(question.answer)}`
        : '<span class="exam-scheme-label">No mark scheme returned.</span>';

      block.append(head, body, label, answer, scheme);
      els.examQuestions.appendChild(block);
    });
  }

  function toggleScheme() {
    schemeOpen = !schemeOpen;
    for (const node of els.examQuestions.querySelectorAll(".exam-scheme")) {
      node.hidden = !schemeOpen;
    }
    els.examScheme.textContent = schemeOpen ? "Hide mark scheme" : "Show mark scheme";
  }

  els.examGenerate?.addEventListener("click", async () => {
    const topic = els.examTopic.value.trim();
    if (!topic) {
      setExamStatus("Type a subject or topic first.", "err");
      els.examTopic.focus();
      return;
    }
    const count = Number(els.examCount.value) || 5;
    els.examGenerate.disabled = true;
    setExamStatus("Writing the paper…");
    try {
      const reply = await bridge.ask(
        [
          `Write a ${count}-question practice exam on “${topic}” for a university student.`,
          "Return ONLY a JSON array — no prose, no code fences — of objects with exactly these keys:",
          '{"question": "the full question text", "marks": 5, "answer": "the mark scheme: the points that earn marks"}',
          "Include a mix of short recall, application and one longer question. Marks should add up sensibly.",
        ].join("\n"),
        { maxTokens: 2000 }
      );
      const questions = parseExam(reply, topic);
      if (!questions.length) {
        setExamStatus("The model didn't return a usable paper. Try again.", "err");
        return;
      }
      paper = questions;
      paperTitle = topic;
      schemeOpen = false;
      stopTimer();
      examStartedAt = Date.now();
      els.examTimer.textContent = "00:00";
      examTimerId = window.setInterval(() => {
        els.examTimer.textContent = formatClock(Date.now() - examStartedAt);
      }, 1000);

      els.examTitle.textContent = `Practice paper · ${topic}`;
      els.examScheme.textContent = "Show mark scheme";
      els.examResult.hidden = true;
      els.examResult.innerHTML = "";
      els.examPaper.hidden = false;
      renderPaper();
      setExamStatus(`${questions.length} questions ready. Timer running.`, "ok");
      store.log("exam");
      els.examPaper.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (err) {
      setExamStatus(err?.message || "Could not build the paper.", "err");
    } finally {
      els.examGenerate.disabled = false;
    }
  });

  els.examScheme?.addEventListener("click", toggleScheme);

  els.examMark?.addEventListener("click", async () => {
    if (!paper) return;
    const answers = [...els.examQuestions.querySelectorAll(".exam-answer")].map((area) =>
      area.value.trim()
    );
    if (!answers.some(Boolean)) {
      setExamStatus("Write at least one answer before marking.", "err");
      return;
    }
    els.examMark.disabled = true;
    stopTimer();
    setExamStatus("Marking your answers…");
    try {
      const script = paper
        .map((q, i) => `Q${i + 1} (${q.marks} marks): ${q.question}\nStudent answer: ${answers[i] || "(blank)"}`)
        .join("\n\n");
      const reply = await bridge.ask(
        [
          "Mark this practice exam as a fair but encouraging tutor.",
          "For each question give: a mark out of the available marks, what earned marks, what was missing, and one line of feedback.",
          "Finish with a total, then the two topics to revise first. Use a Markdown table for the marks. Keep it under 350 words.",
          `Subject: ${paperTitle}`,
          "",
          script,
        ].join("\n"),
        { maxTokens: 1600 }
      );
      els.examResult.innerHTML = renderMarkdown(reply);
      els.examResult.hidden = false;
      setExamStatus("Marked. Read the feedback, then revise the weakest topic.", "ok");
      els.examTimer.textContent = "done";
    } catch (err) {
      setExamStatus(err?.message || "Could not mark the paper.", "err");
    } finally {
      els.examMark.disabled = false;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Notes + formulas                                                 */
  /* ---------------------------------------------------------------- */

  function setNoteStatus(text, tone = "") {
    els.noteStatus.textContent = text;
    els.noteStatus.className = `study-status${tone ? ` ${tone}` : ""}`;
  }

  function renderNotes() {
    els.notesCount.textContent = store.notes.length
      ? `${store.notes.length} saved`
      : "none yet";
    els.notesUse.checked = store.pref("useNotes");
    els.notesList.innerHTML = "";

    if (!store.notes.length) {
      const empty = document.createElement("p");
      empty.className = "study-empty";
      empty.textContent = "No notes imported. Paste your lecture notes above to have Nova answer from them.";
      els.notesList.appendChild(empty);
    }

    for (const note of store.notes) {
      const row = document.createElement("article");
      row.className = "note-row";

      const head = document.createElement("div");
      head.className = "note-head";
      const title = document.createElement("strong");
      title.textContent = note.title;
      const subject = document.createElement("span");
      subject.className = "cat-badge";
      subject.textContent = note.subject;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "mini-btn icon-only";
      del.title = "Delete notes";
      del.setAttribute("aria-label", `Delete notes: ${note.title}`);
      del.innerHTML = icon("trash");
      del.addEventListener("click", async () => {
        const ok = await bridge.confirm({
          title: "Delete these notes?",
          message: `“${note.title}” will be removed from this browser.`,
          confirmLabel: "Delete",
        });
        if (!ok) return;
        store.removeNote(note.id);
        renderNotes();
        bridge.toast("Notes deleted");
      });

      head.append(title, subject, del);

      const body = document.createElement("p");
      body.className = "note-body";
      body.textContent = note.text.length > 260 ? `${note.text.slice(0, 260)}…` : note.text;

      row.append(head, body);
      els.notesList.appendChild(row);
    }
  }

  els.notesFromChat?.addEventListener("click", async () => {
    const chat = bridge.currentChat();
    if (!chat.text.trim()) {
      bridge.toast("Start a conversation first");
      return;
    }
    els.notesFromChat.disabled = true;
    els.notesPreview.textContent = "Writing notes…";
    try {
      const reply = await bridge.ask(
        [
          "Turn this study conversation into concise revision notes in Markdown.",
          "Structure: a short summary, key definitions, formulas (use LaTeX), one worked example, and three likely exam questions with one-line answers.",
          "Only include what the conversation actually covered. Keep it under 500 words.",
          "",
          clip(chat.text, 9000),
        ].join("\n"),
        { maxTokens: 1600 }
      );
      els.notesPreview.innerHTML = "";
      const content = document.createElement("div");
      content.className = "notes-rendered";
      content.innerHTML = renderMarkdown(reply);
      const actions = document.createElement("div");
      actions.className = "study-row";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "text-btn";
      copy.textContent = "Copy";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(reply);
          bridge.toast("Notes copied");
        } catch {
          bridge.toast("Could not copy");
        }
      });

      const save = document.createElement("button");
      save.type = "button";
      save.className = "text-btn";
      save.textContent = "Download .md";
      save.addEventListener("click", () => {
        download(`nova-notes-${stamp()}.md`, `# ${chat.title}\n\n${reply}`, "text/markdown;charset=utf-8");
        bridge.toast("Notes downloaded");
      });

      const keep = document.createElement("button");
      keep.type = "button";
      keep.className = "primary-btn";
      keep.textContent = "Save to my notes";
      keep.addEventListener("click", () => {
        const note = store.addNote({
          title: `Notes: ${chat.title}`.slice(0, 90),
          subject: store.notes[0]?.subject || "Other",
          text: reply,
        });
        if (note) {
          renderNotes();
          bridge.toast("Saved to your notes");
        } else {
          bridge.toast("Could not save those notes");
        }
      });

      actions.append(copy, save, keep);
      els.notesPreview.append(content, actions);
    } catch (err) {
      els.notesPreview.textContent = err?.message || "Could not write notes.";
    } finally {
      els.notesFromChat.disabled = false;
    }
  });

  // Subject options for the import form.
  if (els.noteSubject && !els.noteSubject.options.length) {
    for (const subject of SUBJECTS) {
      const option = document.createElement("option");
      option.value = subject;
      option.textContent = subject;
      els.noteSubject.appendChild(option);
    }
  }

  els.noteAdd?.addEventListener("click", () => {
    const text = els.noteText.value.trim();
    if (text.length < 40) {
      setNoteStatus("Paste a bit more of your notes (at least 40 characters).", "err");
      return;
    }
    const note = store.addNote({
      title: els.noteTitle.value.trim() || "Lecture notes",
      subject: els.noteSubject.value || "Other",
      text,
    });
    if (!note) {
      setNoteStatus("Could not save those notes.", "err");
      return;
    }
    els.noteTitle.value = "";
    els.noteText.value = "";
    setNoteStatus("Notes saved. Turn on “Use in replies” to answer from them.", "ok");
    renderNotes();
    bridge.toast("Notes imported");
  });

  els.notesUse?.addEventListener("change", () => {
    store.setPref("useNotes", els.notesUse.checked);
    bridge.toast(els.notesUse.checked ? "Answers will use your notes" : "Notes context off");
  });

  els.formulasExtract?.addEventListener("click", () => {
    const chat = bridge.currentChat();
    const formulas = extractFormulas(chat.text);
    els.formulasList.innerHTML = "";
    if (!formulas.length) {
      const empty = document.createElement("p");
      empty.className = "study-empty";
      empty.textContent = "No equations found in this conversation yet.";
      els.formulasList.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "formula-list";
    for (const formula of formulas) {
      const item = document.createElement("li");
      item.innerHTML = renderMarkdown(`$$${formula}$$`);
      list.appendChild(item);
    }
    const actions = document.createElement("div");
    actions.className = "study-row";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "text-btn";
    copy.textContent = "Copy sheet";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(formulas.map((f) => `- ${f}`).join("\n"));
        bridge.toast("Formula sheet copied");
      } catch {
        bridge.toast("Could not copy");
      }
    });
    const save = document.createElement("button");
    save.type = "button";
    save.className = "text-btn";
    save.textContent = "Download .md";
    save.addEventListener("click", () => {
      download(
        `nova-formulas-${stamp()}.md`,
        `# Formula sheet — ${chat.title}\n\n${formulas.map((f) => `- $${f}$`).join("\n")}`,
        "text/markdown;charset=utf-8"
      );
      bridge.toast("Formula sheet downloaded");
    });
    actions.append(copy, save);
    els.formulasList.append(list, actions);
  });

  /* ---------------------------------------------------------------- */
  /* Plotter                                                          */
  /* ---------------------------------------------------------------- */

  function plot() {
    const expression = els.plotInput.value.trim() || "y = x^2 - 1";
    const result = drawPlot(els.plotCanvas, expression, { xMin: -10, xMax: 10 });
    if (!result.ok) {
      els.plotStatus.textContent = result.error;
      els.plotStatus.className = "study-status err";
      return;
    }
    els.plotStatus.textContent = `x ∈ [${result.range.xMin}, ${result.range.xMax}] · y ∈ [${result.range.yMin}, ${result.range.yMax}]`;
    els.plotStatus.className = "study-status";
  }

  els.plotDraw?.addEventListener("click", plot);
  els.plotInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      plot();
    }
  });

  /* ---------------------------------------------------------------- */
  /* Progress                                                         */
  /* ---------------------------------------------------------------- */

  function renderProgress() {
    const today = store.today();
    const totals = store.totals();
    els.statStreak.textContent = String(store.streak());
    els.statAnswers.textContent = String(today.answers);
    els.statCards.textContent = String(today.cards);
    els.statTotal.textContent = String(store.cards.length);

    const week = store.week();
    const max = Math.max(1, ...week.map((day) => day.total));
    els.weekChart.innerHTML = "";
    for (const day of week) {
      const column = document.createElement("div");
      column.className = "week-day";
      const bar = document.createElement("span");
      bar.className = "week-bar";
      bar.style.height = `${Math.round((day.total / max) * 72) + 4}px`;
      bar.title = `${day.answers} replies · ${day.cards} cards`;
      const label = document.createElement("small");
      label.textContent = day.label;
      const value = document.createElement("em");
      value.textContent = day.total ? String(day.total) : "";
      column.append(value, bar, label);
      els.weekChart.appendChild(column);
    }

    if (totals.answers + totals.cards + totals.exams === 0) {
      els.weekChart.title = "Your week fills up as you study.";
    }
  }

  els.statsReset?.addEventListener("click", async () => {
    const ok = await bridge.confirm({
      title: "Reset progress?",
      message: "Your study log, streak and weekly chart are cleared. Cards and notes are kept.",
      confirmLabel: "Reset",
    });
    if (!ok) return;
    store.resetStats();
    renderProgress();
    bridge.toast("Progress reset");
  });

  /* ---------------------------------------------------------------- */
  /* Wiring                                                           */
  /* ---------------------------------------------------------------- */

  els.tabs?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tab]");
    if (!btn) return;
    setTab(btn.dataset.tab);
  });

  // Roving focus, as expected of a real tablist.
  els.tabs?.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const tabs = [...els.tabs.querySelectorAll("[data-tab]")];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    tabs[next].focus();
    setTab(tabs[next].dataset.tab);
  });

  els.close?.addEventListener("click", () => els.dialog.close());
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) els.dialog.close();
  });
  els.dialog.addEventListener("close", () => {
    stopTimer();
    window.speechSynthesis?.cancel?.();
  });

  document.addEventListener("keydown", (event) => {
    if (!els.dialog.open) return;
    if (event.key === " " && document.activeElement === document.body) {
      event.preventDefault();
      if (document.querySelector('[data-pane="review"]')?.hidden === false) flipReview();
    }
  });

  renderDeck();
  renderNotes();
  refreshBadge();

  return {
    open,
    refreshBadge,
    logAnswer() {
      store.log("answer");
      if (els.dialog.open) renderProgress();
    },
    contextFor(text) {
      return store.pref("useNotes") ? store.contextFor(text) : "";
    },
    useNotes() {
      return store.pref("useNotes");
    },
    showSteps() {
      return store.pref("showSteps");
    },
    setShowSteps(value) {
      store.setPref("showSteps", Boolean(value));
    },
    store,
  };
}
