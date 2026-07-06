import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(rootDir, 'status.config.json');
const newsPath = path.join(rootDir, 'news.config.json');
const contentPath = path.join(rootDir, 'content.config.json');
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

    if (url.pathname === '/api/content') {
      return sendJson(response, 200, await readContentConfig());
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

  if (request.method === 'POST' && url.pathname === '/admin/content') {
    return handleAdminSaveContent(request, response);
  }

  if (request.method === 'POST' && url.pathname === '/admin/status') {
    return handleAdminSaveStatus(request, response);
  }

  if (request.method === 'POST' && url.pathname === '/admin/status-test') {
    return handleAdminStatusTest(request, response);
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
  const parsed = parseNewsEditorPayload(body.news_items);
  if (parsed instanceof Error) {
    return redirectPath(response, `/admin?notice=${encodeURIComponent(parsed.message)}`);
  }

  await writeFile(newsPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return redirectPath(response, '/admin?notice=News saved.');
}

async function handleAdminSaveContent(request, response) {
  const body = await readFormBody(request, 500_000);
  const parsed = parseContentEditorPayload(body.content_items);
  if (parsed instanceof Error) {
    return redirectPath(response, `/admin?notice=${encodeURIComponent(parsed.message)}`);
  }

  await writeFile(contentPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return redirectPath(response, '/admin?notice=Page content saved.');
}

async function handleAdminSaveStatus(request, response) {
  const body = await readFormBody(request, 200_000);
  const parsed = parseStatusEditorPayload(body.status_items, body.status_settings);
  if (parsed instanceof Error) {
    return redirectPath(response, `/admin?notice=${encodeURIComponent(parsed.message)}`);
  }

  await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return redirectPath(response, '/admin?notice=Status config saved.');
}

async function handleAdminStatusTest(request, response) {
  const body = await readJsonBody(request, 20_000).catch(() => null);
  const host = cleanField(body?.host, 160);
  const port = Number(body?.port);

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(response, 400, {
      ok: false,
      online: false,
      message: 'Add a valid host and port first.'
    });
  }

  const startedAt = Date.now();
  const result = await checkTcp(host, port, 5000);
  const latencyMs = result.online ? Date.now() - startedAt : null;

  return sendJson(response, 200, {
    ok: true,
    online: result.online,
    latencyMs,
    reason: result.reason || null,
    message: result.online
      ? `Connection works (${latencyMs} ms).`
      : `No TCP response${result.reason ? `: ${result.reason}` : '.'}`
  });
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

function cleanMultilineText(value, maxLength) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
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

function parseNewsEditorPayload(value) {
  try {
    const items = JSON.parse(String(value || '[]'));
    if (!Array.isArray(items)) return new Error('News form data was not valid.');

    const cleanedItems = items
      .map((item) => ({
        title: cleanField(item.title, 120) || 'Network update',
        category: cleanField(item.category, 60) || 'Update',
        date: cleanField(item.date, 40) || new Date().toISOString().slice(0, 10),
        body: htmlToPlainText(item.bodyHtml || item.body).slice(0, 800),
        bodyHtml: sanitizeRichText(item.bodyHtml || item.body).slice(0, 4000),
        linkLabel: cleanField(item.linkLabel, 40),
        linkUrl: cleanField(item.linkUrl, 300)
      }))
      .filter((item) => item.body || item.bodyHtml)
      .slice(0, 20);

    return { items: cleanedItems };
  } catch {
    return new Error('News form data was not valid.');
  }
}

function parseContentEditorPayload(value) {
  try {
    const items = JSON.parse(String(value || '{}'));
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      return new Error('Content form data was not valid.');
    }

    const current = structuredClone(defaultContentConfig().items);
    for (const [key, item] of Object.entries(items)) {
      if (!current[key]) continue;
      const type = current[key].type;
      current[key] = {
        ...current[key],
        value: type === 'rich'
          ? sanitizeRichText(item.value).slice(0, 8000)
          : cleanField(item.value, 240)
      };
    }

    return { items: current };
  } catch {
    return new Error('Content form data was not valid.');
  }
}

function parseStatusEditorPayload(itemsValue, settingsValue) {
  try {
    const items = JSON.parse(String(itemsValue || '[]'));
    const settings = JSON.parse(String(settingsValue || '{}'));
    if (!Array.isArray(items)) return new Error('Status form data was not valid.');

    const servers = items
      .map((item) => ({
        name: cleanField(item.name, 100) || 'Server',
        host: cleanField(item.host, 160),
        port: Number(item.port),
        group: cleanField(item.group, 80) || 'Servers',
        description: cleanMultilineText(item.description, 600),
        actions: Array.isArray(item.actions)
          ? item.actions
            .map((action) => ({
              label: cleanField(action.label, 32),
              url: cleanField(action.url, 300)
            }))
            .filter((action) => action.label && /^https?:\/\//i.test(action.url))
            .slice(0, 4)
          : []
      }))
      .filter((item) => item.host && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535)
      .slice(0, 40);

    return {
      siteName: cleanField(settings.siteName, 80) || 'Most Wanted Network',
      port: Number(settings.port) || 3100,
      refreshSeconds: Number(settings.refreshSeconds) || 30,
      timeoutMs: Number(settings.timeoutMs) || 5000,
      discordInviteUrl: cleanField(settings.discordInviteUrl, 300),
      servers
    };
  } catch {
    return new Error('Status form data was not valid.');
  }
}

function sanitizeRichText(value) {
  const html = String(value || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '');

  const allowedTags = new Set(['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'ul', 'ol', 'li', 'a']);
  return html.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (match, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (!allowedTags.has(tag)) return '';
    if (tag !== 'a') return match.startsWith('</') ? `</${tag}>` : `<${tag}>`;

    if (match.startsWith('</')) return '</a>';
    const href = rawAttrs.match(/\shref=["']([^"']+)["']/i)?.[1] || '';
    if (!/^https?:\/\//i.test(href)) return '<a>';
    return `<a href="${escapeHtml(href)}" rel="noreferrer">`;
  });
}

function htmlToPlainText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
          bodyHtml: sanitizeRichText(item.bodyHtml || item.body),
          linkLabel: cleanField(item.linkLabel, 40),
          linkUrl: cleanField(item.linkUrl, 300)
        }))
        .filter((item) => item.body || item.bodyHtml)
        .slice(0, 20)
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('News config failed:', error);
    return { items: [] };
  }
}

async function readContentConfig() {
  try {
    const raw = await readFile(contentPath, 'utf8');
    const config = JSON.parse(raw);
    const defaults = defaultContentConfig();
    const items = structuredClone(defaults.items);
    for (const [key, item] of Object.entries(config.items || {})) {
      if (!items[key]) continue;
      items[key].value = items[key].type === 'rich'
        ? sanitizeRichText(item.value)
        : cleanField(item.value, 240);
    }

    return {
      items
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Content config failed:', error);
    return defaultContentConfig();
  }
}

function defaultContentConfig() {
  return {
    items: {
      'home.hero.eyebrow': { label: 'Home hero eyebrow', group: 'Home', type: 'text', value: 'Game servers with people behind them' },
      'home.hero.title': { label: 'Home hero title', group: 'Home', type: 'text', value: 'Most Wanted Network' },
      'home.hero.body': { label: 'Home hero text', group: 'Home', type: 'rich', value: 'We host the servers, keep an eye on things, and build the kind of game nights people actually want to come back to.' },
      'home.section.title': { label: 'Home section title', group: 'Home', type: 'text', value: 'Jump in, check the status, or help decide what comes next' },
      'home.discord.title': { label: 'Discord CTA title', group: 'Home', type: 'text', value: 'Want updates, support, and event planning in one place?' },
      'home.discord.body': { label: 'Discord CTA text', group: 'Home', type: 'rich', value: 'Join the Discord for announcements, help, suggestions, and the day-to-day Most Wanted Network chatter.' },
      'status.hero.title': { label: 'Status page title', group: 'Status', type: 'text', value: 'Most Wanted Network Status' },
      'status.services.body': { label: 'Status services text', group: 'Status', type: 'rich', value: 'If something is configured for public checks, it shows up here automatically.' },
      'news.hero.title': { label: 'News page title', group: 'News', type: 'text', value: 'News & Changelog' },
      'news.hero.body': { label: 'News page text', group: 'News', type: 'rich', value: 'Short updates for new servers, wipes, events, maintenance, and the small changes players should know about.' },
      'about.hero.title': { label: 'About page title', group: 'About', type: 'text', value: 'A small network for players who like things handled properly' },
      'about.hero.body': { label: 'About page text', group: 'About', type: 'rich', value: 'Most Wanted Network is our place for hosting games, trying new ideas, and keeping the community close enough that people recognize each other.' },
      'suggestions.hero.title': { label: 'Suggestions page title', group: 'Suggestions', type: 'text', value: 'Got an idea? Send it in.' },
      'suggestions.hero.body': { label: 'Suggestions page text', group: 'Suggestions', type: 'rich', value: 'New server, event night, settings change, Discord improvement, odd little quality-of-life thing: if it would make MWN better, we want to see it.' },
      'dayz.hero.title': { label: 'DayZ page title', group: 'DayZ Monetization', type: 'text', value: 'DayZ server monetization information' },
      'dayz.legal.body': { label: 'DayZ page content', group: 'DayZ Monetization', type: 'rich', value: '<p>From December 1st 2015, anyone who registers, is approved, and is listed on <a href="https://www.bohemia.net/monetization/approved/dayz">https://www.bohemia.net/monetization/approved/dayz</a> is allowed following monetization of their DayZ private shard servers:</p><ul><li>Charging players to access your server, if the fees and associated perks do not affect gameplay in any way, is allowed. Limiting access to only paying players is allowed.</li><li>Product placement, in-game advertising and sponsorship is allowed. Accepting donations is allowed, but not donating must not prevent anyone from accessing the content.</li><li>Selling of in-game items that do not affect gameplay and selling cosmetic perks are allowed.</li><li>These rules do not apply to public hive DayZ servers or the DayZ mod.</li></ul><p>The permission is given for a limited time. It will expire on January 31st 2027.</p>' }
    }
  };
}

async function renderAdminPage(admin, notice) {
  const [statusConfig, newsConfig, contentConfig] = await Promise.all([
    readConfig(),
    readNewsConfig(),
    readContentConfig()
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
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <a class="admin-brand" href="/">
        <img src="/assets/most-wanted-network-logo-gaming.png" alt="">
        <div>
          <strong>MWN Admin</strong>
          <span>${escapeHtml(admin.username)}</span>
        </div>
      </a>
      <nav class="admin-nav" aria-label="Admin sections">
        <a href="#page-content">Page Content</a>
        <a href="#news">News</a>
        <a href="#server-status">Server Status</a>
      </nav>
      <div class="sidebar-actions">
        <a class="button secondary" href="/" target="_blank" rel="noreferrer">Open Site</a>
        <a class="button secondary" href="/admin/logout">Logout</a>
      </div>
    </aside>
    <main class="admin-main">
      <header class="admin-topbar">
        <div>
          <span class="eyebrow">Website Admin</span>
          <h1>Content Management</h1>
          <p>Update public website content, news posts, and server status entries.</p>
        </div>
      </header>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
      <section id="page-content">
      <div class="section-head">
        <div>
          <h2>Page Content</h2>
          <p>Edit the visible text on the public website pages.</p>
        </div>
        <a class="button secondary" href="/" target="_blank" rel="noreferrer">Open Site</a>
      </div>
      <form method="post" action="/admin/content" data-content-form>
        <input type="hidden" name="content_items" data-content-payload>
        ${renderContentEditor(contentConfig.items)}
        <div class="admin-actions">
          <button type="submit">Save Page Content</button>
        </div>
      </form>
      </section>
      <section id="news">
      <div class="section-head">
        <div>
          <h2>News & Changelog</h2>
          <p>Edit posts shown on the public news page.</p>
        </div>
        <a class="button secondary" href="/news" target="_blank" rel="noreferrer">Open News</a>
      </div>
      <form method="post" action="/admin/news" data-news-form>
        <input type="hidden" name="news_items" data-news-payload>
        <div class="news-editor-list" data-news-list>
          ${renderNewsEditorItems(newsConfig.items)}
        </div>
        <div class="admin-actions">
          <button type="button" class="button secondary" data-add-news>Add News Post</button>
          <button type="submit">Save News</button>
        </div>
      </form>
      </section>
      <section id="server-status">
      <div class="section-head">
        <div>
          <h2>Server Status</h2>
          <p>Edit checked services and public buttons. Keep private admin links out of actions.</p>
        </div>
        <a class="button secondary" href="/status" target="_blank" rel="noreferrer">Open Status</a>
      </div>
      <form method="post" action="/admin/status" data-status-form>
        <input type="hidden" name="status_settings" data-status-settings>
        <input type="hidden" name="status_items" data-status-payload>
        ${renderStatusEditor(statusConfig)}
        <div class="admin-actions">
          <button type="button" class="button secondary" data-add-status>Add Server</button>
          <button type="submit">Save Status</button>
        </div>
      </form>
      </section>
    </main>
  </div>
  <script>${adminEditorScript()}</script>
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

function renderNewsEditorItems(items) {
  const list = items.length ? items : [{
    title: '',
    category: 'Update',
    date: new Date().toISOString().slice(0, 10),
    bodyHtml: '',
    linkLabel: '',
    linkUrl: ''
  }];

  return list.map((item) => renderNewsEditorItem(item)).join('');
}

function renderContentEditor(items) {
  const grouped = Object.entries(items).reduce((acc, [key, item]) => {
    acc[item.group] ??= [];
    acc[item.group].push([key, item]);
    return acc;
  }, {});

  return Object.entries(grouped).map(([group, groupItems]) => `
    <div class="editor-group">
      <h3>${escapeHtml(group)}</h3>
      <div class="field-grid">
        ${groupItems.map(([key, item]) => item.type === 'rich'
          ? `<label class="full">${escapeHtml(item.label)}
              ${renderMiniToolbar()}
              <div class="rich-editor" contenteditable="true" data-content-key="${escapeHtml(key)}" data-content-type="rich">${sanitizeRichText(item.value)}</div>
            </label>`
          : `<label>${escapeHtml(item.label)}<input data-content-key="${escapeHtml(key)}" data-content-type="text" value="${escapeHtml(item.value)}"></label>`
        ).join('')}
      </div>
    </div>
  `).join('');
}

function renderStatusEditor(config) {
  return `
    <div class="editor-group">
      <h3>General Settings</h3>
      <div class="field-grid" data-status-general>
        <label>Site Name<input data-status-setting="siteName" value="${escapeHtml(config.siteName)}"></label>
        <label>Website Port<input data-status-setting="port" type="number" min="1" max="65535" value="${escapeHtml(config.port)}"></label>
        <label>Refresh Seconds<input data-status-setting="refreshSeconds" type="number" min="5" value="${escapeHtml(config.refreshSeconds)}"></label>
        <label>Timeout MS<input data-status-setting="timeoutMs" type="number" min="500" value="${escapeHtml(config.timeoutMs)}"></label>
        <label class="full">Discord Invite URL<input data-status-setting="discordInviteUrl" value="${escapeHtml(config.discordInviteUrl)}" placeholder="https://discord.gg/..."></label>
      </div>
    </div>
    <div class="news-editor-list" data-status-list>
      ${(config.servers || []).map((server) => renderStatusEditorItem(server)).join('') || renderStatusEditorItem({ name: '', host: '', port: 30120, group: 'Servers', description: '', actions: [] })}
    </div>
  `;
}

function renderStatusEditorItem(item) {
  const actions = Array.isArray(item.actions) && item.actions.length
    ? item.actions
    : [{ label: '', url: '' }];

  return `<article class="news-editor-item" data-status-item>
    <div class="item-head">
      <strong>Status Entry</strong>
      <button type="button" class="button secondary compact" data-remove-status>Remove</button>
    </div>
    <div class="field-grid">
      <label>Name<input data-status-field="name" value="${escapeHtml(item.name || '')}" placeholder="Dune: Awakening"></label>
      <label>Group<input data-status-field="group" value="${escapeHtml(item.group || 'Servers')}" placeholder="Server"></label>
      <label>Host / IP<input data-status-field="host" value="${escapeHtml(item.host || '')}" placeholder="127.0.0.1"></label>
      <label>Port<input data-status-field="port" type="number" min="1" max="65535" value="${escapeHtml(item.port || '')}"></label>
      <label class="full">Description<textarea class="compact-textarea" data-status-field="description" rows="4" placeholder="Optional public note">${escapeHtml(item.description || '')}</textarea></label>
    </div>
    <div class="action-list" data-action-list>
      ${actions.map((action) => renderActionEditorItem(action)).join('')}
    </div>
    <div class="status-test-row">
      <button type="button" class="button secondary compact" data-test-status>Test Connection</button>
      <span data-test-result>Not tested</span>
    </div>
    <button type="button" class="button secondary compact" data-add-action>Add Button</button>
  </article>`;
}

function renderActionEditorItem(action) {
  return `<div class="action-row" data-action-item>
    <label>Button Label<input data-action-field="label" value="${escapeHtml(action.label || '')}" placeholder="Join Discord"></label>
    <label>Button URL<input data-action-field="url" value="${escapeHtml(action.url || '')}" placeholder="https://..."></label>
    <button type="button" class="button secondary compact" data-remove-action>Remove</button>
  </div>`;
}

function renderNewsEditorItem(item) {
  return `<article class="news-editor-item" data-news-item>
    <div class="item-head">
      <strong>News Post</strong>
      <button type="button" class="button secondary compact" data-remove-news>Remove</button>
    </div>
    <div class="field-grid">
      <label>Title<input data-field="title" value="${escapeHtml(item.title || '')}" placeholder="Server wipe notice"></label>
      <label>Category<input data-field="category" value="${escapeHtml(item.category || 'Update')}" placeholder="Update"></label>
      <label>Date<input data-field="date" type="date" value="${escapeHtml(item.date || '')}"></label>
      <label>Link Label<input data-field="linkLabel" value="${escapeHtml(item.linkLabel || '')}" placeholder="Optional button text"></label>
      <label class="full">Link URL<input data-field="linkUrl" value="${escapeHtml(item.linkUrl || '')}" placeholder="https://..."></label>
    </div>
    ${renderMiniToolbar()}
    <div class="rich-editor" contenteditable="true" data-field="bodyHtml" role="textbox" aria-label="News body">${sanitizeRichText(item.bodyHtml || item.body || '')}</div>
  </article>`;
}

function renderMiniToolbar() {
  return `<div class="editor-toolbar" aria-label="Text formatting">
    <button type="button" data-command="bold" title="Bold"><strong>B</strong></button>
    <button type="button" data-command="italic" title="Italic"><em>I</em></button>
    <button type="button" data-command="underline" title="Underline"><u>U</u></button>
    <button type="button" data-command="insertUnorderedList" title="Bullet list">List</button>
    <button type="button" data-link title="Add link">Link</button>
  </div>`;
}

function adminEditorScript() {
  return `
    const newsList = document.querySelector('[data-news-list]');
    const newsForm = document.querySelector('[data-news-form]');
    const payloadInput = document.querySelector('[data-news-payload]');
    const addButton = document.querySelector('[data-add-news]');
    const contentForm = document.querySelector('[data-content-form]');
    const contentPayload = document.querySelector('[data-content-payload]');
    const statusForm = document.querySelector('[data-status-form]');
    const statusPayload = document.querySelector('[data-status-payload]');
    const statusSettings = document.querySelector('[data-status-settings]');
    const statusList = document.querySelector('[data-status-list]');
    const addStatusButton = document.querySelector('[data-add-status]');
    const blankStatus = ${JSON.stringify(renderStatusEditorItem({ name: '', host: '', port: 30120, group: 'Servers', description: '', actions: [] }))};
    const blankAction = ${JSON.stringify(renderActionEditorItem({ label: '', url: '' }))};

    addButton?.addEventListener('click', () => {
      const template = document.createElement('template');
      template.innerHTML = ${JSON.stringify(renderNewsEditorItem({
        title: '',
        category: 'Update',
        date: new Date().toISOString().slice(0, 10),
        bodyHtml: '',
        linkLabel: '',
        linkUrl: ''
      }))};
      newsList.appendChild(template.content.firstElementChild);
    });

    document.addEventListener('click', (event) => {
      const removeButton = event.target.closest('[data-remove-news]');
      if (removeButton) {
        if (newsList.querySelectorAll('[data-news-item]').length > 1) {
          removeButton.closest('[data-news-item]').remove();
        }
        return;
      }

      const commandButton = event.target.closest('[data-command]');
      if (commandButton) {
        event.preventDefault();
        commandButton.closest('.news-editor-item, .editor-group, label')?.querySelector('.rich-editor')?.focus();
        document.execCommand(commandButton.dataset.command, false, null);
        return;
      }

      const linkButton = event.target.closest('[data-link]');
      if (linkButton) {
        event.preventDefault();
        linkButton.closest('.news-editor-item, .editor-group, label')?.querySelector('.rich-editor')?.focus();
        const url = prompt('Link URL');
        if (url && /^https?:\\/\\//i.test(url)) document.execCommand('createLink', false, url);
        return;
      }

      const removeStatus = event.target.closest('[data-remove-status]');
      if (removeStatus) {
        if (statusList.querySelectorAll('[data-status-item]').length > 1) {
          removeStatus.closest('[data-status-item]').remove();
        }
        return;
      }

      const addAction = event.target.closest('[data-add-action]');
      if (addAction) {
        const template = document.createElement('template');
        template.innerHTML = blankAction;
        addAction.closest('[data-status-item]').querySelector('[data-action-list]').appendChild(template.content.firstElementChild);
        return;
      }

      const removeAction = event.target.closest('[data-remove-action]');
      if (removeAction) {
        const list = removeAction.closest('[data-action-list]');
        if (list.querySelectorAll('[data-action-item]').length > 1) removeAction.closest('[data-action-item]').remove();
        return;
      }

      const testStatus = event.target.closest('[data-test-status]');
      if (testStatus) {
        const item = testStatus.closest('[data-status-item]');
        const result = item.querySelector('[data-test-result]');
        const host = item.querySelector('[data-status-field="host"]').value;
        const port = item.querySelector('[data-status-field="port"]').value;
        testStatus.disabled = true;
        result.className = 'test-result';
        result.textContent = 'Checking...';

        fetch('/admin/status-test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ host, port })
        })
          .then((response) => response.json())
          .then((data) => {
            result.className = 'test-result ' + (data.online ? 'ok' : 'bad');
            result.textContent = data.message || (data.online ? 'Connection works.' : 'No response.');
          })
          .catch(() => {
            result.className = 'test-result bad';
            result.textContent = 'Could not run the test.';
          })
          .finally(() => {
            testStatus.disabled = false;
          });
      }
    });

    addStatusButton?.addEventListener('click', () => {
      const template = document.createElement('template');
      template.innerHTML = blankStatus;
      statusList.appendChild(template.content.firstElementChild);
    });

    contentForm?.addEventListener('submit', () => {
      const items = {};
      for (const field of contentForm.querySelectorAll('[data-content-key]')) {
        items[field.dataset.contentKey] = {
          value: field.dataset.contentType === 'rich' ? field.innerHTML : field.value
        };
      }
      contentPayload.value = JSON.stringify(items);
    });

    newsForm?.addEventListener('submit', () => {
      payloadInput.value = JSON.stringify(Array.from(newsList.querySelectorAll('[data-news-item]')).map((item) => ({
        title: item.querySelector('[data-field="title"]').value,
        category: item.querySelector('[data-field="category"]').value,
        date: item.querySelector('[data-field="date"]').value,
        bodyHtml: item.querySelector('[data-field="bodyHtml"]').innerHTML,
        linkLabel: item.querySelector('[data-field="linkLabel"]').value,
        linkUrl: item.querySelector('[data-field="linkUrl"]').value
      })));
    });

    statusForm?.addEventListener('submit', () => {
      statusSettings.value = JSON.stringify(Object.fromEntries(Array.from(statusForm.querySelectorAll('[data-status-setting]')).map((input) => [input.dataset.statusSetting, input.value])));
      statusPayload.value = JSON.stringify(Array.from(statusList.querySelectorAll('[data-status-item]')).map((item) => ({
        name: item.querySelector('[data-status-field="name"]').value,
        group: item.querySelector('[data-status-field="group"]').value,
        host: item.querySelector('[data-status-field="host"]').value,
        port: item.querySelector('[data-status-field="port"]').value,
        description: item.querySelector('[data-status-field="description"]').value,
        actions: Array.from(item.querySelectorAll('[data-action-item]')).map((action) => ({
          label: action.querySelector('[data-action-field="label"]').value,
          url: action.querySelector('[data-action-field="url"]').value
        }))
      })));
    });
  `;
}

function adminStyles() {
  return `
    :root {
      color-scheme: dark;
      --bg: #07090d;
      --panel: #101720;
      --panel-2: #151e29;
      --text: #f3f6f9;
      --muted: #aeb9c8;
      --line: #2b3542;
      --cyan: #27d7ff;
      --green: #9df044;
      --red: #ff5f83;
      --sidebar: #080d13;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Segoe UI, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .admin-shell {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      min-height: 100vh;
    }
    .admin-sidebar {
      background: var(--sidebar);
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding: 20px 14px;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .admin-brand {
      align-items: center;
      color: inherit;
      display: flex;
      gap: 10px;
      padding: 0 6px 16px;
      border-bottom: 1px solid var(--line);
      text-decoration: none;
    }
    .admin-brand img {
      height: 42px;
      object-fit: contain;
      width: 42px;
    }
    .admin-brand strong,
    .admin-brand span {
      display: block;
    }
    .admin-brand strong {
      font-size: 16px;
    }
    .admin-brand span {
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }
    .admin-nav {
      display: grid;
      gap: 6px;
    }
    .admin-nav a {
      border: 1px solid transparent;
      border-radius: 7px;
      color: var(--muted);
      font-weight: 700;
      padding: 10px 11px;
      text-decoration: none;
    }
    .admin-nav a:hover {
      background: rgba(39, 215, 255, .08);
      border-color: rgba(39, 215, 255, .24);
      color: var(--cyan);
    }
    .sidebar-actions {
      display: grid;
      gap: 8px;
      margin-top: auto;
    }
    .admin-main {
      margin: 0;
      padding: 24px 32px 42px;
      width: 100%;
    }
    .admin-topbar {
      background: transparent;
      border: 0;
      box-shadow: none;
      margin: 0 0 18px;
      padding: 0;
    }
    h1, h2, p { margin: 0; letter-spacing: 0; }
    h1 { font-size: 28px; line-height: 1.1; }
    h2 { font-size: 19px; }
    h3 { font-size: 15px; margin: 0 0 12px; }
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
      box-shadow: 0 14px 38px rgba(0,0,0,.18);
    }
    section { margin: 18px 0; padding: 18px; scroll-margin-top: 18px; }
    .notice {
      border-color: rgba(157,240,68,.45);
      color: var(--green);
      font-weight: 800;
      margin: 0 0 18px;
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
    textarea.compact-textarea {
      font: inherit;
      min-height: 96px;
    }
    input {
      background: #070b12;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--text);
      font: inherit;
      min-height: 42px;
      padding: 10px 12px;
      width: 100%;
    }
    label {
      color: var(--text);
      display: grid;
      font-size: 13px;
      font-weight: 700;
      gap: 7px;
    }
    .news-editor-list {
      display: grid;
      gap: 14px;
    }
    .editor-group {
      border-top: 1px solid var(--line);
      margin-top: 16px;
      padding-top: 16px;
    }
    .editor-group:first-of-type {
      border-top: 0;
      margin-top: 0;
      padding-top: 0;
    }
    .editor-group h3 {
      margin: 0 0 12px;
    }
    .news-editor-item {
      background: rgba(7, 11, 18, .5);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .item-head {
      align-items: center;
      display: flex;
      gap: 12px;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .field-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .field-grid .full { grid-column: 1 / -1; }
    .action-list {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .action-row {
      align-items: end;
      display: grid;
      gap: 10px;
      grid-template-columns: 1fr 1.5fr auto;
    }
    .status-test-row {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 12px;
    }
    .test-result {
      color: var(--muted);
      font-weight: 800;
    }
    .test-result.ok { color: var(--green); }
    .test-result.bad { color: var(--red); }
    .editor-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 14px;
    }
    .editor-toolbar button,
    .button.compact {
      min-height: 34px;
      margin-top: 0;
      padding: 7px 10px;
    }
    .rich-editor {
      background: #070b12;
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--text);
      line-height: 1.55;
      margin-top: 8px;
      min-height: 170px;
      outline: none;
      padding: 13px;
    }
    .rich-editor:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 2px rgba(39, 215, 255, .25);
    }
    .rich-editor a { color: var(--cyan); }
    .admin-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    button, .button {
      align-items: center;
      background: linear-gradient(135deg, var(--cyan), #8ff2ff);
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
    button.secondary {
      background: rgba(243,246,249,.08);
      border: 1px solid rgba(243,246,249,.18);
      color: var(--text);
    }
    .login-page {
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at 18% 0%, rgba(39,215,255,.10), transparent 28rem),
        radial-gradient(circle at 82% 8%, rgba(157,240,68,.08), transparent 24rem),
        var(--bg);
    }
    .login-shell {
      width: min(520px, calc(100vw - 32px));
    }
    .login-shell section {
      padding: 28px;
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
    @media (max-width: 860px) {
      .admin-shell { display: block; }
      .admin-sidebar {
        height: auto;
        position: static;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .admin-nav {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      }
      .sidebar-actions {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        margin-top: 0;
      }
      .admin-main { padding: 18px; }
      .section-head { display: grid; }
      .button.secondary { width: 100%; }
      .field-grid,
      .action-row { grid-template-columns: 1fr; }
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
