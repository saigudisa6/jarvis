// JARVIS macro recorder + replayer.
// Self-contained content script: own shadow DOM, own listeners, own storage keys.
// Storage:
//   chrome.storage.local.jarvis_macros    = { "<origin+path>": macro }
//   chrome.storage.local.jarvis_recording = { active, startUrl, startedAt, steps }
//   chrome.storage.local.jarvis_replaying = { macroPath, stepIndex, startedAt }

(async function () {
  if (window !== window.top) return;
  if (document.getElementById('jarvis-macros-host')) return;
  if (!document.body) {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

  // ── Shadow DOM ─────────────────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'jarvis-macros-host';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      top: 0; left: 0;
      width: 0; height: 0;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    /* Recording banner (top center) */
    #rec-banner {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translate(-50%, -120%);
      background: linear-gradient(135deg, #2d1f09, #3d1f1f);
      color: #fbd38d;
      border: 1px solid #f6ad55;
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      opacity: 0;
      transition: transform 0.25s cubic-bezier(.34,1.56,.64,1), opacity 0.2s;
      pointer-events: none;
    }
    #rec-banner.show { transform: translate(-50%, 0); opacity: 1; }
    .rec-pulse {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #fc8181;
      animation: rec-pulse 1.1s infinite;
    }
    @keyframes rec-pulse {
      0%, 100% { transform: scale(1);   opacity: 1; }
      50%       { transform: scale(1.5); opacity: 0.5; }
    }
    #rec-count {
      background: rgba(0,0,0,0.35);
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: #fbd38d;
    }

    /* Replay banner (top center) */
    #play-banner {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translate(-50%, -120%);
      background: linear-gradient(135deg, #14361f, #1c4a2c);
      color: #c6f6d5;
      border: 1px solid #48bb78;
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      opacity: 0;
      transition: transform 0.25s cubic-bezier(.34,1.56,.64,1), opacity 0.2s;
      pointer-events: none;
    }
    #play-banner.show { transform: translate(-50%, 0); opacity: 1; }
    .play-spinner {
      width: 12px; height: 12px;
      border: 2px solid rgba(154,230,180,0.3);
      border-top-color: #9ae6b4;
      border-radius: 50%;
      animation: play-spin 0.8s linear infinite;
    }
    @keyframes play-spin { to { transform: rotate(360deg); } }
    #play-progress {
      background: rgba(0,0,0,0.35);
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: #9ae6b4;
    }

    /* Screen-edge glow — shows while JARVIS is driving */
    #screen-glow {
      position: fixed;
      inset: 0;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.4s ease-out;
      box-shadow: inset 0 0 80px 12px rgba(72, 187, 120, 0.45);
      border: 2px solid rgba(72, 187, 120, 0.55);
      animation: glow-pulse 2.4s ease-in-out infinite;
    }
    #screen-glow.show { opacity: 1; }
    @keyframes glow-pulse {
      0%, 100% { box-shadow: inset 0 0 70px 10px rgba(72, 187, 120, 0.35),
                              0 0 0 0 rgba(72, 187, 120, 0.0); }
      50%      { box-shadow: inset 0 0 110px 18px rgba(72, 187, 120, 0.6),
                              inset 0 0 0 1px rgba(154, 230, 180, 0.3); }
    }

    /* Suggestion card (top right) */
    #suggest {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 320px;
      background: #1a1a2e;
      color: #c6f6d5;
      border: 1px solid #48bb78;
      border-left: 4px solid #48bb78;
      border-radius: 12px;
      padding: 14px 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      transform: translateX(120%);
      transition: transform 0.3s cubic-bezier(.34,1.56,.64,1);
      font-size: 13px;
    }
    #suggest.show { transform: translateX(0); }
    .suggest-title { font-weight: 600; font-size: 13px; margin-bottom: 4px; color: #9ae6b4; display: flex; align-items: center; gap: 6px; }
    .suggest-body  { font-size: 12px; color: #a0aec0; margin-bottom: 10px; line-height: 1.5; }
    .suggest-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .sug-btn {
      flex: 1;
      min-width: 70px;
      border: none;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .sug-btn:hover { opacity: 0.85; }
    .sug-btn.run     { background: #276749; color: #9ae6b4; }
    .sug-btn.dismiss { background: #2d3748; color: #a0aec0; }
    .sug-btn.delete  { background: #742a2a; color: #feb2b2; }

    /* Toast (bottom right, above JARVIS bubble) */
    #toast {
      position: fixed;
      bottom: 90px;
      right: 24px;
      background: #1a1a2e;
      color: #e2e8f0;
      border: 1px solid #2d3748;
      border-left: 3px solid #48bb78;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 12px;
      max-width: 340px;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.18s, transform 0.18s;
      pointer-events: none;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    #toast.show { opacity: 1; transform: translateY(0); }
  `;
  shadow.appendChild(style);

  const ui = document.createElement('div');
  ui.innerHTML = `
    <div id="rec-banner">
      <span class="rec-pulse"></span>
      <span>Recording macro… press ⌘+⌥+&lt;key&gt; to save · Esc to cancel</span>
      <span id="rec-count">0</span>
    </div>
    <div id="play-banner">
      <span class="play-spinner"></span>
      <span id="play-text">Replaying macro…</span>
      <span id="play-progress">0 / 0</span>
    </div>
    <div id="screen-glow"></div>
    <div id="suggest"></div>
    <div id="toast"></div>
  `;
  shadow.appendChild(ui);

  const $ = id => shadow.getElementById(id);
  const recBanner    = $('rec-banner');
  const recCount     = $('rec-count');
  const playBanner   = $('play-banner');
  const playText     = $('play-text');
  const playProgress = $('play-progress');
  const screenGlow   = $('screen-glow');
  const suggest      = $('suggest');
  const toast        = $('toast');

  function showToast(text, ms = 3000) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), ms);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────
  function macroKey(url) {
    try { const u = new URL(url); return u.origin + u.pathname; }
    catch { return url; }
  }
  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function isOurUI(el) {
    return !!(el && el.closest && (el.closest('#jarvis-macros-host') || el.closest('#jarvis-host')));
  }
  function isModifier(k) { return ['Meta','Control','Shift','Alt','CapsLock'].includes(k); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
      return `#${cssEscape(el.id)}`;
    }
    const testid = el.getAttribute('data-testid');
    if (testid) return `[data-testid="${testid}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 60) {
      const sel = `${el.tagName.toLowerCase()}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const path = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && path.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { path.unshift(`#${cssEscape(cur.id)}`); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      path.unshift(part);
      cur = cur.parentElement;
    }
    return path.join(' > ');
  }

  // Brief outline overlay on a target element. Lives in page DOM for trivial positioning.
  function flashElement(el, color) {
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed;
      left: ${r.left - 4}px; top: ${r.top - 4}px;
      width: ${r.width + 8}px; height: ${r.height + 8}px;
      border: 2px solid ${color};
      border-radius: 6px;
      box-shadow: 0 0 0 4px ${color}33, 0 0 20px ${color}88;
      pointer-events: none;
      z-index: 2147483646;
      transition: opacity 0.5s ease-out;
    `;
    document.documentElement.appendChild(overlay);
    setTimeout(() => { overlay.style.opacity = '0'; }, 350);
    setTimeout(() => overlay.remove(), 900);
  }

  // ── State ──────────────────────────────────────────────────────────────────────
  let savedMacros = {};
  let isRecording = false;
  let isReplaying = false;
  let lastUrl     = location.href;

  // Serialize storage writes so rapid events can't race
  let writeChain = Promise.resolve();
  function pushStep(step) {
    writeChain = writeChain.then(async () => {
      const { jarvis_recording } = await chrome.storage.local.get('jarvis_recording');
      if (!jarvis_recording?.active) return;
      const at = Date.now() - jarvis_recording.startedAt;
      const last = jarvis_recording.steps[jarvis_recording.steps.length - 1];
      // Coalesce consecutive input events on the same field
      if (step.type === 'input' && last?.type === 'input' && last.selector === step.selector) {
        last.value = step.value;
        last.at = at;
      } else {
        jarvis_recording.steps.push({ ...step, at });
      }
      await chrome.storage.local.set({ jarvis_recording });
      recCount.textContent = String(jarvis_recording.steps.length);
    }).catch(err => console.error('[JARVIS macros] pushStep failed:', err));
    return writeChain;
  }

  // ── Recording listeners ────────────────────────────────────────────────────────
  let lastClickAt = 0;
  let lastClickSel = null;
  function onRecClick(e) {
    if (isOurUI(e.target)) return;
    if (!e.isTrusted) return;                    // skip programmatic clicks
    if (e.target.tagName === 'OPTION') return;   // input/change event on the parent <select> covers this
    const sel = buildSelector(e.target);
    if (!sel) return;
    const now = Date.now();
    // Collapse rapid-fire clicks: any click within 30ms of the last (event burst from
    // label→input synthesis or React wrappers), or same selector within 400ms.
    if (now - lastClickAt < 30) return;
    if (sel === lastClickSel && now - lastClickAt < 400) return;
    lastClickAt  = now;
    lastClickSel = sel;
    pushStep({ type: 'click', selector: sel });
    flashElement(e.target, '#fc8181');
  }
  function onRecInput(e) {
    if (isOurUI(e.target)) return;
    const sel = buildSelector(e.target);
    if (!sel) return;
    // For native <select>, record as a select step so replay can fire change events
    if (e.target.tagName === 'SELECT') {
      pushStep({ type: 'select', selector: sel, value: e.target.value });
    } else {
      pushStep({ type: 'input', selector: sel, value: e.target.value });
    }
    flashElement(e.target, '#fc8181');
  }
  function onRecChange(e) {
    // Some browsers/components only fire `change` (not `input`) when a <select> changes.
    if (isOurUI(e.target)) return;
    if (e.target.tagName !== 'SELECT') return;
    const sel = buildSelector(e.target);
    if (!sel) return;
    pushStep({ type: 'select', selector: sel, value: e.target.value });
    flashElement(e.target, '#fc8181');
  }
  function onRecSubmit(e) {
    if (isOurUI(e.target)) return;
    const sel = buildSelector(e.target);
    if (!sel) return;
    pushStep({ type: 'submit', selector: sel });
    flashElement(e.target, '#fc8181');
  }
  function onRecKeydown(e) {
    if (isOurUI(e.target)) return;
    if (isModifier(e.key)) return;
    if ((e.metaKey || e.ctrlKey) && e.altKey) return;  // skip our own ⌘+⌥+key shortcuts
    const t = e.target;
    const editable = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    const plainChar = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (editable && plainChar) return;  // input event handles plain typing
    pushStep({
      type: 'key',
      selector: buildSelector(t),
      key: e.key, code: e.code,
      ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
    });
    flashElement(t, '#fc8181');
  }

  function attachRecListeners() {
    document.addEventListener('click',   onRecClick,   true);
    document.addEventListener('input',   onRecInput,   true);
    document.addEventListener('change',  onRecChange,  true);
    document.addEventListener('submit',  onRecSubmit,  true);
    document.addEventListener('keydown', onRecKeydown, true);
  }
  function detachRecListeners() {
    document.removeEventListener('click',   onRecClick,   true);
    document.removeEventListener('input',   onRecInput,   true);
    document.removeEventListener('change',  onRecChange,  true);
    document.removeEventListener('submit',  onRecSubmit,  true);
    document.removeEventListener('keydown', onRecKeydown, true);
  }

  // ── Recording lifecycle ────────────────────────────────────────────────────────
  async function startRecording() {
    if (isRecording) return;
    isRecording = true;
    await chrome.storage.local.set({
      jarvis_recording: { active: true, startUrl: location.href, startedAt: Date.now(), steps: [] }
    });
    recCount.textContent = '0';
    recBanner.classList.add('show');
    attachRecListeners();
    showToast('🔴 Recording started — interact freely, navigate between pages, then press ⌘+⌥+<key> to save.');
  }

  async function resumeRecordingIfActive() {
    const { jarvis_recording } = await chrome.storage.local.get('jarvis_recording');
    if (!jarvis_recording?.active) return;
    isRecording = true;
    recCount.textContent = String(jarvis_recording.steps.length);
    recBanner.classList.add('show');
    attachRecListeners();
    const lastNav = [...jarvis_recording.steps].reverse().find(s => s.type === 'navigate');
    const knownUrl = lastNav ? lastNav.url : jarvis_recording.startUrl;
    if (knownUrl !== location.href) {
      await pushStep({ type: 'navigate', url: location.href, selector: null });
    }
  }

  function countNavs(steps) { return steps.filter(s => s.type === 'navigate').length; }

  async function stopAndSave(hotkey) {
    const { jarvis_recording } = await chrome.storage.local.get('jarvis_recording');
    if (!jarvis_recording?.active) return;
    detachRecListeners();
    recBanner.classList.remove('show');
    isRecording = false;
    await chrome.storage.local.remove('jarvis_recording');

    const steps = jarvis_recording.steps;
    if (!steps.length) { showToast('No actions recorded — macro discarded.'); return; }
    const macro = {
      hotkey,
      url: jarvis_recording.startUrl,
      name: document.title || jarvis_recording.startUrl,
      steps,
      createdAt: Date.now(),
    };
    const { jarvis_macros = {} } = await chrome.storage.local.get('jarvis_macros');
    jarvis_macros[macroKey(jarvis_recording.startUrl)] = macro;
    await chrome.storage.local.set({ jarvis_macros });
    savedMacros = jarvis_macros;
    const navs = countNavs(steps);
    showToast(`Macro saved · press ⌘+⌥+${keyLabel(hotkey)} to replay (${steps.length} steps across ${navs + 1} page${navs ? 's' : ''})`);
  }

  async function cancelRecording() {
    if (!isRecording) return;
    detachRecListeners();
    recBanner.classList.remove('show');
    isRecording = false;
    await chrome.storage.local.remove('jarvis_recording');
    showToast('Recording cancelled.');
  }

  // ── Replay ─────────────────────────────────────────────────────────────────────
  // Try sync first — only fall back to polling if the element isn't there yet.
  async function waitForSelector(sel, timeout = 3000) {
    if (!sel) return null;
    const immediate = document.querySelector(sel);
    if (immediate) return immediate;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(15);
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  // Rich click sequence — covers libraries that listen on pointer events, mouse events,
  // or hover state. Includes coordinates so handlers checking event.clientX work.
  function dispatchRichClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top  + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true,
      view: window, button: 0,
      clientX: x, clientY: y, screenX: x, screenY: y,
    };
    try {
      el.dispatchEvent(new PointerEvent('pointerover',  { ...base, pointerType: 'mouse' }));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...base, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseover',  base));
    el.dispatchEvent(new MouseEvent('mouseenter', base));
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, buttons: 1, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    try {
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pointerType: 'mouse' }));
    } catch {}
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.click();
  }

  async function startReplay(macro) {
    await chrome.storage.local.set({
      jarvis_replaying: { macroPath: macroKey(macro.url), stepIndex: 0, startedAt: Date.now() }
    });
    await runReplay(macro, 0);
  }

  async function runReplay(macro, fromIndex) {
    isReplaying = true;
    const total = macro.steps.length;
    playText.textContent = `Replaying "${macro.name}"`;
    playProgress.textContent = `${fromIndex} / ${total}`;
    playBanner.classList.add('show');
    screenGlow.classList.add('show');
    let skipped = 0;

    // Persist progress every 5 steps instead of every step (each storage.set is ~5ms)
    let lastPersisted = -1;
    async function persist(i) {
      if (i - lastPersisted < 5 && i !== total - 1) return;
      lastPersisted = i;
      await chrome.storage.local.set({
        jarvis_replaying: { macroPath: macroKey(macro.url), stepIndex: i, startedAt: Date.now() }
      });
    }

    for (let i = fromIndex; i < total; i++) {
      const step = macro.steps[i];
      playProgress.textContent = `${i + 1} / ${total}`;

      if (step.type === 'navigate') {
        if (location.href === step.url) continue;
        await chrome.storage.local.set({
          jarvis_replaying: { macroPath: macroKey(macro.url), stepIndex: i + 1, startedAt: Date.now() }
        });
        location.href = step.url;
        return;  // next page's content script resumes
      }

      const el = await waitForSelector(step.selector);
      if (!el) { skipped++; await persist(i); continue; }
      flashElement(el, '#48bb78');  // fire-and-forget — CSS animates async

      if (step.type === 'click') {
        const urlBefore = location.href;
        dispatchRichClick(el);
        // If the next step is a navigation, give the click's natural nav up to 600ms
        // to fire — otherwise we'd force-redirect and cancel any in-flight load.
        if (macro.steps[i + 1]?.type === 'navigate') {
          const start = Date.now();
          while (Date.now() - start < 600 && location.href === urlBefore) {
            await sleep(30);
          }
        }
      } else if (step.type === 'input') {
        el.focus();
        setNativeValue(el, step.value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (step.type === 'select') {
        el.focus();
        el.value = step.value;
        // Mark matching <option> as selected for completeness
        for (const opt of el.options || []) opt.selected = (opt.value === step.value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (step.type === 'submit') {
        if (typeof el.requestSubmit === 'function') el.requestSubmit();
        else el.submit?.();
      } else if (step.type === 'key') {
        if (el.focus) el.focus();
        const opts = {
          key: step.key, code: step.code,
          ctrlKey: step.ctrl, altKey: step.alt, shiftKey: step.shift, metaKey: step.meta,
          bubbles: true, cancelable: true,
        };
        el.dispatchEvent(new KeyboardEvent('keydown', opts));
        el.dispatchEvent(new KeyboardEvent('keyup',   opts));
      }

      await persist(i);
      await sleep(0);  // single microtask yield — let the page react before the next step
    }

    await chrome.storage.local.remove('jarvis_replaying');
    playBanner.classList.remove('show');
    screenGlow.classList.remove('show');         // ← screen-edge glow off
    isReplaying = false;
    const tail = skipped ? ` (${skipped} skipped — element not found)` : '';
    showToast(`✓ Macro complete — ${total - skipped} / ${total} steps replayed${tail}.`);
  }

  async function resumeReplayIfActive() {
    const { jarvis_replaying } = await chrome.storage.local.get('jarvis_replaying');
    if (!jarvis_replaying) return false;
    if (Date.now() - jarvis_replaying.startedAt > 5 * 60_000) {
      await chrome.storage.local.remove('jarvis_replaying');
      return false;
    }
    const { jarvis_macros = {} } = await chrome.storage.local.get('jarvis_macros');
    const macro = jarvis_macros[jarvis_replaying.macroPath];
    if (!macro) {
      await chrome.storage.local.remove('jarvis_replaying');
      return false;
    }
    // Resume immediately — waitForSelector handles per-step readiness, no need for a fixed wait
    runReplay(macro, jarvis_replaying.stepIndex);
    return true;
  }

  // ── Suggestion ─────────────────────────────────────────────────────────────────
  function showSuggestion(macro) {
    suggest.innerHTML = `
      <div class="suggest-title">⚡ JARVIS · saved macro available</div>
      <div class="suggest-body">"${macro.name}" — ${macro.steps.length} steps. Hotkey: ⌘+⌥+${keyLabel(macro.hotkey)}</div>
      <div class="suggest-actions">
        <button class="sug-btn run">Run macro</button>
        <button class="sug-btn dismiss">Dismiss</button>
        <button class="sug-btn delete">Delete</button>
      </div>
    `;
    suggest.classList.add('show');
    suggest.querySelector('.run').addEventListener('click', () => {
      suggest.classList.remove('show');
      startReplay(macro);
    });
    suggest.querySelector('.dismiss').addEventListener('click', () => suggest.classList.remove('show'));
    suggest.querySelector('.delete').addEventListener('click', async () => {
      const { jarvis_macros = {} } = await chrome.storage.local.get('jarvis_macros');
      delete jarvis_macros[macroKey(macro.url)];
      await chrome.storage.local.set({ jarvis_macros });
      savedMacros = jarvis_macros;
      suggest.classList.remove('show');
      showToast('Macro deleted.');
    });
  }

  async function checkForSuggestion() {
    if (isRecording || isReplaying) return;
    const { jarvis_macros = {} } = await chrome.storage.local.get('jarvis_macros');
    savedMacros = jarvis_macros;
    const macro = savedMacros[macroKey(location.href)];
    if (macro) showSuggestion(macro);
  }

  // ── Hotkey handler ─────────────────────────────────────────────────────────────
  // ⌘+⌥+[ start · ⌘+⌥+<key> save (while recording) or replay (idle) · Esc cancel
  document.addEventListener('keydown', (e) => {
    if (isRecording && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      cancelRecording();
      return;
    }
    const cmd = e.metaKey || e.ctrlKey;
    if (!cmd || !e.altKey || isModifier(e.key)) return;

    const code = e.code;
    if (code === 'BracketLeft' && !isRecording) {
      e.preventDefault(); e.stopPropagation();
      startRecording();
      return;
    }
    if (isRecording && code !== 'BracketLeft') {
      e.preventDefault(); e.stopPropagation();
      stopAndSave(code);
      return;
    }
    const macro = savedMacros[macroKey(location.href)];
    if (macro && macro.hotkey === code) {
      e.preventDefault(); e.stopPropagation();
      startReplay(macro);
    }
  }, true);

  // ── Boot + SPA navigation ──────────────────────────────────────────────────────
  await resumeRecordingIfActive();
  const resumingReplay = await resumeReplayIfActive();
  if (!isRecording && !resumingReplay) setTimeout(checkForSuggestion, 800);

  setInterval(async () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (isRecording) await pushStep({ type: 'navigate', url: location.href, selector: null });
      if (!isRecording && !isReplaying) {
        suggest.classList.remove('show');
        setTimeout(checkForSuggestion, 800);
      }
    }
  }, 2000);
})();
