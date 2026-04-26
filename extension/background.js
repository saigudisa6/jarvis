// ── Config ─────────────────────────────────────────────────────────────────────
// Fill these in from Google Cloud Console → Credentials → Web application
// Authorized redirect URI: https://YOUR_EXTENSION_ID.chromiumapp.org/
const GOOGLE_CLIENT_ID     = 'YOUR_GOOGLE_CLIENT_ID';
const GOOGLE_CLIENT_SECRET = 'YOUR_GOOGLE_CLIENT_SECRET';
const GOOGLE_SCOPES        = [
  'openid',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

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

  // Fetch and cache user's real name for prompts
  try {
    const profile = await fetch('https://www.googleapis.com/userinfo/v2/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }).then(r => r.json());
    if (profile.given_name) await chrome.storage.local.set({ user_name: profile.given_name });
  } catch {}

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

async function fetchEmails(query, maxResults = 10) {
  const token = await getGoogleToken();
  const list  = await gFetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
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
      id:      m.id,
      subject: headers.find(h => h.name === 'Subject')?.value || 'No subject',
      from:    headers.find(h => h.name === 'From')?.value    || 'Unknown',
      snippet: msg.snippet || '',
    };
  }));
}

// For briefing context: recent emails (read OR unread) so nothing slips through
async function getRecentEmails(maxResults = 10) {
  return fetchEmails('newer_than:2d -category:promotions -category:updates', maxResults);
}

// For proactive triage: only unread
async function getUnreadEmails(maxResults = 15) {
  return fetchEmails('is:unread newer_than:1d', maxResults);
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

async function getUpcomingEvents(days = 14) {
  const token = await getGoogleToken();
  const now   = new Date();
  const end   = new Date(now);
  end.setDate(end.getDate() + days);
  const data  = await gFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=30`,
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

async function fetchContext({ upcoming = false } = {}) {
  const [emailRes, eventRes] = await Promise.allSettled([
    getRecentEmails(),
    upcoming ? getUpcomingEvents() : getTodayEvents(),
  ]);
  const emails = emailRes.status === 'fulfilled' ? emailRes.value : [];
  const events = eventRes.status === 'fulfilled' ? eventRes.value : [];

  const emailsText = emails.length
    ? emails.map(e => `From: ${e.from}\nSubject: ${e.subject}\nPreview: ${e.snippet}`).join('\n---\n')
    : 'Inbox is clear.';

  const eventsText = events.length
    ? events.map(e => {
        const d    = new Date(e.start);
        const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const soon = !upcoming && minutesUntil(e.start) > 0 && minutesUntil(e.start) < 60
          ? ` (in ${Math.round(minutesUntil(e.start))} min)` : '';
        return upcoming ? `${date} ${time}: ${e.title}` : `${time}: ${e.title}${soon}`;
      }).join('\n')
    : upcoming ? 'No events in the next 14 days.' : 'Nothing on the calendar today.';

  return { emailsText, eventsText };
}

// ── Core intelligence ──────────────────────────────────────────────────────────

function localDateISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function analyzePageContext(pageInfo) {
  const { emailsText, eventsText } = await fetchContext();
  const { user_name } = await chrome.storage.local.get('user_name');
  const name = user_name || 'you';

  const isGmail    = pageInfo.url.includes('mail.google.com');
  const isCalendar = pageInfo.url.includes('calendar.google.com');

  // On Gmail/Calendar, always produce a useful briefing — page text is useless (JS-rendered)
  if (isGmail || isCalendar) {
    const today    = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const todayISO = localDateISO();

    const briefingSystem = `You are JARVIS, ${name}'s personal AI. Casual, like a friend texting. No asterisks, no bullet points. Talking TO ${name}. 1-2 sentences about who emailed and what they said. Use ONLY words from the email text — do not reword, do not mention the calendar, do not invent anything.`;

    const extractSystem = `Does any email below explicitly ask to meet at a specific time (e.g. "at 8pm", "3pm tomorrow")? If yes, respond with ONLY this JSON and nothing else:
{"title":"<short title>","startDate":"${todayISO}","startTime":"HH:MM","durationMinutes":60,"attendeeEmail":"<sender email>"}
If no explicit time exists, respond with exactly: null`;

    const emailContext = `Today: ${today} (${todayISO})\nEmails TO ${name}:\n${emailsText}`;

    const [text, meetingRaw] = await Promise.all([
      callASI(briefingSystem, [{ role: 'user', content: `${emailContext}\n\nCalendar:\n${eventsText}` }]),
      callASI(extractSystem,  [{ role: 'user', content: emailContext }]),
    ]);

    let meeting = null;
    const trimmed = (meetingRaw || '').trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    if (trimmed && trimmed !== 'null') {
      try { meeting = JSON.parse(trimmed); } catch {
        const m = trimmed.match(/\{[\s\S]*\}/);
        if (m) { try { meeting = JSON.parse(m[0]); } catch {} }
      }
    }

    if (meeting) {
      const mKey = `${meeting.startDate}:${meeting.startTime}`;
      if (handledMeetingKeys.has(mKey)) meeting = null;
    }

    return { text, meeting };
  }

  const system = `You are JARVIS, ${name}'s personal AI. Casual, sharp, like a friend texting. No asterisks, no bullet points. You are talking TO ${name}.

Quick heads-up on what's relevant from their inbox/calendar. 1-2 sentences. If nothing useful, reply with just: clear`;

  const userMsg = `Page: ${pageInfo.title} (${pageInfo.url})
${pageInfo.text.slice(0, 500)}

${name}'s calendar today:
${eventsText}

Emails sent to ${name}:
${emailsText}`;

  return callASI(system, [{ role: 'user', content: userMsg }]);
}

async function chatWithJarvis(userText, history) {
  const [{ emailsText, eventsText }, { user_name }] = await Promise.all([
    fetchContext({ upcoming: true }),
    chrome.storage.local.get('user_name'),
  ]);
  const name     = user_name || 'you';
  const todayISO = localDateISO();
  const today    = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const system = `You are JARVIS, ${name}'s personal AI — casual, sharp, zero fluff. Friend texting, not a chatbot. No asterisks, no bullet points, no "Certainly!". Today is ${today} (${todayISO}).

Always respond with JSON:
{"text": "<your reply>", "meeting": null}

If ${name} asks to add a meeting to their calendar AND the context has a specific time, set "meeting":
{"title": "<short title>", "startDate": "YYYY-MM-DD", "startTime": "HH:MM", "durationMinutes": 60, "attendeeEmail": "<email if known>"}

RULES:
- Calendar events below are VERBATIM from Google Calendar. Quote them exactly — never paraphrase or rename them.
- Email content is what OTHER people sent TO ${name}. Never confuse senders with calendar events.
- Only invent nothing. Answer only from the data provided.

Emails TO ${name}:
${emailsText}

${name}'s upcoming calendar (next 14 days):
${eventsText}`;

  const raw    = await callASI(system, [...history, { role: 'user', content: userText }]);
  const parsed = parseMeetingJSON(raw);

  let meeting = parsed.meeting || null;
  if (meeting) {
    const mKey = `${meeting.startDate}:${meeting.startTime}`;
    if (handledMeetingKeys.has(mKey)) meeting = null;
  }

  return { text: parsed.text || raw, meeting };
}

// ── Notifications ──────────────────────────────────────────────────────────────

const ICON         = 'icons/icon48.png';
const notifiedKeys = new Set();

function osNotify(title, message) {
  chrome.notifications.create(`jarvis-${Date.now()}`, {
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

// ── New email triage via AI ────────────────────────────────────────────────────

async function checkNewEmails() {
  let emails;
  try { emails = await getUnreadEmails(15); } catch { return; }

  const { seenEmailIds = [] } = await chrome.storage.local.get('seenEmailIds');
  const seenSet  = new Set(seenEmailIds);
  const newEmails = emails.filter(e => !seenSet.has(e.id));

  if (!newEmails.length) return;

  // Persist seen IDs immediately so parallel checks don't double-notify
  await chrome.storage.local.set({
    seenEmailIds: [...seenSet, ...newEmails.map(e => e.id)].slice(-500),
  });

  // Ask AI whether each new email needs attention
  for (const email of newEmails.slice(0, 5)) {
    const verdict = await callASI(
      'You are a fast email triage assistant. Reply with only YES or NO. Say YES for: anything from a real person (not automated/marketing), meeting requests, questions, plans, anything needing a reply. Say NO only for newsletters, receipts, automated notifications.',
      [{ role: 'user', content: `From: ${email.from}\nSubject: ${email.subject}\nPreview: ${email.snippet}` }]
    ).catch(() => 'YES');  // default to YES if AI fails — never miss an email

    if (verdict.trim().toUpperCase().startsWith('YES')) {
      const msg = `From ${email.from.split('<')[0].trim()}: "${email.subject}"`;
      osNotify('New email', msg);
      await pushToTab(msg);
    }
  }
}

// ── Upcoming meeting check ─────────────────────────────────────────────────────

async function checkMeetings() {
  let events;
  try { events = await getTodayEvents(); } catch { return; }

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
}

// ── Proactive alarm (runs every minute) ───────────────────────────────────────

async function proactiveCheck() {
  const { asi_key } = await chrome.storage.sync.get('asi_key');
  if (!asi_key) return;
  await Promise.allSettled([checkNewEmails(), checkMeetings()]);
}

// ── Calendar event creation ────────────────────────────────────────────────────

async function createCalendarEvent({ title, startDate, startTime, durationMinutes = 60, attendeeEmail }) {
  const token = await getGoogleToken();
  const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let start   = new Date(`${startDate}T${startTime}:00`);

  // Only bump if the event is more than 20 hours in the past (clearly stale date from old email)
  if (start < new Date(Date.now() - 20 * 60 * 60 * 1000)) {
    start.setDate(start.getDate() + 1);
  }

  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const event = {
    summary: title,
    start: { dateTime: start.toISOString(), timeZone: tz },
    end:   { dateTime: end.toISOString(),   timeZone: tz },
  };
  if (attendeeEmail) event.attendees = [{ email: attendeeEmail }];

  const res  = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(event),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Calendar error');
  return data;
}

// ── Parse AI meeting JSON ──────────────────────────────────────────────────────

function parseMeetingJSON(raw) {
  let text = (raw || '').trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { text: raw, meeting: null };
}

// ── Handled meeting tracking (session-scoped, prevents re-prompting) ───────────

const handledMeetingKeys = new Set();

// ── Message listener ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANALYZE_PAGE') {
    analyzePageContext(message.context)
      .then(result => {
        if (typeof result === 'string') return sendResponse({ text: result });
        sendResponse({ text: result.text, meeting: result.meeting });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'CREATE_EVENT') {
    createCalendarEvent(message.event)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'MEETING_HANDLED') {
    handledMeetingKeys.add(message.key);
    sendResponse({});
    return true;
  }
  if (message.type === 'CHAT') {
    chatWithJarvis(message.text, message.history || [])
      .then(result => sendResponse({ text: result.text, meeting: result.meeting }))
      .catch(err   => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'AUTH') {
    // Always clear stored tokens so we get fresh OAuth with current scopes
    chrome.storage.local.remove(['g_access_token', 'g_refresh_token', 'g_expiry'], () => {
      getGoogleToken(true)
        .then(()  => sendResponse({ success: true }))
        .catch(err => sendResponse({ error: err.message }));
    });
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
});

// ── Alarms ─────────────────────────────────────────────────────────────────────

// On startup, wipe seen list so any existing unread emails get a fresh triage pass
chrome.storage.local.remove('seenEmailIds');

chrome.alarms.create('proactive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'proactive') proactiveCheck();
});
