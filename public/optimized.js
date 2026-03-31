import { parsePassageHtml } from "./passage-utils.js";
import { normalizeWord } from "./memorize-core.js";
import {
  beginOptimizedStage,
  createOptimizedPassage,
  createOptimizedSession,
  getOptimizedPrompt,
  getOptimizedStats,
  submitOptimizedWord,
} from "./optimized-core.js";

const referenceInput = document.querySelector("#reference-input");
const translationSelect = document.querySelector("#translation-select");
const passageForm = document.querySelector("#passage-form");
const answerForm = document.querySelector("#answer-form");
const answerField = document.querySelector("#answer-field");
const answerSubmitButton = document.querySelector("#answer-submit-button");
const guessInput = document.querySelector("#guess-input");
const restartButton = document.querySelector("#restart-button");
const passageTitle = document.querySelector("#passage-title");
const statusMessage = document.querySelector("#status-message");
const practiceCard = document.querySelector("#practice-card");
const chunkList = document.querySelector("#chunk-list");
const progressValue = document.querySelector("#progress-value");
const supportValue = document.querySelector("#support-value");
let workspaceScrollFrame = 0;

const state = {
  loading: false,
  passage: null,
  session: null,
  notice: "",
};

applyTheme();
render();

passageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadPassage();
});

answerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitAnswer();
});

guessInput.addEventListener("input", (event) => {
  if (
    event.isComposing ||
    !state.session ||
    state.loading ||
    state.session.stage.type === "study"
  ) {
    return;
  }

  const prompt = getOptimizedPrompt(state.session);
  if (!prompt?.word) {
    return;
  }

  if (normalizeWord(guessInput.value) !== prompt.word.normalized) {
    return;
  }

  submitAnswer();
});

document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.key !== "Enter" ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !state.session ||
    state.loading ||
    state.session.stage.type !== "study"
  ) {
    return;
  }

  const target = event.target;
  if (target instanceof HTMLElement && (passageForm.contains(target) || answerForm.contains(target))) {
    return;
  }

  event.preventDefault();
  beginRecall();
});

restartButton.addEventListener("click", () => {
  if (!state.passage) {
    return;
  }

  state.session = createOptimizedSession(createOptimizedPassage(state.passage));
  render();
});

async function loadPassage() {
  const reference = referenceInput.value.trim();
  const translation = translationSelect.value;

  if (!reference) {
    state.notice = "Enter a Bible reference to begin.";
    render();
    referenceInput.focus();
    return;
  }

  state.loading = true;
  state.notice = "";
  render();

  try {
    const response = await fetch(
      `/api/passage?reference=${encodeURIComponent(reference)}&translation=${encodeURIComponent(
        translation,
      )}`,
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to load that passage.");
    }

    const parsedPassage = parsePassageHtml(payload.html, payload.requestedReference, payload.translation);
    state.passage = parsedPassage;
    state.session = createOptimizedSession(createOptimizedPassage(parsedPassage));
    state.notice = "";
    render();
  } catch (error) {
    state.passage = null;
    state.session = null;
    state.notice = error instanceof Error ? error.message : "Unable to load that passage.";
    render();
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  renderTitle();
  renderStatus();
  renderPractice();
  renderChunkList();
  renderStats();
  renderControls();
  syncWorkspaceVisibility();
}

function renderTitle() {
  if (!state.passage) {
    passageTitle.textContent = "Load a passage to begin.";
    return;
  }

  passageTitle.textContent = `${state.passage.referenceLabel} (${state.passage.translation})`;
}

function renderStatus() {
  if (state.loading) {
    statusMessage.textContent = "Loading passage...";
    return;
  }

  if (!state.session) {
    statusMessage.textContent = state.notice || "Choose a verse or range to begin.";
    return;
  }

  const prompt = getOptimizedPrompt(state.session);
  switch (state.session.feedback.type) {
    case "ready-to-study":
      statusMessage.textContent = "Study this section, then press Begin Recall.";
      break;
    case "chunk-recall-start":
      statusMessage.textContent = getRecallProgressText(state.session, prompt);
      break;
    case "correct-word":
      statusMessage.textContent = getRecallProgressText(state.session, prompt);
      break;
    case "mistake":
      statusMessage.textContent = `The correct word was "${state.session.feedback.revealedWord}".`;
      break;
    case "chunk-cleared":
      statusMessage.textContent = `${state.session.feedback.chunkLabel} cleared. It will return later in the session.`;
      break;
    case "chunk-mastered":
      statusMessage.textContent = `${state.session.feedback.chunkLabel} reached the mastery criterion.`;
      break;
    case "final-round-cleared":
      statusMessage.textContent = "Full passage cleared. One last round remains.";
      break;
    case "completed":
      statusMessage.textContent = "Complete. Session finished.";
      break;
    case "empty-answer":
      statusMessage.textContent = "Make a guess before getting help.";
      break;
    default:
      if (prompt?.type === "study") {
        statusMessage.textContent = "Study this section, then press Begin Recall.";
      } else if (prompt) {
        statusMessage.textContent = getRecallProgressText(state.session, prompt);
      } else {
        statusMessage.textContent = "The passage is ready.";
      }
      break;
  }
}

function renderPractice() {
  practiceCard.innerHTML = "";

  if (!state.session) {
    practiceCard.classList.add("is-empty");
    practiceCard.innerHTML = `
      <div class="empty-state">
        <p class="empty-kicker">MemoryVerse</p>
        <p>Load a passage to begin.</p>
      </div>
    `;
    return;
  }

  practiceCard.classList.remove("is-empty");
  const prompt = getOptimizedPrompt(state.session);
  if (!prompt) {
    return;
  }

  if (prompt.type === "study") {
    const studyCard = document.createElement("div");
    studyCard.className = "study-card";
    studyCard.innerHTML = `
      <p class="eyebrow">Study ${escapeHtml(prompt.chunk.label)}</p>
      <p class="chunk-study-text">${escapeHtml(prompt.chunk.text)}</p>
    `;
    practiceCard.appendChild(studyCard);
    return;
  }

  if (prompt.type === "chunk-recall") {
    renderChunkText(practiceCard, prompt.chunk.segments, state.session.promptPosition, prompt.cueStyle);
    return;
  }

  renderPassageText(practiceCard, state.session.passage, state.session.promptPosition, prompt.cueStyle);
}

function renderChunkText(container, segments, promptPosition, cueStyle) {
  let wordCursor = 0;

  for (const segment of segments) {
    if (segment.type === "text") {
      container.appendChild(document.createTextNode(segment.text));
      continue;
    }

    if (wordCursor < promptPosition) {
      const cleared = document.createElement("span");
      cleared.className = "word word-cleared";
      cleared.textContent = segment.text;
      container.appendChild(cleared);
      wordCursor += 1;
      continue;
    }

    const cue = buildCue(segment.text, cueStyle, wordCursor === promptPosition);
    container.appendChild(cue);
    wordCursor += 1;
  }
}

function renderPassageText(container, passage, promptPosition, cueStyle) {
  let wordCursor = 0;
  const hideableSet = new Set(passage.hideableWordIndices);

  for (let index = 0; index < passage.segments.length; index += 1) {
    const segment = passage.segments[index];

    if (segment.type === "verse-number") {
      const verseNumber = document.createElement("span");
      verseNumber.className = "verse-number";
      verseNumber.textContent = segment.text;
      container.appendChild(verseNumber);
      continue;
    }

    if (segment.type === "text") {
      container.appendChild(document.createTextNode(segment.text));
      continue;
    }

    if (!hideableSet.has(index)) {
      const word = document.createElement("span");
      word.className = "word";
      word.textContent = segment.text;
      container.appendChild(word);
      continue;
    }

    if (wordCursor < promptPosition) {
      const cleared = document.createElement("span");
      cleared.className = "word word-cleared";
      cleared.textContent = segment.text;
      container.appendChild(cleared);
      wordCursor += 1;
      continue;
    }

    const cue = buildCue(segment.text, cueStyle, wordCursor === promptPosition);
    container.appendChild(cue);
    wordCursor += 1;
  }
}

function buildCue(wordText, cueStyle, isCurrent) {
  const cue = document.createElement("span");
  cue.className = "word-gap";
  cue.style.setProperty("--gap-width", String(Math.max(wordText.length, 3)));

  if (isCurrent) {
    cue.classList.add("is-current");
  }

  if (cueStyle === "first-letter") {
    cue.classList.add("has-cue");
    cue.textContent = `${wordText[0]}${".".repeat(Math.max(wordText.length - 1, 1))}`;
  }

  return cue;
}

function renderChunkList() {
  chunkList.innerHTML = "";

  if (!state.session) {
    return;
  }

  state.session.chunks.forEach((chunk, index) => {
    const item = document.createElement("article");
    item.className = "chunk-card";

    if (
      (state.session.stage.type === "study" || state.session.stage.type === "chunk-recall") &&
      state.session.stage.chunkIndex === index
    ) {
      item.classList.add("is-active");
    }

    if (chunk.complete) {
      item.classList.add("is-complete");
    }

    item.innerHTML = `
      <div class="chunk-card-header">
        <strong>${escapeHtml(chunk.label)}</strong>
        <span class="chunk-badge">${chunk.mastery} / 3</span>
      </div>
      <p>${escapeHtml(chunk.text)}</p>
    `;
    chunkList.appendChild(item);
  });
}

function renderStats() {
  if (!state.session) {
    progressValue.textContent = "--";
    supportValue.textContent = "--";
    return;
  }

  const stats = getOptimizedStats(state.session);
  progressValue.textContent = `${stats.completedChunks} / ${stats.totalChunks}`;

  if (state.session.stage.type === "study") {
    supportValue.textContent = "Study";
    return;
  }

  if (state.session.stage.type === "final-recall") {
    supportValue.textContent =
      state.session.stage.cueStyle === "first-letter"
        ? `Final ${state.session.finalRound + 1}: Letter cues`
        : `Final ${state.session.finalRound + 1}: Blank only`;
    return;
  }

  supportValue.textContent =
    state.session.stage.cueStyle === "first-letter" ? "First-letter cues" : "Blank only";
}

function renderControls() {
  const isStudy = state.session?.stage.type === "study";
  const isDone = state.session?.complete;

  answerField.toggleAttribute("hidden", Boolean(isStudy));
  answerField.setAttribute("aria-hidden", isStudy ? "true" : "false");
  answerForm.classList.toggle("is-study-action", Boolean(isStudy));
  guessInput.disabled = !state.session || isStudy || Boolean(isDone) || state.loading;
  answerSubmitButton.textContent = isStudy ? "Begin Recall" : "Help";
  answerSubmitButton.disabled = !state.session || Boolean(isDone) || state.loading;
  guessInput.placeholder = isStudy
    ? "Click Begin Recall"
    : isDone
      ? "Session complete"
      : "Type the next word in order";
  restartButton.disabled = !state.passage || state.loading;
}

function syncWorkspaceVisibility() {
  cancelAnimationFrame(workspaceScrollFrame);

  workspaceScrollFrame = requestAnimationFrame(() => {
    const currentPrompt = practiceCard.querySelector(".is-current");
    if (currentPrompt) {
      currentPrompt.scrollIntoView({
        block: "center",
        inline: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    } else if (state.session?.stage.type === "study") {
      practiceCard.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      answerSubmitButton.focus({ preventScroll: true });
    }

    const activeChunk = chunkList.querySelector(".is-active");
    if (!activeChunk) {
      return;
    }

    activeChunk.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = "dark";
}

function beginRecall() {
  if (!state.session || state.loading || state.session.stage.type !== "study") {
    return;
  }

  state.session = beginOptimizedStage(state.session);
  render();
  guessInput.focus();
}

function submitAnswer() {
  if (!state.session || state.loading) {
    return;
  }

  if (state.session.stage.type === "study") {
    beginRecall();
    return;
  }

  state.session = submitOptimizedWord(state.session, guessInput.value);
  guessInput.value = "";
  render();

  if (state.session && !state.session.complete && state.session.stage.type !== "study") {
    guessInput.focus({ preventScroll: true });
  }
}

function getRecallProgressText(session, prompt) {
  if (!prompt || prompt.type === "study") {
    return "";
  }

  return `${session.promptPosition}/${prompt.totalPrompts}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
