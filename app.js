const STORAGE_KEY = "shelly-shutter-settings";
const FOCUSABLE_SELECTOR = "button, input, [href], select, textarea, [tabindex]:not([tabindex='-1'])";

const hostInput = document.querySelector("#hostInput");
const coverIdInput = document.querySelector("#coverIdInput");
const saveButton = document.querySelector("#saveButton");
const testButton = document.querySelector("#testButton");
const settingsButton = document.querySelector("#settingsButton");
const settingsModal = document.querySelector("#settingsModal");
const closeSettingsButton = document.querySelector("#closeSettingsButton");
const openButton = document.querySelector("#openButton");
const stopButton = document.querySelector("#stopButton");
const closeButton = document.querySelector("#closeButton");
const goButton = document.querySelector("#goButton");
const positionSlider = document.querySelector("#positionSlider");
const targetText = document.querySelector("#targetText");
const positionText = document.querySelector("#positionText");
const stateText = document.querySelector("#stateText");
const message = document.querySelector("#message");
const connectionStatus = document.querySelector("#connectionStatus");
const wakeEnabledInput = document.querySelector("#wakeEnabledInput");
const wakeTimeInput = document.querySelector("#wakeTimeInput");
const saveWakeButton = document.querySelector("#saveWakeButton");
const wakeTimeTags = document.querySelector("#wakeTimeTags");
const wakeStatus = document.querySelector("#wakeStatus");
const DEFAULT_WAKE_TIMES = ["06:30", "08:35"];

let settings = loadLocalSettings();
let pollTimer = null;
let focusBeforeSettings = null;

targetText.textContent = `${positionSlider.value}%`;
applySettings(settings);
init();

saveButton.addEventListener("click", async () => {
  settings = mergeSettings({
    host: normalizeHost(hostInput.value),
    coverId: Number.parseInt(coverIdInput.value, 10) || 0,
  });
  await saveSettings(settings);
});

testButton.addEventListener("click", testConnection);
settingsButton.addEventListener("click", openSettings);
closeSettingsButton.addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) closeSettings();
});

openButton.addEventListener("click", () => runCommand("Cover.Open"));
stopButton.addEventListener("click", () => runCommand("Cover.Stop"));
closeButton.addEventListener("click", () => runCommand("Cover.Close"));
goButton.addEventListener("click", () => {
  runCommand("Cover.GoToPosition", { pos: Number.parseInt(positionSlider.value, 10) });
});
saveWakeButton.addEventListener("click", async () => {
  if (!settings.host) {
    setMessage("Bitte zuerst die Shelly-Adresse in den Einstellungen eintragen.");
    return;
  }

  const wakeTime = readWakeTimeSelection();
  if (wakeEnabledInput.checked && !isValidWakeTime(wakeTime)) {
    setMessage("Bitte eine gültige Weckzeit im 24-Stunden-Format eingeben, zum Beispiel 06:30.");
    wakeTimeInput.focus();
    return;
  }

  settings = mergeSettings({
    wakeEnabled: wakeEnabledInput.checked,
    wakeTime,
    recentWakeTimes: buildRecentWakeTimes(wakeTime, settings.recentWakeTimes),
  });
  await saveSettings(settings, { closeModal: false, refreshShelly: false });
});

wakeTimeTags.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-time]");
  if (!button) return;
  applyWakeTime(button.dataset.time);
  wakeEnabledInput.checked = true;
});

wakeTimeInput.addEventListener("blur", () => {
  const normalizedTime = normalizeWakeTime(wakeTimeInput.value);
  if (normalizedTime) wakeTimeInput.value = normalizedTime;
});

positionSlider.addEventListener("input", () => {
  targetText.textContent = `${positionSlider.value}%`;
});

window.addEventListener("online", refreshStatus);
window.addEventListener("keydown", (event) => {
  if (settingsModal.hidden) return;
  if (event.key === "Escape") closeSettings();
  if (event.key === "Tab") keepFocusInSettings(event);
});

async function init() {
  try {
    const serverSettings = await loadServerSettings();
    settings = serverSettings.host ? serverSettings : mergeSettings(serverSettings);
    persistLocalSettings(settings);
    applySettings(settings);
  } catch (error) {
    showError(error);
  }

  refreshStatus();
  refreshWakeStatus();
  pollTimer = window.setInterval(() => {
    refreshStatus();
    refreshWakeStatus();
  }, 5000);
}

async function saveSettings(nextSettings, options = {}) {
  const { closeModal: shouldCloseModal = true, refreshShelly = true } = options;
  setBusy(true);
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify(nextSettings),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    settings = payload;
    persistLocalSettings(settings);
    applySettings(settings);
    setMessage("Dauerhaft gespeichert.");
    if (shouldCloseModal) closeSettings();
    if (refreshShelly) {
      setMessage("Dauerhaft gespeichert. Prüfe Shelly-Status...");
      await refreshStatus();
    }
    await refreshWakeStatus();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function loadServerSettings() {
  const response = await fetch("/api/settings", {
    method: "GET",
    cache: "no-store",
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return {
    host: payload.host || "",
    coverId: Number.isInteger(payload.coverId) ? payload.coverId : 0,
    wakeEnabled: Boolean(payload.wakeEnabled),
    wakeTime: isValidWakeTime(payload.wakeTime) ? payload.wakeTime : "",
    recentWakeTimes: sanitizeRecentWakeTimes(payload.recentWakeTimes),
  };
}

async function runCommand(method, params = {}) {
  if (!settings.host) {
    setMessage("Bitte zuerst die Shelly-Adresse eintragen.");
    return;
  }

  setBusy(true);
  try {
    await shellyRpc(method, params);
    setMessage("Befehl gesendet.");
    await refreshStatus();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function refreshStatus() {
  if (!settings.host) {
    updateConnection("Nicht verbunden", "bad");
    return;
  }

  try {
    const status = await shellyRpc("Cover.GetStatus");
    updateConnection("Verbunden", "ok");
    renderStatus(status);
  } catch (error) {
    updateConnection("Offline", "bad");
    showError(error);
  }
}

async function refreshWakeStatus() {
  try {
    const response = await fetch("/api/wake-status", {
      method: "GET",
      cache: "no-store",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    wakeStatus.textContent = payload.error || payload.status || "Weckzeit deaktiviert.";
    wakeStatus.classList.toggle("bad", Boolean(payload.error));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    wakeStatus.textContent = `Weckstatus nicht verfügbar. ${detail}`;
    wakeStatus.classList.add("bad");
  }
}

async function testConnection() {
  const host = normalizeHost(hostInput.value);
  if (!host) {
    setMessage("Bitte zuerst die Shelly-Adresse eintragen.");
    return;
  }

  setBusy(true);
  try {
    const response = await fetch("/api/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ host }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }

    if (payload.hasCover0) {
      setMessage("Verbindung funktioniert. Shelly cover:0 wurde gefunden.");
    } else {
      setMessage("Shelly antwortet, aber cover:0 wurde nicht gefunden. Prüfe, ob das Gerät im Cover-/Rolladenmodus ist.");
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function shellyRpc(method, params = {}) {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({
      host: settings.host,
      method,
      params: { id: settings.coverId, ...params },
    }),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload.error) detail = payload.error;
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(detail);
  }

  return response.json();
}

function renderStatus(status) {
  const position = readPosition(status);
  const currentState = status.state || status.last_direction || "stopped";

  if (typeof position === "number") {
    positionText.textContent = `${Math.round(position)}%`;
    positionSlider.value = String(Math.round(position));
    targetText.textContent = `${Math.round(position)}%`;
  } else {
    positionText.textContent = "--%";
  }

  stateText.textContent = formatState(currentState);
  setMessage("");
}

function readPosition(status) {
  if (typeof status.current_pos === "number") return status.current_pos;
  if (typeof status.pos === "number") return status.pos;
  if (typeof status.apos === "number") return status.apos;
  return null;
}

function normalizeHost(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function loadLocalSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      host: parsed.host || "",
      coverId: Number.isInteger(parsed.coverId) ? parsed.coverId : 0,
      wakeEnabled: Boolean(parsed.wakeEnabled),
      wakeTime: isValidWakeTime(parsed.wakeTime) ? parsed.wakeTime : "",
      recentWakeTimes: sanitizeRecentWakeTimes(parsed.recentWakeTimes),
    };
  } catch {
    return defaultSettings();
  }
}

function persistLocalSettings(nextSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings));
}

function applySettings(nextSettings) {
  hostInput.value = nextSettings.host;
  coverIdInput.value = String(nextSettings.coverId);
  wakeEnabledInput.checked = Boolean(nextSettings.wakeEnabled);
  applyWakeTime(nextSettings.wakeTime || DEFAULT_WAKE_TIMES[0]);
  renderWakeTimeTags(nextSettings.recentWakeTimes);
  setControlsEnabled(Boolean(nextSettings.host));
}

function openSettings() {
  focusBeforeSettings = document.activeElement;
  settingsModal.hidden = false;
  settingsButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("modal-open");
  hostInput.focus();
}

function closeSettings() {
  settingsModal.hidden = true;
  settingsButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("modal-open");
  const focusTarget = focusBeforeSettings instanceof HTMLElement ? focusBeforeSettings : settingsButton;
  focusBeforeSettings = null;
  focusTarget.focus();
}

function keepFocusInSettings(event) {
  const focusable = Array.from(settingsModal.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((element) => !element.disabled && element.offsetParent !== null);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (!first || !last) return;

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function formatState(value) {
  const state = String(value);
  const translations = {
    closed: "geschlossen",
    closing: "schließt",
    open: "offen",
    opening: "öffnet",
    stopped: "gestoppt",
    stop: "gestoppt",
  };
  return translations[state] || state.replace(/_/g, " ");
}

function setBusy(isBusy) {
  [saveButton, testButton].forEach((button) => {
    button.disabled = isBusy;
  });

  if (isBusy) {
    [openButton, stopButton, closeButton, goButton, positionSlider, saveWakeButton].forEach((control) => {
      control.disabled = true;
    });
    return;
  }

  setControlsEnabled(Boolean(settings.host));
}

function setControlsEnabled(enabled) {
  [openButton, stopButton, closeButton, goButton, positionSlider].forEach((control) => {
    control.disabled = !enabled;
  });
  [wakeEnabledInput, wakeTimeInput, saveWakeButton].forEach((control) => {
    control.disabled = false;
  });
}

function updateConnection(text, mode) {
  connectionStatus.textContent = text;
  connectionStatus.classList.toggle("ok", mode === "ok");
  connectionStatus.classList.toggle("bad", mode === "bad");
}

function setMessage(text) {
  message.textContent = text;
}

function showError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  setMessage(`Shelly konnte nicht erreicht werden. ${detail}`);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});

function defaultSettings() {
  return {
    host: "",
    coverId: 0,
    wakeEnabled: false,
    wakeTime: "",
    recentWakeTimes: DEFAULT_WAKE_TIMES,
  };
}

function mergeSettings(nextSettings) {
  return {
    ...defaultSettings(),
    ...settings,
    ...nextSettings,
    recentWakeTimes: sanitizeRecentWakeTimes(nextSettings.recentWakeTimes ?? settings.recentWakeTimes),
  };
}

function isValidWakeTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function normalizeWakeTime(value) {
  const trimmed = String(value || "").trim();
  const fullMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (fullMatch) return `${fullMatch[1]}:${fullMatch[2]}`;

  const shortMatch = /^(\d{1,2})[:.](\d{1,2})$/.exec(trimmed);
  if (!shortMatch) return "";

  const hour = Number.parseInt(shortMatch[1], 10);
  const minute = Number.parseInt(shortMatch[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function sanitizeRecentWakeTimes(value) {
  const times = Array.isArray(value) ? value : DEFAULT_WAKE_TIMES;
  return [...new Set(times.filter(isValidWakeTime))].slice(0, 5);
}

function buildRecentWakeTimes(wakeTime, recentWakeTimes) {
  const times = isValidWakeTime(wakeTime) ? [wakeTime, ...recentWakeTimes] : recentWakeTimes;
  return sanitizeRecentWakeTimes(times);
}

function renderWakeTimeTags(recentWakeTimes) {
  wakeTimeTags.replaceChildren();
  for (const time of recentWakeTimes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "time-tag";
    button.dataset.time = time;
    button.textContent = time;
    wakeTimeTags.append(button);
  }
}

function applyWakeTime(time) {
  const safeTime = isValidWakeTime(time) ? time : DEFAULT_WAKE_TIMES[0];
  wakeTimeInput.value = safeTime;
}

function readWakeTimeSelection() {
  const wakeTime = normalizeWakeTime(wakeTimeInput.value);
  if (wakeTime) wakeTimeInput.value = wakeTime;
  return wakeTime;
}
