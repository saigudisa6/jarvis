import os
from datetime import datetime, timedelta
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/calendar.events',
]


def get_calendar_service():
    creds = None
    if os.path.exists('calendar_token.json'):
        creds = Credentials.from_authorized_user_file('calendar_token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('calendar_token.json', 'w') as token:
            token.write(creds.to_json())
    return build('calendar', 'v3', credentials=creds)


def _fetch_events(time_min, time_max):
    service = get_calendar_service()
    result = service.events().list(
        calendarId='primary',
        timeMin=time_min.isoformat(),
        timeMax=time_max.isoformat(),
        singleEvents=True,
        orderBy='startTime',
    ).execute()

    events = []
    for item in result.get('items', []):
        start_raw = item['start'].get('dateTime', item['start'].get('date', ''))
        end_raw   = item['end'].get('dateTime',   item['end'].get('date', ''))
        try:
            start_fmt = datetime.fromisoformat(start_raw).strftime('%-I:%M %p')
        except Exception:
            start_fmt = start_raw

        attendees = [a['email'] for a in item.get('attendees', []) if not a.get('self')]
        events.append({
            'id':          item.get('id', ''),
            'title':       item.get('summary', 'Untitled'),
            'start':       start_fmt,
            'start_raw':   start_raw,
            'end_raw':     end_raw,
            'attendees':   attendees,
            'description': item.get('description', ''),
            'location':    item.get('location', ''),
        })
    return events


def get_todays_events():
    now = datetime.now().astimezone()
    return _fetch_events(
        now.replace(hour=0,  minute=0,  second=0,  microsecond=0),
        now.replace(hour=23, minute=59, second=59, microsecond=0),
    )


def get_events_for_day(offset_days=0):
    now    = datetime.now().astimezone()
    target = now + timedelta(days=offset_days)
    return _fetch_events(
        target.replace(hour=0,  minute=0,  second=0,  microsecond=0),
        target.replace(hour=23, minute=59, second=59, microsecond=0),
    )


def create_calendar_event(title, start_dt, end_dt, attendees=None, description=''):
    """
    start_dt / end_dt: timezone-aware datetime objects.
    Returns the HTML link to the created event.
    """
    service = get_calendar_service()
    tz = datetime.now().astimezone().tzname()

    event = {
        'summary': title,
        'description': description,
        'start': {'dateTime': start_dt.isoformat(), 'timeZone': str(start_dt.tzinfo)},
        'end':   {'dateTime': end_dt.isoformat(),   'timeZone': str(end_dt.tzinfo)},
    }
    if attendees:
        event['attendees'] = [{'email': e} for e in attendees]

    created = service.events().insert(calendarId='primary', body=event).execute()
    return created.get('htmlLink', '')


if __name__ == '__main__':
    get_calendar_service()
    print("Calendar authentication complete. calendar_token.json has been created.")
