import { createPassage } from "./memorize-core.js";

const SKIP_TAG_NAMES = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME"]);
const SKIP_CLASS_NAMES = new Set([
  "a-tn",
  "chapter-num",
  "chapter-number",
  "copyright",
  "crossref",
  "crossrefs",
  "extra_text",
  "footnote",
  "footnote-body",
  "footnotes",
  "heading",
  "subheading",
  "tn",
]);
const VERSE_MARKER_CLASS_NAMES = new Set([
  "label",
  "v",
  "verse-num",
  "verse-number",
  "versenum",
  "vn",
]);

export function parsePassageHtml(html, requestedReference, translation) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(html, "text/html");
  const passageRoot = selectPassageRoot(documentNode);
  const heading = extractHeading(documentNode, requestedReference, translation);
  const referenceLabel = stripTrailingTranslation(heading, translation);
  const verses = extractVerses(passageRoot);

  if (!verses.length) {
    throw new Error("No verse text was found for that reference.");
  }

  return createPassage({
    heading,
    referenceLabel,
    translation,
    verses,
  });
}

function selectPassageRoot(documentNode) {
  return (
    documentNode.querySelector("#bibletext section") ||
    documentNode.querySelector("#bibletext") ||
    documentNode.querySelector(".passage-text") ||
    documentNode.querySelector(".passage") ||
    documentNode.body
  );
}

function extractHeading(documentNode, requestedReference, translation) {
  return (
    documentNode.querySelector(".bk_ch_vs_header")?.textContent?.trim() ||
    documentNode.querySelector("h1, h2, h3")?.textContent?.trim() ||
    `${requestedReference}, ${translation}`
  );
}

function extractVerses(root) {
  const verses = [];
  let currentVerse = null;

  function startVerse(verseNumber) {
    if (currentVerse && currentVerse.text.trim()) {
      verses.push(cleanVerse(currentVerse));
    }

    currentVerse = {
      number: verseNumber,
      text: "",
    };
  }

  function appendText(text) {
    if (currentVerse && text) {
      currentVerse.text += text;
    }
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent || "");
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const verseNumber = getVerseStartNumber(node);

    if (shouldSkipElement(node, verseNumber)) {
      return;
    }

    if (verseNumber) {
      startVerse(verseNumber);
    }

    if (appendInlineVerseText(node, verseNumber, appendText)) {
      if (currentVerse && shouldAppendTrailingSpace(node)) {
        currentVerse.text += " ";
      }
      return;
    }

    if (isMarkerOnlyVerseElement(node, verseNumber)) {
      return;
    }

    for (const childNode of node.childNodes) {
      walk(childNode);
    }

    if (currentVerse && shouldAppendTrailingSpace(node)) {
      currentVerse.text += " ";
    }
  }

  walk(root);

  if (currentVerse && currentVerse.text.trim()) {
    verses.push(cleanVerse(currentVerse));
  }

  return verses.filter((verse) => verse.text.length > 0);
}

function shouldSkipElement(node, verseNumber) {
  if (SKIP_TAG_NAMES.has(node.tagName)) {
    return true;
  }

  if (node.tagName === "SUP" && !verseNumber) {
    return true;
  }

  for (const className of node.classList) {
    if (SKIP_CLASS_NAMES.has(className.toLowerCase())) {
      return true;
    }
  }

  return false;
}

function getVerseStartNumber(node) {
  if (hasClassName(node, "chapter-num") || hasClassName(node, "chapter-number")) {
    return null;
  }

  const dataNumber = node.getAttribute("data-number")?.trim();
  if (isVerseNumberValue(dataNumber)) {
    return dataNumber;
  }

  const textContent = node.textContent?.trim() || "";
  if (!isVerseNumberValue(textContent)) {
    return null;
  }

  if (node.tagName === "SUP") {
    return textContent;
  }

  for (const className of node.classList) {
    if (VERSE_MARKER_CLASS_NAMES.has(className.toLowerCase())) {
      return textContent;
    }
  }

  return null;
}

function isVerseNumberValue(value) {
  return typeof value === "string" && /^\d+[a-z]?$/i.test(value.trim());
}

function hasClassName(node, className) {
  return node.classList.contains(className);
}

function appendInlineVerseText(node, verseNumber, appendText) {
  if (!verseNumber || node.childNodes.length !== 1 || node.firstChild?.nodeType !== Node.TEXT_NODE) {
    return false;
  }

  const strippedText = stripLeadingVerseNumber(node.textContent || "", verseNumber);
  if (!strippedText.trim()) {
    return false;
  }

  appendText(strippedText);
  return true;
}

function isMarkerOnlyVerseElement(node, verseNumber) {
  if (!verseNumber) {
    return false;
  }

  if (node.tagName === "SUP") {
    return true;
  }

  if (node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE) {
    return stripLeadingVerseNumber(node.textContent || "", verseNumber).trim().length === 0;
  }

  for (const className of node.classList) {
    if (VERSE_MARKER_CLASS_NAMES.has(className.toLowerCase()) && !node.hasAttribute("data-number")) {
      return true;
    }
  }

  return false;
}

function stripLeadingVerseNumber(text, verseNumber) {
  return text.replace(new RegExp(`^\\s*${escapeRegExp(verseNumber)}(?:\\s+|\\u00a0|$)`), "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldAppendTrailingSpace(node) {
  return ["BR", "DIV", "LI", "P"].includes(node.tagName);
}

function cleanVerse(verse) {
  return {
    number: verse.number,
    text: verse.text
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([([{])\s+/g, "$1")
      .trim(),
  };
}

function stripTrailingTranslation(heading, translation) {
  const suffix = `, ${translation}`;
  if (heading.endsWith(suffix)) {
    return heading.slice(0, -suffix.length);
  }

  return heading;
}
