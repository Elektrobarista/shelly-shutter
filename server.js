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
const WAKE_RAMP_STEPS = [
  { delayMs: 0, pos: 2 },
  { delayMs: 90_000, pos: 3 },
  { delayMs: 180_000, pos: 5 },
  { delayMs: 270_000, pos: 8 },
  { delayMs: 360_000, pos: 12 },
  { delayMs: 450_000, pos: 18 },
  { delayMs: 540_000, pos: 27 },
  { delayMs: 630_000, pos: 40 },
  { delayMs: 720_000, pos: 58 },
  { delayMs: 810_000, pos: 78 },
  { delayMs: 900_000, pos: 100 },
];
const MAX_RECENT_WAKE_TIMES = 5;
const DEFAULT_WAKE_TIMES = ["06:30", "08:35"];

const wakeRuntime = {
  active: false,
  checkedMinute: "",
  lastDate: "",
  lastStatus: "Weckzeit deaktiviert.",
  lastError: "",
  runId: 0,
  timers: [],
};

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

    if (request.method === "GET" && request.url === "/api/wake-status") {
      handleWakeStatus(response);
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

setInterval(checkWakeSchedule, 15_000);
checkWakeSchedule();

async function handleRpc(request, response) {
  const body = await readJson(request);
  const savedSettings = await loadServerSettings();
  const host = normalizeHost(body.host || savedSettings.host);
  const method = String(body.method || "");
  const params = body.params && typeof body.params === "object" ? body.params : {};

  if (!host) {
    sendJson(response, 400, { error: "Shelly-Adresse fehlt" });
    return;
  }

  if (!/^Cover\./.test(method)) {
    sendJson(response, 400, { error: "Unsupported RPC method" });
    return;
  }

  if (params.tag !== "wake" && method !== "Cover.GetStatus") {
    cancelWakeRamp("Weckrampe durch manuellen Befehl gestoppt.");
  }

  const result = await callShelly(host, method, params);
  sendJson(response, 200, result);
}

async function handleTest(request, response) {
  const body = await readJson(request);
  const savedSettings = await loadServerSettings();
  const host = normalizeHost(body.host || savedSettings.host);

  if (!host) {
    sendJson(response, 400, { error: "Shelly-Adresse fehlt" });
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

function handleWakeStatus(response) {
  sendJson(response, 200, {
    active: wakeRuntime.active,
    status: wakeRuntime.lastStatus,
    error: wakeRuntime.lastError,
  });
}

async function handleSaveSettings(request, response) {
  const body = await readJson(request);
  const settings = sanitizeSettings(body);

  if (!settings.host) {
    sendJson(response, 400, { error: "Shelly-Adresse fehlt" });
    return;
  }

  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  await fs.promises.writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  wakeRuntime.checkedMinute = "";
  wakeRuntime.lastError = "";
  wakeRuntime.lastStatus = describeWakeSettings(settings);
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
      wakeEnabled: false,
      wakeTime: "",
      recentWakeTimes: DEFAULT_WAKE_TIMES,
    });
  }
}

function sanitizeSettings(value) {
  const coverId = Number.parseInt(value?.coverId, 10);
  const wakeTime = sanitizeWakeTime(value?.wakeTime);
  const recentWakeTimes = sanitizeRecentWakeTimes(value?.recentWakeTimes, wakeTime);

  return {
    host: normalizeHost(value?.host || ""),
    coverId: Number.isInteger(coverId) && coverId >= 0 ? coverId : 0,
    wakeEnabled: Boolean(value?.wakeEnabled && wakeTime),
    wakeTime,
    recentWakeTimes,
  };
}

async function checkWakeSchedule() {
  const now = new Date();
  const minuteKey = formatDateMinute(now);
  if (minuteKey === wakeRuntime.checkedMinute) return;
  wakeRuntime.checkedMinute = minuteKey;

  const settings = await loadServerSettings();
  if (!settings.wakeEnabled || !settings.wakeTime || wakeRuntime.active) {
    if (!wakeRuntime.active) wakeRuntime.lastStatus = describeWakeSettings(settings);
    return;
  }

  const today = formatDate(now);
  if (wakeRuntime.lastDate === today || formatTime(now) !== settings.wakeTime) return;

  wakeRuntime.lastDate = today;
  startWakeRamp(settings).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    wakeRuntime.lastError = message;
    wakeRuntime.lastStatus = `Weckrampe fehlgeschlagen: ${message}`;
    wakeRuntime.active = false;
    clearWakeTimers();
  });
}

async function startWakeRamp(settings) {
  if (!settings.host) throw new Error("Shelly-Adresse fehlt");

  const status = await callShelly(settings.host, "Cover.GetStatus", { id: settings.coverId });
  if (status.pos_control === false) {
    throw new Error("Shelly-Cover ist nicht für Positionssteuerung kalibriert.");
  }

  const currentPosition = readShellyPosition(status);
  if (typeof currentPosition !== "number") {
    throw new Error("Shelly-Cover-Position ist unbekannt.");
  }

  clearWakeTimers();
  wakeRuntime.active = true;
  wakeRuntime.lastError = "";
  wakeRuntime.lastStatus = "Weckrampe läuft.";
  wakeRuntime.runId += 1;

  const runId = wakeRuntime.runId;
  for (const step of WAKE_RAMP_STEPS) {
    if (currentPosition > step.pos) continue;
    wakeRuntime.timers.push(setTimeout(() => {
      runWakeStep(settings, step, runId);
    }, step.delayMs));
  }

  wakeRuntime.timers.push(setTimeout(() => {
    if (wakeRuntime.runId !== runId) return;
    wakeRuntime.active = false;
    wakeRuntime.lastStatus = describeWakeSettings(settings);
    clearWakeTimers();
  }, WAKE_RAMP_STEPS.at(-1).delayMs + 5_000));
}

async function runWakeStep(settings, step, runId) {
  if (wakeRuntime.runId !== runId) return;

  try {
    await callShelly(settings.host, "Cover.GoToPosition", {
      id: settings.coverId,
      pos: step.pos,
      tag: "wake",
    });
    wakeRuntime.lastStatus = `Weckrampe auf ${step.pos}% gefahren.`;
  } catch (error) {
    if (wakeRuntime.runId !== runId) return;
    const message = error instanceof Error ? error.message : String(error);
    wakeRuntime.lastError = message;
    wakeRuntime.lastStatus = `Weckrampe fehlgeschlagen: ${message}`;
    wakeRuntime.active = false;
    clearWakeTimers();
  }
}

function cancelWakeRamp(status) {
  if (!wakeRuntime.active) return;
  wakeRuntime.active = false;
  wakeRuntime.runId += 1;
  wakeRuntime.lastStatus = status;
  clearWakeTimers();
}

function clearWakeTimers() {
  for (const timer of wakeRuntime.timers) clearTimeout(timer);
  wakeRuntime.timers = [];
}

function sanitizeWakeTime(value) {
  const time = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : "";
}

function sanitizeRecentWakeTimes(value, wakeTime) {
  const candidates = Array.isArray(value) ? value : DEFAULT_WAKE_TIMES;
  const times = wakeTime ? [wakeTime, ...candidates] : candidates;
  return [...new Set(times.map(sanitizeWakeTime).filter(Boolean))].slice(0, MAX_RECENT_WAKE_TIMES);
}

function describeWakeSettings(settings) {
  if (!settings.wakeEnabled || !settings.wakeTime) return "Weckzeit deaktiviert.";
  return `Weckzeit für die nächste Ausführung um ${settings.wakeTime} gesetzt.`;
}

function readShellyPosition(status) {
  if (typeof status.current_pos === "number") return status.current_pos;
  if (typeof status.pos === "number") return status.pos;
  if (typeof status.apos === "number") return status.apos;
  return null;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDateMinute(date) {
  return `${formatDate(date)} ${formatTime(date)}`;
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
