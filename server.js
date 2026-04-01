import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const passageCacheFile = path.join(dataDir, "passage-cache.json");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const passageCacheLimit = Math.max(1, Number(process.env.PASSAGE_CACHE_LIMIT || 5000));
const upstreamTimeoutMs = Math.max(1000, Number(process.env.UPSTREAM_TIMEOUT_MS || 15000));

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

const allowedTranslations = new Set(["NLT", "NLTUK", "NTV", "KJV"]);
const passageCache = new Map();
const inFlightPassageRequests = new Map();
let passageCacheWriteTimer = null;

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
    const { payload, cacheStatus } = await getPassagePayload(reference, translation);
    writeJson(res, 200, payload, {
      "Cache-Control": "private, max-age=31536000, immutable",
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

async function getPassagePayload(reference, translation) {
  const cacheKey = createPassageCacheKey(reference, translation);
  const cachedPayload = readCachedPassage(cacheKey);
  if (cachedPayload) {
    return {
      payload: cachedPayload,
      cacheStatus: "HIT",
    };
  }

  const existingRequest = inFlightPassageRequests.get(cacheKey);
  if (existingRequest) {
    const payload = await existingRequest;
    return {
      payload,
      cacheStatus: "DEDUPED",
    };
  }

  const requestPromise = fetchPassagePayload(reference, translation)
    .then((payload) => {
      writeCachedPassage(cacheKey, payload);
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

async function fetchPassagePayload(reference, translation) {
  const upstreamUrl = new URL("https://api.nlt.to/api/passages");
  upstreamUrl.searchParams.set("ref", reference);
  upstreamUrl.searchParams.set("version", translation);
  upstreamUrl.searchParams.set("key", "TEST");

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(upstreamTimeoutMs),
      headers: {
        "User-Agent": "MemoryVerse/1.0",
        Accept: "text/html",
      },
    });
  } catch (error) {
    throw new UpstreamPassageError(
      504,
      error instanceof Error ? error.message : "Timed out while contacting the upstream passage API.",
    );
  }

  const html = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    throw new UpstreamPassageError(upstreamResponse.status, html.slice(0, 500));
  }

  return {
    html,
    translation,
    requestedReference: reference,
  };
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
