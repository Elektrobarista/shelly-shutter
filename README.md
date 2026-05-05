# Shelly Shutter

A small local web app for controlling a Shelly Plus 2PM configured as a cover or shutter.

## Use

Start the local controller server with your Shelly password:

```sh
SHELLY_PASSWORD='your-shelly-password' node server.js
```

If your Shelly user is not `admin`, also set `SHELLY_USER`:

```sh
SHELLY_USER='your-user' SHELLY_PASSWORD='your-shelly-password' node server.js
```

Then open:

```text
http://127.0.0.1:4173/
```

Open the settings with the gear button, enter the Shelly address, and save it.
Use **Test connection** first. It checks whether the local controller can authenticate with the Shelly and whether `cover:0` exists.

Examples:

- `192.168.1.42`
- `http://shellyplus2pm.local`

The app calls the Shelly Gen2 RPC cover endpoints:

- `Cover.GetStatus`
- `Cover.Open`
- `Cover.Stop`
- `Cover.Close`
- `Cover.GoToPosition`

The default cover id is `0`, which is the normal id for a Plus 2PM shutter setup.

## Docker

Build the image:

```sh
docker build -t shelly-shutter .
```

Run it:

```sh
docker run --rm \
  -p 4173:4173 \
  -e SHELLY_PASSWORD='your-shelly-password' \
  -v shelly-shutter-data:/data \
  shelly-shutter
```

If the Shelly username is not `admin`, add:

```sh
-e SHELLY_USER='your-user'
```

Then open:

```text
http://127.0.0.1:4173/
```

The Shelly address and cover id are saved in `/data/settings.json`. Mounting `/data` keeps them across container restarts.

## Docker Compose

Create a `.env` file:

```sh
cp .env.example .env
```

Edit `.env` and set:

```text
SHELLY_USER=admin
SHELLY_PASSWORD=your-shelly-password
```

Start:

```sh
docker compose up -d
```

Open:

```text
http://127.0.0.1:4173/
```

Stop:

```sh
docker compose down
```

The named volume `shelly-shutter-data` keeps `/data/settings.json` across restarts.

## Notes

The app is intended for local network use. The Shelly password is read by the local Node server and is not sent to frontend JavaScript.

## License

MIT. See [LICENSE](LICENSE).
