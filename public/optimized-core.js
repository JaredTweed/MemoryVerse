import { normalizeWord } from "./memorize-core.js";

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu;

export function createOptimizedPassage(passage) {
  const chunks = buildChunks(passage);
  return {
    ...passage,
    chunks,
    plan: buildStudyPlan(chunks),
  };
}

export function createOptimizedSession(passage) {
  const preparedPassage =
    passage.chunks && passage.plan ? passage : createOptimizedPassage(passage);
  const chunks = preparedPassage.chunks.map((chunk) => ({
    ...chunk,
    mastery: 0,
    seen: false,
    complete: false,
  }));

  return {
    passage: preparedPassage,
    chunks,
    plan: preparedPassage.plan,
    stage: {
      type: "study",
      planIndex: 0,
    },
    promptPosition: 0,
    currentTurn: 0,
    finalRound: 0,
    complete: false,
    feedback: { type: "ready-to-study" },
  };
}

export function createOptimizedFinalTestSession(passage) {
  return restartOptimizedFinalTest(createOptimizedSession(passage), "final-test-start");
}

export function restartOptimizedFinalTest(session, feedbackType = "final-test-retry") {
  return {
    ...session,
    stage: {
      type: "final-recall",
      cueStyle: "blank",
    },
    finalRound: 1,
    promptPosition: 0,
    complete: false,
    feedback: { type: feedbackType },
  };
}

export function beginOptimizedStage(session) {
  if (session.complete || session.stage.type !== "study") {
    return session;
  }

  const activeUnit = session.plan[session.stage.planIndex];
  const updatedChunks =
    activeUnit.startChunkIndex === activeUnit.endChunkIndex
      ? updateChunk(session.chunks, activeUnit.startChunkIndex, (chunk) => ({
          ...chunk,
          seen: true,
        }))
      : session.chunks;

  return {
    ...session,
    chunks: updatedChunks,
    stage: {
      type: "chunk-recall",
      planIndex: session.stage.planIndex,
      cueStyle: "first-letter",
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
    const unit = session.plan[session.stage.planIndex];
    return {
      type: "study",
      planIndex: session.stage.planIndex,
      chunkIndex: unit.startChunkIndex,
      chunk: unit,
      unit,
    };
  }

  if (session.stage.type === "chunk-recall") {
    const unit = session.plan[session.stage.planIndex];
    return {
      type: "chunk-recall",
      planIndex: session.stage.planIndex,
      chunkIndex: unit.startChunkIndex,
      chunk: unit,
      unit,
      word: unit.words[session.promptPosition],
      cueStyle: session.stage.cueStyle,
      promptPosition: session.promptPosition,
      totalPrompts: unit.words.length,
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

export function getActivePlanIndex(session) {
  if (!session?.plan?.length) {
    return -1;
  }

  if (session.stage.type === "study" || session.stage.type === "chunk-recall") {
    return session.stage.planIndex;
  }

  return session.plan.length - 1;
}

export function jumpToPlanStudy(session, requestedPlanIndex) {
  if (!session?.plan?.length) {
    return session;
  }

  const planIndex = Math.min(Math.max(requestedPlanIndex, 0), session.plan.length - 1);

  return {
    ...session,
    stage: {
      type: "study",
      planIndex,
    },
    promptPosition: 0,
    complete: false,
    feedback: { type: "ready-to-study" },
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
  const currentUnit = session.plan[session.stage.planIndex];
  const isSingleChunk = currentUnit.startChunkIndex === currentUnit.endChunkIndex;
  const updatedTurn = session.currentTurn + 1;

  if (session.stage.cueStyle === "first-letter") {
    const updatedChunks =
      isSingleChunk
        ? updateChunk(session.chunks, currentUnit.startChunkIndex, (chunk) => ({
            ...chunk,
            mastery: Math.max(chunk.mastery, 1),
          }))
        : session.chunks;

    return {
      ...session,
      chunks: updatedChunks,
      currentTurn: updatedTurn,
      stage: {
        type: "chunk-recall",
        planIndex: session.stage.planIndex,
        cueStyle: "blank",
      },
      promptPosition: 0,
      feedback: { type: "chunk-cleared", chunkLabel: currentUnit.label },
    };
  }

  const completedChunks =
    isSingleChunk
      ? updateChunk(session.chunks, currentUnit.startChunkIndex, (chunk) => ({
          ...chunk,
          mastery: 2,
          complete: true,
        }))
      : session.chunks;
  const nextPlanIndex = session.stage.planIndex + 1;

  if (nextPlanIndex < session.plan.length) {
    return {
      ...session,
      chunks: completedChunks,
      currentTurn: updatedTurn,
      stage: {
        type: "study",
        planIndex: nextPlanIndex,
      },
      promptPosition: 0,
      feedback: { type: "chunk-mastered", chunkLabel: currentUnit.label },
    };
  }

  return {
    ...session,
    chunks: completedChunks,
    currentTurn: updatedTurn,
    stage: {
      type: "final-recall",
      cueStyle: "blank",
    },
    finalRound: 1,
    promptPosition: 0,
    feedback: { type: "final-test-start" },
  };
}

function completeFinalRecall(session) {
  return {
    ...session,
    currentTurn: session.currentTurn + 1,
    complete: true,
    promptPosition: session.passage.hideableWordIndices.length,
    feedback: { type: "completed" },
  };
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
        startChunkIndex: order,
        endChunkIndex: order,
        baseChunkCount: 1,
        text: clause,
        verseNumber: verse.number,
        ...structureText(clause),
      });
      order += 1;
    });
  }

  return chunks;
}

function buildStudyPlan(chunks) {
  if (!chunks.length) {
    return [];
  }

  return buildPlanRange(chunks, 0, chunks.length - 1);
}

function buildPlanRange(chunks, startChunkIndex, endChunkIndex) {
  const count = endChunkIndex - startChunkIndex + 1;

  if (count === 1) {
    return [createUnit(chunks, startChunkIndex, endChunkIndex)];
  }

  if (count === 2) {
    return [
      createUnit(chunks, startChunkIndex, startChunkIndex),
      createUnit(chunks, endChunkIndex, endChunkIndex),
      createUnit(chunks, startChunkIndex, endChunkIndex),
    ];
  }

  if (count === 3) {
    return [
      createUnit(chunks, startChunkIndex, startChunkIndex),
      createUnit(chunks, startChunkIndex + 1, startChunkIndex + 1),
      createUnit(chunks, startChunkIndex, startChunkIndex + 1),
      createUnit(chunks, endChunkIndex, endChunkIndex),
      createUnit(chunks, startChunkIndex, endChunkIndex),
    ];
  }

  const leftCount = Math.floor((count - 1) / 3) * 3;
  const leftEndChunkIndex = startChunkIndex + leftCount - 1;
  const rightStartChunkIndex = leftEndChunkIndex + 1;

  return [
    ...buildPlanRange(chunks, startChunkIndex, leftEndChunkIndex),
    ...buildPlanRange(chunks, rightStartChunkIndex, endChunkIndex),
    createUnit(chunks, startChunkIndex, endChunkIndex),
  ];
}

function createUnit(chunks, startChunkIndex, endChunkIndex) {
  const startChunk = chunks[startChunkIndex];
  const endChunk = chunks[endChunkIndex];
  const text = chunks
    .slice(startChunkIndex, endChunkIndex + 1)
    .map((chunk) => chunk.text)
    .join(" ");

  return {
    id: `unit-${startChunkIndex}-${endChunkIndex}`,
    label: formatMergedLabel(startChunk.label, endChunk.label),
    startChunkIndex,
    endChunkIndex,
    baseChunkCount: endChunkIndex - startChunkIndex + 1,
    text,
    ...structureText(text),
  };
}

function formatMergedLabel(startLabel, endLabel) {
  if (startLabel === endLabel) {
    return startLabel;
  }

  const startSuffix = startLabel.replace(/^Verse\s+/u, "");
  const endSuffix = endLabel.replace(/^Verse\s+/u, "");
  return `Verse ${startSuffix}-${endSuffix}`;
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
  let index = 0;

  while (index < rawClauses.length) {
    const clause = rawClauses[index];
    const wordCount = countWords(clause);

    if (wordCount >= 2) {
      mergedClauses.push(clause);
      index += 1;
      continue;
    }

    if (mergedClauses.length) {
      mergedClauses[mergedClauses.length - 1] = `${mergedClauses.at(-1)} ${clause}`.trim();
      index += 1;
      continue;
    }

    if (index + 1 < rawClauses.length) {
      mergedClauses.push(`${clause} ${rawClauses[index + 1]}`.trim());
      index += 2;
      continue;
    }

    mergedClauses.push(clause);
    index += 1;
  }

  return mergedClauses;
}

function countWords(text) {
  return [...text.matchAll(WORD_PATTERN)].length;
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

function updateChunk(chunks, chunkIndex, updater) {
  return chunks.map((chunk, index) => (index === chunkIndex ? updater(chunk) : chunk));
}
