(async function () {
  // Only top-level frames, only once per page
  if (window !== window.top) return;
  if (document.getElementById('jarvis-host')) return;

  // Wait for a body to exist (some pages are slow)
  if (!document.body) {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

  // ── Shadow DOM — immune to page styles and CSP ─────────────────────────────────
  const host = document.createElement('div');
  host.id    = 'jarvis-host';
  // Attach to <html>, not <body> — Gmail and other SPAs recreate body
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // Fetch CSS and inject as <style> — never blocked by page CSP
  try {
    const css   = await fetch(chrome.runtime.getURL('overlay.css')).then(r => r.text());
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
  } catch (_) {}

  const ui = document.createElement('div');
  ui.innerHTML = `
    <div id="panel">
      <div class="jarvis-header">
        <span class="jarvis-header-title">⚡ JARVIS</span>
        <span class="jarvis-header-status" id="status">ready</span>
        <span class="jarvis-close" id="close-btn">✕</span>
      </div>
      <div class="jarvis-messages" id="msgs"></div>
      <div class="jarvis-input-row">
        <input class="jarvis-input" id="input" placeholder="Ask me anything…" />
        <button class="jarvis-send" id="send-btn">↑</button>
      </div>
    </div>
    <div id="bubble">
      <span class="jarvis-logo">J</span>
      <span class="jarvis-dot" id="dot"></span>
    </div>
  `;
  shadow.appendChild(ui);

  const q      = id => shadow.getElementById(id);
  const panel  = q('panel');
  const bubble = q('bubble');
  const dot    = q('dot');
  const msgs   = q('msgs');
  const input  = q('input');
  const status = q('status');

  // ── State ──────────────────────────────────────────────────────────────────────
  let open          = false;
  let history       = [];
  let lastUrl       = location.href;
  let ready         = false;
  let lastAnalyzed  = 0;  // timestamp — prevents rapid double-fires on SPAs

  // ── Helpers ────────────────────────────────────────────────────────────────────
  function stripMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
      .replace(/\*(.+?)\*/g,     '$1')   // *italic*
      .replace(/__(.+?)__/g,     '$1')   // __bold__
      .replace(/_(.+?)_/g,       '$1')   // _italic_
      .replace(/`(.+?)`/g,       '$1')   // `code`
      .replace(/^#{1,6}\s+/gm,   '')     // # headings
      .replace(/^\s*[-*]\s+/gm,  '• ')  // - bullets → •
      .trim();
  }

  function addMsg(text, type = 'jarvis') {
    const el       = document.createElement('div');
    el.className   = `jarvis-msg ${type}`;
    el.textContent = stripMarkdown(text);
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function meetingKey(m) {
    const base = `${m.startDate}:${m.startTime}`;
    if (m.emailId)       return `${m.emailId}:${base}`;
    if (m.attendeeEmail) return `${m.attendeeEmail}:${base}`;
    return base;
  }

  function addMeetingGroup(meetings) {
    if (!meetings?.length) return;

    const group = document.createElement('div');
    group.className = 'jarvis-meeting-group';

    meetings.forEach(meeting => {
      const mKey = meetingKey(meeting);
      const t    = new Date(`${meeting.startDate}T${meeting.startTime}:00`);
      const label = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
                    (meeting.title ? ` — ${meeting.title}` : '');

      const row = document.createElement('div');
      row.className = 'jarvis-meeting-row';

      const timeEl = document.createElement('div');
      timeEl.className   = 'jarvis-meeting-time';
      timeEl.textContent = label;

      const actions = document.createElement('div');
      actions.className = 'jarvis-actions';

      const accept  = document.createElement('button');
      accept.className   = 'jarvis-btn accept';
      accept.textContent = "I'm in";

      const decline = document.createElement('button');
      decline.className   = 'jarvis-btn decline';
      decline.textContent = "Can't make it";

      accept.addEventListener('click', async () => {
        // Disable immediately to prevent double-clicks
        accept.disabled = true;
        decline.disabled = true;
        // Mark every meeting in the group as handled
        meetings.forEach(m => {
          chrome.runtime.sendMessage({ type: 'MEETING_HANDLED', key: meetingKey(m) }).catch(() => {});
        });
        group.remove();

        const thinking = addMsg('Adding to your calendar…', 'thinking');
        const res = await chrome.runtime.sendMessage({ type: 'CREATE_EVENT', event: meeting }).catch(() => null);
        thinking.remove();
        if (res?.success) {
          const others = meetings.length > 1 ? ` Passed on the other ${meetings.length - 1}.` : '';
          addMsg(`Done — "${meeting.title}" is on your calendar.${others}`, 'jarvis');
        } else {
          const err = res?.error || 'unknown error';
          const hint = err.toLowerCase().includes('scope') || err.toLowerCase().includes('auth')
            ? 'Reconnect Google in the JARVIS popup.' : err;
          addMsg(`Couldn't add it: ${hint}`, 'alert');
        }
        msgs.scrollTop = msgs.scrollHeight;
      });

      decline.addEventListener('click', async () => {
        decline.disabled = true;
        accept.disabled  = true;
        const res = await chrome.runtime.sendMessage({ type: 'DECLINE_MEETING', key: mKey, meeting }).catch(() => null);
        row.remove();
        if (res?.error) {
          const hint = res.error.toLowerCase().includes('scope') || res.error.toLowerCase().includes('auth')
            ? 'Reconnect Google in the JARVIS popup to enable email sending.' : res.error;
          addMsg(`Passed on it, but couldn't send the email: ${hint}`, 'alert');
        } else if (!group.querySelector('.jarvis-meeting-row')) {
          group.remove();
          addMsg(meeting.attendeeEmail ? 'Passed on all of them — sent decline emails.' : 'Passed on all of them.', 'jarvis');
        } else {
          addMsg(meeting.attendeeEmail ? `Passed on that one — sent ${meeting.attendeeEmail} a note.` : 'Passed on that one.', 'jarvis');
        }
        msgs.scrollTop = msgs.scrollHeight;
      });

      actions.appendChild(accept);
      actions.appendChild(decline);
      row.appendChild(timeEl);
      row.appendChild(actions);
      group.appendChild(row);
    });

    msgs.appendChild(group);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function openPanel() {
    open = true;
    panel.classList.add('open');
    dot.classList.remove('alert');
  }

  function closePanel() {
    open = false;
    panel.classList.remove('open');
  }

  function flashDot() {
    dot.classList.add('alert');
    setTimeout(() => dot.classList.remove('alert'), 10000);
  }

  function pageContext() {
    try {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll('script,style,noscript,svg,img').forEach(e => e.remove());
      const text = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
      return { url: location.href, title: document.title, text: text.slice(0, 1500) };
    } catch (_) {
      return { url: location.href, title: document.title, text: '' };
    }
  }

  // ── Toggle ─────────────────────────────────────────────────────────────────────
  bubble.addEventListener('click', () => open ? closePanel() : openPanel());
  q('close-btn').addEventListener('click', closePanel);

  // ── Chat ───────────────────────────────────────────────────────────────────────
  async function send(text) {
    if (!text.trim()) return;
    input.value = '';
    addMsg(text, 'user');
    const thinking = addMsg('Thinking…', 'thinking');
    status.textContent = 'thinking…';

    const res = await chrome.runtime.sendMessage({ type: 'CHAT', text, history });
    thinking.remove();
    status.textContent = 'ready';

    if (res?.error) {
      addMsg(res.error.includes('no_key') ? 'Add your ASI:One key in the JARVIS popup.' : res.error, 'alert');
      return;
    }
    addMsg(res.text, 'jarvis');
    if (res.meetings?.length) addMeetingGroup(res.meetings);
    history.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
    if (history.length > 20) history = history.slice(-20);
  }

  q('send-btn').addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) send(input.value); });

  // ── Page analysis ──────────────────────────────────────────────────────────────
  async function analyze() {
    if (Date.now() - lastAnalyzed < 20_000) return;  // one analysis per 20s max
    lastAnalyzed = Date.now();

    status.textContent = 'analyzing…';
    const res = await chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE', context: pageContext() }).catch(() => null);
    status.textContent = 'ready';

    if (!res) return;
    const text = res.error
      ? (res.error.includes('no_key') ? 'Add your ASI:One key in the JARVIS popup.' : res.error)
      : res.text?.trim() || '';
    const msgType = res.error ? 'alert' : 'jarvis';
    const isClear = !res.error && text.toLowerCase().startsWith('clear');
    if (text && !isClear) {
      addMsg(text, msgType);
      if (res.meetings?.length && !res.error) addMeetingGroup(res.meetings);
      flashDot();
      openPanel();
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────────
  const statusRes = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }).catch(() => ({}));
  ready = !!statusRes?.ready;

  if (!ready) {
    addMsg('Add your ASI:One API key in the JARVIS popup to get started.', 'alert');
    openPanel();
  } else if (!statusRes?.authed) {
    addMsg('Connect Google in the JARVIS popup to unlock email & calendar context.', 'alert');
    openPanel();
  } else {
    setTimeout(() => {
      lastUrl      = location.href;  // absorb URL settling during page init
      lastAnalyzed = 0;              // ensure first run always fires
      analyze();
    }, 1500);
  }

  // SPA navigation detection
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl        = location.href;
      history        = [];
      msgs.innerHTML = '';
      lastAnalyzed   = 0;  // reset cooldown for new page
      if (ready) setTimeout(analyze, 1000);
    }
  }, 2000);

  // ── Incoming proactive alerts ──────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'PROACTIVE_ALERT') {
      addMsg(msg.text, 'alert');
      flashDot();
      openPanel();   // auto-open the panel
    }
  });
})();
