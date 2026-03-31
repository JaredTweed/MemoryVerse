import test from "node:test";
import assert from "node:assert/strict";

import {
  createPassage,
  createSession,
  getPrompt,
  normalizeWord,
  submitWord,
} from "../public/memorize-core.js";

function createRandomSequence(...values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

function buildPassage() {
  return createPassage({
    heading: "Romans 5:1, NLT",
    referenceLabel: "Romans 5:1",
    translation: "NLT",
    verses: [{ number: "1", text: "Grace builds steady courage." }],
  });
}

test("normalizeWord removes punctuation, case differences, and accents", () => {
  assert.equal(normalizeWord("Courage!"), "courage");
  assert.equal(normalizeWord("Didn’t"), "didn't");
  assert.equal(normalizeWord("Cancion"), "cancion");
  assert.equal(normalizeWord("Canción"), "cancion");
});

test("createSession hides one random word and adds another after a cleared round", () => {
  const passage = buildPassage();
  const random = createRandomSequence(0, 0);
  let session = createSession(passage, random);

  assert.equal(session.hiddenWordIndices.length, 1);
  assert.equal(getPrompt(session).hiddenCount, 1);

  session = submitWord(session, "Grace", random);

  assert.equal(session.feedback.type, "round-advanced");
  assert.equal(session.hiddenWordIndices.length, 2);
  assert.equal(getPrompt(session).promptPosition, 0);
  assert.deepEqual(
    session.hiddenWordIndices.map((segmentIndex) => passage.segments[segmentIndex].text),
    ["Grace", "builds"],
  );
});

test("a wrong answer reveals only the missed word and restarts the remaining round", () => {
  const passage = buildPassage();
  const random = createRandomSequence(0, 0);
  let session = createSession(passage, random);

  session = submitWord(session, "Grace", random);
  session = submitWord(session, "Grace");
  session = submitWord(session, "wrong");

  assert.equal(session.feedback.type, "mistake-revealed-word");
  assert.equal(session.promptPosition, 0);
  assert.deepEqual(
    session.hiddenWordIndices.map((segmentIndex) => passage.segments[segmentIndex].text),
    ["Grace"],
  );
});

test("missing the only hidden word restarts with a different word when possible", () => {
  const passage = buildPassage();
  const random = createRandomSequence(0, 0);
  const session = submitWord(createSession(passage, random), "wrong", random);

  assert.equal(session.feedback.type, "mistake-restart");
  assert.deepEqual(
    session.hiddenWordIndices.map((segmentIndex) => passage.segments[segmentIndex].text),
    ["builds"],
  );
});

test("the session completes once every word has been hidden and answered in order", () => {
  const passage = buildPassage();
  const random = createRandomSequence(0, 0, 0, 0);
  let session = createSession(passage, random);

  session = submitWord(session, "Grace", random);
  session = submitWord(session, "Grace");
  session = submitWord(session, "builds", random);
  session = submitWord(session, "Grace");
  session = submitWord(session, "builds");
  session = submitWord(session, "steady", random);
  session = submitWord(session, "Grace");
  session = submitWord(session, "builds");
  session = submitWord(session, "steady");
  session = submitWord(session, "courage");

  assert.equal(session.complete, true);
  assert.equal(session.feedback.type, "completed");
});
