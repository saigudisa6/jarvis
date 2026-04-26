import base64
import json
import os
from datetime import datetime

from anthropic import Anthropic
from uagents import Agent, Context

from calendar_auth import get_todays_events
from gmail_auth import get_gmail_service
from notifications import notify
from proactive import check_meeting_reminders, check_back_to_back, check_follow_ups, check_eod_summary

AGENTVERSE_API_KEY = os.getenv("AGENTVERSE_API_KEY", "")

KEYWORDS = ["schedule", "meeting", "urgent", "invoice", "deadline"]

SEEN_IDS_FILE = "seen_ids.json"
BRIEFING_STATE_FILE = "briefing_state.json"

anthropic_client = Anthropic()


# ── Persistence helpers ────────────────────────────────────────────────────────

def load_seen_ids():
    if os.path.exists(SEEN_IDS_FILE):
        with open(SEEN_IDS_FILE) as f:
            return set(json.load(f))
    return set()


def save_seen_ids(ids):
    with open(SEEN_IDS_FILE, 'w') as f:
        json.dump(list(ids), f)


def briefing_sent_today():
    today = datetime.now().strftime('%Y-%m-%d')
    if os.path.exists(BRIEFING_STATE_FILE):
        with open(BRIEFING_STATE_FILE) as f:
            return json.load(f).get('last_sent') == today
    return False


def mark_briefing_sent():
    with open(BRIEFING_STATE_FILE, 'w') as f:
        json.dump({'last_sent': datetime.now().strftime('%Y-%m-%d')}, f)


# ── Gmail helpers ──────────────────────────────────────────────────────────────

def get_email_body(msg):
    payload = msg['payload']
    if 'parts' in payload:
        for part in payload['parts']:
            if part['mimeType'] == 'text/plain':
                data = part['body'].get('data', '')
                return base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
    data = payload.get('body', {}).get('data', '')
    return base64.urlsafe_b64decode(data).decode('utf-8', errors='replace') if data else ''


def check_keywords(text, keywords):
    lower = text.lower()
    return [kw for kw in keywords if kw in lower]


def get_recent_emails(query='is:unread newer_than:1d', max_results=15):
    service = get_gmail_service()
    result = service.users().messages().list(
        userId='me', q=query, maxResults=max_results
    ).execute()

    emails = []
    for message in result.get('messages', []):
        msg = service.users().messages().get(
            userId='me', id=message['id'], format='full'
        ).execute()
        headers = msg['payload']['headers']
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        sender  = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
        body    = get_email_body(msg)
        emails.append({'subject': subject, 'sender': sender, 'preview': body[:400]})
    return emails


# ── Morning briefing ───────────────────────────────────────────────────────────

def generate_morning_briefing():
    events = get_todays_events()
    emails = get_recent_emails()

    if events:
        events_text = "\n".join(
            f"  {e['start']}: {e['title']}"
            + (f" (with {', '.join(e['attendees'])})" if e['attendees'] else "")
            for e in events
        )
    else:
        events_text = "  No events scheduled today."

    if emails:
        emails_text = "\n\n".join(
            f"  From: {e['sender']}\n  Subject: {e['subject']}\n  Preview: {e['preview']}"
            for e in emails
        )
    else:
        emails_text = "  No unread emails in the last 24 hours."

    response = anthropic_client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=600,
        messages=[{
            "role": "user",
            "content": f"""You are JARVIS, a personal AI assistant. Generate a concise morning briefing.

TODAY'S CALENDAR:
{events_text}

RECENT UNREAD EMAILS:
{emails_text}

Produce a morning briefing with three short sections:
1. Meetings & Events — list today's events with times
2. Inbox Highlights — flag emails that need a reply or action
3. Top Priorities — 2-3 concrete action items for the day

Be direct and specific. Keep the whole briefing under 220 words."""
        }]
    )
    return response.content[0].text


# ── Agent ──────────────────────────────────────────────────────────────────────

agent = Agent(
    name="jarvis",
    seed="win_lahacks_2026",
    port=8000,
    endpoint=["http://localhost:8000/submit"],
    agentverse=f"{AGENTVERSE_API_KEY}@https://agentverse.ai" if AGENTVERSE_API_KEY else None,
    mailbox=bool(AGENTVERSE_API_KEY),
)

from chat_protocol import chat_proto
agent.include(chat_proto, publish_manifest=True)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"JARVIS started. Address: {agent.address}")
    ctx.logger.info(f"Agentverse mailbox: {'enabled' if AGENTVERSE_API_KEY else 'disabled — set AGENTVERSE_API_KEY'}")
    ctx.logger.info("Monitoring Gmail and Calendar...")


@agent.on_interval(period=60.0)
async def check_emails(ctx: Context):
    ctx.logger.info("Checking emails...")
    try:
        service  = get_gmail_service()
        seen_ids = load_seen_ids()

        result   = service.users().messages().list(
            userId='me', q='is:unread', maxResults=10
        ).execute()
        messages = result.get('messages', [])
        new_seen = set()

        for message in messages:
            msg_id = message['id']
            new_seen.add(msg_id)
            if msg_id in seen_ids:
                continue

            msg     = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
            headers = msg['payload']['headers']
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
            sender  = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
            body    = get_email_body(msg)
            matched = check_keywords(subject + " " + body, KEYWORDS)

            if matched:
                ctx.logger.info(f"[EMAIL] keyword={matched} | from={sender} | subject={subject}")
                notify(f"Urgent email: {subject}", f"From: {sender} | Keywords: {', '.join(matched)}")

        save_seen_ids(seen_ids | new_seen)
    except Exception as e:
        ctx.logger.error(f"Email check failed: {e}")


@agent.on_interval(period=300.0)  # poll every 5 min so we catch the 8am window
async def morning_briefing_check(ctx: Context):
    now = datetime.now()
    if now.hour == 8 and not briefing_sent_today():
        ctx.logger.info("Generating morning briefing...")
        try:
            briefing = generate_morning_briefing()
            mark_briefing_sent()
            notify("JARVIS Morning Briefing", briefing)
            ctx.logger.info("\n=== JARVIS MORNING BRIEFING ===\n" + briefing + "\n===============================")
        except Exception as e:
            ctx.logger.error(f"Morning briefing failed: {e}")


@agent.on_interval(period=60.0)
async def proactive_calendar_checks(ctx: Context):
    try:
        check_meeting_reminders()
        check_back_to_back()
    except Exception as e:
        ctx.logger.error(f"Proactive calendar check failed: {e}")


@agent.on_interval(period=300.0)
async def proactive_daily_checks(ctx: Context):
    try:
        check_eod_summary()
        check_follow_ups()
    except Exception as e:
        ctx.logger.error(f"Proactive daily check failed: {e}")


if __name__ == "__main__":
    agent.run()
