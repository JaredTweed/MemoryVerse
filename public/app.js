import {
  createSession,
  getPrompt,
  submitWord,
} from "./memorize-core.js";
import { parsePassageHtml } from "./passage-utils.js";

const referenceInput = document.querySelector("#reference-input");
const translationSelect = document.querySelector("#translation-select");
const passageForm = document.querySelector("#passage-form");
const answerForm = document.querySelector("#answer-form");
const guessInput = document.querySelector("#guess-input");
const restartButton = document.querySelector("#restart-button");
const passageTitle = document.querySelector("#passage-title");
const statusMessage = document.querySelector("#status-message");
const passageCard = document.querySelector("#passage-card");
const hiddenCountValue = document.querySelector("#hidden-count");
const promptValue = document.querySelector("#prompt-count");
const totalWordsValue = document.querySelector("#total-words");
const themeButtons = document.querySelectorAll("[data-theme-value]");
let promptScrollFrame = 0;

const state = {
  loading: false,
  passage: null,
  session: null,
  notice: "",
  theme: getInitialTheme(),
};

applyTheme(state.theme);
render();

passageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadPassage();
});

answerForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!state.session || state.loading) {
    return;
  }

  state.session = submitWord(state.session, guessInput.value);
  guessInput.value = "";
  render();
});

restartButton.addEventListener("click", () => {
  if (!state.passage) {
    return;
  }

  state.session = createSession(state.passage);
  render();
  guessInput.focus();
});

for (const button of themeButtons) {
  button.addEventListener("click", () => {
    state.theme = button.dataset.themeValue || "light";
    localStorage.setItem("memoryverse-theme", state.theme);
    applyTheme(state.theme);
    renderThemeButtons();
  });
}

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
    state.session = createSession(parsedPassage);
    state.notice = "";
    render();
    guessInput.focus();
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
  renderThemeButtons();
  renderTitle();
  renderStatus();
  renderPassage();
  renderStats();
  renderControls();
  syncPromptVisibility();
}

function renderTitle() {
  if (!state.passage) {
    passageTitle.textContent = "Choose a verse and start drilling it from memory.";
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
    statusMessage.textContent =
      state.notice ||
      "Pick a reference, choose a translation, and the app will hide one random word to start the round.";
    return;
  }

  const prompt = getPrompt(state.session);

  switch (state.session.feedback.type) {
    case "empty-answer":
      statusMessage.textContent = "Type the current missing word before submitting.";
      break;
    case "correct-word":
      statusMessage.textContent = `Correct. Keep going with word ${prompt.promptPosition + 1} of ${prompt.hiddenCount}.`;
      break;
    case "round-advanced":
      statusMessage.textContent =
        "Round cleared. One more word is hidden now, so start again from the first missing word.";
      break;
    case "mistake-revealed-word":
      statusMessage.textContent = `Incorrect. "${state.session.feedback.revealedWord}" has reappeared, and you need to re-enter the remaining hidden words in order.`;
      break;
    case "mistake-restart":
      statusMessage.textContent =
        "Incorrect. The missed word reappeared, and a fresh single hidden word is ready for the next attempt.";
      break;
    case "completed":
      statusMessage.textContent =
        "Complete. You typed the entire passage from memory in order.";
      break;
    default:
      if (prompt) {
        statusMessage.textContent = `Type missing word ${prompt.promptPosition + 1} of ${prompt.hiddenCount}.`;
      } else {
        statusMessage.textContent = "The passage is ready.";
      }
      break;
  }
}

function renderPassage() {
  passageCard.innerHTML = "";

  if (!state.passage || !state.session) {
    passageCard.classList.add("is-empty");
    passageCard.innerHTML = `
      <div class="empty-state">
        <p class="empty-kicker">MemoryVerse</p>
        <p>Load a verse or verse range to start hiding words one round at a time.</p>
      </div>
    `;
    return;
  }

  passageCard.classList.remove("is-empty");

  const hiddenWordIndices = new Set(state.session.hiddenWordIndices);
  const hiddenOrderLookup = new Map(
    state.session.hiddenWordIndices.map((segmentIndex, order) => [segmentIndex, order]),
  );

  for (let index = 0; index < state.passage.segments.length; index += 1) {
    const segment = state.passage.segments[index];

    if (segment.type === "verse-number") {
      const verseNumber = document.createElement("span");
      verseNumber.className = "verse-number";
      verseNumber.textContent = segment.text;
      passageCard.appendChild(verseNumber);
      continue;
    }

    if (segment.type === "text") {
      passageCard.appendChild(document.createTextNode(segment.text));
      continue;
    }

    const shouldHide = hiddenWordIndices.has(index) && !state.session.complete;

    if (!shouldHide) {
      const word = document.createElement("span");
      word.className = "word";
      word.textContent = segment.text;
      passageCard.appendChild(word);
      continue;
    }

    const order = hiddenOrderLookup.get(index) ?? 0;
    const gap = document.createElement("span");
    gap.className = "word-gap";
    gap.style.setProperty("--gap-width", String(Math.max(segment.text.length, 3)));

    if (order < state.session.promptPosition) {
      gap.classList.add("is-cleared");
    } else if (order === state.session.promptPosition) {
      gap.classList.add("is-current");
    }

    gap.setAttribute("aria-hidden", "true");
    passageCard.appendChild(gap);
  }
}

function renderStats() {
  if (!state.session) {
    hiddenCountValue.textContent = "--";
    promptValue.textContent = "--";
    totalWordsValue.textContent = "--";
    return;
  }

  const prompt = getPrompt(state.session);
  hiddenCountValue.textContent = String(state.session.hiddenWordIndices.length);
  promptValue.textContent = prompt
    ? `${prompt.promptPosition + 1} / ${prompt.hiddenCount}`
    : state.session.complete
      ? "Done"
      : "--";
  totalWordsValue.textContent = String(state.session.passage.totalWords);
}

function renderControls() {
  const disabled = state.loading || !state.session || state.session.complete;
  guessInput.disabled = disabled;
  guessInput.placeholder = state.session?.complete
    ? "Passage complete"
    : state.session
      ? "Type the current missing word"
      : "Load a passage first";
  restartButton.disabled = !state.passage || state.loading;
}

function syncPromptVisibility() {
  cancelAnimationFrame(promptScrollFrame);

  promptScrollFrame = requestAnimationFrame(() => {
    const currentPrompt = passageCard.querySelector(".is-current");

    if (!currentPrompt) {
      return;
    }

    currentPrompt.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  });
}

function renderThemeButtons() {
  for (const button of themeButtons) {
    const isActive = button.dataset.themeValue === state.theme;
    button.dataset.active = isActive ? "true" : "false";
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function getInitialTheme() {
  const savedTheme = localStorage.getItem("memoryverse-theme");
  if (savedTheme === "light" || savedTheme === "dark") {
    return savedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
