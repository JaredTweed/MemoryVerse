const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu;

export function normalizeWord(value = "") {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}'-]+/gu, "")
    .toLowerCase();
}

export function createPassage({ heading, referenceLabel, translation, verses }) {
  const segments = [];
  const hideableWordIndices = [];

  verses.forEach((verse, verseIndex) => {
    if (verseIndex > 0) {
      segments.push({ type: "text", text: " " });
    }

    segments.push({ type: "verse-number", text: verse.number });
    segments.push({ type: "text", text: " " });

    for (const segment of tokenizeText(verse.text)) {
      if (segment.type === "word") {
        segment.order = hideableWordIndices.length;
        hideableWordIndices.push(segments.length);
      }

      segments.push(segment);
    }
  });

  return {
    heading,
    referenceLabel,
    translation,
    verses,
    segments,
    hideableWordIndices,
    totalWords: hideableWordIndices.length,
  };
}

export function createSession(passage, randomFn = Math.random) {
  if (!passage.totalWords) {
    return {
      passage,
      hiddenWordIndices: [],
      promptPosition: 0,
      complete: true,
      feedback: { type: "empty-passage" },
    };
  }

  return {
    passage,
    hiddenWordIndices: pickAdditionalHiddenWord([], passage, randomFn),
    promptPosition: 0,
    complete: false,
    feedback: { type: "round-start" },
  };
}

export function getPrompt(session) {
  if (!session || session.complete || !session.hiddenWordIndices.length) {
    return null;
  }

  return {
    currentSegmentIndex: session.hiddenWordIndices[session.promptPosition],
    hiddenCount: session.hiddenWordIndices.length,
    promptPosition: session.promptPosition,
    totalWords: session.passage.totalWords,
  };
}

export function submitWord(session, rawGuess, randomFn = Math.random) {
  const guess = normalizeWord(rawGuess);
  const prompt = getPrompt(session);

  if (!prompt) {
    return session;
  }

  if (!guess) {
    return {
      ...session,
      feedback: { type: "empty-answer" },
    };
  }

  const targetSegment = session.passage.segments[prompt.currentSegmentIndex];

  if (guess === targetSegment.normalized) {
    const nextPromptPosition = session.promptPosition + 1;

    if (nextPromptPosition < session.hiddenWordIndices.length) {
      return {
        ...session,
        promptPosition: nextPromptPosition,
        feedback: { type: "correct-word" },
      };
    }

    if (session.hiddenWordIndices.length === session.passage.totalWords) {
      return {
        ...session,
        promptPosition: session.hiddenWordIndices.length,
        complete: true,
        feedback: { type: "completed" },
      };
    }

    return {
      ...session,
      hiddenWordIndices: pickAdditionalHiddenWord(
        session.hiddenWordIndices,
        session.passage,
        randomFn,
      ),
      promptPosition: 0,
      feedback: { type: "round-advanced" },
    };
  }

  const remainingHiddenWordIndices = session.hiddenWordIndices.filter(
    (segmentIndex) => segmentIndex !== prompt.currentSegmentIndex,
  );

  if (remainingHiddenWordIndices.length > 0) {
    return {
      ...session,
      hiddenWordIndices: remainingHiddenWordIndices,
      promptPosition: 0,
      feedback: {
        type: "mistake-revealed-word",
        revealedWord: targetSegment.text,
      },
    };
  }

  return {
    ...session,
    hiddenWordIndices: pickAdditionalHiddenWord(
      [],
      session.passage,
      randomFn,
      [prompt.currentSegmentIndex],
    ),
    promptPosition: 0,
    feedback: {
      type: "mistake-restart",
      revealedWord: targetSegment.text,
    },
  };
}

function tokenizeText(text) {
  const segments = [];
  let lastIndex = 0;

  for (const match of text.matchAll(WORD_PATTERN)) {
    const start = match.index ?? 0;

    if (start > lastIndex) {
      segments.push({
        type: "text",
        text: text.slice(lastIndex, start),
      });
    }

    segments.push({
      type: "word",
      text: match[0],
      normalized: normalizeWord(match[0]),
    });

    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      text: text.slice(lastIndex),
    });
  }

  return segments;
}

function pickAdditionalHiddenWord(
  hiddenWordIndices,
  passage,
  randomFn,
  excludedWordIndices = [],
) {
  const hiddenWordIndexSet = new Set(hiddenWordIndices);
  const excludedWordIndexSet = new Set(excludedWordIndices);

  let candidates = passage.hideableWordIndices.filter(
    (segmentIndex) =>
      !hiddenWordIndexSet.has(segmentIndex) && !excludedWordIndexSet.has(segmentIndex),
  );

  if (!candidates.length) {
    candidates = passage.hideableWordIndices.filter(
      (segmentIndex) => !hiddenWordIndexSet.has(segmentIndex),
    );
  }

  if (!candidates.length) {
    return sortHiddenWordIndices(hiddenWordIndices, passage);
  }

  const chosenWordIndex = candidates[Math.floor(randomFn() * candidates.length)];
  return sortHiddenWordIndices([...hiddenWordIndices, chosenWordIndex], passage);
}

function sortHiddenWordIndices(hiddenWordIndices, passage) {
  return [...hiddenWordIndices].sort(
    (leftIndex, rightIndex) =>
      passage.segments[leftIndex].order - passage.segments[rightIndex].order,
  );
}
