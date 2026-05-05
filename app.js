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

let settings = loadLocalSettings();
let pollTimer = null;
let focusBeforeSettings = null;

targetText.textContent = `${positionSlider.value}%`;
applySettings(settings);
init();

saveButton.addEventListener("click", async () => {
  settings = {
    host: normalizeHost(hostInput.value),
    coverId: Number.parseInt(coverIdInput.value, 10) || 0,
  };
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
    settings = serverSettings.host ? serverSettings : settings;
    persistLocalSettings(settings);
    applySettings(settings);
  } catch (error) {
    showError(error);
  }

  refreshStatus();
  pollTimer = window.setInterval(refreshStatus, 5000);
}

async function saveSettings(nextSettings) {
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
    setMessage("Saved permanently. Checking Shelly status...");
    closeSettings();
    await refreshStatus();
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
  };
}

async function runCommand(method, params = {}) {
  if (!settings.host) {
    setMessage("Enter the Shelly address first.");
    return;
  }

  setBusy(true);
  try {
    await shellyRpc(method, params);
    setMessage("Command sent.");
    await refreshStatus();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function refreshStatus() {
  if (!settings.host) {
    updateConnection("Not connected", "bad");
    return;
  }

  try {
    const status = await shellyRpc("Cover.GetStatus");
    updateConnection("Connected", "ok");
    renderStatus(status);
  } catch (error) {
    updateConnection("Offline", "bad");
    showError(error);
  }
}

async function testConnection() {
  const host = normalizeHost(hostInput.value);
  if (!host) {
    setMessage("Enter the Shelly address first.");
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
      setMessage("Connection works. Shelly cover:0 was found.");
    } else {
      setMessage("Shelly answered, but cover:0 was not found. Check that the device is in Cover/Shutter mode.");
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
    };
  } catch {
    return { host: "", coverId: 0 };
  }
}

function persistLocalSettings(nextSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings));
}

function applySettings(nextSettings) {
  hostInput.value = nextSettings.host;
  coverIdInput.value = String(nextSettings.coverId);
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
  return String(value).replace(/_/g, " ");
}

function setBusy(isBusy) {
  [openButton, stopButton, closeButton, goButton, saveButton, testButton].forEach((button) => {
    button.disabled = isBusy;
  });
}

function setControlsEnabled(enabled) {
  [openButton, stopButton, closeButton, goButton, positionSlider].forEach((control) => {
    control.disabled = !enabled;
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
  setMessage(`Could not reach Shelly. ${detail}`);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});
