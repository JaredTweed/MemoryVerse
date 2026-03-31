import test from "node:test";
import assert from "node:assert/strict";

import { createPassage } from "../public/memorize-core.js";
import {
  beginOptimizedStage,
  createOptimizedFinalTestSession,
  createOptimizedPassage,
  createOptimizedSession,
  getOptimizedPrompt,
  submitOptimizedWord,
} from "../public/optimized-core.js";

function buildPassage() {
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

function clearCurrentStage(session) {
  let current = session;

  if (current.stage.type === "study") {
    current = beginOptimizedStage(current);
  }

  while (!current.complete) {
    const prompt = getOptimizedPrompt(current);
    if (!prompt || prompt.type === "study") {
      return current;
    }

    current = submitOptimizedWord(current, prompt.word.text);
    if (current.promptPosition === 0 && current.feedback.type !== "correct-word") {
      return current;
    }
  }

  return current;
}

test("optimized passage splits longer text into chunked clauses", () => {
  const optimized = createOptimizedPassage(buildPassage());

  assert.equal(optimized.chunks.length, 2);
  assert.equal(optimized.chunks[0].text, "Grace makes peace,");
  assert.equal(optimized.chunks[1].text, "and peace grows courage.");
});

test("optimized session starts in study mode and then moves into first-letter recall", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildPassage()));
  let prompt = getOptimizedPrompt(session);

  assert.equal(prompt.type, "study");
  assert.equal(prompt.chunk.label, "Verse 1.1");

  session = beginOptimizedStage(session);
  prompt = getOptimizedPrompt(session);

  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.cueStyle, "first-letter");
  assert.equal(prompt.word.text, "Grace");
});

test("new chunks are introduced before previously cleared chunks return for spaced review", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildPassage()));

  session = clearCurrentStage(session);
  let prompt = getOptimizedPrompt(session);

  assert.equal(session.feedback.type, "chunk-cleared");
  assert.equal(prompt.type, "study");
  assert.equal(prompt.chunk.label, "Verse 1.2");

  session = clearCurrentStage(session);
  prompt = getOptimizedPrompt(session);

  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.chunk.label, "Verse 1.1");
  assert.equal(prompt.cueStyle, "blank");
});

test("a mistake resets the chunk and restores first-letter cues", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildPassage()));

  session = clearCurrentStage(session);
  session = clearCurrentStage(session);

  let prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.cueStyle, "blank");

  session = submitOptimizedWord(session, "wrong");
  prompt = getOptimizedPrompt(session);

  assert.equal(session.feedback.type, "mistake");
  assert.equal(prompt.type, "chunk-recall");
  assert.equal(prompt.promptPosition, 0);
  assert.equal(prompt.cueStyle, "first-letter");
});

test("after chunk mastery, the session moves into final consolidation and completes", () => {
  let session = createOptimizedSession(createOptimizedPassage(buildPassage()));

  while (!session.complete && session.stage.type !== "final-recall") {
    session = clearCurrentStage(session);
  }

  let prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "final-recall");
  assert.equal(prompt.cueStyle, "first-letter");

  session = clearCurrentStage(session);
  prompt = getOptimizedPrompt(session);
  assert.equal(prompt.type, "final-recall");
  assert.equal(prompt.cueStyle, "blank");

  session = clearCurrentStage(session);
  assert.equal(session.complete, true);
  assert.equal(session.feedback.type, "completed");
});

test("skip-to-final session starts in blank-only final recall", () => {
  const session = createOptimizedFinalTestSession(createOptimizedPassage(buildPassage()));
  const prompt = getOptimizedPrompt(session);

  assert.equal(session.complete, false);
  assert.equal(session.finalRound, 1);
  assert.equal(prompt.type, "final-recall");
  assert.equal(prompt.cueStyle, "blank");
  assert.equal(prompt.word.text, "Grace");
});
