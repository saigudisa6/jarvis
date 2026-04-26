import base64
import uuid
from datetime import datetime, timedelta

from uagents import Model

class PreMeetingBriefReq(Model):
    request_id: str
    event_title: str
    event_start: str
    attendees_text: str
    description: str
    emails_text: str

class EODSummaryReq(Model):
    request_id: str
    unread_count: int
    tomorrow_text: str

from calendar_auth import get_todays_events, get_events_for_day
from gmail_auth import get_gmail_service
from notifications import notify, load_state, save_state


def _parse_dt(iso_str):
    return datetime.fromisoformat(iso_str.replace('Z', '+00:00'))


def _get_email_body(msg):
    payload = msg['payload']
    if 'parts' in payload:
        for part in payload['parts']:
            if part['mimeType'] == 'text/plain':
                data = part['body'].get('data', '')
                return base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
    data = payload.get('body', {}).get('data', '')
    return base64.urlsafe_b64decode(data).decode('utf-8', errors='replace') if data else ''


def _emails_from_senders(sender_emails, max_per_sender=3):
    service = get_gmail_service()
    subjects = []
    for email in sender_emails[:3]:
        result = service.users().messages().list(
            userId='me', q=f'from:{email} newer_than:14d', maxResults=max_per_sender
        ).execute()
        for ref in result.get('messages', []):
            msg = service.users().messages().get(
                userId='me', id=ref['id'], format='metadata',
                metadataHeaders=['Subject']
            ).execute()
            subject = next(
                (h['value'] for h in msg['payload']['headers'] if h['name'] == 'Subject'),
                'No Subject'
            )
            subjects.append(f"- {subject}")
    return subjects


# ── Feature 1: Pre-meeting brief (15 min before) (CLOUD VERSION) ──────────────

async def proactive_calendar_checks_cloud(ctx, cloud_address: str):
    await _check_meeting_reminders_cloud(ctx, cloud_address)
    _check_back_to_back()  # This one doesn't use LLM, so we keep it local

async def _check_meeting_reminders_cloud(ctx, cloud_address: str):
    state     = load_state()
    reminded  = set(state.get('reminded_events', []))
    now       = datetime.now().astimezone()

    for event in get_todays_events():
        event_key = f"{event['id'] or event['title']}_{event['start_raw']}"
        if event_key in reminded:
            continue
        try:
            minutes_until = (_parse_dt(event['start_raw']) - now).total_seconds() / 60
        except Exception:
            continue

        if not (10 <= minutes_until <= 20):
            continue

        attendees      = event['attendees']
        recent_subjects = _emails_from_senders(attendees) if attendees else []
        attendees_text  = ', '.join(attendees) if attendees else 'No external attendees'
        emails_text     = '\n'.join(recent_subjects) if recent_subjects else 'No recent emails from attendees.'

        ctx.logger.info(f"Requesting pre-meeting brief for: {event['title']}")
        req = PreMeetingBriefReq(
            request_id=str(uuid.uuid4()),
            event_title=event['title'],
            event_start=event['start'],
            attendees_text=attendees_text,
            description=event.get('description') or 'None',
            emails_text=emails_text
        )
        await ctx.send(cloud_address, req)
        
        reminded.add(event_key)

    state['reminded_events'] = list(reminded)
    save_state(state)


# ── Feature 2: Back-to-back meeting warning (30 min before pair) ──────────────

def _check_back_to_back():
    state   = load_state()
    warned  = set(state.get('btob_warned', []))
    now     = datetime.now().astimezone()
    events  = get_todays_events()

    for i in range(len(events) - 1):
        e1, e2    = events[i], events[i + 1]
        pair_key  = f"{e1['title']}|{e2['title']}"
        if pair_key in warned:
            continue
        try:
            e1_start = _parse_dt(e1['start_raw'])
            e1_end   = _parse_dt(e1['end_raw']) if e1['end_raw'] else e1_start + timedelta(hours=1)
            e2_start = _parse_dt(e2['start_raw'])
            gap_min          = (e2_start - e1_end).total_seconds() / 60
            until_first_min  = (e1_start - now).total_seconds() / 60
        except Exception:
            continue

        if gap_min < 10 and 25 <= until_first_min <= 35:
            msg = (
                f"'{e1['title']}' → '{e2['title']}' with only {int(gap_min)} min gap. "
                f"Wrap up '{e1['title']}' early."
            )
            notify("Back-to-back meetings ahead", msg)
            warned.add(pair_key)

    state['btob_warned'] = list(warned)
    save_state(state)


# ── Feature 3: Follow-up nudge (unanswered sent emails after 3 days) ──────────

async def proactive_daily_checks_cloud(ctx, cloud_address: str):
    await _check_eod_summary_cloud(ctx, cloud_address)
    _check_follow_ups()

def _check_follow_ups():
    state = load_state()
    now   = datetime.now()

    # run at most once per hour
    last = state.get('follow_up_last_checked', '')
    if last:
        try:
            if (now - datetime.fromisoformat(last)).total_seconds() < 3600:
                return
        except Exception:
            pass

    service     = get_gmail_service()
    followed_up = set(state.get('followed_up', []))

    result = service.users().messages().list(
        userId='me', q='in:sent older_than:3d newer_than:4d', maxResults=10
    ).execute()

    for ref in result.get('messages', []):
        msg_id = ref['id']
        if msg_id in followed_up:
            continue

        msg = service.users().messages().get(
            userId='me', id=msg_id, format='metadata',
            metadataHeaders=['Subject', 'To']
        ).execute()
        headers = msg['payload']['headers']
        subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
        to      = next((h['value'] for h in headers if h['name'] == 'To'), '')

        thread = service.users().threads().get(
            userId='me', id=msg['threadId'], format='minimal'
        ).execute()

        if len(thread.get('messages', [])) <= 1:
            notify("No reply — follow up?", f"{subject} → {to}")
            followed_up.add(msg_id)

    state['followed_up']            = list(followed_up)
    state['follow_up_last_checked'] = now.isoformat()
    save_state(state)


# ── Feature 4: End-of-day summary (5 PM) (CLOUD VERSION) ─────────────────────────────────────

async def _check_eod_summary_cloud(ctx, cloud_address: str):
    state = load_state()
    now   = datetime.now()
    today = now.strftime('%Y-%m-%d')

    if now.hour != 17 or state.get('eod_sent') == today:
        return

    service        = get_gmail_service()
    unread_result  = service.users().messages().list(
        userId='me', q='is:unread', maxResults=1
    ).execute()
    unread_count   = unread_result.get('resultSizeEstimate', 0)

    tomorrow_events = get_events_for_day(offset_days=1)
    if tomorrow_events:
        tomorrow_text = '\n'.join(f"  {e['start']}: {e['title']}" for e in tomorrow_events)
    else:
        tomorrow_text = '  Nothing scheduled.'

    ctx.logger.info("Requesting EOD summary from cloud...")
    req = EODSummaryReq(
        request_id=str(uuid.uuid4()),
        unread_count=unread_count,
        tomorrow_text=tomorrow_text
    )
    await ctx.send(cloud_address, req)

    state['eod_sent'] = today
    save_state(state)
