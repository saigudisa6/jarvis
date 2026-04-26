import base64
import json
import os
from email.mime.text import MIMEText
from uagents import Agent, Context
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

from gmail_auth import get_gmail_service
# Obsolete local imports removed
from datetime import datetime

from anthropic import Anthropic
from uagents import Agent, Context, Model
import uuid

from calendar_auth import get_todays_events
from gmail_auth import get_gmail_service, get_email_body, get_recent_emails
from notifications import notify
from proactive import proactive_calendar_checks_cloud, proactive_daily_checks_cloud

AGENTVERSE_API_KEY = os.getenv("AGENTVERSE_API_KEY", "")
CLOUD_ORCHESTRATOR_ADDRESS = os.getenv("CLOUD_ORCHESTRATOR_ADDRESS", "")
AGENT_SEED = os.getenv("AGENT_SEED", "jarvis_orch_final_sync")

SEEN_IDS_FILE = "seen_ids.json"
BRIEFING_STATE_FILE = "briefing_state.json"

# ── Cloud Models ─────────────────────────────────────────────────────────────

# --- Models ---
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

class PreMeetingBriefReq(Model):
    user_uuid: str
    request_id: str
    event_title: str
    event_start: str
    attendees_text: str
    description: str
    emails_text: str

class PreMeetingBriefRes(Model):
    request_id: str
    brief: str

class EODSummaryReq(Model):
    user_uuid: str
    request_id: str
    unread_count: int
    tomorrow_text: str

class EODSummaryRes(Model):
    request_id: str
    summary: str

from typing import List, Dict

class EmailAnalysisReq(Model):
    user_uuid: str
    request_id: str
    emails: List[Dict[str, str]]

class EmailAnalysisRes(Model):
    request_id: str
    alerts: List[Dict[str, str]]
    



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


# ── Gmail helpers imported from gmail_auth.py ──



# ── Agent ──────────────────────────────────────────────────────────────────────

# Restaurant search logic migrated to cloud-native extension bridge

# Create the agent
# No port/endpoint — mailbox-only so Agentverse doesn't try to reach
# localhost:8000 from the cloud (which always fails).
agent = Agent(
    name="jarvis",
    seed=AGENT_SEED,
    mailbox=True,
)

# Chat protocol removed to restore stable communication
# agent.include(chat_proto, publish_manifest=True)


@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"JARVIS started. Address: {agent.address}")
    ctx.logger.info(f"Agentverse mailbox: {'enabled' if AGENTVERSE_API_KEY else 'disabled — set AGENTVERSE_API_KEY'}")
    ctx.logger.info("Monitoring Gmail and Calendar...")
    
    # Send a quick test to the cloud to verify everything works!
    if CLOUD_ORCHESTRATOR_ADDRESS:
        ctx.logger.info(f"--- Sending test to Cloud Agent: {CLOUD_ORCHESTRATOR_ADDRESS} ---")
        req = MorningBriefingReq(
            user_uuid=agent.address,
            request_id="startup-test-123",
            events_text="  2:00 PM: Project sync with design team",
            emails_text="  From: boss@company.com\n  Subject: Urgent Update needed\n  Preview: Hey, please review the latest designs."
        )
        await ctx.send(CLOUD_ORCHESTRATOR_ADDRESS, req)
    else:
        ctx.logger.warning("CLOUD_ORCHESTRATOR_ADDRESS not set — skipping test send")


@agent.on_interval(period=60.0)
async def check_emails(ctx: Context):
    if not CLOUD_ORCHESTRATOR_ADDRESS:
        return
        
    ctx.logger.info("Checking emails...")
    try:
        service  = get_gmail_service()
        seen_ids = load_seen_ids()

        result   = service.users().messages().list(
            userId='me', q='is:unread', maxResults=10
        ).execute()
        messages = result.get('messages', [])
        new_seen = set()

        emails_to_analyze = []

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
            
            emails_to_analyze.append({
                "subject": subject,
                "sender": sender,
                "preview": body[:200]
            })

        save_seen_ids(seen_ids | new_seen)
        
        if emails_to_analyze:
            req = EmailAnalysisReq(
                user_uuid=agent.address,
                request_id=str(uuid.uuid4()), 
                emails=emails_to_analyze
            )
            await ctx.send(CLOUD_ORCHESTRATOR_ADDRESS, req)
            
    except Exception as e:
        ctx.logger.error(f"Email check failed: {e}")

@agent.on_message(model=EmailAnalysisRes)
async def handle_email_alerts(ctx: Context, sender: str, msg: EmailAnalysisRes):
    for alert in msg.alerts:
        ctx.logger.info(f"[EMAIL ALERT] {alert['subject']}")
        notify(alert['subject'], alert['body'])



@agent.on_interval(period=300.0)  # poll every 5 min so we catch the 8am window
async def morning_briefing_check(ctx: Context):
    now = datetime.now()
    if now.hour == 8 and not briefing_sent_today() and CLOUD_ORCHESTRATOR_ADDRESS:
        ctx.logger.info("Requesting morning briefing from cloud...")
        try:
            events = get_todays_events()
            emails = get_recent_emails()
            
            events_text = "\n".join(
                f"  {e['start']}: {e['title']}"
                + (f" (with {', '.join(e['attendees'])})" if e['attendees'] else "")
                for e in events
            ) if events else "  No events scheduled today."

            emails_text = "\n\n".join(
                f"  From: {e['sender']}\n  Subject: {e['subject']}\n  Preview: {e['preview']}"
                for e in emails
            ) if emails else "  No unread emails in the last 24 hours."

            req = MorningBriefingReq(
                user_uuid=agent.address,
                request_id=str(uuid.uuid4()),
                events_text=events_text,
                emails_text=emails_text
            )
            await ctx.send(CLOUD_ORCHESTRATOR_ADDRESS, req)
        except Exception as e:
            ctx.logger.error(f"Failed to request morning briefing: {e}")

@agent.on_message(model=MorningBriefingRes)
async def handle_morning_briefing(ctx: Context, sender: str, msg: MorningBriefingRes):
    mark_briefing_sent()
    notify("JARVIS Morning Briefing", msg.briefing)
    ctx.logger.info("\n=== JARVIS MORNING BRIEFING ===\n" + msg.briefing + "\n===============================")



@agent.on_interval(period=60.0)
async def proactive_calendar_checks(ctx: Context):
    if not CLOUD_ORCHESTRATOR_ADDRESS:
        return
    try:
        await proactive_calendar_checks_cloud(ctx, CLOUD_ORCHESTRATOR_ADDRESS)
    except Exception as e:
        ctx.logger.error(f"Proactive calendar check failed: {e}")

@agent.on_interval(period=300.0)
async def proactive_daily_checks(ctx: Context):
    if not CLOUD_ORCHESTRATOR_ADDRESS:
        return
    try:
        await proactive_daily_checks_cloud(ctx, CLOUD_ORCHESTRATOR_ADDRESS)
    except Exception as e:
        ctx.logger.error(f"Proactive daily check failed: {e}")

@agent.on_message(model=PreMeetingBriefRes)
async def handle_pre_meeting_brief(ctx: Context, sender: str, msg: PreMeetingBriefRes):
    notify("Meeting starting soon", msg.brief)
    ctx.logger.info(f"\n[JARVIS] Pre-meeting brief:\n{msg.brief}\n")

@agent.on_message(model=EODSummaryRes)
async def handle_eod_summary(ctx: Context, sender: str, msg: EODSummaryRes):
    notify("JARVIS — End of Day", msg.summary)
    ctx.logger.info(f"\n[JARVIS] EOD Summary:\n{msg.summary}\n")





if __name__ == "__main__":
    agent.run()
