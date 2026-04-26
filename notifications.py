import json
import os
import subprocess

STATE_FILE = "proactive_state.json"


def notify(title, body):
    safe_body  = body.replace('"', "'").replace('\n', ' ')[:200]
    safe_title = title.replace('"', "'")[:60]
    subprocess.run(
        ['osascript', '-e', f'display notification "{safe_body}" with title "{safe_title}"'],
        capture_output=True,
    )
    print(f"[JARVIS] {safe_title}: {safe_body}")


def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {
        'reminded_events':        [],
        'btob_warned':            [],
        'followed_up':            [],
        'follow_up_last_checked': '',
        'eod_sent':               '',
    }


def save_state(state):
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)
