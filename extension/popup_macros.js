// JARVIS macro management UI for the extension popup.
// Self-contained: injects its own DOM section, styles, and storage handlers.
// Drop into popup.html with: <script src="popup_macros.js"></script>

(function () {
  function keyLabel(code) {
    if (!code) return '?';
    if (code.startsWith('Key'))   return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const map = {
      BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/',
      Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Minus: '-', Equal: '=',
      Backquote: '`', Space: 'Space', Enter: 'Enter', Tab: 'Tab',
    };
    return map[code] || code;
  }
  function shortUrl(url) {
    try { const u = new URL(url); return u.host + u.pathname; } catch { return url; }
  }

  // Inject CSS scoped to our section
  const style = document.createElement('style');
  style.textContent = `
    #jarvis-macros-section hr { border: none; border-top: 1px solid #2d3748; margin: 12px 0; }
    #jarvis-macros-section .macros-title {
      color: #63b3ed; font-size: 12px; font-weight: 600; margin-bottom: 4px;
    }
    #jarvis-macros-section .macros-hint {
      color: #a0aec0; font-size: 11px; line-height: 1.5; margin: 6px 0 10px;
    }
    #jarvis-macros-section .macros-hint kbd {
      background: #2d3748; border: 1px solid #4a5568; border-radius: 4px;
      padding: 1px 5px; font-size: 10px; color: #e2e8f0; font-family: monospace;
    }
    #jarvis-macros-section .macro-list {
      max-height: 180px; overflow-y: auto; margin-top: 6px;
    }
    #jarvis-macros-section .macro-row {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 8px; background: #12192b; border: 1px solid #2d3748;
      border-radius: 6px; margin-bottom: 4px; font-size: 11px;
    }
    #jarvis-macros-section .macro-name {
      flex: 1; color: #e2e8f0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #jarvis-macros-section .macro-meta { color: #4a5568; font-size: 10px; }
    #jarvis-macros-section .macro-row button {
      width: auto; padding: 2px 6px; margin: 0;
      font-size: 10px; background: #742a2a; color: #feb2b2;
      border: none; border-radius: 4px; cursor: pointer;
    }
    #jarvis-macros-section .macro-empty {
      color: #4a5568; font-size: 11px; font-style: italic; padding: 4px 0;
    }
  `;
  document.head.appendChild(style);

  // Inject the section
  const section = document.createElement('div');
  section.id = 'jarvis-macros-section';
  section.innerHTML = `
    <hr>
    <div class="macros-title">Macros</div>
    <div class="macros-hint">
      Press <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>[</kbd> on any page to start recording. Press <kbd>⌘</kbd>+<kbd>⌥</kbd>+&lt;key&gt; to save with that key as the replay hotkey.
    </div>
    <div class="macro-list" id="jarvis-macro-list"></div>
  `;
  document.body.appendChild(section);

  const listEl = document.getElementById('jarvis-macro-list');

  function render(macros) {
    const entries = Object.entries(macros);
    if (!entries.length) {
      listEl.innerHTML = '<div class="macro-empty">No macros yet — press ⌘+⌥+[ on a page to record one.</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const [key, m] of entries) {
      const row = document.createElement('div');
      row.className = 'macro-row';
      row.innerHTML = `
        <div class="macro-name" title="${shortUrl(m.url)}">⌘+⌥+${keyLabel(m.hotkey)} · ${shortUrl(m.url)}</div>
        <div class="macro-meta">${m.steps.length} steps</div>
        <button>Delete</button>
      `;
      row.querySelector('button').addEventListener('click', async () => {
        const { jarvis_macros = {} } = await chrome.storage.local.get('jarvis_macros');
        delete jarvis_macros[key];
        await chrome.storage.local.set({ jarvis_macros });
        render(jarvis_macros);
      });
      listEl.appendChild(row);
    }
  }

  chrome.storage.local.get('jarvis_macros', ({ jarvis_macros = {} }) => render(jarvis_macros));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.jarvis_macros) render(changes.jarvis_macros.newValue || {});
  });
})();
