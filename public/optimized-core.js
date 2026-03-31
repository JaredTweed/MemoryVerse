import { normalizeWord } from "./memorize-core.js";

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu;
const REVIEW_INTERVALS = [1, 2];

export function createOptimizedPassage(passage) {
  return {
    ...passage,
    chunks: buildChunks(passage),
  };
}

export function createOptimizedSession(passage) {
  const preparedPassage = passage.chunks ? passage : createOptimizedPassage(passage);
  const chunks = preparedPassage.chunks.map((chunk) => ({
    ...chunk,
    mastery: 0,
    seen: false,
    complete: false,
    nextDueTurn: 0,
  }));

  return {
    passage: preparedPassage,
    chunks,
    stage: {
      type: "study",
      chunkIndex: 0,
    },
    promptPosition: 0,
    currentTurn: 0,
    finalRound: 0,
    complete: false,
    feedback: { type: "ready-to-study" },
  };
}

export function beginOptimizedStage(session) {
  if (session.complete || session.stage.type !== "study") {
    return session;
  }

  const updatedChunks = session.chunks.map((chunk, index) =>
    index === session.stage.chunkIndex
      ? {
          ...chunk,
          seen: true,
        }
      : chunk,
  );
  const activeChunk = updatedChunks[session.stage.chunkIndex];

  return {
    ...session,
    chunks: updatedChunks,
    stage: {
      type: "chunk-recall",
      chunkIndex: session.stage.chunkIndex,
      cueStyle: cueStyleForMastery(activeChunk.mastery),
    },
    promptPosition: 0,
    feedback: { type: "chunk-recall-start" },
  };
}

export function getOptimizedPrompt(session) {
  if (session.complete) {
    return null;
  }

  if (session.stage.type === "study") {
    return {
      type: "study",
      chunkIndex: session.stage.chunkIndex,
      chunk: session.chunks[session.stage.chunkIndex],
    };
  }

  if (session.stage.type === "chunk-recall") {
    const chunk = session.chunks[session.stage.chunkIndex];
    return {
      type: "chunk-recall",
      chunkIndex: session.stage.chunkIndex,
      chunk,
      word: chunk.words[session.promptPosition],
      cueStyle: session.stage.cueStyle,
      promptPosition: session.promptPosition,
      totalPrompts: chunk.words.length,
    };
  }

  const segmentIndex = session.passage.hideableWordIndices[session.promptPosition];
  return {
    type: "final-recall",
    segmentIndex,
    word: session.passage.segments[segmentIndex],
    cueStyle: session.stage.cueStyle,
    promptPosition: session.promptPosition,
    totalPrompts: session.passage.hideableWordIndices.length,
    round: session.finalRound,
  };
}

export function submitOptimizedWord(session, rawGuess) {
  if (session.complete || session.stage.type === "study") {
    return session;
  }

  const guess = normalizeWord(rawGuess);
  if (!guess) {
    return {
      ...session,
      feedback: { type: "empty-answer" },
    };
  }

  const prompt = getOptimizedPrompt(session);
  if (!prompt) {
    return session;
  }

  if (guess !== prompt.word.normalized) {
    return {
      ...session,
      promptPosition: 0,
      stage: {
        ...session.stage,
        cueStyle: "first-letter",
      },
      feedback: {
        type: "mistake",
        revealedWord: prompt.word.text,
      },
    };
  }

  const nextPromptPosition = session.promptPosition + 1;
  if (nextPromptPosition < prompt.totalPrompts) {
    return {
      ...session,
      promptPosition: nextPromptPosition,
      feedback: { type: "correct-word" },
    };
  }

  return session.stage.type === "chunk-recall"
    ? completeChunkRecall(session)
    : completeFinalRecall(session);
}

export function getOptimizedStats(session) {
  const prompt = getOptimizedPrompt(session);
  return {
    completedChunks: session.chunks.filter((chunk) => chunk.complete).length,
    totalChunks: session.chunks.length,
    promptPosition: prompt ? prompt.promptPosition + 1 : 0,
    totalPrompts: prompt ? prompt.totalPrompts : 0,
  };
}

function completeChunkRecall(session) {
  const chunkIndex = session.stage.chunkIndex;
  const currentChunk = session.chunks[chunkIndex];
  const newMastery = Math.min(currentChunk.mastery + 1, 3);
  const updatedTurn = session.currentTurn + 1;
  const updatedChunk = {
    ...currentChunk,
    mastery: newMastery,
    complete: newMastery >= 3,
    nextDueTurn:
      newMastery >= 3 ? updatedTurn : updatedTurn + REVIEW_INTERVALS[newMastery - 1],
  };
  const updatedChunks = session.chunks.map((chunk, index) =>
    index === chunkIndex ? updatedChunk : chunk,
  );

  return advanceToNextStage({
    ...session,
    chunks: updatedChunks,
    currentTurn: updatedTurn,
    promptPosition: 0,
    feedback: {
      type: updatedChunk.complete ? "chunk-mastered" : "chunk-cleared",
      chunkLabel: updatedChunk.label,
    },
  });
}

function completeFinalRecall(session) {
  const updatedTurn = session.currentTurn + 1;

  if (session.finalRound === 0) {
    return {
      ...session,
      currentTurn: updatedTurn,
      finalRound: 1,
      stage: {
        type: "final-recall",
        cueStyle: "blank",
      },
      promptPosition: 0,
      feedback: { type: "final-round-cleared" },
    };
  }

  return {
    ...session,
    currentTurn: updatedTurn,
    complete: true,
    promptPosition: session.passage.hideableWordIndices.length,
    feedback: { type: "completed" },
  };
}

function advanceToNextStage(session) {
  const nextStage = pickNextStage(session);

  if (!nextStage) {
    return {
      ...session,
      stage: {
        type: "final-recall",
        cueStyle: "first-letter",
      },
      finalRound: 0,
      promptPosition: 0,
    };
  }

  return {
    ...session,
    stage: nextStage,
    promptPosition: 0,
  };
}

function pickNextStage(session) {
  const pendingChunks = session.chunks.filter((chunk) => !chunk.complete);

  if (!pendingChunks.length) {
    return null;
  }

  const dueChunkIndex = session.chunks.findIndex(
    (chunk) => chunk.seen && !chunk.complete && chunk.nextDueTurn <= session.currentTurn,
  );
  if (dueChunkIndex >= 0) {
    return {
      type: "chunk-recall",
      chunkIndex: dueChunkIndex,
      cueStyle: cueStyleForMastery(session.chunks[dueChunkIndex].mastery),
    };
  }

  const unseenChunkIndex = session.chunks.findIndex((chunk) => !chunk.seen);
  if (unseenChunkIndex >= 0) {
    return {
      type: "study",
      chunkIndex: unseenChunkIndex,
    };
  }

  const fallbackChunkIndex = session.chunks.reduce((bestIndex, chunk, index, items) => {
    if (chunk.complete) {
      return bestIndex;
    }

    if (bestIndex < 0) {
      return index;
    }

    return chunk.nextDueTurn < items[bestIndex].nextDueTurn ? index : bestIndex;
  }, -1);

  return {
    type: "chunk-recall",
    chunkIndex: fallbackChunkIndex,
    cueStyle: cueStyleForMastery(session.chunks[fallbackChunkIndex].mastery),
  };
}

function cueStyleForMastery(mastery) {
  return mastery === 0 ? "first-letter" : "blank";
}

function buildChunks(passage) {
  const chunks = [];
  let order = 0;

  for (const verse of passage.verses) {
    const clauses = splitIntoClauses(verse.text);
    clauses.forEach((clause, clauseIndex) => {
      chunks.push({
        id: `chunk-${order}`,
        label:
          clauses.length === 1 ? `Verse ${verse.number}` : `Verse ${verse.number}.${clauseIndex + 1}`,
        order,
        text: clause,
        verseNumber: verse.number,
        ...structureText(clause),
      });
      order += 1;
    });
  }

  return chunks;
}

function splitIntoClauses(text) {
  const rawClauses = text
    .split(/(?<=[,;:.!?])\s+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);

  if (rawClauses.length <= 1) {
    return [text];
  }

  const mergedClauses = [];
  for (const clause of rawClauses) {
    const wordCount = [...clause.matchAll(WORD_PATTERN)].length;
    const previousClause = mergedClauses[mergedClauses.length - 1];

    if (wordCount < 4 && previousClause) {
      mergedClauses[mergedClauses.length - 1] = `${previousClause} ${clause}`.trim();
      continue;
    }

    mergedClauses.push(clause);
  }

  return mergedClauses;
}

function structureText(text) {
  const segments = [];
  const words = [];
  let lastIndex = 0;

  for (const match of text.matchAll(WORD_PATTERN)) {
    const start = match.index ?? 0;

    if (start > lastIndex) {
      segments.push({
        type: "text",
        text: text.slice(lastIndex, start),
      });
    }

    const word = {
      type: "word",
      text: match[0],
      normalized: normalizeWord(match[0]),
      order: words.length,
    };

    words.push(word);
    segments.push(word);
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({
      type: "text",
      text: text.slice(lastIndex),
    });
  }

  return {
    segments,
    words,
  };
}
