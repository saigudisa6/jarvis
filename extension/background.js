// ── Config ─────────────────────────────────────────────────────────────────────
// Credentials live in config.js (gitignored). Copy config.example.js → config.js.
// Authorized redirect URI: https://YOUR_EXTENSION_ID.chromiumapp.org/
importScripts('config.js');
const GOOGLE_SCOPES        = [
  'openid',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
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

function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    try { return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/')); } catch {}
  }
  for (const part of payload.parts || []) {
    const t = extractPlainText(part);
    if (t) return t;
  }
  return '';
}

async function fetchEmails(query, maxResults = 10) {
  const token = await getGoogleToken();
  const list  = await gFetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    token
  );
  if (!list.messages) return [];

  return Promise.all(list.messages.map(async m => {
    const msg      = await gFetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
      token
    );
    const headers   = msg.payload?.headers || [];
    const body      = extractPlainText(msg.payload).replace(/\s+/g, ' ').trim().slice(0, 600);
    const fromFull  = headers.find(h => h.name === 'From')?.value || 'Unknown';
    // Extract bare email address so AI doesn't have to parse "Name <email>"
    const emailMatch = fromFull.match(/<([^>]+)>/) || fromFull.match(/(\S+@\S+)/);
    const fromEmail  = emailMatch ? (emailMatch[1] || emailMatch[0]) : '';
    return {
      id:        m.id,
      subject:   headers.find(h => h.name === 'Subject')?.value || 'No subject',
      from:      fromFull,
      fromEmail,
      snippet:   msg.snippet || '',
      body,
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
    ? emails.map(e => `From: ${e.from}\nSenderEmail: ${e.fromEmail}\nSubject: ${e.subject}\nContent: ${e.body || e.snippet}`).join('\n---\n')
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

  return { emailsText, eventsText, emails };
}

// ── Core intelligence ──────────────────────────────────────────────────────────

function localDateISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseTimeStr(str) {
  const m = (str || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const isPM = m[3].toLowerCase() === 'pm';
  if (isPM && h !== 12) h += 12;
  if (!isPM && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

async function analyzePageContext(pageInfo) {
  const { emailsText, eventsText, emails } = await fetchContext();
  const { user_name } = await chrome.storage.local.get('user_name');
  const name = user_name || 'you';

  const isGmail    = pageInfo.url.includes('mail.google.com');
  const isCalendar = pageInfo.url.includes('calendar.google.com');

  // On Gmail/Calendar, always produce a useful briefing — page text is useless (JS-rendered)
  if (isGmail || isCalendar) {
    const today    = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const todayISO = localDateISO();

    // Build reverse lookup: senderEmail → gmail message ID (for stable dedup keys)
    const emailIdByAddress = {};
    for (const e of emails) {
      if (e.fromEmail) emailIdByAddress[e.fromEmail] = e.id;
    }

    // Single combined call — briefing + meeting extraction in one shot
    const combinedSystem = `You are JARVIS, ${name}'s personal AI. Return ONLY a valid JSON object — no text outside it:
{"briefing":"<string>","meetings":[]}

briefing: 2-3 casual sentences to ${name} like a friend texting, no asterisks or bullet points. Mention EVERY email by the sender's first name and what they want.

meetings: for each email that mentions a specific time, add one object:
{"title":"<use Subject line, or Meeting with [sender first name]>","startDate":"${todayISO}","startTime":"HH:MM","durationMinutes":60,"attendeeEmail":"<copy SenderEmail value exactly>"}

CRITICAL:
- Return ONLY the JSON object. First char = { last char = }.
- Today is ${todayISO}. Use this date unless the email names a specific future date.
- Check BOTH Subject AND Content of every email for times.
- 12h → 24h: 4:45am=04:45, 11pm=23:00, 11:45pm=23:45.
- attendeeEmail = copy the SenderEmail field exactly, no changes.`;

    const emailContext = `Today: ${today} (${todayISO})\nEmails TO ${name}:\n${emailsText}\n\nCalendar:\n${eventsText}`;

    const raw = await callASI(combinedSystem, [{ role: 'user', content: emailContext }]);

    // Parse combined response — be forgiving about model formatting
    let text = '';
    let candidates = [];
    const cleanRaw = (raw || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
    try {
      const parsed = JSON.parse(cleanRaw);
      text = parsed.briefing || '';
      if (Array.isArray(parsed.meetings)) candidates = parsed.meetings;
    } catch {
      const objMatch = cleanRaw.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          const parsed = JSON.parse(objMatch[0]);
          text = parsed.briefing || '';
          if (Array.isArray(parsed.meetings)) candidates = parsed.meetings;
        } catch {}
      }
      if (!text) text = raw; // last resort: show raw response
    }

    // Regex fallback — if AI returned [] but emails clearly contain meeting times
    if (!candidates.length) {
      for (const e of emails) {
        const fullText = `${e.subject} ${e.body || e.snippet}`;
        const tMatch   = fullText.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
        if (tMatch && /\b(meet(?:ing)?|call|sync|chat|zoom)\b/i.test(fullText)) {
          const t24 = parseTimeStr(tMatch[1]);
          if (t24) candidates.push({
            title:           e.subject || `Meeting with ${e.from.split(' ')[0]}`,
            startDate:       todayISO,
            startTime:       t24,
            durationMinutes: 60,
            attendeeEmail:   e.fromEmail,
          });
        }
      }
    }

    // Correct any past dates to today
    const todayStr = localDateISO();
    for (const c of candidates) {
      if (c.startDate < todayStr) c.startDate = todayStr;
    }

    // Filter already-handled meetings — key on gmail message ID so same email is never re-asked
    const meetings = [];
    for (const c of candidates) {
      const emailId = emailIdByAddress[c.attendeeEmail] || null;
      const mKey    = emailId
        ? `${emailId}:${c.startDate}:${c.startTime}`
        : (c.attendeeEmail ? `${c.attendeeEmail}:${c.startDate}:${c.startTime}` : `${c.startDate}:${c.startTime}`);
      if (!await isMeetingHandled(mKey)) {
        meetings.push({ ...c, emailId });
      }
    }

    return { text, meetings };
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
    const mKey = meeting.attendeeEmail
      ? `${meeting.attendeeEmail}:${meeting.startDate}:${meeting.startTime}`
      : `${meeting.startDate}:${meeting.startTime}`;
    if (await isMeetingHandled(mKey)) meeting = null;
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

// ── Gmail send ────────────────────────────────────────────────────────────────

async function sendDeclineEmail(toEmail, meeting) {
  if (!toEmail) return;
  // Strip display name if present: "Name <email@x.com>" → "email@x.com"
  const cleanTo = (toEmail.match(/<([^>]+)>/) || toEmail.match(/(\S+@\S+)/))?.[1] || toEmail;
  toEmail = cleanTo;
  const token = await getGoogleToken();
  const { user_name } = await chrome.storage.local.get('user_name');
  const name = user_name || 'me';

  const timeLabel = (() => {
    try {
      return new Date(`${meeting.startDate}T${meeting.startTime}:00`)
        .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return meeting.startTime || 'that time'; }
  })();

  const subject = `Re: ${meeting.title || 'Meeting'}`;
  const body    = `Hey, thanks for reaching out! Unfortunately I won't be able to make it at ${timeLabel}. Hope we can find another time that works!\n\n— ${name}`;

  const raw = [
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n');

  const bytes   = new TextEncoder().encode(raw);
  let binary    = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const res  = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ raw: encoded }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gmail send error');
  return data;
}

// ── Calendar event creation ────────────────────────────────────────────────────

async function createCalendarEvent({ title, startDate, startTime, durationMinutes = 60, attendeeEmail }) {
  const token = await getGoogleToken();
  const tz    = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = new Date(`${startDate}T${startTime}:00`);
  const end   = new Date(start.getTime() + durationMinutes * 60_000);

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

// ── Handled meeting tracking (persisted, survives SW restarts) ────────────────

async function isMeetingHandled(key) {
  const today  = localDateISO();
  const stored = await chrome.storage.local.get(['handledMeetings', 'handledMeetingsDate']);
  // New day → clear stale decisions so fresh meeting requests can surface
  if (stored.handledMeetingsDate !== today) {
    await chrome.storage.local.set({ handledMeetings: [], handledMeetingsDate: today });
    return false;
  }
  return (stored.handledMeetings || []).includes(key);
}

async function markMeetingHandled(key) {
  const today  = localDateISO();
  const stored = await chrome.storage.local.get(['handledMeetings', 'handledMeetingsDate']);
  const list   = stored.handledMeetingsDate === today ? (stored.handledMeetings || []) : [];
  await chrome.storage.local.set({
    handledMeetings:     [...new Set([...list, key])].slice(-100),
    handledMeetingsDate: today,
  });
}

// Check Google Calendar — returns true if an event already exists within 30 min of the proposed time
async function meetingExistsOnCalendar(startDate, startTime) {
  try {
    const token = await getGoogleToken();
    const start = new Date(`${startDate}T${startTime}:00`);
    const lo    = new Date(start.getTime() - 30 * 60_000);
    const hi    = new Date(start.getTime() + 30 * 60_000);
    const data  = await gFetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${lo.toISOString()}&timeMax=${hi.toISOString()}&singleEvents=true`,
      token
    );
    return (data.items || []).length > 0;
  } catch {
    return false;
  }
}

// ── Message listener ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'ANALYZE_PAGE') {
    analyzePageContext(message.context)
      .then(result => {
        if (typeof result === 'string') return sendResponse({ text: result });
        sendResponse({ text: result.text, meetings: result.meetings || [] });
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
    markMeetingHandled(message.key).then(() => sendResponse({}));
    return true;
  }
  if (message.type === 'DECLINE_MEETING') {
    const { key, meeting } = message;
    Promise.all([
      markMeetingHandled(key),
      meeting?.attendeeEmail ? sendDeclineEmail(meeting.attendeeEmail, meeting) : Promise.resolve(),
    ]).then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'CHAT') {
    chatWithJarvis(message.text, message.history || [])
      .then(result => sendResponse({ text: result.text, meetings: result.meeting ? [result.meeting] : [] }))
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
  if (message.type === 'RESTAURANT_SEARCH') {
    handleRestaurantSearch(message.query, message.latitude, message.longitude)
      .then(recommendations => sendResponse({ success: true, recommendations }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  if (message.type === 'GET_EVENTS') {
    getTodayEvents()
      .then(events => sendResponse({ events }))
      .catch(err => sendResponse({ error: err.message, events: [] }));
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

chrome.alarms.create('proactive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'proactive') proactiveCheck();
});
