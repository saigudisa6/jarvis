// ── Config ─────────────────────────────────────────────────────────────────────
// Fill these in from Google Cloud Console → Credentials → Web application
// Authorized redirect URI: https://YOUR_EXTENSION_ID.chromiumapp.org/
const GOOGLE_CLIENT_ID     = 'YOUR_GOOGLE_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = 'YOUR_GOOGLE_CLIENT_SECRET';
const GOOGLE_SCOPES        = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

// Local Jarvis Agent Configuration
const LOCAL_ORCHESTRATOR_URL = 'http://localhost:8000/submit';
const LOCAL_RESTAURANT_AGENT_URL = 'http://localhost:8001/submit';
const JARVIS_BRIDGE_URL = 'http://127.0.0.1:9000/restaurant-search';
const DEFAULT_USER_ID = 'extension_user';

// ── Google OAuth ───────────────────────────────────────────────────────────────

async function getGoogleToken(interactive = false) {
  const stored = await chrome.storage.local.get(['g_access_token', 'g_expiry', 'g_refresh_token']);
  if (stored.g_access_token && Date.now() < (stored.g_expiry - 60_000)) {
    return stored.g_access_token;
  }
  if (stored.g_refresh_token) {
    return refreshGoogleToken(stored.g_refresh_token);
  }
  if (!interactive) throw new Error('not_authed');
  return launchGoogleOAuth();
}

async function refreshGoogleToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  const tokens = await res.json();
  await chrome.storage.local.set({
    g_access_token: tokens.access_token,
    g_expiry:       Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
}

async function launchGoogleOAuth() {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const verifier    = generateVerifier();
  const challenge   = await generateChallenge(verifier);

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',             GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri',          redirectUri);
  authUrl.searchParams.set('response_type',         'code');
  authUrl.searchParams.set('scope',                 GOOGLE_SCOPES);
  authUrl.searchParams.set('access_type',           'offline');
  authUrl.searchParams.set('prompt',                'consent');
  authUrl.searchParams.set('code_challenge',        challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const redirectUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, url => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(url);
    });
  });

  const code = new URL(redirectUrl).searchParams.get('code');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  await chrome.storage.local.set({
    g_access_token:  tokens.access_token,
    g_refresh_token: tokens.refresh_token,
    g_expiry:        Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
}

function generateVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function generateChallenge(verifier) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Gmail ──────────────────────────────────────────────────────────────────────

async function getUnreadEmails(maxResults = 8) {
  const token = await getGoogleToken();
  const list  = await gFetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread+newer_than:1d&maxResults=${maxResults}`,
    token
  );
  if (!list.messages) return [];

  return Promise.all(list.messages.map(async m => {
    const msg     = await gFetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      token
    );
    const headers = msg.payload?.headers || [];
    return {
      subject: headers.find(h => h.name === 'Subject')?.value || 'No subject',
      from:    headers.find(h => h.name === 'From')?.value    || 'Unknown',
      snippet: msg.snippet || '',
    };
  }));
}

// ── Calendar ───────────────────────────────────────────────────────────────────

async function getTodayEvents() {
  const token  = await getGoogleToken();
  const now    = new Date();
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59);
  const data   = await gFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${dayEnd.toISOString()}&singleEvents=true&orderBy=startTime`,
    token
  );
  return (data.items || []).map(e => ({
    title:     e.summary || 'Untitled',
    start:     e.start?.dateTime || e.start?.date || '',
    attendees: (e.attendees || []).filter(a => !a.self).map(a => a.email),
  }));
}

function minutesUntil(iso) { return (new Date(iso) - Date.now()) / 60_000; }

async function gFetch(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

// ── ASI:One ────────────────────────────────────────────────────────────────────

async function callASI(system, messages) {
  const { asi_key } = await chrome.storage.sync.get('asi_key');
  if (!asi_key) throw new Error('no_key');

  const res = await fetch('https://api.asi1.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${asi_key}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:    'asi1-mini',
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'ASI:One error');
  return data.choices?.[0]?.message?.content || '';
}

// ── Context builders ───────────────────────────────────────────────────────────

async function fetchContext() {
  const [emailRes, eventRes] = await Promise.allSettled([getUnreadEmails(), getTodayEvents()]);
  const emails = emailRes.status  === 'fulfilled' ? emailRes.value  : [];
  const events = eventRes.status  === 'fulfilled' ? eventRes.value  : [];

  const emailsText = emails.length
    ? emails.map(e => `• From: ${e.from}\n  Subject: ${e.subject}\n  Preview: ${e.snippet}`).join('\n')
    : 'No unread emails today.';

  const eventsText = events.length
    ? events.map(e => {
        const t    = new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const soon = minutesUntil(e.start) > 0 && minutesUntil(e.start) < 60
          ? ` ⚡ in ${Math.round(minutesUntil(e.start))} min` : '';
        return `• ${t}: ${e.title}${soon}`;
      }).join('\n')
    : 'No more events today.';

  return { emailsText, eventsText };
}

// ── Core intelligence ──────────────────────────────────────────────────────────

async function analyzePageContext(pageInfo) {
  const { emailsText, eventsText } = await fetchContext();

  const system = `You are JARVIS, the user's personal AI assistant living in their browser. Every time they navigate to a page, give them a genuinely useful briefing. Cover all of these that apply:

- What's coming up on their calendar today (next 2-3 events with times)
- Any unread emails worth knowing about (urgent, from important people, needing a reply)
- If the current page relates to something in their inbox or calendar, call it out specifically
- A quick tip, reminder, or piece of advice relevant to what they're doing or their day

Be like a smart assistant who actually knows their schedule. Conversational but concise — 3-5 sentences max. Don't just list events robotically, actually give context and advice. Only respond with "clear" if there is literally nothing in the inbox, no events, and the page has no interesting context.`;

  const userMsg = `Current page: ${pageInfo.title} (${pageInfo.url})
Page content: ${pageInfo.text.slice(0, 600)}

TODAY'S REMAINING CALENDAR:
${eventsText}

UNREAD EMAILS:
${emailsText}

Give the user their briefing.`;

  return callASI(system, [{ role: 'user', content: userMsg }]);
}

async function chatWithJarvis(userText, history) {
  const { emailsText, eventsText } = await fetchContext();

  const system = `You are JARVIS, a smart personal AI assistant embedded in the user's browser. You can help with absolutely anything — answering questions, writing, coding, brainstorming, math, advice, analysis, or just chatting. You also have access to the user's Gmail and Google Calendar, so you can answer questions about their schedule and inbox too. Be concise, direct, and genuinely helpful. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

INBOX (unread, last 24h):
${emailsText}

TODAY'S CALENDAR:
${eventsText}`;

  return callASI(system, [...history, { role: 'user', content: userText }]);
}

// ── Notifications ──────────────────────────────────────────────────────────────

const ICON = 'icons/icon48.png';
const notifiedKeys = new Set();  // prevent duplicate alerts within a session

function osNotify(title, message) {
  chrome.notifications.create({
    type:     'basic',
    iconUrl:  ICON,
    title:    `⚡ JARVIS — ${title}`,
    message,
    priority: 2,
  });
}

async function pushToTab(text) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const tab of tabs) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'PROACTIVE_ALERT', text }); } catch {}
  }
}

// ── Proactive alarm ────────────────────────────────────────────────────────────

async function proactiveCheck() {
  const { asi_key } = await chrome.storage.sync.get('asi_key');
  if (!asi_key) return;

  let emails, events;
  try {
    [emails, events] = await Promise.all([getUnreadEmails(), getTodayEvents()]);
  } catch { return; }

  // Upcoming meetings (10–20 min window)
  for (const e of events) {
    const m   = minutesUntil(e.start);
    const key = `meeting:${e.title}:${e.start}`;
    if (m >= 10 && m <= 20 && !notifiedKeys.has(key)) {
      notifiedKeys.add(key);
      const msg = `"${e.title}" starts in ${Math.round(m)} minutes.`;
      osNotify('Meeting soon', msg);
      await pushToTab(msg);
    }
  }

  // Urgent emails
  for (const e of emails) {
    const key = `email:${e.subject}:${e.from}`;
    if (/urgent|asap|deadline|invoice|action required/i.test(e.subject + e.snippet) && !notifiedKeys.has(key)) {
      notifiedKeys.add(key);
      const msg = `From ${e.from}: "${e.subject}"`;
      osNotify('Urgent email', msg);
      await pushToTab(msg);
      break;  // one urgent email alert at a time
    }
  }
}

// ── Message listener ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANALYZE_PAGE') {
    analyzePageContext(message.context)
      .then(text => sendResponse({ text }))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'CHAT') {
    chatWithJarvis(message.text, message.history || [])
      .then(text => sendResponse({ text }))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'AUTH') {
    getGoogleToken(true)
      .then(()  => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_STATUS') {
    Promise.all([
      chrome.storage.sync.get('asi_key'),
      chrome.storage.local.get(['g_access_token', 'g_expiry']),
    ]).then(([{ asi_key }, s]) => {
      sendResponse({
        ready:  !!asi_key,
        authed: !!(s.g_access_token && Date.now() < s.g_expiry),
      });
    });
    return true;
  }
  if (message.type === 'RESTAURANT_SEARCH') {
    handleRestaurantSearch(message.query, message.latitude, message.longitude)
      .then(recommendations => sendResponse({ success: true, recommendations }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ── Restaurant Search Handler ──────────────────────────────────────────────────

async function handleRestaurantSearch(searchQuery, latitude, longitude) {
  console.log(`\n🍽️ [JARVIS Restaurant Agent] Processing search: "${searchQuery}"`);

  try {
    const request = {
      query: searchQuery,
      user_id: DEFAULT_USER_ID,
    };
    if (latitude != null && longitude != null) {
      request.latitude  = latitude;
      request.longitude = longitude;
    }
    
    console.log(`📡 Connecting to Jarvis Bridge server...`);
    
    // Send request to bridge server
    const response = await fetch(JARVIS_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    
    if (!response.ok) {
      throw new Error(`Bridge server responded with status ${response.status}`);
    }
    
    const recommendations = await response.json();
    
    // Log results to console/terminal
    if (recommendations.success) {
      console.log(`✅ Found ${recommendations.restaurants.length} restaurant recommendations:\n`);
      
      recommendations.restaurants.forEach((rest, i) => {
        console.log(`  ${i + 1}. ${rest.name}`);
        console.log(`     ⭐ Rating: ${rest.rating}★ | 💰 Price Level: ${rest.price_level}/4 | 📊 Score: ${rest.score?.toFixed(2) || 'N/A'}`);
        console.log(`     📍 ${rest.address}`);
        if (rest.website) console.log(`     🌐 ${rest.website}`);
        console.log();
      });
      
      console.log(`Message: ${recommendations.message}\n`);
    } else {
      console.error(`❌ Failed to get recommendations: ${recommendations.error}`);
    }
    
    return recommendations;
    
  } catch (error) {
    console.error(`❌ [JARVIS] Restaurant search error: ${error.message}`);
    console.log('💡 Tip: Make sure the Jarvis Bridge server is running on port 9000');
    console.log('   Run: python extension_bridge.py');
    throw error;
  }
}

// ── Alarms ─────────────────────────────────────────────────────────────────────

chrome.alarms.create('proactive', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'proactive') proactiveCheck();
});
