"""
JARVIS Onboarding Agent — paste this into a new Agentverse hosted agent.

Conducts a natural conversation via ASI:One to collect the user's personality
profile, then saves it to Supabase. Uses the official ACP (Agent Chat Protocol).

Required Secrets (set in Agentverse agent settings):
  - ASI1_API_KEY  (from https://asi1.ai/developer)
  - SUPABASE_URL
  - SUPABASE_KEY
"""

import json
import os
import requests
from datetime import datetime
from uuid import uuid4

from openai import OpenAI
from uagents import Agent, Context, Protocol
from uagents.experimental.chat_agent.protocol import build_llm_message_history
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

agent   = Agent()
protocol = Protocol(spec=chat_protocol_spec)

# ── Secrets ───────────────────────────────────────────────────────────────────
ASI1_API_KEY = os.environ.get("ASI1_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

# ── ASI:One client ────────────────────────────────────────────────────────────
client = OpenAI(
    base_url="https://api.asi1.ai/v1",
    api_key=ASI1_API_KEY,
)

# ── System prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are JARVIS Onboarding — a warm, friendly AI helping users set up their personal profile.

Your goal is to collect this information through natural conversation:
- name
- current_role and career_goals
- skills (list) and skill_gaps (list)
- communication_style (e.g. "direct", "collaborative", "formal")
- work_style (e.g. "independent", "team-oriented")
- values (list, e.g. ["Innovation", "Growth", "Integrity"])
- hobbies (list)
- favorite_cuisines (list) and cuisine_aversions (list)
- dietary_restrictions (list, e.g. ["gluten-free", "vegetarian"] or [])
- price_range ("budget", "moderate", or "upscale")
- meeting_tolerance (max meetings per day, e.g. 3)
- notification_preferences: urgent_only (true/false), real_time (true/false)

Rules:
- Ask 2-3 questions at a time — keep it conversational, not a form
- Make reasonable inferences from natural answers (e.g. "I hate meetings" → meeting_tolerance: 2)
- Confirm assumptions briefly before moving on
- When you have gathered ALL fields, end your reply with exactly this block (no extra text after it):

[PROFILE_COMPLETE]
```json
{
  "name": "...",
  "current_role": "...",
  "career_goals": "...",
  "skills": [],
  "skill_gaps": [],
  "communication_style": "...",
  "work_style": "...",
  "values": [],
  "hobbies": [],
  "favorite_cuisines": [],
  "cuisine_aversions": [],
  "dietary_restrictions": [],
  "price_range": "...",
  "meeting_tolerance": 3,
  "notification_preferences": {"urgent_only": false, "real_time": true}
}
```

Start by greeting the user warmly and asking their name and what they do."""

# ── Helpers ───────────────────────────────────────────────────────────────────

def create_text_chat(text: str, end_session: bool = False) -> ChatMessage:
    content = [TextContent(type="text", text=text)]
    if end_session:
        content.append(EndSessionContent(type="end-session"))
    return ChatMessage(timestamp=datetime.utcnow(), msg_id=uuid4(), content=content)


def save_profile_to_supabase(user_uuid: str, profile: dict) -> bool:
    if not SUPABASE_URL:
        return False
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    payload = {"user_uuid": user_uuid, **profile}
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/user_profiles",
            headers=headers, json=payload, timeout=10
        )
        return resp.status_code in (200, 201)
    except:
        return False

# ── Chat handlers ─────────────────────────────────────────────────────────────

@protocol.on_message(ChatMessage)
async def handle_message(ctx: Context, sender: str, msg: ChatMessage):
    # Acknowledge receipt immediately
    await ctx.send(
        sender,
        ChatAcknowledgement(timestamp=datetime.utcnow(), acknowledged_msg_id=msg.msg_id),
    )

    # Already onboarded?
    if ctx.storage.get(f"done_{sender}"):
        await ctx.send(sender, create_text_chat(
            "✅ Your profile is already set up! You can start using JARVIS.",
            end_session=True
        ))
        return

    text = msg.text()

    # Session just started — no user text yet. Send the opening prompt proactively.
    if not text:
        opening = (
            "👋 Hi! I'm JARVIS Onboarding. I'll help set up your personal profile so JARVIS "
            "can tailor briefings, email alerts, and recommendations just for you.\n\n"
            "Let's start with the basics:\n"
            "1. What's your name?\n"
            "2. What's your current role / what do you do?\n"
            "3. What are your main career goals?"
        )
        await ctx.send(sender, create_text_chat(opening))
        return

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        *build_llm_message_history(ctx),
    ]

    try:
        r = client.chat.completions.create(
            model="asi1",
            messages=messages,
            max_tokens=800,
        )
        response = str(r.choices[0].message.content)
    except Exception as e:
        ctx.logger.exception("Error querying ASI:One")
        response = f"Sorry, I hit an error: {e}"
        await ctx.send(sender, create_text_chat(response))
        return

    # Check if the profile interview is complete
    if "[PROFILE_COMPLETE]" in response:
        try:
            json_start = response.find("```json") + 7
            json_end   = response.find("```", json_start)
            profile    = json.loads(response[json_start:json_end].strip())

            display = response[:response.find("[PROFILE_COMPLETE]")].strip()
            display += "\n\n✅ **Profile saved!** JARVIS is now personalised for you."

            saved = save_profile_to_supabase(sender, profile)
            if saved:
                ctx.logger.info(f"Profile saved to Supabase for {sender[:16]}")
            else:
                ctx.logger.warning(f"Supabase save failed for {sender[:16]}")
                display += "\n⚠️ (Database save failed — check Supabase secrets)"

            ctx.storage.set(f"done_{sender}", "true")
            await ctx.send(sender, create_text_chat(display, end_session=True))
        except Exception as e:
            ctx.logger.error(f"Profile parse error: {e}")
            await ctx.send(sender, create_text_chat(response))
    else:
        await ctx.send(sender, create_text_chat(response))


@protocol.on_message(ChatAcknowledgement)
async def handle_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    pass  # acknowledgements are handled automatically


agent.include(protocol, publish_manifest=True)
