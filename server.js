import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

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
  const reference = requestUrl.searchParams.get("reference")?.trim();
  const translation = requestUrl.searchParams.get("translation")?.trim().toUpperCase() || "NLT";

  if (!reference) {
    writeJson(res, 400, { error: "A Bible reference is required." });
    return;
  }

  if (!allowedTranslations.has(translation)) {
    writeJson(res, 400, { error: "Unsupported translation." });
    return;
  }

  const upstreamUrl = new URL("https://api.nlt.to/api/passages");
  upstreamUrl.searchParams.set("ref", reference);
  upstreamUrl.searchParams.set("version", translation);
  upstreamUrl.searchParams.set("key", "TEST");

  const upstreamResponse = await fetch(upstreamUrl, {
    headers: {
      "User-Agent": "MemoryVerse/1.0",
      Accept: "text/html",
    },
  });

  const html = await upstreamResponse.text();

  if (!upstreamResponse.ok) {
    writeJson(res, upstreamResponse.status, {
      error: "Unable to load that passage right now.",
      details: html.slice(0, 500),
    });
    return;
  }

  writeJson(res, 200, {
    html,
    translation,
    requestedReference: reference,
  });
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

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

server.listen(port, host, () => {
  console.log(`MemoryVerse running at http://${host}:${port}`);
});
