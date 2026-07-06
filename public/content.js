loadEditableContent();

async function loadEditableContent() {
  const response = await fetch('/api/content').catch(() => null);
  if (!response?.ok) return;

  const data = await response.json();
  for (const element of document.querySelectorAll('[data-content]')) {
    const item = data.items?.[element.dataset.content];
    if (!item?.value) continue;

    if (element.dataset.contentMode === 'html') {
      element.innerHTML = item.value;
    } else {
      element.textContent = item.value;
    }
  }
}
