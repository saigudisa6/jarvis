import os
import requests
import json
from uagents import Agent, Context, Model

agent = Agent()

# ── Configuration (Add these as SECRETS in Agentverse) ──────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
ASI1_API_KEY = os.environ.get("ASI1_API_KEY", "")

# ── Models ──────────────────────────────────────────────────────────────────

class MorningBriefingReq(Model):
    user_uuid: str
    request_id: str
    events_text: str
    emails_text: str

class MorningBriefingRes(Model):
    request_id: str
    briefing: str

class EmailAnalysisReq(Model):
    user_uuid: str
    request_id: str
    emails: list

class EmailAnalysisRes(Model):
    request_id: str
    alerts: list

# ── Helpers (MUST BE DEFINED ABOVE THE HANDLER) ─────────────────────────────

def fetch_user_profile(user_uuid: str) -> dict:
    if not SUPABASE_URL: return {}
    url = f"{SUPABASE_URL}/rest/v1/user_profiles?user_uuid=eq.{user_uuid}&select=*"
    headers = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    try:
        resp = requests.get(url, headers=headers, timeout=10)
        data = resp.json()
        return data[0] if (data and len(data) > 0) else {}
    except: return {}

def build_personality_context(profile: dict) -> str:
    if not profile:
        return "Professional, direct, and concise."
    parts = []
    if profile.get("name"):           parts.append(f"User: {profile['name']}.")
    if profile.get("communication_style"): parts.append(f"Communication style: {profile['communication_style']}.")
    if profile.get("work_style"):     parts.append(f"Work style: {profile['work_style']}.")
    if profile.get("career_goals"):   parts.append(f"Career goal: {profile['career_goals']}.")
    if profile.get("values"):         parts.append(f"Core values: {', '.join(profile['values'])}.")
    if profile.get("meeting_tolerance") is not None:
        parts.append(f"Meeting tolerance: {profile['meeting_tolerance']} meetings/day max.")
    return " ".join(parts) if parts else "Professional, direct, and concise."

def call_asi1(system: str, prompt: str, max_tokens: int = 800) -> str:
    if not ASI1_API_KEY:
        return "JARVIS brain offline — ASI1_API_KEY not set."
    headers = {
        "Authorization": "Bearer " + ASI1_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "model": "asi1-mini",
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": prompt},
        ],
    }
    try:
        resp = requests.post(
            "https://api.asi1.ai/v1/chat/completions",
            headers=headers, json=payload, timeout=25
        )
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"Error connecting to JARVIS brain: {e}"

# ── Handlers ─────────────────────────────────────────────────────────────────

@agent.on_message(model=MorningBriefingReq)
async def handle_morning_briefing(ctx: Context, sender: str, msg: MorningBriefingReq):
    ctx.logger.info(f"Processing briefing: {msg.request_id}")

    profile     = fetch_user_profile(msg.user_uuid)
    personality = build_personality_context(profile)

    system = (
        f"You are JARVIS, a sharp personal AI assistant. "
        f"Personality context: {personality} "
        f"Be concise — under 220 words total."
    )
    prompt = (
        f"Generate a morning briefing with three sections:\n"
        f"1. Meetings & Events — list today's events with times\n"
        f"2. Inbox Highlights — flag emails needing action\n"
        f"3. Top Priorities — 2-3 concrete action items\n\n"
        f"TODAY'S CALENDAR:\n{msg.events_text}\n\n"
        f"RECENT EMAILS:\n{msg.emails_text}"
    )

    result = call_asi1(system, prompt)

    await ctx.send(sender, MorningBriefingRes(
        request_id=msg.request_id,
        briefing=result
    ))

@agent.on_message(model=EmailAnalysisReq)
async def handle_email_analysis(ctx: Context, sender: str, msg: EmailAnalysisReq):
    ctx.logger.info(f"Analyzing {len(msg.emails)} emails for {sender[:16]}")

    profile     = fetch_user_profile(msg.user_uuid)
    personality = build_personality_context(profile)

    emails_text = "\n\n".join(
        f"From: {e.get('sender', '?')}\nSubject: {e.get('subject', '?')}\nPreview: {e.get('preview', '')}"
        for e in msg.emails
    )
    system = (
        f"You are JARVIS. {personality} "
        f"Identify only emails that genuinely need action or are time-sensitive. "
        f"Return a JSON array of objects with keys: subject, body (one-line action suggestion). "
        f"If nothing needs action, return []."
    )
    prompt = f"Analyze these emails and flag anything requiring attention:\n\n{emails_text}"

    raw = call_asi1(system, prompt, max_tokens=400)

    try:
        start  = raw.find("[")
        end    = raw.rfind("]") + 1
        alerts = json.loads(raw[start:end]) if start != -1 else []
    except Exception:
        alerts = []

    await ctx.send(sender, EmailAnalysisRes(
        request_id=msg.request_id,
        alerts=alerts
    ))
