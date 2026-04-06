"""
ClapStartup installer — installs dependencies and registers auto-start.

Usage:
    python install.py              Install deps + create startup entry
    python install.py --uninstall  Remove the startup entry
"""

import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STARTUP_FOLDER = os.path.join(
    os.environ.get("APPDATA", ""),
    r"Microsoft\Windows\Start Menu\Programs\Startup",
)
VBS_NAME = "ClapStartup.vbs"
VBS_PATH = os.path.join(STARTUP_FOLDER, VBS_NAME)


def install_dependencies():
    """Install Python packages from requirements.txt."""
    req = os.path.join(SCRIPT_DIR, "requirements.txt")
    print("Installing dependencies …")
    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "-r", req],
    )
    print("Dependencies installed.\n")


def create_startup_entry():
    """Create a .vbs script in the Windows Startup folder.

    The .vbs wrapper launches pythonw.exe (no console window) silently.
    """
    pythonw = sys.executable.replace("python.exe", "pythonw.exe")
    if not os.path.isfile(pythonw):
        # Fall back to python.exe if pythonw is not available
        pythonw = sys.executable

    main_script = os.path.join(SCRIPT_DIR, "clap_startup.py")

    vbs_content = (
        'Set WshShell = CreateObject("WScript.Shell")\n'
        f'WshShell.Run """{pythonw}"" ""{main_script}""", 0, False\n'
    )

    with open(VBS_PATH, "w", encoding="utf-8") as f:
        f.write(vbs_content)

    print(f"Startup entry created: {VBS_PATH}")
    print("ClapStartup will run automatically on next login.\n")


def remove_startup_entry():
    """Remove the startup .vbs file."""
    if os.path.isfile(VBS_PATH):
        os.remove(VBS_PATH)
        print(f"Removed: {VBS_PATH}")
    else:
        print("No startup entry found — nothing to remove.")


def main():
    if "--uninstall" in sys.argv:
        remove_startup_entry()
        return

    install_dependencies()
    create_startup_entry()
    print("Done! You can also run clap_startup.py manually to test:")
    print(f"  python \"{os.path.join(SCRIPT_DIR, 'clap_startup.py')}\"")


if __name__ == "__main__":
    main()
