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

  function addMeetingButtons(meeting) {
    const mKey = `${meeting.startDate}:${meeting.startTime}`;

    const wrap = document.createElement('div');
    wrap.className = 'jarvis-actions';

    const accept  = document.createElement('button');
    accept.className   = 'jarvis-btn accept';
    accept.textContent = "I'm in — add to calendar";

    const decline = document.createElement('button');
    decline.className   = 'jarvis-btn decline';
    decline.textContent = "Can't make it";

    const markHandled = () => {
      chrome.runtime.sendMessage({ type: 'MEETING_HANDLED', key: mKey }).catch(() => {});
    };

    accept.addEventListener('click', async () => {
      markHandled();
      wrap.remove();
      const thinking = addMsg('Adding to your calendar…', 'thinking');
      const res = await chrome.runtime.sendMessage({ type: 'CREATE_EVENT', event: meeting }).catch(() => null);
      thinking.remove();
      if (res?.success) {
        addMsg(`Done — "${meeting.title}" is on your calendar.`, 'jarvis');
      } else {
        addMsg(`Couldn't add it: ${res?.error || 'unknown error'}`, 'alert');
      }
      msgs.scrollTop = msgs.scrollHeight;
    });

    decline.addEventListener('click', () => {
      markHandled();
      wrap.remove();
      addMsg("Got it, skipping that one.", 'jarvis');
    });

    wrap.appendChild(accept);
    wrap.appendChild(decline);
    msgs.appendChild(wrap);
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

    const res = await chrome.runtime.sendMessage({ type: 'CHAT', text, history: chatHistory });
    thinking.remove();
    status.textContent = 'ready';

    if (res?.error) {
      addMsg(res.error.includes('no_key') ? 'Add your ASI:One key in the JARVIS popup.' : res.error, 'alert');
      return;
    }
    addMsg(res.text, 'jarvis');
    if (res.meeting) addMeetingButtons(res.meeting);
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
      if (res.meeting && !res.error) addMeetingButtons(res.meeting);
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
