import base64
import json
import os
from email.mime.text import MIMEText
from uagents import Agent, Context
from gmail_auth import get_gmail_service

# Keywords to watch for
KEYWORDS = ["schedule", "meeting", "urgent", "invoice", "deadline"]

# Track emails we've already seen
seen_ids_file = "seen_ids.json"

def load_seen_ids():
    if os.path.exists(seen_ids_file):
        with open(seen_ids_file) as f:
            return set(json.load(f))
    return set()

def save_seen_ids(ids):
    with open(seen_ids_file, 'w') as f:
        json.dump(list(ids), f)

def get_email_body(msg):
    if 'parts' in msg['payload']:
        for part in msg['payload']['parts']:
            if part['mimeType'] == 'text/plain':
                data = part['body'].get('data', '')
                return base64.urlsafe_b64decode(data).decode('utf-8')
    else:
        data = msg['payload']['body'].get('data', '')
        return base64.urlsafe_b64decode(data).decode('utf-8')
    return ""

def check_keywords(text, keywords):
    text_lower = text.lower()
    return [kw for kw in keywords if kw in text_lower]

# Create the agent
agent = Agent(
    name="orchestrator",
    seed="win_lahacks_2026",   # change this
    port=8000,
    endpoint=["http://localhost:8000/submit"],
)

@agent.on_event("startup")
async def startup(ctx: Context):
    ctx.logger.info(f"Orchestrator started. Address: {agent.address}")
    ctx.logger.info("Monitoring Gmail for keywords...")

@agent.on_interval(period=60.0)  # check every 60 seconds
async def check_emails(ctx: Context):
    ctx.logger.info("Checking emails...")
    
    try:
        service = get_gmail_service()
        seen_ids = load_seen_ids()

        # Fetch unread emails
        results = service.users().messages().list(
            userId='me',
            q='is:unread',
            maxResults=10
        ).execute()

        messages = results.get('messages', [])
        new_seen = set()

        for message in messages:
            msg_id = message['id']
            new_seen.add(msg_id)

            if msg_id in seen_ids:
                continue  # already processed

            # Fetch full message
            msg = service.users().messages().get(
                userId='me',
                id=msg_id,
                format='full'
            ).execute()

            # Extract subject and sender
            headers = msg['payload']['headers']
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
            sender = next((h['value'] for h in headers if h['name'] == 'From'), 'Unknown')
            body = get_email_body(msg)

            # Check for keywords in subject + body
            full_text = subject + " " + body
            matched = check_keywords(full_text, KEYWORDS)

            if matched:
                ctx.logger.info(f"KEYWORD MATCH: {matched}")
                ctx.logger.info(f"From: {sender}")
                ctx.logger.info(f"Subject: {subject}")
                ctx.logger.info(f"Preview: {body[:200]}")
                # TODO: trigger action here — call Claude, send reply, etc.

        save_seen_ids(seen_ids | new_seen)

    except Exception as e:
        ctx.logger.error(f"Error checking email: {e}")

if __name__ == "__main__":
    agent.run()
