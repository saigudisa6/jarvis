# 🤖 JARVIS — Personal Agentic Desktop Assistant

A locally-run AI orchestration agent packaged as a standalone desktop application. Download the executable, double-click it, and you're done — no Python or coding knowledge required. On first launch, a setup wizard walks you through connecting your Google account, choosing integrations, and calibrating the agent's personality. After that, JARVIS runs silently in your system tray, monitoring Gmail and Google Calendar, taking autonomous actions on your behalf, and staying connected to the Fetch.ai Agentverse network so it can communicate with other agents and ASI:One. All your personal data stays on your machine.

## Quick Start

1. **Download** `JarvisAgent.exe` (Windows) or `JarvisAgent` (Mac) from the releases
2. **Double-click** — the setup wizard opens on first launch
3. **Follow the wizard** — name, Google sign-in, integrations, personality quiz
4. **Done** — JARVIS runs in your system tray and starts on every boot

## For Developers

### Prerequisites

- Python 3.10+
- `pip install -r requirements.txt`

### Run from source

```bash
python orchestrator.py
```

First run triggers the onboarding wizard. Subsequent runs go straight to the background agent.

### Build the executable

```bash
python build.py
```

Output: `dist/JarvisAgent.exe` (Windows) or `dist/JarvisAgent` (Mac)

## File Structure

| File | Purpose |
|---|---|
| `orchestrator.py` | Main entry point — first-run detection, system tray, agent with all integration hooks |
| `setup.py` | Tkinter onboarding wizard — writes config files on first launch |
| `build.py` | PyInstaller build script — produces a single portable executable |
| `icon.png` | System tray icon |
| `requirements.txt` | Python dependencies |
| `config.json` | *(generated)* Agent seed, enabled integrations, OAuth flags |
| `profile.json` | *(generated)* User name, motivations, personality preferences |
| `behavioral_log.json` | *(generated)* Action log — tracks everything the agent does |
| `macros.json` | *(generated)* Browser macro definitions |

## Teammate Integration Guide

Each integration has a clearly labeled section in `orchestrator.py` with `Person N: START YOUR CODE HERE` / `END YOUR CODE HERE` markers:

| Hook | Owner | Section |
|---|---|---|
| `check_gmail()` | **Person 1** | Gmail Integration |
| `check_calendar()` | **Person 2** | Google Calendar Integration |
| `check_slack()` | **Person 3** | Slack Integration |
| `handle_chat()` | **Person 4** | Chat Protocol |

Every polling hook:
1. Gates on `config["integrations"]` — won't run unless the user enabled it
2. Should call `await reason_and_act(data, ctx)` after fetching data
3. Runs every 60 seconds automatically via `@agent.on_interval`

## Architecture

- **Single executable** — no installer, no Python required on target machine
- **First-run wizard** — tkinter GUI, writes all config files
- **System tray** — pystray icon with status, activity log viewer, and quit
- **Auto-startup** — registers itself to run on boot (Windows Registry / Mac LaunchAgent)
- **Agentverse** — registered via unique agent_seed, discoverable on Fetch.ai network
- **Chat Protocol** — ASI:One and other agents can message this agent
- **Privacy-first** — all data stored locally next to the executable

## License

MIT
