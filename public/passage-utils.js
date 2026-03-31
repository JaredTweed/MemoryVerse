import { createPassage } from "./memorize-core.js";

export function parsePassageHtml(html, requestedReference, translation) {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(html, "text/html");
  const passageRoot =
    documentNode.querySelector("#bibletext section") ||
    documentNode.querySelector("#bibletext") ||
    documentNode.body;
  const heading =
    documentNode.querySelector(".bk_ch_vs_header")?.textContent?.trim() ||
    `${requestedReference}, ${translation}`;
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

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (currentVerse) {
        currentVerse.text += node.textContent || "";
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    if (
      node.matches("h1, h2, h3, h4, h5, h6, sup, script, style") ||
      node.classList.contains("tn") ||
      node.classList.contains("a-tn")
    ) {
      return;
    }

    if (node.classList.contains("vn")) {
      const verseNumber = node.textContent?.trim();

      if (verseNumber) {
        startVerse(verseNumber);
      }

      return;
    }

    for (const childNode of node.childNodes) {
      walk(childNode);
    }

    if (currentVerse && (node.tagName === "P" || node.tagName === "BR")) {
      currentVerse.text += " ";
    }
  }

  walk(root);

  if (currentVerse && currentVerse.text.trim()) {
    verses.push(cleanVerse(currentVerse));
  }

  return verses.filter((verse) => verse.text.length > 0);
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
