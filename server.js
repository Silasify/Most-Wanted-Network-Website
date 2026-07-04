import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(rootDir, 'status.config.json');
const publicDir = path.join(rootDir, 'public');

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

    if (request.method === 'POST' && url.pathname === '/api/suggestions') {
      return handleSuggestion(request, response);
    }

    if (url.pathname === '/discord') {
      return redirectToDiscord(response);
    }

    if (url.pathname === '/api/status') {
      return sendJson(response, 200, await buildStatus());
    }

    const pageRoutes = {
      '/': '/index.html',
      '/status': '/status.html',
      '/about': '/about.html',
      '/suggestions': '/suggestions.html'
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

async function redirectToDiscord(response) {
  const currentConfig = await readConfig();
  if (!currentConfig.discordInviteUrl) {
    return sendText(response, 503, 'Discord invite is not configured yet.');
  }

  response.writeHead(302, { location: currentConfig.discordInviteUrl });
  response.end();
}

async function handleSuggestion(request, response) {
  const webhookUrl = process.env.DISCORD_SUGGESTIONS_WEBHOOK_URL;
  if (!webhookUrl) {
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

async function checkServer(item, timeoutMs) {
  const startedAt = Date.now();
  const result = await checkTcp(item.host, item.port, timeoutMs);

  return {
    id: item.id || `${item.host}:${item.port}`,
    name: item.name,
    host: item.host,
    port: item.port,
    group: item.group || 'Servers',
    description: item.description || '',
    checkedAt: new Date().toISOString(),
    online: result.online,
    latencyMs: result.online ? Date.now() - startedAt : null,
    reason: result.reason || null
  };
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

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value, null, 2));
}

function sendText(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(value);
}
