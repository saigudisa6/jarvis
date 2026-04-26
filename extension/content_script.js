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
        chrome.runtime.sendMessage(msg);
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
  let history       = [];
  let lastUrl       = location.href;
  let ready         = false;
  let lastAnalyzed  = 0;  // timestamp — prevents rapid double-fires on SPAs

  // ── Helpers ────────────────────────────────────────────────────────────────────
  function addMsg(text, type = 'jarvis') {
    const el       = document.createElement('div');
    el.className   = `jarvis-msg ${type}`;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
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
    history.push({ role: 'user', content: text }, { role: 'assistant', content: res.text });
    if (history.length > 20) history = history.slice(-20);
  }

  q('send-btn').addEventListener('click', () => send(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) send(input.value); });

  // ── Page analysis ──────────────────────────────────────────────────────────────
  async function analyze() {
    // Debounce — ignore if we analyzed within the last 10 seconds (catches SPA double-fires)
    if (Date.now() - lastAnalyzed < 10_000) return;
    lastAnalyzed = Date.now();

    status.textContent = 'analyzing…';
    const res = await chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE', context: pageContext() });
    status.textContent = 'ready';

    const text = res?.text?.trim() || '';
    const isClear = text.toLowerCase().startsWith('clear');
    if (text && !isClear) {
      addMsg(text, 'jarvis');
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
    setTimeout(analyze, 1500);
  }

  // SPA navigation detection
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl  = location.href;
      history  = [];
      msgs.innerHTML = '';
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
