"""
orchestrator.py — Main entry point for the JARVIS personal agentic assistant.

First-run detection:
  - If config.json does NOT exist → launch tkinter onboarding wizard (setup.py)
  - If config.json exists → start the agent silently with a system tray icon

The agent:
  - Loads config.json and profile.json from the same directory as the exe
  - Registers on Agentverse via the saved agent_seed (unique per user)
  - Runs silently (NO visible window) using a pystray system tray icon
  - Polls Gmail / Google Calendar every 60 seconds (stub hooks for teammates)
  - Implements Chat Protocol from uagents_core for ASI:One compatibility
  - Adds itself to system startup (Windows registry / Mac LaunchAgent)

Usage:
    Double-click the exe (or python orchestrator.py)
"""

import json
import os
import platform
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4

# ─────────────────────────────────────────────
# Resolve base directory (PyInstaller-safe)
# ─────────────────────────────────────────────

def get_base_dir():
    """Return the directory where data files live.
    When frozen (PyInstaller --onefile), sys.executable is the exe path.
    Otherwise, use __file__ (the script's own location).
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
PROFILE_PATH = os.path.join(BASE_DIR, "profile.json")
BEHAVIORAL_LOG_PATH = os.path.join(BASE_DIR, "behavioral_log.json")
MACROS_PATH = os.path.join(BASE_DIR, "macros.json")

# Icon path — bundled by PyInstaller, or in script dir during dev
if getattr(sys, "frozen", False):
    ICON_PATH = os.path.join(sys._MEIPASS, "icon.png")
else:
    ICON_PATH = os.path.join(BASE_DIR, "icon.png")


# ═════════════════════════════════════════════
# Auto-startup registration
# ═════════════════════════════════════════════

def get_exe_path():
    """Return the path to the running executable (or script)."""
    if getattr(sys, "frozen", False):
        return sys.executable
    return os.path.abspath(__file__)


def add_to_startup():
    """Register the app to run on system boot.
    Windows: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
    Mac: ~/Library/LaunchAgents/com.personalagent.plist
    """
    exe_path = get_exe_path()
    system = platform.system()

    if system == "Windows":
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Run",
                0,
                winreg.KEY_SET_VALUE,
            )
            winreg.SetValueEx(key, "JarvisAgent", 0, winreg.REG_SZ, f'"{exe_path}"')
            winreg.CloseKey(key)
            print("✅  Added to Windows startup.")
        except Exception as e:
            print(f"⚠  Could not add to startup: {e}")

    elif system == "Darwin":
        plist_dir = os.path.expanduser("~/Library/LaunchAgents")
        os.makedirs(plist_dir, exist_ok=True)
        plist_path = os.path.join(plist_dir, "com.personalagent.plist")
        plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.personalagent</string>
    <key>ProgramArguments</key>
    <array>
        <string>{exe_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>"""
        try:
            with open(plist_path, "w", encoding="utf-8") as f:
                f.write(plist_content)
            subprocess.run(["launchctl", "load", plist_path],
                           capture_output=True, check=False)
            print("✅  Added to macOS startup (LaunchAgent).")
        except Exception as e:
            print(f"⚠  Could not add to startup: {e}")

    else:
        print(f"⚠  Auto-startup not implemented for {system}.")


# ═════════════════════════════════════════════
# Activity log helpers
# ═════════════════════════════════════════════

def log_activity(action: str, details: str = ""):
    """Append an entry to behavioral_log.json."""
    try:
        with open(BEHAVIORAL_LOG_PATH, "r", encoding="utf-8") as f:
            log = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        log = []

    log.append({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "details": details,
    })

    with open(BEHAVIORAL_LOG_PATH, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=2)


def get_activity_log_text() -> str:
    """Return a formatted string of the last 25 activity entries."""
    try:
        with open(BEHAVIORAL_LOG_PATH, "r", encoding="utf-8") as f:
            log = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return "No activity recorded yet."

    if not log:
        return "No activity recorded yet."

    lines = []
    for entry in log[-25:]:
        ts = entry.get("timestamp", "?")
        action = entry.get("action", "?")
        details = entry.get("details", "")
        lines.append(f"[{ts}] {action}" + (f" — {details}" if details else ""))
    return "\n".join(lines)


# ═════════════════════════════════════════════
# System Tray (pystray)
# ═════════════════════════════════════════════

def run_tray_icon(stop_event: threading.Event):
    """Create and run the system tray icon. Blocks until quit."""
    import pystray
    from PIL import Image

    # Load tray icon
    try:
        image = Image.open(ICON_PATH)
    except FileNotFoundError:
        # Fallback: generate a simple colored square
        image = Image.new("RGB", (64, 64), color=(124, 58, 237))

    def on_status(icon, item):
        pass  # Static label, no action needed

    def on_view_log(icon, item):
        """Show the activity log in a simple tkinter window."""
        def _show():
            import tkinter as tk
            win = tk.Tk()
            win.title("JARVIS — Activity Log")
            win.geometry("600x450")
            win.configure(bg="#1a1a2e")

            tk.Label(win, text="📋  Activity Log",
                     font=("Segoe UI", 14, "bold"),
                     fg="#e0e0e0", bg="#1a1a2e").pack(pady=(15, 5))

            text = tk.Text(win, wrap="word",
                           font=("Consolas", 10),
                           bg="#0f1629", fg="#e0e0e0",
                           relief="flat", padx=10, pady=10)
            text.pack(fill="both", expand=True, padx=15, pady=(0, 15))
            text.insert("1.0", get_activity_log_text())
            text.configure(state="disabled")

            win.mainloop()

        threading.Thread(target=_show, daemon=True).start()

    def on_quit(icon, item):
        log_activity("agent_stopped", "User quit from system tray")
        stop_event.set()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Status: Running ✅", on_status, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("View Activity Log", on_view_log),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )

    icon = pystray.Icon("jarvis", image, "JARVIS Agent", menu)
    icon.run()


# ═════════════════════════════════════════════
# Agent setup & run
# ═════════════════════════════════════════════

def run_agent_silently():
    """Load config, start the uagents agent with system tray.
    This is the main path for every launch after onboarding.
    """
    # ── Load config & profile ──
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)

    with open(PROFILE_PATH, "r", encoding="utf-8") as f:
        profile = json.load(f)

    log_activity("agent_started", f"User: {profile['name']}, Integrations: {config['integrations']}")

    # ── Import uagents ──
    from uagents import Agent, Context, Protocol
    from uagents_core.contrib.protocols.chat import (
        ChatMessage,
        ChatAcknowledgement,
        TextContent,
        EndSessionContent,
        chat_protocol_spec,
    )

    # ── Create agent ──
    agent = Agent(
        name="jarvis",
        seed=config["agent_seed"],
        port=8000,
        mailbox=True,
    )

    # ═════════════════════════════════════════════
    # SECTION: Chat Protocol  (ASI:One compatibility)
    # ═════════════════════════════════════════════

    chat_proto = Protocol(spec=chat_protocol_spec)

    @chat_proto.on_message(ChatMessage)
    async def handle_chat(ctx: Context, sender: str, msg: ChatMessage):
        """
        ── TEAMMATE HOOK (Person 4) ──────────────────────────
        Chat Protocol handler. ASI:One and other Agentverse
        agents send ChatMessage objects here.

        Person 4 plugs Chat Protocol logic here

        `msg.content` is a list — iterate to find TextContent
        items and process the user's text.

        For now the stub acknowledges the message and echoes
        back a confirmation. Replace the body below with your
        LLM-powered conversational logic.
        ───────────────────────────────────────────────────────
        """
        ctx.logger.info(f"💬  Chat from {sender}: {msg.msg_id}")

        # 1 — Acknowledge receipt
        ack = ChatAcknowledgement(
            timestamp=datetime.now(timezone.utc),
            acknowledged_msg_id=msg.msg_id,
        )
        await ctx.send(sender, ack)

        # 2 — Extract text content
        user_text = ""
        for item in msg.content:
            if isinstance(item, TextContent):
                user_text += item.text + " "
        user_text = user_text.strip()
        ctx.logger.info(f"   Message text: {user_text}")

        log_activity("chat_received", f"From {sender[:16]}...: {user_text[:80]}")

        # ── Person 4: START YOUR CODE HERE ────────────────────
        # TODO: Implement chat logic (onboarding Q&A, manual overrides,
        #       LLM-powered conversation, etc.)
        response_text = (
            f"Hello from {profile['name']}'s Orchestrator! "
            f"I received your message: \"{user_text}\""
        )
        # ── Person 4: END YOUR CODE HERE ──────────────────────

        # 3 — Send response
        await ctx.send(
            sender,
            ChatMessage(
                timestamp=datetime.now(timezone.utc),
                msg_id=uuid4(),
                content=[
                    TextContent(type="text", text=response_text),
                    EndSessionContent(type="end-session"),
                ],
            ),
        )

    @chat_proto.on_message(ChatAcknowledgement)
    async def handle_chat_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
        """Handle acknowledgements for messages we sent."""
        ctx.logger.info(
            f"✔  Ack from {sender} for message {msg.acknowledged_msg_id}"
        )

    agent.include(chat_proto, publish_manifest=True)

    # ═════════════════════════════════════════════
    # SECTION: Reasoning Engine
    # ═════════════════════════════════════════════

    async def reason_and_act(data: dict, ctx: Context):
        """
        ── TEAMMATE HOOK ──────────────────────────────────────
        Core reasoning function. Called by integration hooks
        (check_gmail, check_calendar, etc.) whenever new data
        arrives that may require autonomous action.

        Parameters
        ----------
        data : dict
            Structured payload from the calling hook. Shape
            depends on the source (email dict, calendar event, etc.)
        ctx  : Context
            The uagents Context for logging and sending messages.

        Instructions
        ------------
        Use `profile` and `config` (closure variables) to
        personalize decisions. Log actions to behavioral_log.json
        via the log_activity() helper.
        ───────────────────────────────────────────────────────
        """
        # ── START YOUR CODE HERE ──────────────────────────────
        ctx.logger.info(f"🧠  reason_and_act called with: {list(data.keys())}")
        # TODO: Implement reasoning logic using profile personality,
        #       decide on actions, execute them, and log to behavioral_log.json
        pass
        # ── END YOUR CODE HERE ────────────────────────────────

    # ═════════════════════════════════════════════
    # SECTION: Gmail Integration
    # ═════════════════════════════════════════════

    @agent.on_interval(period=60.0)
    async def check_gmail(ctx: Context):
        """
        ── TEAMMATE HOOK ──────────────────────────────────────
        Person 1 plugs Gmail logic here

        Polls Gmail for new messages every 60 seconds.
        Only runs if "gmail" is in config["integrations"].

        After fetching new mail, call:
            await reason_and_act(email_data, ctx)

        Use token.json (saved during OAuth onboarding) for
        authentication via google.oauth2.credentials.
        ───────────────────────────────────────────────────────
        """
        if "gmail" not in config["integrations"]:
            return

        # ── Person 1: START YOUR CODE HERE ────────────────────
        ctx.logger.info("📧  check_gmail triggered — polling for new messages")
        # TODO: Authenticate via Google OAuth (load token.json),
        #       fetch unread emails from Gmail API,
        #       parse them, and pass to reason_and_act()
        #
        # Example:
        #   from google.oauth2.credentials import Credentials
        #   from googleapiclient.discovery import build
        #   creds = Credentials.from_authorized_user_file(
        #       os.path.join(BASE_DIR, "token.json"), SCOPES)
        #   service = build("gmail", "v1", credentials=creds)
        #   results = service.users().messages().list(
        #       userId="me", q="is:unread", maxResults=10).execute()
        #   for msg_meta in results.get("messages", []):
        #       msg = service.users().messages().get(
        #           userId="me", id=msg_meta["id"]).execute()
        #       await reason_and_act({"source": "gmail", "email": msg}, ctx)
        pass
        # ── Person 1: END YOUR CODE HERE ──────────────────────

    # ═════════════════════════════════════════════
    # SECTION: Google Calendar Integration
    # ═════════════════════════════════════════════

    @agent.on_interval(period=60.0)
    async def check_calendar(ctx: Context):
        """
        ── TEAMMATE HOOK ──────────────────────────────────────
        Person 2 plugs Calendar logic here

        Polls Google Calendar for upcoming events every 60 seconds.
        Only runs if "google_calendar" is in config["integrations"].

        After fetching events, call:
            await reason_and_act(calendar_data, ctx)

        Use token.json (saved during OAuth onboarding) for
        authentication via google.oauth2.credentials.
        ───────────────────────────────────────────────────────
        """
        if "google_calendar" not in config["integrations"]:
            return

        # ── Person 2: START YOUR CODE HERE ────────────────────
        ctx.logger.info("📅  check_calendar triggered — checking upcoming events")
        # TODO: Authenticate via Google OAuth (load token.json),
        #       fetch upcoming calendar events from Google Calendar API,
        #       parse them, and pass to reason_and_act()
        #
        # Example:
        #   from google.oauth2.credentials import Credentials
        #   from googleapiclient.discovery import build
        #   creds = Credentials.from_authorized_user_file(
        #       os.path.join(BASE_DIR, "token.json"), SCOPES)
        #   service = build("calendar", "v3", credentials=creds)
        #   now = datetime.utcnow().isoformat() + "Z"
        #   events_result = service.events().list(
        #       calendarId="primary", timeMin=now, maxResults=10,
        #       singleEvents=True, orderBy="startTime").execute()
        #   for event in events_result.get("items", []):
        #       await reason_and_act({"source": "calendar", "event": event}, ctx)
        pass
        # ── Person 2: END YOUR CODE HERE ──────────────────────

    # ═════════════════════════════════════════════
    # SECTION: Slack Integration
    # ═════════════════════════════════════════════

    @agent.on_interval(period=60.0)
    async def check_slack(ctx: Context):
        """
        ── TEAMMATE HOOK ──────────────────────────────────────
        Person 3 plugs Slack logic here

        Polls Slack for new messages every 60 seconds.
        Only runs if "slack" is in config["integrations"].
        ───────────────────────────────────────────────────────
        """
        if "slack" not in config["integrations"]:
            return

        # ── Person 3: START YOUR CODE HERE ────────────────────
        ctx.logger.info("💬  check_slack triggered")
        # TODO: Fetch new Slack messages and pass to reason_and_act()
        pass
        # ── Person 3: END YOUR CODE HERE ──────────────────────

    # ═════════════════════════════════════════════
    # SECTION: Browser Macros
    # ═════════════════════════════════════════════

    @agent.on_interval(period=60.0)
    async def run_browser_macros(ctx: Context):
        """
        ── TEAMMATE HOOK ──────────────────────────────────────
        Executes browser macros every 60 seconds.

        Only runs if "browser_macros" is in config["integrations"].
        Reads macro definitions from macros.json.
        ───────────────────────────────────────────────────────
        """
        if "browser_macros" not in config["integrations"]:
            return

        # ── START YOUR CODE HERE ──────────────────────────────
        ctx.logger.info("🌐  run_browser_macros triggered")
        # TODO: Load macros from macros.json and execute them
        pass
        # ── END YOUR CODE HERE ────────────────────────────────

    # ═════════════════════════════════════════════
    # SECTION: Startup handler
    # ═════════════════════════════════════════════

    @agent.on_event("startup")
    async def on_startup(ctx: Context):
        """Log agent boot information."""
        ctx.logger.info("=" * 50)
        ctx.logger.info(f"🚀  Orchestrator started for {profile['name']}")
        ctx.logger.info(f"    Address:       {agent.address}")
        ctx.logger.info(f"    Integrations:  {', '.join(config['integrations'])}")
        ctx.logger.info(f"    Autonomy:      {profile['personality']['autonomy']}")
        ctx.logger.info("=" * 50)
        log_activity("agent_boot", f"Address: {agent.address}")

    # ── Run agent in a background thread, tray in main thread ──
    stop_event = threading.Event()

    def agent_thread_target():
        """Run the uagents event loop in a daemon thread."""
        try:
            agent.run()
        except Exception as e:
            log_activity("agent_error", str(e))
            stop_event.set()

    agent_thread = threading.Thread(target=agent_thread_target, daemon=True)
    agent_thread.start()

    # System tray occupies the main thread (required by pystray on macOS)
    run_tray_icon(stop_event)


# ═════════════════════════════════════════════
# First-run detection & entry point
# ═════════════════════════════════════════════

def main():
    """Entry point: detect first run, then either onboard or run silently."""
    if not os.path.exists(CONFIG_PATH):
        # ── First run: show onboarding wizard ──
        from setup import run_onboarding
        completed = run_onboarding()

        if not completed:
            sys.exit(0)

        # Register auto-startup after first successful onboarding
        add_to_startup()

        # Now start the agent
        run_agent_silently()

    else:
        # ── Subsequent runs: go straight to background agent ──
        run_agent_silently()


if __name__ == "__main__":
    main()
