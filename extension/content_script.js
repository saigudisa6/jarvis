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

  // ── Restaurant Search Detection ─────────────────────────────────────────────────
  // Listen for Google search queries and detect if user is searching for restaurants
  function detectRestaurantSearch() {
    const currentUrl = window.location.href;
    
    // Only trigger on Google Search results
    if (!currentUrl.includes('google.com/search') && 
        !currentUrl.includes('google.com/maps') &&
        !currentUrl.includes('google.com/localservices')) {
      return;
    }

    // Extract search query from URL
    const urlParams = new URLSearchParams(window.location.search);
    const searchQuery = urlParams.get('q');
    
    if (!searchQuery) return;

    // Keywords that indicate food/restaurant search
    const foodKeywords = [
      'restaurant', 'food', 'eat', 'dining', 'lunch', 'dinner', 'breakfast',
      'cafe', 'coffee', 'pizza', 'sushi', 'burger', 'thai', 'italian', 
      'mexican', 'chinese', 'indian', 'ramen', 'pho', 'BBQ', 'steak',
      'vegan', 'vegetarian', 'breakfast spots', 'brunch', 'dessert',
      'bakery', 'taco', 'french', 'greek', 'korean', 'japanese'
    ];

    const queryLower = searchQuery.toLowerCase();
    const isRestaurantSearch = foodKeywords.some(keyword => queryLower.includes(keyword));
    
    if (isRestaurantSearch) {
      console.log(`🍽️ [JARVIS] Restaurant search detected: "${searchQuery}"`);

      function sendRestaurantMsg(lat, lng) {
        const msg = { type: 'RESTAURANT_SEARCH', query: searchQuery };
        if (lat != null && lng != null) { msg.latitude = lat; msg.longitude = lng; }
        chrome.runtime.sendMessage(msg, response => {
          if (chrome.runtime.lastError || !response?.success) return;
          if (response.recommendations?.restaurants?.length) {
            displayRestaurantResults(searchQuery, response.recommendations);
          }
        });
      }

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          pos => sendRestaurantMsg(pos.coords.latitude, pos.coords.longitude),
          ()  => sendRestaurantMsg(null, null),
          { timeout: 5000, maximumAge: 300000 }
        );
      } else {
        sendRestaurantMsg(null, null);
      }
    }
  }

  // Check for restaurant search on page load and when URL changes
  detectRestaurantSearch();
  
  // Monitor for navigation changes (SPA)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  
  history.pushState = function(...args) {
    originalPushState.apply(history, args);
    setTimeout(detectRestaurantSearch, 500);
    return args[2];
  };
  
  history.replaceState = function(...args) {
    originalReplaceState.apply(history, args);
    setTimeout(detectRestaurantSearch, 500);
    return args[2];
  };

  window.addEventListener('popstate', detectRestaurantSearch);
  const dot    = q('dot');
  const msgs   = q('msgs');
  const input  = q('input');
  const status = q('status');

  // ── State ──────────────────────────────────────────────────────────────────────
  let open          = false;
  let chatHistory   = [];
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

  // ── Email-row highlights ───────────────────────────────────────────────────────
  // When JARVIS surfaces 2+ proposed meeting times from the same person, find the
  // inbox rows containing those times and outline each in green — same color as
  // the macro screen-edge glow. Cleared when the I'm in / Can't make it group
  // goes away.

  let _rowHighlightStylesInjected = false;
  function ensureTimeHighlightStyles() {
    if (_rowHighlightStylesInjected) return;
    _rowHighlightStylesInjected = true;
    const style = document.createElement('style');
    style.id = 'jarvis-row-highlight-styles';
    style.textContent = `
      .jarvis-row-highlight {
        outline: 2px solid rgba(72, 187, 120, 0.7) !important;
        outline-offset: -2px !important;
        background: rgba(72, 187, 120, 0.10) !important;
        animation: jarvis-row-pulse 2.4s ease-in-out infinite !important;
        position: relative;
      }
      .jarvis-row-highlight > td {
        background: rgba(72, 187, 120, 0.10) !important;
      }
      @keyframes jarvis-row-pulse {
        0%, 100% { outline-color: rgba(72, 187, 120, 0.55) !important; }
        50%      { outline-color: rgba(154, 230, 180, 0.95) !important; }
      }
    `;
    document.head.appendChild(style);
  }

  function timePatternsFor(meeting) {
    const [hStr, mStr] = (meeting.startTime || '').split(':');
    const h24 = parseInt(hStr, 10);
    const m   = parseInt(mStr, 10);
    if (isNaN(h24)) return [];
    const h12  = ((h24 + 11) % 12) + 1;
    const ampm = h24 >= 12 ? 'pm' : 'am';
    const mm   = String(m).padStart(2, '0');
    const out  = [`${h12}:${mm}\\s*${ampm}`, `${h24}:${mm}`];
    if (m === 0) out.push(`${h12}\\s*${ampm}`);
    return out;
  }

  // Walk up from a text node's parent to the nearest "email row" container.
  // Gmail uses <tr class="zA">; some apps use [role="listitem"] or [data-thread-id].
  function findRowAncestor(el) {
    let cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      const tag = cur.tagName;
      if (tag === 'TR') return cur;
      if (cur.getAttribute) {
        if (cur.getAttribute('role') === 'listitem') return cur;
        if (cur.hasAttribute('data-thread-id')) return cur;
        if (cur.hasAttribute('data-legacy-thread-id')) return cur;
      }
      // Gmail's email-row class
      if (cur.classList && cur.classList.contains('zA')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function findMatchingRows(meetings) {
    const patterns = meetings.flatMap(timePatternsFor);
    if (!patterns.length) return [];
    const regex = new RegExp(`(?<![\\d:])(?:${patterns.join('|')})(?!\\w|:)`, 'gi');
    const rows = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('#jarvis-host, #jarvis-macros-host')) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'IFRAME') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        regex.lastIndex = 0;
        return regex.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      const row = findRowAncestor(n.parentElement);
      if (row) rows.add(row);
    }
    return [...rows];
  }

  // Track active highlight session so a MutationObserver can re-apply when Gmail
  // dynamically inserts a row (e.g. a brand-new email arriving while the prompt
  // is already on screen).
  let _activeHighlightMeetings = null;
  let _highlightObserver = null;
  let _highlightDebounce = null;

  function startHighlightObserver() {
    if (_highlightObserver) return;
    _highlightObserver = new MutationObserver(() => {
      if (!_activeHighlightMeetings) return;
      clearTimeout(_highlightDebounce);
      _highlightDebounce = setTimeout(() => {
        if (!_activeHighlightMeetings) return;
        const rows = findMatchingRows(_activeHighlightMeetings);
        rows.forEach(r => r.classList.add('jarvis-row-highlight'));
      }, 250);
    });
    _highlightObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopHighlightObserver() {
    if (_highlightObserver) {
      _highlightObserver.disconnect();
      _highlightObserver = null;
    }
    clearTimeout(_highlightDebounce);
    _highlightDebounce = null;
  }

  function highlightTimesInEmail(meetings) {
    ensureTimeHighlightStyles();
    ensureNoteStyles();
    const patterns = meetings.flatMap(timePatternsFor);
    console.log('[JARVIS] highlightTimesInEmail meetings:', meetings, 'patterns:', patterns);
    const rows = findMatchingRows(meetings);
    rows.forEach(r => r.classList.add('jarvis-row-highlight'));
    _activeHighlightMeetings = meetings;
    startHighlightObserver();
    console.log(`[JARVIS] highlighted ${rows.length} row(s); watching for new ones`);

    // Inline contextual notes — fired async since they may need calendar data
    addContextualNotes(meetings, rows);
    return rows.length;
  }

  function clearTimeHighlights() {
    _activeHighlightMeetings = null;
    stopHighlightObserver();
    document.querySelectorAll('.jarvis-row-highlight')
      .forEach(el => el.classList.remove('jarvis-row-highlight'));
    document.querySelectorAll('.jarvis-note-row, .jarvis-note-block').forEach(el => el.remove());
  }

  // ── Inline contextual notes ────────────────────────────────────────────────────
  let _noteStylesInjected = false;
  function ensureNoteStyles() {
    if (_noteStylesInjected) return;
    _noteStylesInjected = true;
    const style = document.createElement('style');
    style.id = 'jarvis-note-styles';
    style.textContent = `
      .jarvis-note-row > td { padding: 0 !important; }
      .jarvis-note {
        margin: 6px 24px 10px;
        padding: 12px 16px;
        background: rgba(20, 20, 25, 0.85) !important;
        backdrop-filter: blur(30px) saturate(180%);
        -webkit-backdrop-filter: blur(30px) saturate(180%);
        color: rgba(255, 255, 255, 0.92) !important;
        border: 0.5px solid rgba(255, 255, 255, 0.12) !important;
        border-left: 3px solid #ff9f0a !important;
        border-radius: 12px !important;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
        font-size: 13.5px;
        font-weight: 500;
        line-height: 1.45;
        letter-spacing: -0.1px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .jarvis-note .jarvis-note-icon {
        flex-shrink: 0;
        font-size: 14px;
        line-height: 1.4;
      }
      .jarvis-note .jarvis-note-label {
        font-weight: 600;
        color: #ffb84d;
        margin-right: 4px;
        letter-spacing: 0.1px;
        text-transform: lowercase;
      }
    `;
    document.head.appendChild(style);
  }

  function buildNote(text) {
    const note = document.createElement('div');
    note.className = 'jarvis-note';
    note.innerHTML = `
      <span class="jarvis-note-icon">⚡</span>
      <div><span class="jarvis-note-label">agentverse reminder:</span>${text}</div>
    `;
    return note;
  }

  function addNoteAfterRow(row, text) {
    if (!row?.parentNode) return;
    let wrapper;
    if (row.tagName === 'TR') {
      wrapper = document.createElement('tr');
      wrapper.className = 'jarvis-note-row';
      const td = document.createElement('td');
      td.colSpan = Math.max(row.children.length, 6);
      td.appendChild(buildNote(text));
      wrapper.appendChild(td);
    } else {
      wrapper = buildNote(text);
      wrapper.classList.add('jarvis-note-block');
    }
    row.parentNode.insertBefore(wrapper, row.nextSibling);
  }

  function findRowForMeeting(meeting, rows) {
    const patterns = timePatternsFor(meeting);
    if (!patterns.length) return null;
    const regex = new RegExp(`(?<![\\d:])(?:${patterns.join('|')})(?!\\w|:)`, 'gi');
    return rows.find(row => {
      regex.lastIndex = 0;
      return regex.test(row.textContent);
    });
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch { return iso; }
  }
  function fmtMeetingTime(meeting) {
    try {
      return new Date(`${meeting.startDate}T${meeting.startTime}:00`)
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch { return meeting.startTime; }
  }

  async function addContextualNotes(meetings, rows) {
    if (!meetings?.length || !rows?.length) return;

    // 1) Same-sender conflicting requests
    const senders = [...new Set(meetings.map(m => m.attendeeEmail).filter(Boolean))];
    if (meetings.length > 1 && senders.length === 1) {
      const sender = senders[0];
      const times = meetings.map(fmtMeetingTime).filter(Boolean).join(' and ');
      addNoteAfterRow(rows[0], `conflicting scheduling requests from <b>${sender}</b> — ${times}`);
    }

    // 2) Calendar conflicts
    let events = [];
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_EVENTS' });
      events = res?.events || [];
    } catch { /* not authed or no calendar — silently skip */ }
    if (!events.length) return;

    for (const meeting of meetings) {
      const meetingDt = new Date(`${meeting.startDate}T${meeting.startTime}:00`);
      if (isNaN(meetingDt.getTime())) continue;
      // Same-day events within ±2 hours of the proposed meeting
      const conflict = events.find(ev => {
        const evDt = new Date(ev.start);
        if (isNaN(evDt.getTime())) return false;
        const sameDay = evDt.toDateString() === meetingDt.toDateString();
        const hoursApart = Math.abs(evDt - meetingDt) / 36e5;
        return sameDay && hoursApart < 2;
      });
      if (!conflict) continue;
      const row = findRowForMeeting(meeting, rows);
      if (!row) continue;
      addNoteAfterRow(row,
        `you have <b>"${conflict.title}"</b> at ${fmtTime(conflict.start)} — this could pull you off track.`);
    }
  }

  // Debug helpers — work across world boundaries via DOM CustomEvents.
  // From any DevTools context (default page world OR extension context), call:
  //   window.dispatchEvent(new CustomEvent('jarvis-highlight-test', { detail: { times: ['2pm','3:30pm','14:00'] } }))
  //   window.dispatchEvent(new CustomEvent('jarvis-highlight-clear'))
  function timesToMeetings(times) {
    return (Array.isArray(times) ? times : [times]).map(t => {
      let s = String(t).trim().toLowerCase();
      const ampm = s.endsWith('pm') ? 'pm' : (s.endsWith('am') ? 'am' : null);
      if (ampm) s = s.slice(0, -2).trim();
      const [hStr, mStr = '0'] = s.split(':');
      let h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10) || 0;
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      return { startTime: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, startDate: '2099-01-01' };
    });
  }
  window.addEventListener('jarvis-highlight-test', (e) => {
    const meetings = timesToMeetings(e.detail?.times || []);
    console.log('[JARVIS] test event received, meetings:', meetings);
    highlightTimesInEmail(meetings);
  });
  window.addEventListener('jarvis-highlight-clear', () => clearTimeHighlights());
  // Also expose direct functions for the JARVIS DevTools context
  window.__jarvisHighlightTest  = (times) => highlightTimesInEmail(timesToMeetings(times));
  window.__jarvisHighlightClear = clearTimeHighlights;

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
        clearTimeHighlights();

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
          clearTimeHighlights();
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

    // Outline the inbox row(s) for any meeting prompted with I'm in / Can't make it.
    // Fires for single-meeting prompts too — the row is the new email.
    highlightTimesInEmail(meetings);
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

    const res = await chrome.runtime.sendMessage({ type: 'CHAT', text, history: chatHistory });
    thinking.remove();
    status.textContent = 'ready';

    if (res?.error) {
      addMsg(res.error.includes('no_key') ? 'Add your ASI:One key in the JARVIS popup.' : res.error, 'alert');
      return;
    }
    addMsg(res.text, 'jarvis');
    if (res.meetings?.length) addMeetingGroup(res.meetings);
    chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
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

  // ── Restaurant Results Display ─────────────────────────────────────────────────
  function displayRestaurantResults(query, data) {
    const restaurants = data.restaurants || [];
    if (!restaurants.length) return;

    addMsg(`🍽️ Top picks near you for "${query}"`, 'jarvis');

    restaurants.forEach((r, i) => {
      const price = r.price_level ? '$'.repeat(r.price_level) : '$$';
      const open  = r.open_now === true ? 'Open now' : r.open_now === false ? 'Closed' : '';
      const meta  = [r.rating ? `${r.rating}★` : null, price, open].filter(Boolean).join('  ·  ');
      const match = r.score != null ? `${Math.round(r.score * 100)}% match` : '';
      const why   = (r.reasons || []).join(' · ');
      const footer = [match, why].filter(Boolean).join(' — ');

      addMsg(`${i + 1}. ${r.name}\n${meta}\n${r.address}${footer ? '\n' + footer : ''}`, 'jarvis');
    });

    flashDot();
    openPanel();
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
      chatHistory    = [];
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
