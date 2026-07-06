const newsList = document.querySelector('[data-news-list]');

loadNews();

async function loadNews() {
  const response = await fetch('/api/news').catch(() => null);
  if (!response?.ok) {
    newsList.innerHTML = '<div class="empty-state">Could not load updates right now.</div>';
    return;
  }

  const data = await response.json();
  newsList.innerHTML = data.items.length
    ? data.items.map(renderNewsItem).join('')
    : '<div class="empty-state">No updates have been posted yet.</div>';
}

function renderNewsItem(item) {
  const date = item.date ? new Date(item.date).toLocaleDateString() : 'Recent';
  const link = item.linkLabel && item.linkUrl
    ? `<a href="${escapeHtml(item.linkUrl)}" rel="noreferrer">${escapeHtml(item.linkLabel)}</a>`
    : '';

  return `<article class="news-card">
    <div>
      <span class="card-kicker">${escapeHtml(item.category)} · ${escapeHtml(date)}</span>
      <h2>${escapeHtml(item.title)}</h2>
      <p>${escapeHtml(item.body)}</p>
    </div>
    ${link}
  </article>`;
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
