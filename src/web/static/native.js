const refresh = document.getElementById('refresh');
const status = document.getElementById('status');
const snapshot = document.getElementById('snapshot');
const login = document.getElementById('login');
const loginMessage = document.getElementById('login-message');
let imageUrl;

async function capture() {
  refresh.disabled = true;
  refresh.hidden = false;
  login.hidden = true;
  status.classList.remove('error');
  status.textContent = 'Capturing the Mac desktop…';
  try {
    const response = await fetch('/api/v1/screenshot?format=png&max_dimension=1600', { cache: 'no-store' });
    if (response.status === 401) {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = undefined;
      snapshot.removeAttribute('src');
      snapshot.hidden = true;
      refresh.hidden = true;
      login.hidden = false;
      loginMessage.textContent = new URLSearchParams(location.search).has('token')
        ? 'That token was not accepted.'
        : 'Enter the access token to view this desktop.';
      status.textContent = 'Sign in to view this desktop.';
      document.getElementById('token').focus();
      return;
    }
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || `Capture failed (${response.status})`);
    }
    const next = URL.createObjectURL(await response.blob());
    const old = imageUrl;
    imageUrl = next;
    snapshot.src = next;
    snapshot.hidden = false;
    if (old) URL.revokeObjectURL(old);
    status.textContent = `Captured ${response.headers.get('x-image-size') || 'desktop'} at ${new Date().toLocaleTimeString()}.`;
  } catch (error) {
    status.classList.add('error');
    status.textContent = error instanceof Error ? error.message : 'Capture failed.';
  } finally {
    refresh.disabled = false;
  }
}

refresh.addEventListener('click', capture);
window.addEventListener('beforeunload', () => { if (imageUrl) URL.revokeObjectURL(imageUrl); });
void capture();
