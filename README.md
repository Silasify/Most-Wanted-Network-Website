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
- News: `http://127.0.0.1:3100/news`
- About Us: `http://127.0.0.1:3100/about`
- Suggestions: `http://127.0.0.1:3100/suggestions`
- Discord join redirect: `http://127.0.0.1:3100/discord`
- Admin: `http://127.0.0.1:3100/admin`

## Website Admin

The admin page uses Discord login and checks for a specific Discord role ID. Add these environment values to the website service:

```bash
DISCORD_CLIENT_ID="your_discord_application_client_id"
DISCORD_CLIENT_SECRET="your_discord_application_client_secret"
DISCORD_GUILD_ID="your_discord_server_id"
ADMIN_ROLE_ID="role_id_allowed_to_edit_the_website"
WEBSITE_PUBLIC_URL="https://mostwantednetwork.net"
```

In the Discord Developer Portal, add this redirect URL to the same application:

```text
https://mostwantednetwork.net/admin/callback
```

Then restart the website service and open `/admin`. The first version lets you edit `news.config.json` and `status.config.json` from the browser.

## Discord Join Button

Set `discordInviteUrl` in `status.config.json` or start the website with `DISCORD_INVITE_URL`.

PowerShell:

```powershell
$env:DISCORD_INVITE_URL="https://discord.gg/your-invite"
node server.js
```

## Send Suggestions to Discord

The best setup is to let the website send suggestions into the Discord bot, because the bot can post them with voting buttons.

Set these on the website service:

```bash
BOT_SUGGESTIONS_URL="http://127.0.0.1:3000/api/website-suggestion"
WEBSITE_SUGGESTION_TOKEN="use-the-same-secret-as-the-bot"
```

Set the same token on the bot service:

```bash
WEBSITE_SUGGESTION_TOKEN="use-the-same-secret-as-the-website"
```

As a fallback, you can still use a plain Discord webhook for the channel that should receive website suggestions:

PowerShell:

```powershell
$env:DISCORD_SUGGESTIONS_WEBHOOK_URL="https://discord.com/api/webhooks/..."
node server.js
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

Edit `status.config.json`:

```json
{
  "name": "Game Server",
  "host": "127.0.0.1",
  "port": 30120,
  "group": "Production",
  "description": "Optional short note",
  "actions": [
    {
      "label": "Join Discord",
      "url": "https://discord.mostwantednetwork.net"
    }
  ]
}
```

Add as many objects as needed to the `servers` array.

`actions` are public buttons shown on the status card. The hidden check address still stays private.

## Add News

Edit `news.config.json` to add updates for new servers, wipes, events, maintenance, and mod changes. The public page is available at `/news`.

To use a different web port without editing the file:

```bash
$env:STATUS_PORT=3200; node server.js
```
