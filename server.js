import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const passageCacheFile = path.join(dataDir, "passage-cache.json");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const passageCacheLimit = Math.max(1, Number(process.env.PASSAGE_CACHE_LIMIT || 5000));
const upstreamTimeoutMs = Math.max(1000, Number(process.env.UPSTREAM_TIMEOUT_MS || 15000));
const upstreamTimeoutSeconds = Math.max(1, Math.ceil(upstreamTimeoutMs / 1000));
const nltApiKey = process.env.NLT_API_KEY?.trim() || "TEST";
const esvApiKey = process.env.ESV_API_KEY?.trim() || "";
const apiBibleKey = process.env.API_BIBLE_KEY?.trim() || "";
const execFileAsync = promisify(execFile);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

const translationConfigs = new Map([
  ["NLT", { provider: "nlt", cacheable: true }],
  ["NLTUK", { provider: "nlt", cacheable: true }],
  ["KJV", { provider: "nlt", cacheable: true }],
  ["ESV", { provider: "esv", cacheable: false }],
  ["NIV", { provider: "api-bible", cacheable: false }],
]);
const allowedTranslations = new Set(translationConfigs.keys());
const passageCache = new Map();
const inFlightPassageRequests = new Map();
let passageCacheWriteTimer = null;
let apiBibleBiblesPromise = null;

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

    if (requestUrl.pathname === "/api/passage") {
      await handlePassageRequest(requestUrl, res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      writeJson(res, 405, { error: "Method not allowed." });
      return;
    }

    await serveStaticAsset(requestUrl.pathname, res, req.method === "HEAD");
  } catch (error) {
    console.error(error);
    writeJson(res, 500, { error: "Unexpected server error." });
  }
});

async function handlePassageRequest(requestUrl, res) {
  const reference = normalizeReference(requestUrl.searchParams.get("reference"));
  const translation = requestUrl.searchParams.get("translation")?.trim().toUpperCase() || "NLT";

  if (!reference) {
    writeJson(res, 400, { error: "A Bible reference is required." });
    return;
  }

  if (!allowedTranslations.has(translation)) {
    writeJson(res, 400, { error: "Unsupported translation." });
    return;
  }

  try {
    const translationConfig = getTranslationConfig(translation);
    const { payload, cacheStatus } = await getPassagePayload(reference, translation, translationConfig);
    writeJson(res, 200, payload, {
      "Cache-Control": translationConfig.cacheable
        ? "private, max-age=31536000, immutable"
        : "no-store",
      "X-MemoryVerse-Cache": cacheStatus,
    });
  } catch (error) {
    if (error instanceof UpstreamPassageError) {
      writeJson(res, error.statusCode, {
        error: "Unable to load that passage right now.",
        details: error.details,
      });
      return;
    }

    throw error;
  }
}

async function serveStaticAsset(requestPath, res, headOnly) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, normalizedPath));

  if (!filePath.startsWith(publicDir)) {
    writeJson(res, 403, { error: "Forbidden." });
    return;
  }

  try {
    const file = await readFile(filePath);
    const extension = path.extname(filePath);
    const contentType = contentTypes.get(extension) || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });

    if (!headOnly) {
      res.end(file);
      return;
    }

    res.end();
  } catch (error) {
    if (requestPath !== "/favicon.ico") {
      writeJson(res, 404, { error: "Not found." });
      return;
    }

    res.writeHead(204);
    res.end();
  }
}

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function getPassagePayload(reference, translation, translationConfig) {
  const cacheKey = createPassageCacheKey(reference, translation);
  if (translationConfig.cacheable) {
    const cachedPayload = readCachedPassage(cacheKey);
    if (cachedPayload) {
      return {
        payload: cachedPayload,
        cacheStatus: "HIT",
      };
    }
  }

  const existingRequest = inFlightPassageRequests.get(cacheKey);
  if (existingRequest) {
    const payload = await existingRequest;
    return {
      payload,
      cacheStatus: "DEDUPED",
    };
  }

  const requestPromise = fetchPassagePayload(reference, translation, translationConfig)
    .then((payload) => {
      if (translationConfig.cacheable) {
        writeCachedPassage(cacheKey, payload);
      }
      return payload;
    })
    .finally(() => {
      inFlightPassageRequests.delete(cacheKey);
    });

  inFlightPassageRequests.set(cacheKey, requestPromise);

  const payload = await requestPromise;
  return {
    payload,
    cacheStatus: "MISS",
  };
}

async function fetchPassagePayload(reference, translation, translationConfig) {
  let payload;

  switch (translationConfig.provider) {
    case "nlt":
      payload = await fetchNltPassagePayload(reference, translation);
      break;
    case "esv":
      payload = await fetchEsvPassagePayload(reference, translation);
      break;
    case "api-bible":
      payload = await fetchApiBiblePassagePayload(reference, translation);
      break;
    default:
      throw new UpstreamPassageError(500, "Unsupported translation provider configuration.");
  }

  return {
    ...payload,
    cacheable: translationConfig.cacheable,
  };
}

async function fetchNltPassagePayload(reference, translation) {
  const upstreamUrl = new URL("https://api.nlt.to/api/passages");
  upstreamUrl.searchParams.set("ref", reference);
  upstreamUrl.searchParams.set("version", translation);
  upstreamUrl.searchParams.set("key", nltApiKey);
  const html = await fetchTextUpstream(upstreamUrl, {
    Accept: "text/html",
  });

  return {
    html,
    translation,
    requestedReference: reference,
  };
}

async function fetchEsvPassagePayload(reference, translation) {
  if (!esvApiKey) {
    throw new UpstreamPassageError(503, "ESV support is not configured. Set ESV_API_KEY.");
  }

  const upstreamUrl = new URL("https://api.esv.org/v3/passage/html/");
  upstreamUrl.searchParams.set("q", reference);
  upstreamUrl.searchParams.set("include-passage-references", "false");
  upstreamUrl.searchParams.set("include-verse-numbers", "true");
  upstreamUrl.searchParams.set("include-first-verse-numbers", "true");
  upstreamUrl.searchParams.set("include-footnotes", "false");
  upstreamUrl.searchParams.set("include-footnote-body", "false");
  upstreamUrl.searchParams.set("include-headings", "false");
  upstreamUrl.searchParams.set("include-short-copyright", "false");
  upstreamUrl.searchParams.set("include-copyright", "false");
  upstreamUrl.searchParams.set("include-css-link", "false");
  upstreamUrl.searchParams.set("inline-styles", "false");
  upstreamUrl.searchParams.set("wrapping-div", "false");
  upstreamUrl.searchParams.set("include-book-titles", "false");
  upstreamUrl.searchParams.set("include-verse-anchors", "false");
  upstreamUrl.searchParams.set("include-chapter-numbers", "false");
  upstreamUrl.searchParams.set("include-crossrefs", "false");
  upstreamUrl.searchParams.set("include-subheadings", "false");
  upstreamUrl.searchParams.set("include-surrounding-chapters", "false");

  const responseData = await fetchJsonUpstream(upstreamUrl, {
    Authorization: `Token ${esvApiKey}`,
    Accept: "application/json",
  });
  const html = Array.isArray(responseData?.passages)
    ? responseData.passages.filter(Boolean).join("\n")
    : "";

  if (!html) {
    throw new UpstreamPassageError(404, "The ESV API did not return passage text.");
  }

  return {
    html,
    translation,
    requestedReference: responseData?.canonical || reference,
  };
}

async function fetchApiBiblePassagePayload(reference, translation) {
  if (!apiBibleKey) {
    throw new UpstreamPassageError(
      503,
      "NIV support is not configured. Set API_BIBLE_KEY and enable NIV for that key.",
    );
  }

  const bibleId = await resolveApiBibleBibleId(translation);
  const upstreamUrl = new URL(
    `https://api.scripture.api.bible/v1/bibles/${encodeURIComponent(bibleId)}/search`,
  );
  upstreamUrl.searchParams.set("query", reference);
  upstreamUrl.searchParams.set("limit", "1");
  upstreamUrl.searchParams.set("fums-version", "3");

  const responseData = await fetchJsonUpstream(upstreamUrl, {
    "api-key": apiBibleKey,
    Accept: "application/json",
  });
  const firstPassage = responseData?.data?.passages?.[0];

  if (!firstPassage?.content) {
    throw new UpstreamPassageError(
      404,
      `The ${translation} API did not return passage text for "${reference}".`,
    );
  }

  return {
    html: firstPassage.content,
    translation,
    requestedReference: firstPassage.reference || reference,
  };
}

async function fetchJsonUpstream(upstreamUrl, headers) {
  const responseText = await fetchTextUpstream(upstreamUrl, headers);

  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new UpstreamPassageError(
      502,
      error instanceof Error ? error.message : "The upstream passage API returned invalid JSON.",
    );
  }
}

async function fetchTextUpstream(upstreamUrl, headers) {
  try {
    return await fetchTextUpstreamWithFetch(upstreamUrl, headers);
  } catch (error) {
    if (!shouldRetryUpstreamWithCurl(error)) {
      throw coerceUpstreamError(error);
    }
  }

  try {
    return await fetchTextUpstreamWithCurl(upstreamUrl, headers);
  } catch (error) {
    throw coerceUpstreamError(error);
  }
}

async function fetchTextUpstreamWithFetch(upstreamUrl, headers) {
  const upstreamResponse = await fetch(upstreamUrl, {
    signal: AbortSignal.timeout(upstreamTimeoutMs),
    headers: {
      ...headers,
      "User-Agent": "MemoryVerse/1.0",
    },
  });
  const responseText = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    throw new UpstreamPassageError(
      upstreamResponse.status,
      summarizeUpstreamBody(responseText),
    );
  }

  return responseText;
}

async function fetchTextUpstreamWithCurl(upstreamUrl, headers) {
  const args = [
    "-sS",
    "-L",
    "--connect-timeout",
    String(Math.min(upstreamTimeoutSeconds, 10)),
    "--max-time",
    String(upstreamTimeoutSeconds),
  ];

  for (const [name, value] of Object.entries({
    ...headers,
    "User-Agent": "MemoryVerse/1.0",
  })) {
    args.push("-H", `${name}: ${value}`);
  }

  args.push("-w", "\n%{http_code}");
  args.push(upstreamUrl.toString());

  let stdout;
  try {
    ({ stdout } = await execFileAsync("curl", args, {
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    const output =
      `${error?.stdout || ""}\n${error?.stderr || ""}`.trim() ||
      formatNetworkErrorDetails(error);
    throw new UpstreamPassageError(504, output);
  }

  const normalizedOutput = stdout.replace(/\r\n/g, "\n");
  const statusMatch = normalizedOutput.match(/\n(\d{3})$/);
  if (!statusMatch) {
    throw new UpstreamPassageError(502, "curl did not return an HTTP status code.");
  }

  const statusCode = Number(statusMatch[1]);
  const responseText = normalizedOutput.slice(0, -statusMatch[0].length);
  if (statusCode < 200 || statusCode >= 300) {
    throw new UpstreamPassageError(statusCode, summarizeUpstreamBody(responseText));
  }

  return responseText;
}

function shouldRetryUpstreamWithCurl(error) {
  if (error instanceof UpstreamPassageError) {
    return false;
  }

  if (error?.name === "AbortError") {
    return true;
  }

  const code = error?.code || error?.cause?.code;
  if (typeof code === "string" && code.length > 0) {
    return true;
  }

  return error instanceof TypeError;
}

function coerceUpstreamError(error) {
  if (error instanceof UpstreamPassageError) {
    return error;
  }

  return new UpstreamPassageError(504, formatNetworkErrorDetails(error));
}

function formatNetworkErrorDetails(error) {
  const cause = error?.cause;
  const code = cause?.code || error?.code;
  const hostname = cause?.hostname || error?.hostname;
  const syscall = cause?.syscall || error?.syscall;

  if (code && hostname) {
    return `${syscall || "Network error"} ${code} while contacting ${hostname}.`;
  }

  if (code) {
    return `Network error ${code} while contacting the upstream passage API.`;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unable to contact the upstream passage API.";
}

function summarizeUpstreamBody(body) {
  return String(body)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

async function resolveApiBibleBibleId(translation) {
  if (translation === "NIV" && process.env.NIV_BIBLE_ID?.trim()) {
    return process.env.NIV_BIBLE_ID.trim();
  }

  const bibles = await getApiBibleBibles();
  const match =
    bibles.find((bible) => bible.abbreviation === translation) ||
    bibles.find((bible) => bible.abbreviationLocal === translation) ||
    bibles.find((bible) =>
      translation === "NIV" &&
      typeof bible.name === "string" &&
      bible.name.toUpperCase().includes("NEW INTERNATIONAL VERSION"),
    );

  if (!match?.id) {
    throw new UpstreamPassageError(
      503,
      `${translation} is not available for the configured API_BIBLE_KEY. Set NIV_BIBLE_ID or enable access for that version in API.Bible.`,
    );
  }

  return match.id;
}

async function getApiBibleBibles() {
  if (!apiBibleBiblesPromise) {
    const upstreamUrl = new URL("https://api.scripture.api.bible/v1/bibles");
    apiBibleBiblesPromise = fetchJsonUpstream(upstreamUrl, {
      "api-key": apiBibleKey,
      Accept: "application/json",
    })
      .then((responseData) =>
        Array.isArray(responseData?.data)
          ? responseData.data.map((bible) => ({
              id: typeof bible?.id === "string" ? bible.id : "",
              abbreviation:
                typeof bible?.abbreviation === "string" ? bible.abbreviation.trim().toUpperCase() : "",
              abbreviationLocal:
                typeof bible?.abbreviationLocal === "string"
                  ? bible.abbreviationLocal.trim().toUpperCase()
                  : "",
              name: typeof bible?.name === "string" ? bible.name.trim() : "",
            }))
          : [],
      )
      .catch((error) => {
        apiBibleBiblesPromise = null;
        throw error;
      });
  }

  return apiBibleBiblesPromise;
}

function readCachedPassage(cacheKey) {
  const cachedEntry = passageCache.get(cacheKey);
  if (!cachedEntry) {
    return null;
  }

  passageCache.delete(cacheKey);
  passageCache.set(cacheKey, {
    ...cachedEntry,
    accessedAt: Date.now(),
  });

  return cachedEntry.payload;
}

function writeCachedPassage(cacheKey, payload) {
  passageCache.delete(cacheKey);
  passageCache.set(cacheKey, {
    payload,
    accessedAt: Date.now(),
  });

  prunePassageCache();
  schedulePassageCacheWrite();
}

function prunePassageCache() {
  while (passageCache.size > passageCacheLimit) {
    const oldestKey = passageCache.keys().next().value;
    if (!oldestKey) {
      return;
    }

    passageCache.delete(oldestKey);
  }
}

function schedulePassageCacheWrite() {
  if (passageCacheWriteTimer) {
    clearTimeout(passageCacheWriteTimer);
  }

  passageCacheWriteTimer = setTimeout(() => {
    passageCacheWriteTimer = null;
    writePassageCacheToDisk().catch((error) => {
      console.error("Unable to persist passage cache.", error);
    });
  }, 250);
}

async function hydratePassageCache() {
  try {
    const rawCache = await readFile(passageCacheFile, "utf8");
    const parsedCache = JSON.parse(rawCache);
    const entries = Array.isArray(parsedCache?.entries) ? parsedCache.entries : [];

    for (const entry of entries.slice(0, passageCacheLimit).reverse()) {
      if (
        typeof entry?.key !== "string" ||
        !entry.key ||
        typeof entry?.payload?.html !== "string" ||
        typeof entry?.payload?.translation !== "string" ||
        typeof entry?.payload?.requestedReference !== "string"
      ) {
        continue;
      }

      passageCache.set(entry.key, {
        payload: entry.payload,
        accessedAt: Number(entry.accessedAt) || 0,
      });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error("Unable to load passage cache.", error);
    }
  }
}

async function writePassageCacheToDisk() {
  const serializedEntries = [...passageCache.entries()]
    .reverse()
    .slice(0, passageCacheLimit)
    .map(([key, value]) => ({
      key,
      payload: value.payload,
      accessedAt: value.accessedAt,
    }));
  const nextCacheState = JSON.stringify(
    {
      version: 1,
      entries: serializedEntries,
    },
    null,
    2,
  );
  const tempFile = `${passageCacheFile}.tmp`;

  await mkdir(dataDir, { recursive: true });
  await writeFile(tempFile, nextCacheState, "utf8");
  await rename(tempFile, passageCacheFile);
}

function normalizeReference(reference) {
  return reference?.trim().replace(/\s+/g, " ") || "";
}

function createPassageCacheKey(reference, translation) {
  return `${translation}:${reference.toLowerCase()}`;
}

function getTranslationConfig(translation) {
  const translationConfig = translationConfigs.get(translation);
  if (!translationConfig) {
    throw new UpstreamPassageError(400, "Unsupported translation.");
  }

  return translationConfig;
}

class UpstreamPassageError extends Error {
  constructor(statusCode, details) {
    super("Unable to load passage from upstream.");
    this.name = "UpstreamPassageError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

await hydratePassageCache();

server.listen(port, host, () => {
  console.log(
    `MemoryVerse running at http://${host}:${port} with ${passageCache.size} cached passages`,
  );
});
