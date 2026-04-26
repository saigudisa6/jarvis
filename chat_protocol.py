"""
Agentverse Chat Protocol handler.

Flow: ASI:One → Agentverse → (mailbox) → this handler → Google APIs (local) → response back
The Google APIs stay 100% local — ASI:One is just the chat interface.
"""

import json
from datetime import datetime, timedelta
from typing import List, Literal
from uuid import UUID, uuid4

from anthropic import Anthropic
from uagents import Context, Model, Protocol

from calendar_auth import get_todays_events, get_events_for_day, create_calendar_event
from gmail_auth import get_gmail_service, get_recent_emails, get_email_body

anthropic_client = Anthropic()

def generate_morning_briefing():
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

    response = anthropic_client.messages.create(
        model="claude-3-5-sonnet-20240620",
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


# ── Protocol models (must match Agentverse Chat Protocol schema) ───────────────

class TextContent(Model):
    type: Literal["text"] = "text"
    text: str


class ChatMessage(Model):
    timestamp: datetime
    msg_id: UUID
    content: List[TextContent]


class ChatAcknowledgement(Model):
    timestamp: datetime
    acknowledged_msg_id: UUID


chat_proto = Protocol(name="AgentChatProtocol", version="0.3.0")

# ── Tools Claude can call ──────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "get_calendar_today",
        "description": "Get the user's calendar events for today.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_calendar_tomorrow",
        "description": "Get the user's calendar events for tomorrow.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_emails",
        "description": "Get recent unread emails from the last 24 hours.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "morning_briefing",
        "description": "Generate a full morning briefing combining calendar and email.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "create_event",
        "description": "Create a calendar event. Infer reasonable defaults for missing fields.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title":      {"type": "string", "description": "Event title"},
                "date":       {"type": "string", "description": "Date in YYYY-MM-DD format"},
                "start_time": {"type": "string", "description": "Start time in HH:MM (24h) format"},
                "duration_minutes": {"type": "integer", "description": "Duration in minutes, default 60"},
                "attendees":  {"type": "array", "items": {"type": "string"}, "description": "List of attendee emails"},
            },
            "required": ["title", "date", "start_time"],
        },
    },
    {
        "name": "search_emails",
        "description": "Search emails by a Gmail query string.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Gmail search query (e.g. 'from:john subject:invoice')"},
            },
            "required": ["query"],
        },
    },
]


def _run_tool(name: str, inputs: dict) -> str:
    if name == "get_calendar_today":
        events = get_todays_events()
        if not events:
            return "No events today."
        return "\n".join(
            f"• {e['start']}: {e['title']}"
            + (f" (with {', '.join(e['attendees'])})" if e['attendees'] else "")
            for e in events
        )

    if name == "get_calendar_tomorrow":
        events = get_events_for_day(offset_days=1)
        if not events:
            return "Nothing on the calendar tomorrow."
        return "\n".join(f"• {e['start']}: {e['title']}" for e in events)

    if name == "get_emails":
        emails = get_recent_emails()
        if not emails:
            return "No unread emails in the last 24 hours."
        return "\n".join(
            f"• From: {e['sender']}\n  Subject: {e['subject']}\n  Preview: {e['preview'][:200]}"
            for e in emails[:8]
        )

    if name == "morning_briefing":
        return generate_morning_briefing()

    if name == "create_event":
        title     = inputs["title"]
        date_str  = inputs["date"]
        time_str  = inputs["start_time"]
        duration  = inputs.get("duration_minutes", 60)
        attendees = inputs.get("attendees", [])

        start_dt = datetime.fromisoformat(f"{date_str}T{time_str}:00").astimezone()
        end_dt   = start_dt + timedelta(minutes=duration)
        link     = create_calendar_event(title, start_dt, end_dt, attendees)
        return f"Event created: '{title}' on {date_str} at {time_str}. Link: {link}"

    if name == "search_emails":
        emails = get_recent_emails(query=inputs["query"], max_results=5)
        if not emails:
            return f"No emails found for query: {inputs['query']}"
        return "\n".join(
            f"• From: {e['sender']}\n  Subject: {e['subject']}"
            for e in emails
        )

    return f"Unknown tool: {name}"


def _process_request(user_text: str) -> str:
    messages = [{"role": "user", "content": user_text}]

    # agentic loop — let Claude call tools until it has a final answer
    while True:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=(
                "You are JARVIS, a personal AI assistant running locally on the user's laptop. "
                "You have access to their Gmail and Google Calendar. "
                "Use tools to answer their request, then give a concise, direct reply. "
                "Today is " + datetime.now().strftime("%A, %B %-d %Y") + "."
            ),
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason == "end_turn":
            # extract text from response
            return " ".join(
                block.text for block in response.content if hasattr(block, "text")
            )

        # collect tool calls
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result = _run_tool(block.name, block.input)
                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": block.id,
                    "content":     result,
                })

        if not tool_results:
            return " ".join(
                block.text for block in response.content if hasattr(block, "text")
            )

        # feed results back and continue
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user",      "content": tool_results})


# ── Message handler ────────────────────────────────────────────────────────────

@chat_proto.on_message(ChatMessage, replies={ChatMessage, ChatAcknowledgement})
async def handle_chat(ctx: Context, sender: str, msg: ChatMessage):
    # acknowledge immediately
    await ctx.send(sender, ChatAcknowledgement(
        timestamp=datetime.utcnow(),
        acknowledged_msg_id=msg.msg_id,
    ))

    user_text = " ".join(
        block.text for block in msg.content if hasattr(block, "text")
    ).strip()

    ctx.logger.info(f"[CHAT] from={sender} | text={user_text[:80]}")

    try:
        reply = _process_request(user_text)
    except Exception as e:
        reply = f"Sorry, I hit an error: {e}"

    await ctx.send(sender, ChatMessage(
        timestamp=datetime.utcnow(),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=reply)],
    ))
