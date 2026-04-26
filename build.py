"""
build.py — PyInstaller build script for the JARVIS desktop application.

Produces a single-file executable with no console window.
Works on both Windows (.exe) and Mac (.app).

Usage:
    python build.py

Output:
    dist/orchestrator.exe   (Windows)
    dist/orchestrator        (Mac/Linux)
"""

import platform
import subprocess
import sys
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def build():
    """Build the JARVIS desktop application with PyInstaller."""

    # Ensure PyInstaller is installed
    try:
        import PyInstaller
    except ImportError:
        print("⚠  PyInstaller not found. Installing...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])

    entry_script = os.path.join(BASE_DIR, "orchestrator.py")
    icon_file = os.path.join(BASE_DIR, "icon.png")

    # ── PyInstaller arguments ──
    args = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--noconsole",
        "--windowed",
        "--name", "JarvisAgent",

        # Bundle the icon into the exe so the tray can load it
        "--add-data", f"{icon_file}{os.pathsep}.",

        # Bundle setup.py so orchestrator can import it on first run
        "--add-data", f"{os.path.join(BASE_DIR, 'setup.py')}{os.pathsep}.",

        # ── Hidden imports ──
        # uagents and its transitive deps
        "--hidden-import", "uagents",
        "--hidden-import", "uagents.agent",
        "--hidden-import", "uagents.context",
        "--hidden-import", "uagents.protocol",
        "--hidden-import", "uagents.models",
        "--hidden-import", "uagents.envelope",
        "--hidden-import", "uagents.resolver",
        "--hidden-import", "uagents.network",
        "--hidden-import", "uagents.config",
        "--hidden-import", "uagents.dispatch",
        "--hidden-import", "uagents_core",
        "--hidden-import", "uagents_core.contrib.protocols.chat",
        "--hidden-import", "uagents_core.models",

        # Google Auth
        "--hidden-import", "google.auth",
        "--hidden-import", "google.auth.transport.requests",
        "--hidden-import", "google.oauth2.credentials",
        "--hidden-import", "google_auth_oauthlib",
        "--hidden-import", "google_auth_oauthlib.flow",
        "--hidden-import", "googleapiclient",
        "--hidden-import", "googleapiclient.discovery",

        # System tray
        "--hidden-import", "pystray",
        "--hidden-import", "pystray._win32" if platform.system() == "Windows" else "pystray._darwin",
        "--hidden-import", "PIL",
        "--hidden-import", "PIL.Image",

        # tkinter (usually bundled, but be explicit)
        "--hidden-import", "tkinter",
        "--hidden-import", "tkinter.ttk",
        "--hidden-import", "tkinter.messagebox",

        # Networking / async deps often needed by uagents
        "--hidden-import", "aiohttp",
        "--hidden-import", "cosmpy",
        "--hidden-import", "cosmpy.aerial",
        "--hidden-import", "cosmpy.crypto",
        "--hidden-import", "bech32",
        "--hidden-import", "ecdsa",
        "--hidden-import", "msgpack",
        "--hidden-import", "uvloop" if platform.system() != "Windows" else "asyncio",

        # Collect all uagents data files
        "--collect-all", "uagents",
        "--collect-all", "uagents_core",
        "--collect-all", "cosmpy",

        # Output directory
        "--distpath", os.path.join(BASE_DIR, "dist"),
        "--workpath", os.path.join(BASE_DIR, "build"),
        "--specpath", BASE_DIR,

        # Clean build
        "--clean",
        "-y",

        entry_script,
    ]

    print("=" * 60)
    print("  🔨  Building JARVIS Desktop Application")
    print("=" * 60)
    print()
    print(f"  Platform:     {platform.system()} {platform.machine()}")
    print(f"  Entry point:  {entry_script}")
    print(f"  Icon:         {icon_file}")
    print(f"  Output:       {os.path.join(BASE_DIR, 'dist')}")
    print()
    print("-" * 60)
    print()

    result = subprocess.run(args, cwd=BASE_DIR)

    if result.returncode == 0:
        print()
        print("=" * 60)
        print("  ✅  Build successful!")
        print()
        if platform.system() == "Windows":
            print(f"  Output: dist/JarvisAgent.exe")
        else:
            print(f"  Output: dist/JarvisAgent")
        print()
        print("  Distribute this file. Users double-click to run.")
        print("  No Python installation required on the target machine.")
        print("=" * 60)
    else:
        print()
        print("❌  Build failed. Check the output above for errors.")
        sys.exit(1)


if __name__ == "__main__":
    build()
