const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const SHELLY_USER = process.env.SHELLY_USER || "admin";
const SHELLY_PASSWORD = process.env.SHELLY_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/rpc") {
      await handleRpc(request, response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/test") {
      await handleTest(request, response);
      return;
    }

    if (request.method === "GET" && request.url === "/api/settings") {
      await handleGetSettings(response);
      return;
    }

    if (request.method === "POST" && request.url === "/api/settings") {
      await handleSaveSettings(request, response);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Shelly Shutter controller: http://127.0.0.1:${PORT}/`);
  if (!SHELLY_PASSWORD) {
    console.log("Set SHELLY_PASSWORD before controlling a password-protected Shelly.");
  }
});

async function handleRpc(request, response) {
  const body = await readJson(request);
  const savedSettings = await loadServerSettings();
  const host = normalizeHost(body.host || savedSettings.host);
  const method = String(body.method || "");
  const params = body.params && typeof body.params === "object" ? body.params : {};

  if (!host) {
    sendJson(response, 400, { error: "Missing Shelly address" });
    return;
  }

  if (!/^Cover\./.test(method)) {
    sendJson(response, 400, { error: "Unsupported RPC method" });
    return;
  }

  const result = await callShelly(host, method, params);
  sendJson(response, 200, result);
}

async function handleTest(request, response) {
  const body = await readJson(request);
  const savedSettings = await loadServerSettings();
  const host = normalizeHost(body.host || savedSettings.host);

  if (!host) {
    sendJson(response, 400, { error: "Missing Shelly address" });
    return;
  }

  const result = await callShelly(host, "Shelly.GetStatus", {});
  sendJson(response, 200, {
    ok: true,
    hasCover0: Boolean(result["cover:0"]),
    cover0: result["cover:0"] || null,
  });
}

async function handleGetSettings(response) {
  const settings = await loadServerSettings();
  sendJson(response, 200, settings);
}

async function handleSaveSettings(request, response) {
  const body = await readJson(request);
  const settings = sanitizeSettings(body);

  if (!settings.host) {
    sendJson(response, 400, { error: "Missing Shelly address" });
    return;
  }

  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  sendJson(response, 200, settings);
}

async function loadServerSettings() {
  try {
    const file = await fs.promises.readFile(SETTINGS_FILE, "utf8");
    return sanitizeSettings(JSON.parse(file));
  } catch (error) {
    if (error.code && error.code !== "ENOENT") {
      console.warn(`Could not read settings file: ${error.message}`);
    }
    return sanitizeSettings({
      host: process.env.SHELLY_HOST || "",
      coverId: Number.parseInt(process.env.SHELLY_COVER_ID || "0", 10),
    });
  }
}

function sanitizeSettings(value) {
  const coverId = Number.parseInt(value?.coverId, 10);

  return {
    host: normalizeHost(value?.host || ""),
    coverId: Number.isInteger(coverId) && coverId >= 0 ? coverId : 0,
  };
}

async function callShelly(host, method, params) {
  const rpcUrl = new URL("/rpc", host);
  const body = JSON.stringify({
    id: Date.now(),
    src: "shelly-shutter",
    method,
    params,
  });

  const firstResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (firstResponse.status !== 401) {
    return parseShellyResponse(firstResponse);
  }

  if (!SHELLY_PASSWORD) {
    throw new Error("Shelly requires a password. Start the server with SHELLY_PASSWORD set.");
  }

  const challenge = firstResponse.headers.get("www-authenticate");
  if (!challenge) {
    throw new Error("Shelly requested authentication without a digest challenge.");
  }

  const authorization = createDigestHeader({
    challenge,
    username: SHELLY_USER,
    password: SHELLY_PASSWORD,
    method: "POST",
    uri: rpcUrl.pathname,
  });

  const authenticatedResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Authorization": authorization,
      "Content-Type": "application/json",
    },
    body,
  });

  return parseShellyResponse(authenticatedResponse);
}

async function parseShellyResponse(response) {
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Shelly returned non-JSON response: ${text.slice(0, 120)}`);
    }
  }

  if (!response.ok) {
    const detail = payload.error?.message || payload.message || `Shelly returned HTTP ${response.status}`;
    throw new Error(detail);
  }

  if (payload.error) {
    const detail = payload.error.message || JSON.stringify(payload.error);
    throw new Error(detail);
  }

  return payload.result ?? payload;
}

function createDigestHeader({ challenge, username, password, method, uri }) {
  const values = parseDigestChallenge(challenge);
  const realm = values.realm;
  const nonce = values.nonce;
  const qop = selectQop(values.qop);
  const algorithm = (values.algorithm || "SHA-256").toUpperCase();

  if (!realm || !nonce) {
    throw new Error("Shelly digest challenge did not include realm and nonce.");
  }

  if (algorithm !== "SHA-256") {
    throw new Error(`Unsupported Shelly digest algorithm: ${algorithm}`);
  }

  const nc = "00000001";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const ha1 = sha256(`${username}:${realm}:${password}`);
  const ha2 = sha256(`${method}:${uri}`);
  const response = sha256(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);

  return [
    `Digest username="${escapeHeader(username)}"`,
    `realm="${escapeHeader(realm)}"`,
    `nonce="${escapeHeader(nonce)}"`,
    `uri="${escapeHeader(uri)}"`,
    `algorithm=${algorithm}`,
    `qop=${qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`,
    `response="${response}"`,
  ].join(", ");
}

function parseDigestChallenge(header) {
  const withoutScheme = header.replace(/^Digest\s+/i, "");
  const values = {};
  const pattern = /(\w+)=("([^"\\]*(?:\\.[^"\\]*)*)"|[^,]*)/g;
  let match = pattern.exec(withoutScheme);

  while (match) {
    values[match[1].toLowerCase()] = match[3] ? match[3].replace(/\\"/g, "\"") : match[2].trim();
    match = pattern.exec(withoutScheme);
  }

  return values;
}

function selectQop(qop) {
  if (!qop) return "auth";
  const options = qop.split(",").map((value) => value.trim());
  if (options.includes("auth")) return "auth";
  throw new Error(`Unsupported Shelly digest qop: ${qop}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function escapeHeader(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function normalizeHost(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let data = "";

    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) {
        request.destroy();
        reject(new Error("Request body too large"));
      }
    });

    request.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        reject(new Error("Invalid JSON request"));
      }
    });

    request.on("error", reject);
  });
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR) || filePath === __filename) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": stat.size,
    });

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    fs.createReadStream(filePath).pipe(response);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
