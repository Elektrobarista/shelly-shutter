# Shelly Shutter Controller Explanation

This project is a small local web app for controlling a Shelly Plus 2PM that is configured in cover/shutter mode.

It has two parts:

- `index.html`, `styles.css`, and `app.js`: the browser frontend.
- `server.js`: a local Node.js server that serves the frontend and talks to the Shelly device.

The local server is needed because the Shelly is password protected. The password should not be put into browser JavaScript, so the browser only talks to the local server. The local server reads the Shelly password from an environment variable and sends authenticated RPC requests to the Shelly.

## Request Flow

The control flow is:

```text
Browser UI
  -> POST /api/rpc on local server
  -> server.js sends RPC request to http://SHELLY_IP/rpc
  -> Shelly executes Cover.Open, Cover.Close, Cover.Stop, etc.
  -> response returns through server.js
  -> browser updates the UI
```

For diagnostics, the flow is:

```text
Browser UI
  -> POST /api/test on local server
  -> server.js sends Shelly.GetStatus to the Shelly
  -> server checks whether cover:0 exists
  -> browser displays whether the Shelly is in cover/shutter mode
```

## Starting The App

Start the local server from the project folder:

```sh
SHELLY_PASSWORD='your-shelly-password' node server.js
```

If the Shelly username is not `admin`, also set `SHELLY_USER`:

```sh
SHELLY_USER='your-user' SHELLY_PASSWORD='your-shelly-password' node server.js
```

Then open:

```text
http://127.0.0.1:4173/
```

The password is not stored in `localStorage` and is not sent to the frontend. It only exists in the `server.js` process environment.

## Frontend Files

### `index.html`

`index.html` defines the visible controls:

- Shelly address input.
- Cover id input.
- Save button.
- Test connection button.
- Open, Stop, and Close buttons.
- Position slider.
- Status and error message areas.

The important element ids are used by `app.js`, for example:

- `hostInput`
- `coverIdInput`
- `testButton`
- `openButton`
- `stopButton`
- `closeButton`
- `positionSlider`
- `message`
- `connectionStatus`

### `styles.css`

`styles.css` handles the layout and visual design. It does not contain any Shelly logic.

The UI is intentionally simple:

- One main panel.
- A connection status pill.
- A setup area for address and cover id.
- A control area for shutter state and commands.
- Responsive layout for smaller screens.

### `app.js`

`app.js` contains all frontend behavior.

At startup it:

1. Reads saved settings from `localStorage`.
2. Fills the Shelly address and cover id inputs.
3. Enables or disables controls depending on whether an address exists.
4. Starts polling the Shelly status every 5 seconds.

The browser keeps a fallback copy with this key:

```js
const STORAGE_KEY = "shelly-shutter-settings";
```

The durable copy is stored by `server.js` in `/data/settings.json` by default. Only the Shelly address and cover id are saved. The password is not saved by the browser or by the settings file.

## Frontend Functions

### `saveButton` click handler

When Save is clicked, the frontend:

1. Normalizes the Shelly address.
2. Reads the cover id, defaulting to `0`.
3. Sends both values to `POST /api/settings`.
4. Stores a fallback copy in `localStorage`.
5. Calls `refreshStatus()`.

The address normalizer allows the user to enter either:

```text
192.168.1.42
```

or:

```text
http://192.168.1.42
```

If no protocol is present, the app adds `http://`.

### `testConnection()`

`testConnection()` calls the local server endpoint:

```text
POST /api/test
```

It sends:

```json
{
  "host": "http://192.168.1.42"
}
```

The server then calls `Shelly.GetStatus` on the Shelly. The response tells the UI whether `cover:0` exists.

If `cover:0` does not exist, the Shelly is probably still configured as two switch outputs instead of cover/shutter mode.

### `runCommand(method, params)`

`runCommand()` is used for the shutter commands.

Examples:

```js
runCommand("Cover.Open");
runCommand("Cover.Stop");
runCommand("Cover.Close");
runCommand("Cover.GoToPosition", { pos: 50 });
```

It disables the buttons while the command is running, sends the command, then refreshes status.

### `refreshStatus()`

`refreshStatus()` calls:

```js
shellyRpc("Cover.GetStatus");
```

The returned status is rendered by `renderStatus()`. This updates:

- Current position text.
- Slider value.
- State text.
- Connection status.

### `shellyRpc(method, params)`

This function does not contact the Shelly directly. It contacts the local Node server:

```text
POST /api/rpc
```

The request body looks like this:

```json
{
  "host": "http://192.168.1.42",
  "method": "Cover.GoToPosition",
  "params": {
    "id": 0,
    "pos": 50
  }
}
```

The `id` is the Shelly cover id. For a normal Shelly Plus 2PM shutter setup, this is `0`.

## Server File

### `server.js`

`server.js` has two jobs:

1. Serve the static frontend files.
2. Proxy authenticated Shelly RPC requests.

It uses only built-in Node.js modules:

- `http`
- `fs`
- `path`
- `crypto`

There are no npm dependencies.

## Server Configuration

The server reads these environment variables:

```js
const PORT = Number.parseInt(process.env.PORT || "4173", 10);
const SHELLY_USER = process.env.SHELLY_USER || "admin";
const SHELLY_PASSWORD = process.env.SHELLY_PASSWORD || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
```

Defaults:

- Port: `4173`
- Shelly username: `admin`
- Shelly password: empty
- Settings directory: local `data` folder, or `/data` in Docker

For a password-protected Shelly, `SHELLY_PASSWORD` must be set.

The Shelly address and cover id are persisted in:

```text
/data/settings.json
```

when running in Docker.

## Server Endpoints

### `GET /`

Serves `index.html`.

The same static file handler also serves:

- `/styles.css`
- `/app.js`
- `/assets/shutter.svg`

### `GET /api/settings`

Returns the saved Shelly address and cover id.

If no settings file exists yet, the server falls back to:

- `SHELLY_HOST`
- `SHELLY_COVER_ID`

### `POST /api/settings`

Stores the Shelly address and cover id permanently in the configured data directory.

Example saved file:

```json
{
  "host": "http://192.168.1.42",
  "coverId": 0
}
```

### `POST /api/rpc`

This endpoint is used by the frontend to run cover commands.

It accepts:

```json
{
  "host": "http://192.168.1.42",
  "method": "Cover.Open",
  "params": {
    "id": 0
  }
}
```

For safety, it only accepts methods beginning with:

```text
Cover.
```

That prevents the browser UI from using this endpoint as an unrestricted Shelly API proxy.

### `POST /api/test`

This endpoint checks whether the Shelly is reachable and whether it exposes `cover:0`.

It calls:

```text
Shelly.GetStatus
```

Then it returns:

```json
{
  "ok": true,
  "hasCover0": true,
  "cover0": {}
}
```

If `hasCover0` is `false`, the Shelly answered, but it is probably not in cover/shutter mode.

## Shelly RPC Calls

The server sends Shelly RPC requests to:

```text
http://SHELLY_IP/rpc
```

The body uses Shelly Gen2 JSON-RPC style:

```json
{
  "id": 123456789,
  "src": "shelly-shutter",
  "method": "Cover.Open",
  "params": {
    "id": 0
  }
}
```

The commands used by the app are:

- `Cover.GetStatus`
- `Cover.Open`
- `Cover.Stop`
- `Cover.Close`
- `Cover.GoToPosition`
- `Shelly.GetStatus` for diagnostics

## Authentication

Password-protected Shelly Gen2 devices use HTTP digest authentication.

The server handles this in `callShelly()`:

1. It sends the RPC request without authentication.
2. If the Shelly returns HTTP `401`, the server reads the `WWW-Authenticate` challenge header.
3. It builds a digest `Authorization` header.
4. It sends the same RPC request again with that header.

The digest header is created by:

```js
createDigestHeader(...)
```

This function:

1. Parses the Shelly challenge.
2. Reads `realm`, `nonce`, `qop`, and `algorithm`.
3. Creates a random `cnonce`.
4. Hashes the digest parts with SHA-256.
5. Returns the final `Authorization` header.

The hashing formula is:

```text
HA1 = SHA256(username:realm:password)
HA2 = SHA256(method:uri)
response = SHA256(HA1:nonce:nc:cnonce:qop:HA2)
```

The implementation currently supports `SHA-256` and `qop=auth`, which matches the expected Shelly Gen2 digest auth flow.

## Error Handling

Frontend errors are shown in the message area below the controls.

Common failures:

- Missing Shelly address: the frontend asks for an address.
- Missing password: the server says to start with `SHELLY_PASSWORD`.
- Wrong password: Shelly returns an authentication error.
- Wrong Shelly mode: `/api/test` works, but `hasCover0` is false.
- Network issue: the server cannot reach the Shelly IP.

The server returns errors as JSON:

```json
{
  "error": "message"
}
```

The frontend reads that error and displays it.

## Important Shelly Setup

The Shelly Plus 2PM must be configured as a cover/shutter.

If the Shelly home screen shows:

```text
Output (0)
Output (1)
```

then it is still in switch mode, and `Cover.*` RPC methods will not work.

Change the Shelly device profile to cover/shutter/roller shutter mode, save, reboot if needed, and run calibration. After that, `cover:0` should appear in `Shelly.GetStatus`, and this app can control it.
