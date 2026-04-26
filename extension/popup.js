const statusEl = document.getElementById('status');
const googleBadge = document.getElementById('google-badge');

function setStatus(msg, type = '') {
  statusEl.innerHTML = type ? `<span class="badge ${type}">${msg}</span>` : msg;
}

function setGoogleBadge(connected) {
  googleBadge.textContent = connected ? 'connected' : 'not connected';
  googleBadge.className   = `badge ${connected ? 'ok' : 'err'}`;
}

// Load current state
chrome.storage.sync.get('asi_key', ({ asi_key }) => {
  if (asi_key) document.getElementById('asi-key').value = asi_key;
});

chrome.runtime.sendMessage({ type: 'GET_STATUS' }, ({ authed } = {}) => {
  setGoogleBadge(!!authed);
});

// Save ASI:One key
document.getElementById('btn-save').addEventListener('click', () => {
  const key = document.getElementById('asi-key').value.trim();
  if (!key) { setStatus('Enter a key first', 'err'); return; }
  chrome.storage.sync.set({ asi_key: key }, () => setStatus('Saved!', 'ok'));
});

// Connect Google
document.getElementById('btn-auth').addEventListener('click', () => {
  setStatus('Opening Google auth…');
  chrome.runtime.sendMessage({ type: 'AUTH' }, response => {
    if (response?.success) {
      setGoogleBadge(true);
      setStatus('Google connected!', 'ok');
    } else {
      setStatus(response?.error || 'Auth failed', 'err');
    }
  });
});
