"""
setup.py — Tkinter GUI onboarding wizard for the Orchestrator agent.

Runs automatically on first launch when no config.json exists.
Walks the user through a clean multi-step wizard:
  1. Welcome screen
  2. Google OAuth flow
  3. Integration selection
  4. Motivation selection
  5. Personality quiz
  6. Completion screen

After onboarding, writes these local files:
  - config.json
  - profile.json
  - behavioral_log.json
  - macros.json

No external GUI libraries — tkinter only.
"""

import json
import os
import secrets
import sys
import threading
import webbrowser
import tkinter as tk
from tkinter import ttk, messagebox


# ─────────────────────────────────────────────
# Resolve base directory (works for both script and PyInstaller exe)
# ─────────────────────────────────────────────

def get_base_dir():
    """Return the directory where data files should live.
    When running as a PyInstaller --onefile exe, sys.executable
    points to the exe itself; otherwise fall back to __file__.
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()

# Google OAuth scopes required for Gmail + Calendar read/write
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
]


# ═════════════════════════════════════════════════════════════
# OnboardingWizard — main tkinter application
# ═════════════════════════════════════════════════════════════

class OnboardingWizard:
    """Multi-step tkinter wizard for first-time agent setup."""

    # ── Color palette ──────────────────────────
    BG = "#1a1a2e"
    FG = "#e0e0e0"
    ACCENT = "#7c3aed"
    ACCENT_HOVER = "#6d28d9"
    CARD_BG = "#16213e"
    BORDER = "#2a2a4a"
    SUCCESS = "#10b981"
    MUTED = "#9ca3af"

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("JARVIS — Setup Wizard")
        self.root.geometry("720x620")
        self.root.resizable(False, False)
        self.root.configure(bg=self.BG)

        # Center the window on screen
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() // 2) - 360
        y = (self.root.winfo_screenheight() // 2) - 310
        self.root.geometry(f"720x620+{x}+{y}")

        # Configure ttk styles
        self._configure_styles()

        # State variables
        self.current_step = 0
        self.name_var = tk.StringVar()
        self.oauth_complete = False
        self.integration_vars = {}
        self.motivation_vars = {}
        self.personality_vars = {}
        self.completed = False

        # Frames for each step (lazy-built)
        self.container = tk.Frame(self.root, bg=self.BG)
        self.container.pack(fill="both", expand=True, padx=30, pady=20)

        self.steps = [
            self._build_welcome,
            self._build_oauth,
            self._build_integrations,
            self._build_motivations,
            self._build_personality,
            self._build_completion,
        ]

        # Show first step
        self._show_step(0)

    # ── Styling ────────────────────────────────

    def _configure_styles(self):
        style = ttk.Style()
        style.theme_use("clam")

        style.configure("Wizard.TCheckbutton",
                        background=self.CARD_BG,
                        foreground=self.FG,
                        font=("Segoe UI", 11))
        style.map("Wizard.TCheckbutton",
                  background=[("active", self.CARD_BG)])

        style.configure("Wizard.TRadiobutton",
                        background=self.CARD_BG,
                        foreground=self.FG,
                        font=("Segoe UI", 11))
        style.map("Wizard.TRadiobutton",
                  background=[("active", self.CARD_BG)])

    # ── Navigation ─────────────────────────────

    def _clear_container(self):
        for widget in self.container.winfo_children():
            widget.destroy()

    def _show_step(self, step_index):
        self.current_step = step_index
        self._clear_container()
        self.steps[step_index]()

    def _next_step(self):
        self._show_step(self.current_step + 1)

    # ── Reusable widgets ───────────────────────

    def _make_title(self, text, emoji=""):
        label = tk.Label(
            self.container,
            text=f"{emoji}  {text}" if emoji else text,
            font=("Segoe UI", 20, "bold"),
            fg=self.FG, bg=self.BG,
            anchor="w",
        )
        label.pack(anchor="w", pady=(0, 5))

    def _make_subtitle(self, text):
        label = tk.Label(
            self.container,
            text=text,
            font=("Segoe UI", 11),
            fg=self.MUTED, bg=self.BG,
            anchor="w",
            wraplength=660,
            justify="left",
        )
        label.pack(anchor="w", pady=(0, 20))

    def _make_step_indicator(self):
        step_names = ["Welcome", "OAuth", "Integrations", "Motivations", "Personality", "Done"]
        frame = tk.Frame(self.container, bg=self.BG)
        frame.pack(anchor="w", pady=(0, 15))
        for i, name in enumerate(step_names):
            color = self.ACCENT if i == self.current_step else (
                self.SUCCESS if i < self.current_step else self.MUTED
            )
            dot = tk.Label(frame, text="●" if i <= self.current_step else "○",
                           fg=color, bg=self.BG, font=("Segoe UI", 10))
            dot.pack(side="left", padx=2)
            lbl = tk.Label(frame, text=name, fg=color, bg=self.BG,
                           font=("Segoe UI", 9))
            lbl.pack(side="left", padx=(0, 12))

    def _make_card(self):
        card = tk.Frame(self.container, bg=self.CARD_BG,
                        highlightbackground=self.BORDER,
                        highlightthickness=1)
        card.pack(fill="both", expand=True, pady=(0, 15))
        return card

    def _make_button(self, parent, text, command, primary=True):
        btn = tk.Button(
            parent, text=text, command=command,
            font=("Segoe UI", 12, "bold"),
            fg="white",
            bg=self.ACCENT if primary else self.CARD_BG,
            activebackground=self.ACCENT_HOVER if primary else self.BORDER,
            activeforeground="white",
            relief="flat",
            cursor="hand2",
            padx=30, pady=10,
            bd=0,
        )
        if not primary:
            btn.configure(highlightbackground=self.BORDER, highlightthickness=1)
        return btn

    # ═══════════════════════════════════════════
    # STEP 1: Welcome
    # ═══════════════════════════════════════════

    def _build_welcome(self):
        self._make_step_indicator()
        self._make_title("Welcome to JARVIS", "🤖")
        self._make_subtitle(
            "Your personal AI assistant that runs locally on your machine. "
            "It monitors your Gmail and Google Calendar, takes autonomous actions "
            "on your behalf based on your personality profile, and stays connected "
            "to the Fetch.ai network. All your personal data stays on your machine — "
            "nothing sensitive ever leaves."
        )

        card = self._make_card()

        tk.Label(card, text="What's your name?",
                 font=("Segoe UI", 13, "bold"),
                 fg=self.FG, bg=self.CARD_BG).pack(anchor="w", padx=20, pady=(20, 8))

        name_entry = tk.Entry(
            card, textvariable=self.name_var,
            font=("Segoe UI", 13),
            bg="#0f1629", fg=self.FG,
            insertbackground=self.FG,
            relief="flat",
            highlightbackground=self.BORDER,
            highlightthickness=1,
        )
        name_entry.pack(fill="x", padx=20, pady=(0, 20))
        name_entry.focus_set()

        # Bind Enter key to advance
        name_entry.bind("<Return>", lambda e: self._validate_welcome())

        btn_frame = tk.Frame(self.container, bg=self.BG)
        btn_frame.pack(fill="x")
        btn = self._make_button(btn_frame, "Get Started  →", self._validate_welcome)
        btn.pack(side="right")

    def _validate_welcome(self):
        if not self.name_var.get().strip():
            messagebox.showwarning("Name Required", "Please enter your name to continue.")
            return
        self._next_step()

    # ═══════════════════════════════════════════
    # STEP 2: Google OAuth
    # ═══════════════════════════════════════════

    def _build_oauth(self):
        self._make_step_indicator()
        self._make_title("Google Account Access", "🔐")
        self._make_subtitle(
            "JARVIS needs access to your Gmail and Google Calendar to monitor "
            "emails and events on your behalf. Click the button below to sign in "
            "with Google. You'll be redirected to your browser."
        )

        card = self._make_card()

        tk.Label(card, text="Permissions requested:",
                 font=("Segoe UI", 12, "bold"),
                 fg=self.FG, bg=self.CARD_BG).pack(anchor="w", padx=20, pady=(20, 10))

        permissions = [
            "📧  Gmail — Read and send emails on your behalf",
            "📅  Calendar — Read and create calendar events",
        ]
        for perm in permissions:
            tk.Label(card, text=perm, font=("Segoe UI", 11),
                     fg=self.MUTED, bg=self.CARD_BG).pack(anchor="w", padx=30, pady=2)

        tk.Label(card, text="", bg=self.CARD_BG).pack(pady=5)

        self.oauth_status_label = tk.Label(
            card,
            text="⏳ Not yet connected",
            font=("Segoe UI", 11, "italic"),
            fg="#f59e0b", bg=self.CARD_BG,
        )
        self.oauth_status_label.pack(pady=(5, 15))

        oauth_btn = self._make_button(card, "🔑  Sign in with Google", self._start_oauth)
        oauth_btn.pack(pady=(0, 20))

        btn_frame = tk.Frame(self.container, bg=self.BG)
        btn_frame.pack(fill="x")

        skip_btn = self._make_button(btn_frame, "Skip for now", self._next_step, primary=False)
        skip_btn.pack(side="left")

        self.oauth_next_btn = self._make_button(btn_frame, "Continue  →", self._next_step)
        self.oauth_next_btn.pack(side="right")

    def _start_oauth(self):
        """Launch Google OAuth flow in a background thread."""
        self.oauth_status_label.configure(text="🔄  Opening browser...", fg="#60a5fa")
        threading.Thread(target=self._run_oauth, daemon=True).start()

    def _run_oauth(self):
        """Perform the actual OAuth credential exchange."""
        try:
            from google_auth_oauthlib.flow import InstalledAppFlow

            credentials_path = os.path.join(BASE_DIR, "credentials.json")
            if not os.path.exists(credentials_path):
                self.root.after(0, lambda: self.oauth_status_label.configure(
                    text="❌  credentials.json not found in app folder",
                    fg="#ef4444",
                ))
                return

            flow = InstalledAppFlow.from_client_secrets_file(
                credentials_path, GOOGLE_SCOPES
            )
            creds = flow.run_local_server(port=0)

            token_path = os.path.join(BASE_DIR, "token.json")
            with open(token_path, "w", encoding="utf-8") as f:
                f.write(creds.to_json())

            self.oauth_complete = True
            self.root.after(0, lambda: self.oauth_status_label.configure(
                text="✅  Connected successfully! Token saved.",
                fg=self.SUCCESS,
            ))

        except ImportError:
            self.root.after(0, lambda: self.oauth_status_label.configure(
                text="⚠  google-auth-oauthlib not installed. Skipping.",
                fg="#f59e0b",
            ))
        except Exception as e:
            self.root.after(0, lambda: self.oauth_status_label.configure(
                text=f"❌  Error: {str(e)[:60]}",
                fg="#ef4444",
            ))

    # ═══════════════════════════════════════════
    # STEP 3: Integration Selection
    # ═══════════════════════════════════════════

    def _build_integrations(self):
        self._make_step_indicator()
        self._make_title("Choose Your Integrations", "🔌")
        self._make_subtitle(
            "Select which services JARVIS should monitor and act on. "
            "You can change these later in config.json."
        )

        card = self._make_card()

        integrations = [
            ("gmail", "Gmail", "Monitor incoming emails and draft responses"),
            ("google_calendar", "Google Calendar", "Track events and schedule meetings"),
            ("slack", "Slack", "Monitor channels and respond to messages"),
            ("browser_macros", "Browser Macros", "Automate repetitive browser tasks"),
        ]

        inner = tk.Frame(card, bg=self.CARD_BG)
        inner.pack(fill="both", expand=True, padx=20, pady=20)

        for key, label, description in integrations:
            var = tk.BooleanVar(value=(key in ("gmail", "google_calendar")))
            self.integration_vars[key] = var

            row = tk.Frame(inner, bg=self.CARD_BG)
            row.pack(fill="x", pady=6)

            cb = ttk.Checkbutton(row, text=label, variable=var,
                                 style="Wizard.TCheckbutton")
            cb.pack(anchor="w")

            tk.Label(row, text=description,
                     font=("Segoe UI", 9),
                     fg=self.MUTED, bg=self.CARD_BG).pack(anchor="w", padx=25)

        btn_frame = tk.Frame(self.container, bg=self.BG)
        btn_frame.pack(fill="x")
        btn = self._make_button(btn_frame, "Continue  →", self._next_step)
        btn.pack(side="right")

    # ═══════════════════════════════════════════
    # STEP 4: Motivation Selection
    # ═══════════════════════════════════════════

    def _build_motivations(self):
        self._make_step_indicator()
        self._make_title("What Motivates You?", "🎯")
        self._make_subtitle(
            "Help JARVIS understand your priorities so it can focus on what matters most to you."
        )

        card = self._make_card()

        motivations = [
            ("save_time", "Save time on repetitive tasks"),
            ("never_miss", "Never miss important emails"),
            ("automate_calendar", "Automate calendar scheduling"),
            ("reduce_switching", "Reduce context switching"),
            ("automate_browser", "Automate browser tasks"),
        ]

        inner = tk.Frame(card, bg=self.CARD_BG)
        inner.pack(fill="both", expand=True, padx=20, pady=20)

        for key, label in motivations:
            var = tk.BooleanVar(value=False)
            self.motivation_vars[key] = (var, label)

            cb = ttk.Checkbutton(inner, text=label, variable=var,
                                 style="Wizard.TCheckbutton")
            cb.pack(anchor="w", pady=6)

        btn_frame = tk.Frame(self.container, bg=self.BG)
        btn_frame.pack(fill="x")

        back_btn = self._make_button(btn_frame, "←  Back",
                                     lambda: self._show_step(self.current_step - 1),
                                     primary=False)
        back_btn.pack(side="left")

        btn = self._make_button(btn_frame, "Continue  →", self._validate_motivations)
        btn.pack(side="right")

    def _validate_motivations(self):
        selected = [label for _, (var, label) in self.motivation_vars.items() if var.get()]
        if not selected:
            messagebox.showwarning("Selection Required",
                                   "Please select at least one motivation.")
            return
        self._next_step()

    # ═══════════════════════════════════════════
    # STEP 5: Personality Quiz
    # ═══════════════════════════════════════════

    def _build_personality(self):
        self._make_step_indicator()
        self._make_title("Personality Quiz", "🧠")
        self._make_subtitle(
            "These questions calibrate how JARVIS communicates and makes decisions on your behalf."
        )

        card = self._make_card()

        # Scrollable inner area
        canvas = tk.Canvas(card, bg=self.CARD_BG, highlightthickness=0)
        scrollbar = tk.Scrollbar(card, orient="vertical", command=canvas.yview)
        scroll_frame = tk.Frame(canvas, bg=self.CARD_BG)

        scroll_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        canvas.create_window((0, 0), window=scroll_frame, anchor="nw", width=620)
        canvas.configure(yscrollcommand=scrollbar.set)

        # Enable mousewheel scrolling
        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        canvas.pack(side="left", fill="both", expand=True, padx=(15, 0), pady=15)
        scrollbar.pack(side="right", fill="y", pady=15)

        questions = [
            ("email_style", "What's your preferred email style?", [
                "Very formal",
                "Friendly but professional",
                "Casual and direct",
                "Brief as possible",
            ]),
            ("task_handling", "How should non-urgent tasks be handled?", [
                "Handle immediately",
                "Batch for later",
                "Let the agent decide",
            ]),
            ("autonomy", "How much autonomy should the agent have?", [
                "Always ask before acting",
                "Act on routine things, ask on new",
                "Act on most things, flag big decisions",
                "Just handle it",
            ]),
            ("meeting_preference", "Meeting time preference?", [
                "Mornings only",
                "Afternoons only",
                "No preference",
                "Never before 10am",
                "Never after 4pm",
            ]),
        ]

        for key, question, options in questions:
            var = tk.StringVar(value=options[0])
            self.personality_vars[key] = var

            tk.Label(scroll_frame, text=question,
                     font=("Segoe UI", 12, "bold"),
                     fg=self.FG, bg=self.CARD_BG).pack(anchor="w", padx=10, pady=(15, 5))

            for opt in options:
                rb = ttk.Radiobutton(scroll_frame, text=opt, variable=var,
                                     value=opt, style="Wizard.TRadiobutton")
                rb.pack(anchor="w", padx=25, pady=2)

        btn_frame = tk.Frame(self.container, bg=self.BG)
        btn_frame.pack(fill="x")

        back_btn = self._make_button(btn_frame, "←  Back",
                                     lambda: self._show_step(self.current_step - 1),
                                     primary=False)
        back_btn.pack(side="left")

        btn = self._make_button(btn_frame, "Finish Setup  ✓", self._finish_setup)
        btn.pack(side="right")

    # ═══════════════════════════════════════════
    # STEP 6: Completion
    # ═══════════════════════════════════════════

    def _build_completion(self):
        self._make_step_indicator()
        self._make_title("Setup Complete!", "✅")
        self._make_subtitle(
            "JARVIS is configured and ready to go. The agent will now start "
            "running silently in your system tray."
        )

        card = self._make_card()
        inner = tk.Frame(card, bg=self.CARD_BG)
        inner.pack(fill="both", expand=True, padx=20, pady=20)

        name = self.name_var.get().strip()
        integrations = [k for k, v in self.integration_vars.items() if v.get()]
        motivations = [label for _, (var, label) in self.motivation_vars.items() if var.get()]

        summary_lines = [
            f"👤  Name: {name}",
            f"🔌  Integrations: {', '.join(integrations) or 'None'}",
            f"🎯  Motivations: {', '.join(motivations) or 'None'}",
            f"✉️  Email style: {self.personality_vars['email_style'].get()}",
            f"📋  Task handling: {self.personality_vars['task_handling'].get()}",
            f"🤖  Autonomy: {self.personality_vars['autonomy'].get()}",
            f"📅  Meeting pref: {self.personality_vars['meeting_preference'].get()}",
        ]

        for line in summary_lines:
            tk.Label(inner, text=line,
                     font=("Segoe UI", 11),
                     fg=self.FG, bg=self.CARD_BG,
                     anchor="w").pack(anchor="w", pady=3)

        tk.Label(inner, text="",  bg=self.CARD_BG).pack(pady=5)
        tk.Label(inner, text="Files written: config.json, profile.json, behavioral_log.json, macros.json",
                 font=("Segoe UI", 10, "italic"),
                 fg=self.SUCCESS, bg=self.CARD_BG).pack(anchor="w")

        btn_frame = tk.Frame(self.container, bg=self.BG)
        btn_frame.pack(fill="x")
        btn = self._make_button(btn_frame, "Launch JARVIS  🚀", self._close_wizard)
        btn.pack(side="right")

    # ═══════════════════════════════════════════
    # Data persistence
    # ═══════════════════════════════════════════

    def _finish_setup(self):
        """Collect all wizard data, write JSON files, show completion."""
        name = self.name_var.get().strip()
        integrations = [k for k, v in self.integration_vars.items() if v.get()]
        motivations = [label for _, (var, label) in self.motivation_vars.items() if var.get()]
        personality = {k: v.get() for k, v in self.personality_vars.items()}
        agent_seed = secrets.token_hex(16)

        # OAuth flags — only for selected integrations
        oauth_flags = {}
        oauth_map = {
            "gmail": "google_oauth_complete",
            "google_calendar": "google_oauth_complete",
            "slack": "slack_oauth_complete",
        }
        for integ in integrations:
            flag = oauth_map.get(integ)
            if flag and flag not in oauth_flags:
                oauth_flags[flag] = self.oauth_complete if flag == "google_oauth_complete" else False

        # ── config.json ──
        config = {
            "agent_seed": agent_seed,
            "integrations": integrations,
            **oauth_flags,
        }

        # ── profile.json ──
        profile = {
            "name": name,
            "motivations": motivations,
            "personality": personality,
        }

        # ── Write all files ──
        files = {
            "config.json": config,
            "profile.json": profile,
            "behavioral_log.json": [],
            "macros.json": {},
        }
        for filename, data in files.items():
            path = os.path.join(BASE_DIR, filename)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)

        self.completed = True
        self._next_step()

    def _close_wizard(self):
        """Close the wizard window and signal the main process to launch the agent."""
        self.root.destroy()

    # ═══════════════════════════════════════════
    # Public API
    # ═══════════════════════════════════════════

    def run(self):
        """Start the tkinter main loop. Returns True if setup completed."""
        self.root.mainloop()
        return self.completed


# ─────────────────────────────────────────────
# Entry point (used when running setup.py directly for testing)
# ─────────────────────────────────────────────

def run_onboarding():
    """Public function called by orchestrator.py on first run."""
    wizard = OnboardingWizard()
    return wizard.run()


if __name__ == "__main__":
    completed = run_onboarding()
    if completed:
        print("✅  Onboarding complete. Config files written.")
    else:
        print("❌  Onboarding cancelled.")
