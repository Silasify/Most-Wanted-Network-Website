const elements = {
  siteName: document.querySelector('[data-site-name]'),
  statusCopy: document.querySelector('[data-status-copy]'),
  overall: document.querySelector('[data-overall]'),
  entries: document.querySelector('[data-entries]'),
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

  elements.entries.innerHTML = data.entries.length
    ? data.entries.map(renderEntry).join('')
    : '<div class="empty-state">No entries are configured yet.</div>';
}

function renderEntry(entry) {
  const statusText = entry.online ? 'Online' : 'Offline';
  const latency = entry.online ? `${entry.latencyMs} ms` : reasonText(entry.reason);

  return `<article class="entry-card ${entry.online ? 'online' : 'offline'}">
    <div class="entry-top">
      <div>
        <h3>${escapeHtml(entry.name)}</h3>
        ${entry.description ? `<p>${escapeHtml(entry.description)}</p>` : ''}
      </div>
      <span>${statusText}</span>
    </div>
    <dl>
      <div><dt>Group</dt><dd>${escapeHtml(entry.group)}</dd></div>
      <div><dt>Latency</dt><dd>${escapeHtml(latency)}</dd></div>
      <div><dt>Checked</dt><dd>${new Date(entry.checkedAt).toLocaleTimeString()}</dd></div>
    </dl>
  </article>`;
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}
