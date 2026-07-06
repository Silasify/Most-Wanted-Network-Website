import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(rootDir, 'status.config.json');
const newsPath = path.join(rootDir, 'news.config.json');
const publicDir = path.join(rootDir, 'public');
const adminSessions = new Map();
const adminStates = new Map();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png'
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      return handleAdmin(request, response, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/suggestions') {
      return handleSuggestion(request, response);
    }

    if (url.pathname === '/discord') {
      return redirectToDiscord(response);
    }

    if (url.pathname === '/api/status') {
      return sendJson(response, 200, await buildStatus());
    }

    if (url.pathname === '/api/news') {
      return sendJson(response, 200, await buildNews());
    }

    const pageRoutes = {
      '/': '/index.html',
      '/status': '/status.html',
      '/about': '/about.html',
      '/suggestions': '/suggestions.html',
      '/news': '/news.html',
      '/dayzmonetization': '/dayzmonetization.html'
    };
    const requestedPath = pageRoutes[url.pathname] || url.pathname;
    const filePath = path.normalize(path.join(publicDir, requestedPath));
    if (!filePath.startsWith(publicDir)) return sendText(response, 403, 'Forbidden');

    const body = await readFile(filePath);
    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': contentType });
    response.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') return sendText(response, 404, 'Not found');
    console.error(error);
    sendText(response, 500, 'Status page error');
  }
});

const config = await readConfig();
server.listen(config.port, () => {
  console.log(`Standalone status page running at http://127.0.0.1:${config.port}`);
});

async function buildStatus() {
  const currentConfig = await readConfig();
  const entries = await Promise.all(currentConfig.servers.map((item) => checkServer(item, currentConfig.timeoutMs)));
  const online = entries.filter((item) => item.online).length;
  const offline = entries.length - online;
  const overall = entries.length === 0
    ? 'unknown'
    : offline === 0
      ? 'operational'
      : online === 0
        ? 'outage'
        : 'degraded';

  return {
    siteName: currentConfig.siteName,
    generatedAt: new Date().toISOString(),
    refreshSeconds: currentConfig.refreshSeconds,
    overall,
    summary: {
      total: entries.length,
      online,
      offline
    },
    entries
  };
}

async function buildNews() {
  const currentConfig = await readNewsConfig();
  return {
    siteName: config.siteName,
    generatedAt: new Date().toISOString(),
    items: currentConfig.items
  };
}

async function redirectToDiscord(response) {
  const currentConfig = await readConfig();
  if (!currentConfig.discordInviteUrl) {
    return sendText(response, 503, 'Discord invite is not configured yet.');
  }

  response.writeHead(302, { location: currentConfig.discordInviteUrl });
  response.end();
}

async function handleAdmin(request, response, url) {
  if (url.pathname === '/admin/login') return handleAdminLogin(request, response);
  if (url.pathname === '/admin/callback') return handleAdminCallback(request, response, url);
  if (url.pathname === '/admin/logout') return handleAdminLogout(response);

  const admin = getAdminSession(request);
  if (!admin) return sendHtml(response, 200, renderAdminLoginPage(url));

  if (request.method === 'POST' && url.pathname === '/admin/news') {
    return handleAdminSaveNews(request, response);
  }

  if (request.method === 'POST' && url.pathname === '/admin/status') {
    return handleAdminSaveStatus(request, response);
  }

  if (request.method === 'GET' && url.pathname === '/admin') {
    const notice = cleanField(url.searchParams.get('notice'), 180);
    return sendHtml(response, 200, await renderAdminPage(admin, notice));
  }

  return sendText(response, 404, 'Admin page not found.');
}

function handleAdminLogin(request, response) {
  const settings = getAdminSettings();
  if (!settings.configured) {
    return sendHtml(response, 500, renderAdminSetupMissingPage(settings));
  }

  const redirectUri = getAdminRedirectUri(request);
  const state = crypto.randomBytes(24).toString('hex');
  adminStates.set(state, { createdAt: Date.now(), redirectUri });

  const authUrl = new URL('https://discord.com/oauth2/authorize');
  authUrl.searchParams.set('client_id', settings.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'identify guilds.members.read');
  authUrl.searchParams.set('state', state);

  response.writeHead(302, { location: authUrl.toString() });
  response.end();
}

async function handleAdminCallback(request, response, url) {
  const settings = getAdminSettings();
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const stateRecord = state ? adminStates.get(state) : null;
  adminStates.delete(state);

  if (!settings.configured || !code || !stateRecord || Date.now() - stateRecord.createdAt > 10 * 60 * 1000) {
    return redirectPath(response, '/admin?notice=Discord login expired. Please try again.');
  }

  const token = await exchangeDiscordCode(settings, code, stateRecord.redirectUri).catch(() => null);
  if (!token?.access_token) {
    return redirectPath(response, '/admin?notice=Discord login failed.');
  }

  const user = await fetchDiscordUser(token.access_token).catch(() => null);
  const member = await fetchDiscordGuildMember(token.access_token, settings.guildId).catch(() => null);
  if (!user?.id || !member?.roles?.includes(settings.roleId)) {
    return redirectPath(response, '/admin?notice=You do not have the required Discord role.');
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  adminSessions.set(sessionId, {
    id: user.id,
    username: user.global_name || user.username || 'Discord admin',
    createdAt: Date.now()
  });

  response.writeHead(302, {
    location: '/admin',
    'set-cookie': `mwn_site_admin=${sessionId}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=604800`
  });
  response.end();
}

function handleAdminLogout(response) {
  response.writeHead(302, {
    location: '/admin',
    'set-cookie': 'mwn_site_admin=; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=0'
  });
  response.end();
}

async function handleAdminSaveNews(request, response) {
  const body = await readFormBody(request, 200_000);
  const parsed = parseAdminJson(body.news_json, 'items');
  if (parsed instanceof Error) {
    return redirectPath(response, `/admin?notice=${encodeURIComponent(parsed.message)}`);
  }

  await writeFile(newsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return redirectPath(response, '/admin?notice=News saved.');
}

async function handleAdminSaveStatus(request, response) {
  const body = await readFormBody(request, 200_000);
  const parsed = parseAdminJson(body.status_json, 'servers');
  if (parsed instanceof Error) {
    return redirectPath(response, `/admin?notice=${encodeURIComponent(parsed.message)}`);
  }

  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return redirectPath(response, '/admin?notice=Status config saved.');
}

async function handleSuggestion(request, response) {
  const botSuggestionUrl = process.env.BOT_SUGGESTIONS_URL;
  const botSuggestionToken = process.env.WEBSITE_SUGGESTION_TOKEN;
  const webhookUrl = process.env.DISCORD_SUGGESTIONS_WEBHOOK_URL;
  if (!botSuggestionUrl && !webhookUrl) {
    return sendJson(response, 503, {
      ok: false,
      message: 'Suggestions are not connected to Discord yet.'
    });
  }

  const payload = await readJsonBody(request, 10_000).catch(() => null);
  const suggestion = normalizeSuggestion(payload);
  if (!suggestion.idea) {
    return sendJson(response, 400, {
      ok: false,
      message: 'Please add your suggestion before sending.'
    });
  }

  if (botSuggestionUrl && botSuggestionToken) {
    const botResponse = await fetch(botSuggestionUrl, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${botSuggestionToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(suggestion)
    }).catch((error) => ({ ok: false, status: 500, statusText: error.message }));

    if (botResponse.ok) {
      return sendJson(response, 200, {
        ok: true,
        message: 'Thanks, your suggestion was sent to the MWN Discord.'
      });
    }

    if (!webhookUrl) {
      console.error('Bot suggestion endpoint failed:', botResponse.status, botResponse.statusText);
      return sendJson(response, 502, {
        ok: false,
        message: 'Discord did not accept the suggestion. Please try again later.'
      });
    }
  }

  const discordResponse = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildSuggestionMessage(suggestion, request))
  }).catch((error) => ({ ok: false, status: 500, statusText: error.message }));

  if (!discordResponse.ok) {
    console.error('Suggestion webhook failed:', discordResponse.status, discordResponse.statusText);
    return sendJson(response, 502, {
      ok: false,
      message: 'Discord did not accept the suggestion. Please try again later.'
    });
  }

  return sendJson(response, 200, {
    ok: true,
    message: 'Thanks, your suggestion was sent to the MWN Discord.'
  });
}

function normalizeSuggestion(payload) {
  const value = payload && typeof payload === 'object' ? payload : {};
  return {
    name: cleanField(value.name, 80) || 'Anonymous',
    type: cleanField(value.type, 80) || 'General suggestion',
    idea: cleanField(value.idea, 1800)
  };
}

function cleanField(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildSuggestionMessage(suggestion, request) {
  return {
    username: 'Most Wanted Network Suggestions',
    avatar_url: publicUrl(request, '/assets/most-wanted-network-logo-gaming.png'),
    embeds: [
      {
        title: 'New website suggestion',
        color: 2603007,
        fields: [
          { name: 'From', value: suggestion.name, inline: true },
          { name: 'Type', value: suggestion.type, inline: true },
          { name: 'Suggestion', value: suggestion.idea }
        ],
        timestamp: new Date().toISOString(),
        footer: { text: 'Sent from the Most Wanted Network website' }
      }
    ]
  };
}

function publicUrl(request, pathname) {
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  const protocol = request.headers['x-forwarded-proto'] || 'http';
  return host ? `${protocol}://${host}${pathname}` : undefined;
}

function getAdminSettings() {
  const settings = {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    roleId: process.env.ADMIN_ROLE_ID || process.env.WEBSITE_ADMIN_ROLE_ID || '',
    publicUrl: process.env.WEBSITE_PUBLIC_URL || process.env.ADMIN_PUBLIC_URL || ''
  };

  return {
    ...settings,
    configured: Boolean(settings.clientId && settings.clientSecret && settings.guildId && settings.roleId)
  };
}

function getAdminRedirectUri(request) {
  const settings = getAdminSettings();
  if (settings.publicUrl) return `${settings.publicUrl.replace(/\/$/, '')}/admin/callback`;
  return publicUrl(request, '/admin/callback');
}

async function exchangeDiscordCode(settings, code, redirectUri) {
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    })
  });

  if (!response.ok) throw new Error(`Discord token exchange failed: ${response.status}`);
  return response.json();
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) throw new Error(`Discord user fetch failed: ${response.status}`);
  return response.json();
}

async function fetchDiscordGuildMember(accessToken, guildId) {
  const response = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) throw new Error(`Discord guild member fetch failed: ${response.status}`);
  return response.json();
}

function getAdminSession(request) {
  const sessionId = parseCookies(request.headers.cookie || '').mwn_site_admin;
  const session = sessionId ? adminSessions.get(sessionId) : null;
  if (!session) return null;

  if (Date.now() - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
    adminSessions.delete(sessionId);
    return null;
  }

  return session;
}

function parseAdminJson(value, requiredArrayKey) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Error('Config must be a JSON object.');
    }

    if (!Array.isArray(parsed[requiredArrayKey])) {
      return new Error(`Config must include a "${requiredArrayKey}" array.`);
    }

    return parsed;
  } catch {
    return new Error('Config is not valid JSON.');
  }
}

async function checkServer(item, timeoutMs) {
  const startedAt = Date.now();
  const result = await checkTcp(item.host, item.port, timeoutMs);

  return {
    id: item.id || item.name,
    name: item.name,
    group: item.group || 'Servers',
    description: item.description || '',
    checkedAt: new Date().toISOString(),
    online: result.online,
    latencyMs: result.online ? Date.now() - startedAt : null,
    reason: result.reason || null,
    actions: normalizeActions(item.actions)
  };
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .map((action) => ({
      label: cleanField(action.label, 32),
      url: cleanField(action.url, 300)
    }))
    .filter((action) => action.label && /^https?:\/\//i.test(action.url))
    .slice(0, 4);
}

function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ online: true }));
    socket.once('timeout', () => finish({ online: false, reason: 'timeout' }));
    socket.once('error', (error) => finish({ online: false, reason: error.code || 'error' }));
  });
}

async function readConfig() {
  const raw = await readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  return {
    siteName: config.siteName || 'Server Status',
    port: Number(process.env.STATUS_PORT || config.port || 3100),
    refreshSeconds: Number(config.refreshSeconds || 30),
    timeoutMs: Number(config.timeoutMs || 5000),
    discordInviteUrl: process.env.DISCORD_INVITE_URL || config.discordInviteUrl || '',
    servers: Array.isArray(config.servers) ? config.servers : []
  };
}

async function readNewsConfig() {
  try {
    const raw = await readFile(newsPath, 'utf8');
    const news = JSON.parse(raw);
    const items = Array.isArray(news.items) ? news.items : [];
    return {
      items: items
        .map((item) => ({
          title: cleanField(item.title, 120) || 'Network update',
          category: cleanField(item.category, 60) || 'Update',
          date: cleanField(item.date, 40) || '',
          body: cleanField(item.body, 800),
          linkLabel: cleanField(item.linkLabel, 40),
          linkUrl: cleanField(item.linkUrl, 300)
        }))
        .filter((item) => item.body)
        .slice(0, 20)
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('News config failed:', error);
    return { items: [] };
  }
}

async function renderAdminPage(admin, notice) {
  const [statusRaw, newsRaw] = await Promise.all([
    readFile(configPath, 'utf8'),
    readFile(newsPath, 'utf8').catch(() => '{\n  "items": []\n}\n')
  ]);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Website Admin | Most Wanted Network</title>
  <style>${adminStyles()}</style>
</head>
<body>
  <header>
    <div>
      <span class="eyebrow">Website Admin</span>
      <h1>Most Wanted Network</h1>
      <p>Signed in as ${escapeHtml(admin.username)}. Changes are saved directly to the website config files.</p>
    </div>
    <a class="button secondary" href="/admin/logout">Logout</a>
  </header>
  <main>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
    <section>
      <div class="section-head">
        <div>
          <h2>News & Changelog</h2>
          <p>Edit posts shown on the public news page.</p>
        </div>
        <a class="button secondary" href="/news" target="_blank" rel="noreferrer">Open News</a>
      </div>
      <form method="post" action="/admin/news">
        <textarea name="news_json" spellcheck="false">${escapeHtml(newsRaw.trim())}</textarea>
        <button type="submit">Save News</button>
      </form>
    </section>
    <section>
      <div class="section-head">
        <div>
          <h2>Status Config</h2>
          <p>Edit checked services and public buttons. Keep private admin links out of actions.</p>
        </div>
        <a class="button secondary" href="/status" target="_blank" rel="noreferrer">Open Status</a>
      </div>
      <form method="post" action="/admin/status">
        <textarea name="status_json" spellcheck="false">${escapeHtml(statusRaw.trim())}</textarea>
        <button type="submit">Save Status</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function renderAdminLoginPage(url) {
  const notice = cleanField(url.searchParams.get('notice'), 180);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Website Admin Login | Most Wanted Network</title>
  <style>${adminStyles()}</style>
</head>
<body class="login-page">
  <main class="login-shell">
    <section>
      <span class="eyebrow">Website Admin</span>
      <h1>Most Wanted Network</h1>
      <p>Sign in with Discord. Access is only allowed when your Discord account has the configured admin role.</p>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
      <a class="button" href="/admin/login">Login with Discord</a>
    </section>
  </main>
</body>
</html>`;
}

function renderAdminSetupMissingPage(settings) {
  const missing = [
    settings.clientId ? null : 'DISCORD_CLIENT_ID',
    settings.clientSecret ? null : 'DISCORD_CLIENT_SECRET',
    settings.guildId ? null : 'DISCORD_GUILD_ID',
    settings.roleId ? null : 'ADMIN_ROLE_ID'
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Website Admin Setup Needed</title>
  <style>${adminStyles()}</style>
</head>
<body class="login-page">
  <main class="login-shell">
    <section>
      <span class="eyebrow">Setup Needed</span>
      <h1>Discord login is not configured</h1>
      <p>Add these environment values to the website service, then restart it:</p>
      <pre>${escapeHtml(missing.join('\n'))}</pre>
      <p>The Discord Developer Portal redirect URL should be:</p>
      <pre>${escapeHtml(settings.publicUrl ? `${settings.publicUrl.replace(/\/$/, '')}/admin/callback` : 'https://mostwantednetwork.net/admin/callback')}</pre>
    </section>
  </main>
</body>
</html>`;
}

function adminStyles() {
  return `
    :root {
      color-scheme: dark;
      --bg: #07090d;
      --panel: #111821;
      --panel-2: #17212c;
      --text: #f3f6f9;
      --muted: #aeb9c8;
      --line: #2b3542;
      --cyan: #27d7ff;
      --green: #9df044;
      --red: #ff5f83;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      background: linear-gradient(145deg, rgba(39,215,255,.08), transparent 32rem), var(--bg);
      color: var(--text);
    }
    header, main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; }
    header {
      align-items: center;
      display: flex;
      gap: 18px;
      justify-content: space-between;
      padding: 34px 0 18px;
    }
    h1, h2, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: clamp(34px, 5vw, 56px); line-height: 1; }
    h2 { font-size: 24px; }
    p { color: var(--muted); line-height: 1.55; margin-top: 8px; }
    .eyebrow {
      color: var(--green);
      display: block;
      font-size: 12px;
      font-weight: 900;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    section, .notice {
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 22px 72px rgba(0,0,0,.3);
    }
    section { margin: 18px 0; padding: 20px; }
    .notice {
      border-color: rgba(157,240,68,.45);
      color: var(--green);
      font-weight: 800;
      margin: 16px 0;
      padding: 12px 14px;
    }
    .section-head {
      align-items: flex-start;
      display: flex;
      gap: 14px;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    textarea {
      background: #070b12;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--text);
      font: 14px Consolas, Monaco, monospace;
      min-height: 360px;
      padding: 14px;
      resize: vertical;
      width: 100%;
    }
    button, .button {
      align-items: center;
      background: var(--cyan);
      border: 0;
      border-radius: 7px;
      color: #061018;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      font-weight: 900;
      justify-content: center;
      margin-top: 12px;
      min-height: 42px;
      padding: 10px 14px;
      text-decoration: none;
    }
    .button.secondary {
      background: rgba(243,246,249,.08);
      border: 1px solid rgba(243,246,249,.18);
      color: var(--text);
      margin-top: 0;
    }
    .login-page {
      display: grid;
      place-items: center;
    }
    .login-shell {
      width: min(520px, calc(100vw - 32px));
    }
    pre {
      background: #070b12;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--cyan);
      overflow-x: auto;
      padding: 12px;
      white-space: pre-wrap;
    }
    @media (max-width: 700px) {
      header, .section-head { display: grid; }
      .button.secondary { width: 100%; }
    }
  `;
}

function readJsonBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new Error('Request body is too large'));
      }
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function readFormBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new Error('Request body is too large'));
      }
    });
    request.on('end', () => {
      resolve(Object.fromEntries(new URLSearchParams(body).entries()));
    });
    request.on('error', reject);
  });
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');
      return index === -1
        ? [part, '']
        : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    }));
}

function redirectPath(response, pathname) {
  response.writeHead(303, { location: pathname });
  response.end();
}

function sendHtml(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  response.end(value);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value, null, 2));
}

function sendText(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(value);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}
