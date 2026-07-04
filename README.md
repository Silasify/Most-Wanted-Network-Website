# Most Wanted Network Website

This is separate from the Discord bot. It runs its own tiny Node server, serves the Most Wanted Network website, and checks every entry in `status.config.json` for the live Server Status page.

## Run

```bash
npm start
```

Open:

```text
http://127.0.0.1:3100
```

## Pages

- Landing page: `http://127.0.0.1:3100/`
- Server Status: `http://127.0.0.1:3100/status`
- About Us: `http://127.0.0.1:3100/about`
- Suggestions: `http://127.0.0.1:3100/suggestions`
- Discord join redirect: `http://127.0.0.1:3100/discord`

## Discord Join Button

Set `discordInviteUrl` in `standalone-status/status.config.json` or start the website with `DISCORD_INVITE_URL`.

PowerShell:

```powershell
$env:DISCORD_INVITE_URL="https://discord.gg/your-invite"
node standalone-status/server.js
```

## Send Suggestions to Discord

Create a Discord webhook for the channel that should receive website suggestions. Then start the website with the webhook URL in `DISCORD_SUGGESTIONS_WEBHOOK_URL`.

PowerShell:

```powershell
$env:DISCORD_SUGGESTIONS_WEBHOOK_URL="https://discord.com/api/webhooks/..."
node standalone-status/server.js
```

If this variable is not set, the Suggestions page will show that Discord is not connected yet.

## Debian Server Quick Start

Install Node.js 20 or newer, then clone the repo and run:

```bash
npm install
DISCORD_INVITE_URL="https://discord.gg/your-invite" \
DISCORD_SUGGESTIONS_WEBHOOK_URL="https://discord.com/api/webhooks/..." \
npm start
```

The site listens on the port from `STATUS_PORT`, or `3100` by default. Put Nginx, Caddy, or your host panel in front of it if you want to serve it on ports `80` and `443`.

## Add Servers

Edit `standalone-status/status.config.json`:

```json
{
  "name": "Game Server",
  "host": "127.0.0.1",
  "port": 30120,
  "group": "Production",
  "description": "Optional short note"
}
```

Add as many objects as needed to the `servers` array.

To use a different web port without editing the file:

```bash
$env:STATUS_PORT=3200; node standalone-status/server.js
```
