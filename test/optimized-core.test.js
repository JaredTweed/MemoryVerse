import test from "node:test";
import assert from "node:assert/strict";

import { createPassage } from "../public/memorize-core.js";
import {
  beginOptimizedStage,
  createOptimizedFinalTestSession,
  createOptimizedPassage,
  createOptimizedSession,
  getOptimizedPrompt,
  restartOptimizedFinalTest,
  submitOptimizedWord,
} from "../public/optimized-core.js";

function buildTwoChunkPassage() {
  return createPassage({
    heading: "Romans 5:1, NLT",
    referenceLabel: "Romans 5:1",
    translation: "NLT",
    verses: [
      {
        number: "1",
        text: "Grace makes peace, and peace grows courage.",
      },
    ],
  });
}

function buildTenChunkPassage() {
  return createPassage({
    heading: "Sample 1:1, NLT",
    referenceLabel: "Sample 1:1",
    translation: "NLT",
    verses: [
      {
        number: "1",
        text:
          "one alpha, two beta, three gamma, four delta, five epsilon, six zeta, seven eta, eight theta, nine iota, ten kappa.",
      },
    ],
  });
}

function clearCurrentLine(session) {
  let current = session;

  if (current.stage.type === "study") {
    current = beginOptimizedStage(current);
  }

  while (!current.complete && current.stage.type === "chunk-recall") {
    const prompt = getOptimizedPrompt(current);
    current = submitOptimizedWord(current, prompt.word.text);
  }

  return current;
}

function clearFinalRecall(session) {
  let current = session;

  while (!current.complete && current.stage.type === "final-recall") {
    const prompt = getOptimizedPrompt(current);
    current = submitOptimizedWord(current, prompt.word.text);
  }

  return current;
}

test("optimized passage keeps each chunk at two words or more when possible", () => {
  const optimized = createOptimizedPassage(
    createPassage({
      heading: "Sample 1:1, NLT",
      referenceLabel: "Sample 1:1",
      translation: "NLT",
      verses: [
        {
          number: "1",
          text: "Grace builds, hope, steady courage.",
        },
      ],
    }),
  );

  assert.equal(optimized.chunks.length, 2);
  assert.ok(optimized.chunks.every((chunk) => chunk.words.length >= 2));
});

test("optimized passage builds the recursive chunk plan in the requested order", () => {
  const optimized = createOptimizedPassage(buildTenChunkPassage());

  assert.equal(optimized.chunks.length, 10);
  assert.deepEqual(
    optimized.plan.map((unit) => [unit.startChunkIndex + 1, unit.endChunkIndex + 1]),
    [
      [1, 1],
      [2, 2],
      [1, 2],
      [3, 3],
      [1, 3],
      [4, 4],
      [5, 5],
      [4, 5],
      [6, 6],
      [4, 6],
      [1, 6],
      [7, 7],
      [8, 8],
      [7, 8],
      [9, 9],
      [7, 9],
      [1, 9],
      [10, 10],
      [1, 10],
    ],
  );
});

test("each plan line moves from study to letter cues to blank only", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildTwoChunkPassage()));
  let prompt = getOptimizedPrompt(session);

  assert.equal(prompt.type, "study");
  assert.equal(prompt.chunk.label, "Verse 1.1");

  session = beginOptimizedStage(session);
  prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.cueStyle, "first-letter");

  while (session.stage.type === "chunk-recall" && session.stage.cueStyle === "first-letter") {
    prompt = getOptimizedPrompt(session);
    session = submitOptimizedWord(session, prompt.word.text);
  }

  prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.cueStyle, "blank");

  while (session.stage.type === "chunk-recall") {
    prompt = getOptimizedPrompt(session);
    session = submitOptimizedWord(session, prompt.word.text);
  }

  prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "study");
  assert.equal(prompt.chunk.label, "Verse 1.2");
  assert.equal(session.chunks[0].mastery, 2);
  assert.equal(session.chunks[0].complete, true);
});

test("a mistake resets the current line and restores first-letter cues", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildTwoChunkPassage()));

  session = beginOptimizedStage(session);

  while (session.stage.type === "chunk-recall" && session.stage.cueStyle === "first-letter") {
    const prompt = getOptimizedPrompt(session);
    session = submitOptimizedWord(session, prompt.word.text);
  }

  let prompt = getOptimizedPrompt(session);
  assert.equal(prompt.cueStyle, "blank");

  session = submitOptimizedWord(session, "wrong");
  prompt = getOptimizedPrompt(session);

  assert.equal(session.feedback.type, "mistake");
  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.promptPosition, 0);
  assert.equal(prompt.cueStyle, "first-letter");
});

test("after the last planned line, the session moves into final blank-only recall", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildTwoChunkPassage()));

  while (session.stage.type !== "final-recall") {
    session = clearCurrentLine(session);
  }

  const prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "final-recall");
  assert.equal(prompt.cueStyle, "blank");
  assert.equal(session.finalRound, 1);
});

test("skip-to-final session starts in blank-only final recall", () => {
  const session = createOptimizedFinalTestSession(createOptimizedPassage(buildTwoChunkPassage()));
  const prompt = getOptimizedPrompt(session);

  assert.equal(session.complete, false);
  assert.equal(session.finalRound, 1);
  assert.equal(prompt.type, "final-recall");
  assert.equal(prompt.cueStyle, "blank");
  assert.equal(prompt.word.text, "Grace");
});

test("final test can be restarted in blank-only mode after a failed run", () => {
  let session = createOptimizedFinalTestSession(createOptimizedPassage(buildTwoChunkPassage()));

  session = submitOptimizedWord(session, "wrong");
  session = restartOptimizedFinalTest(session);

  const prompt = getOptimizedPrompt(session);
  assert.equal(session.complete, false);
  assert.equal(session.feedback.type, "final-test-retry");
  assert.equal(prompt.type, "final-recall");
  assert.equal(prompt.cueStyle, "blank");
  assert.equal(prompt.promptPosition, 0);
});

test("final blank-only recall completes once every word is answered", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildTwoChunkPassage()));

  while (session.stage.type !== "final-recall") {
    session = clearCurrentLine(session);
  }

  session = clearFinalRecall(session);

  assert.equal(session.complete, true);
  assert.equal(session.feedback.type, "completed");
});
