const elements = {
  siteName: document.querySelector('[data-site-name]'),
  statusCopy: document.querySelector('[data-status-copy]'),
  overall: document.querySelector('[data-overall]'),
  entries: document.querySelector('[data-entries]'),
  healthCard: document.querySelector('[data-health-card]'),
  healthScore: document.querySelector('[data-health-score]'),
  healthBars: document.querySelector('[data-health-bars]'),
  refresh: document.querySelector('[data-refresh]')
};

let refreshTimer = null;

elements.refresh.addEventListener('click', () => {
  refreshStatus();
});

refreshStatus();

async function refreshStatus() {
  const response = await fetch('/api/status').catch(() => null);
  if (!response || !response.ok) {
    renderError();
    return;
  }

  const data = await response.json();
  renderStatus(data);

  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshStatus, data.refreshSeconds * 1000);
}

function renderStatus(data) {
  document.title = `${data.siteName} Status`;
  elements.siteName.textContent = `${data.siteName} Status`;
  elements.statusCopy.textContent = getStatusCopy(data.overall);
  elements.overall.className = `overall ${data.overall}`;
  elements.overall.textContent = getStatusLabel(data.overall);

  updateSummary('total', data.summary.total);
  updateSummary('online', data.summary.online, 'online');
  updateSummary('offline', data.summary.offline, data.summary.offline > 0 ? 'offline' : '');
  updateSummary('updated', new Date(data.generatedAt).toLocaleTimeString());
  updateHealth(data);

  elements.entries.innerHTML = data.entries.length
    ? data.entries.map(renderEntry).join('')
    : '<div class="empty-state">No entries are configured yet.</div>';
}

function renderEntry(entry) {
  const statusText = entry.online ? 'Online' : 'Offline';
  const latency = entry.online ? `${entry.latencyMs} ms` : reasonText(entry.reason);
  const health = getEntryHealth(entry);

  return `<article class="entry-card ${entry.online ? 'online' : 'offline'}">
    <div class="entry-top">
      <div>
        <h3>${escapeHtml(entry.name)}</h3>
        ${entry.description ? `<p>${escapeHtml(entry.description)}</p>` : ''}
      </div>
      <span>${statusText}</span>
    </div>
    <div class="entry-health">
      <div class="health-line">
        <span>Live health</span>
        <strong>${health}%</strong>
      </div>
      ${renderBars(health, entry.online ? 'online' : 'offline')}
    </div>
    <dl>
      <div><dt>Group</dt><dd>${escapeHtml(entry.group)}</dd></div>
      <div><dt>Latency</dt><dd>${escapeHtml(latency)}</dd></div>
      <div><dt>Checked</dt><dd>${new Date(entry.checkedAt).toLocaleTimeString()}</dd></div>
    </dl>
    ${renderActions(entry.actions)}
  </article>`;
}

function renderActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  return `<div class="entry-actions">${actions.map((action) =>
    `<a class="button secondary" href="${escapeHtml(action.url)}" rel="noreferrer">${escapeHtml(action.label)}</a>`
  ).join('')}</div>`;
}

function updateHealth(data) {
  if (!elements.healthCard || !elements.healthScore || !elements.healthBars) return;
  const score = getNetworkHealth(data.entries);
  const state = score >= 95 ? 'online' : score > 0 ? 'degraded' : 'offline';
  elements.healthCard.className = `summary-card health-summary ${state}`;
  elements.healthScore.textContent = data.entries.length ? `${score}%` : '--';
  elements.healthBars.innerHTML = data.entries.length ? renderBarSegments(score, state) : '';
}

function updateSummary(key, value, state = '') {
  const card = document.querySelector(`[data-summary-card="${key}"]`);
  if (!card) return;
  card.className = `summary-card${state ? ` ${state}` : ''}`;
  card.querySelector('strong').textContent = value;
}

function renderError() {
  elements.statusCopy.textContent = 'The standalone status server is not responding.';
  elements.overall.className = 'overall outage';
  elements.overall.textContent = 'Unavailable';
  if (elements.healthScore) elements.healthScore.textContent = '--';
  if (elements.healthBars) elements.healthBars.innerHTML = '';
  elements.entries.innerHTML = '<div class="empty-state">Could not load status data.</div>';
}

function getStatusCopy(overall) {
  if (overall === 'operational') return 'All configured services are responding normally.';
  if (overall === 'degraded') return 'Some configured services are not responding right now.';
  if (overall === 'outage') return 'Configured services are currently offline.';
  return 'No services have been configured yet.';
}

function getStatusLabel(overall) {
  if (overall === 'operational') return 'Operational';
  if (overall === 'degraded') return 'Degraded';
  if (overall === 'outage') return 'Outage';
  return 'Waiting';
}

function reasonText(reason) {
  if (reason === 'timeout') return 'Timed out';
  return reason || 'No response';
}

function getNetworkHealth(entries) {
  if (!entries.length) return 0;
  const total = entries.reduce((sum, entry) => sum + getEntryHealth(entry), 0);
  return Math.round(total / entries.length);
}

function getEntryHealth(entry) {
  if (!entry.online) return 0;
  if (typeof entry.latencyMs !== 'number') return 95;
  const latencyPenalty = Math.min(15, Math.floor(entry.latencyMs / 100));
  return Math.max(85, 100 - latencyPenalty);
}

function renderBars(score, state) {
  return `<div class="status-bars ${state}" aria-hidden="true">${renderBarSegments(score, state)}</div>`;
}

function renderBarSegments(score, state) {
  const total = 34;
  const filled = Math.round((score / 100) * total);
  return Array.from({ length: total }, (_, index) => {
    const active = index < filled;
    return `<i class="${active ? state : 'empty'}"></i>`;
  }).join('');
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
