const form = document.querySelector('[data-suggestion-form]');
const message = document.querySelector('[data-suggestion-message]');

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const button = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);
    const payload = {
      name: formData.get('name'),
      type: formData.get('type'),
      idea: formData.get('idea')
    };

    setMessage('Sending your suggestion...', '');
    button.disabled = true;

    const response = await fetch('/api/suggestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => null);

    button.disabled = false;

    if (!response) {
      setMessage('Could not reach the website server. Please try again in a moment.', 'error');
      return;
    }

    const result = await response.json().catch(() => ({
      message: 'Something went wrong while sending the suggestion.'
    }));

    if (!response.ok) {
      setMessage(result.message, 'error');
      return;
    }

    form.reset();
    setMessage(result.message, 'success');
  });
}

function setMessage(value, state) {
  if (!message) return;
  message.textContent = value;
  message.className = `form-message${state ? ` ${state}` : ''}`;
}
