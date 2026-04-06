"""
ClapStartup — Say "It's time to work" to launch your dev environment.

Listens continuously via the microphone (offline, no internet needed). On hearing
the trigger phrase:
  1. Opens VS Code with the most recently worked-in folder
  2. Activates the Claude Code extension
  3. Plays "The World We Knew (Over And Over).mp3" on loop

Click the Stop Music button or use the tray menu to stop the music.
"""

import difflib
import json
import logging
import logging.handlers
import os
import queue
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.parse

import sounddevice as sd

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STORAGE_JSON = os.path.join(
    os.environ.get("APPDATA", ""),
    r"Code\User\globalStorage\storage.json",
)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MP3_PATH = os.path.join(SCRIPT_DIR, "The World We Knew (Over And Over).mp3")
LOG_PATH = os.path.join(SCRIPT_DIR, "clap_startup.log")

VOSK_SAMPLE_RATE = 16000   # vosk works at 16 kHz
VOSK_BLOCK_SIZE = 4000     # samples per callback chunk (~250 ms)

TRIGGER_PHRASE = "it's time to work"
PHRASE_MATCH_THRESHOLD = 0.60  # fuzzy similarity required (0–1)
COOLDOWN_AFTER_TRIGGER = 5.0   # seconds — ignore further phrases after trigger

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log = logging.getLogger("ClapStartup")
log.setLevel(logging.DEBUG)
_handler = logging.handlers.RotatingFileHandler(
    LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8"
)
_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
log.addHandler(_handler)

if sys.stderr and hasattr(sys.stderr, "write"):
    _console = logging.StreamHandler(sys.stderr)
    _console.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
    log.addHandler(_console)

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_music_playing = False
_last_trigger_time: float = 0.0
_tray_icon = None
_stop_button_root: tk.Tk | None = None
_audio_queue: queue.Queue = queue.Queue()

# ---------------------------------------------------------------------------
# Phrase matching
# ---------------------------------------------------------------------------

_PHRASE_NORM = re.sub(r"[^\w\s]", "", TRIGGER_PHRASE.lower())


def _phrase_matches(text: str) -> bool:
    """Return True if *text* is similar enough to the trigger phrase."""
    text_norm = re.sub(r"[^\w\s]", "", text.lower())

    # Exact substring hit
    if _PHRASE_NORM in text_norm:
        return True

    # Sliding-window fuzzy match over same-length spans of words
    phrase_words = _PHRASE_NORM.split()
    text_words = text_norm.split()
    n = len(phrase_words)
    for i in range(max(1, len(text_words) - n + 1)):
        window = " ".join(text_words[i : i + n])
        ratio = difflib.SequenceMatcher(None, _PHRASE_NORM, window).ratio()
        if ratio >= PHRASE_MATCH_THRESHOLD:
            log.debug("Phrase match ratio=%.2f for %r", ratio, window)
            return True

    return False

# ---------------------------------------------------------------------------
# VS Code recent folder
# ---------------------------------------------------------------------------


def get_recent_vscode_folder() -> str | None:
    """Return the most recently active VS Code folder path, or None."""
    try:
        with open(STORAGE_JSON, encoding="utf-8") as f:
            data = json.load(f)

        folder_uri = (
            data.get("windowsState", {})
            .get("lastActiveWindow", {})
            .get("folder")
        )
        if not folder_uri:
            opened = data.get("windowsState", {}).get("openedWindows", [])
            if opened:
                folder_uri = opened[0].get("folder")

        if not folder_uri:
            log.warning("No recent folder found in storage.json")
            return None

        path = folder_uri
        if path.startswith("file:///"):
            path = path[len("file:///"):]
        path = urllib.parse.unquote(path)
        path = os.path.normpath(path)
        log.info("Recent VS Code folder: %s", path)
        return path

    except FileNotFoundError:
        log.warning("VS Code storage.json not found: %s", STORAGE_JSON)
    except Exception:
        log.exception("Failed to read VS Code storage.json")
    return None


# ---------------------------------------------------------------------------
# VS Code launch
# ---------------------------------------------------------------------------


def launch_vscode(folder: str) -> None:
    log.info("Launching VS Code: %s", folder)
    try:
        subprocess.Popen(["code", folder], shell=True)
    except Exception:
        log.exception("Failed to launch VS Code")
        return

    def _activate_claude_code():
        time.sleep(5)
        try:
            subprocess.Popen(
                ["code", "--command", "claude-code.openInNewTab"], shell=True
            )
            log.info("Sent command to open Claude Code tab")
        except Exception:
            log.exception("Failed to activate Claude Code extension")

    threading.Thread(target=_activate_claude_code, daemon=True).start()


# ---------------------------------------------------------------------------
# Floating "Stop Music" button
# ---------------------------------------------------------------------------


def _show_stop_button():
    global _stop_button_root

    def _run():
        global _stop_button_root
        root = tk.Tk()
        _stop_button_root = root
        root.title("ClapStartup")
        root.attributes("-topmost", True)
        root.resizable(False, False)

        root.update_idletasks()
        screen_w = root.winfo_screenwidth()
        screen_h = root.winfo_screenheight()
        root.geometry(f"+{screen_w - 220}+{screen_h - 120}")

        btn = tk.Button(
            root,
            text="Stop Music",
            font=("Segoe UI", 14, "bold"),
            bg="#ef4444",
            fg="white",
            activebackground="#dc2626",
            activeforeground="white",
            padx=20,
            pady=10,
            cursor="hand2",
            command=lambda: threading.Thread(target=stop_music, daemon=True).start(),
        )
        btn.pack(padx=10, pady=10)

        root.protocol(
            "WM_DELETE_WINDOW",
            lambda: threading.Thread(target=stop_music, daemon=True).start(),
        )
        root.mainloop()

    threading.Thread(target=_run, daemon=True).start()


def _hide_stop_button():
    global _stop_button_root
    root = _stop_button_root
    if root is not None:
        try:
            root.after(0, root.destroy)
        except Exception:
            pass
        _stop_button_root = None


# ---------------------------------------------------------------------------
# MP3 playback (pygame.mixer)
# ---------------------------------------------------------------------------

_pygame_inited = False


def _ensure_pygame():
    global _pygame_inited
    if not _pygame_inited:
        import pygame
        pygame.mixer.init()
        _pygame_inited = True


def start_music() -> bool:
    global _music_playing
    if not os.path.isfile(MP3_PATH):
        log.error("MP3 not found: %s", MP3_PATH)
        return False
    try:
        import pygame
        _ensure_pygame()
        pygame.mixer.music.load(MP3_PATH)
        pygame.mixer.music.play(loops=-1)
        with _lock:
            _music_playing = True
        log.info("Music started (looping)")
        _update_tray_icon()
        _show_stop_button()
        return True
    except Exception:
        log.exception("Failed to start music")
        return False


def stop_music() -> None:
    global _music_playing, _pygame_inited
    try:
        import pygame
        if _pygame_inited and pygame.mixer.get_init():
            pygame.mixer.music.stop()
            pygame.mixer.quit()
            _pygame_inited = False
    except Exception:
        log.exception("Error stopping music")
    with _lock:
        _music_playing = False
    log.info("Music stopped")
    _hide_stop_button()
    _update_tray_icon()


# ---------------------------------------------------------------------------
# Action orchestration
# ---------------------------------------------------------------------------


def trigger_actions() -> None:
    log.info("Trigger phrase detected → launching environment")
    folder = get_recent_vscode_folder()
    if folder:
        launch_vscode(folder)
    time.sleep(2)
    start_music()


# ---------------------------------------------------------------------------
# Voice recognition (vosk, offline)
# ---------------------------------------------------------------------------


def _audio_callback(indata, frames, time_info, status):
    """Push raw mic bytes into the queue for the recognition thread."""
    if status:
        log.debug("Audio status: %s", status)
    _audio_queue.put(bytes(indata))


def _load_vosk_model():
    """Load (and auto-download if needed) the small English vosk model."""
    try:
        import vosk
        vosk.SetLogLevel(-1)  # suppress verbose vosk output
        log.info("Loading vosk model (downloads ~50 MB on first run) …")
        print("Loading speech recognition model (downloads ~50 MB on first run) …")
        model = vosk.Model(lang="en-us")
        log.info("Vosk model ready")
        return model
    except Exception:
        log.exception("Failed to load vosk model")
        return None


def _recognition_loop(model) -> None:
    """Continuously transcribe mic audio and fire trigger on phrase match."""
    global _last_trigger_time
    import vosk

    rec = vosk.KaldiRecognizer(model, VOSK_SAMPLE_RATE)

    with sd.RawInputStream(
        samplerate=VOSK_SAMPLE_RATE,
        blocksize=VOSK_BLOCK_SIZE,
        dtype="int16",
        channels=1,
        callback=_audio_callback,
    ):
        log.info("Listening for: %r", TRIGGER_PHRASE)
        print(f'Listening for: "{TRIGGER_PHRASE}"')

        while True:
            data = _audio_queue.get()
            if not rec.AcceptWaveform(data):
                continue  # partial result — wait for full utterance

            result = json.loads(rec.Result())
            text = result.get("text", "").strip()
            if not text:
                continue

            log.debug("Heard: %r", text)

            now = time.time()
            with _lock:
                last_trigger = _last_trigger_time

            if (now - last_trigger) < COOLDOWN_AFTER_TRIGGER:
                continue  # still in cooldown

            if _phrase_matches(text):
                log.info("Phrase matched: %r", text)
                with _lock:
                    _last_trigger_time = time.time()
                threading.Thread(target=trigger_actions, daemon=True).start()


# ---------------------------------------------------------------------------
# System tray icon
# ---------------------------------------------------------------------------


def _create_icon_image(color: str):
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    fill = (34, 197, 94) if color == "green" else (239, 68, 68)
    draw.ellipse([4, 4, size - 4, size - 4], fill=fill)
    return img


def _update_tray_icon():
    if _tray_icon is None:
        return
    with _lock:
        playing = _music_playing
    color = "red" if playing else "green"
    _tray_icon.icon = _create_icon_image(color)
    _tray_icon.title = "ClapStartup — Playing" if playing else "ClapStartup — Listening"


def _on_stop_music(icon, item):
    stop_music()


def _on_quit(icon, item):
    log.info("Quit requested from tray menu")
    stop_music()
    icon.stop()


def run_tray_icon():
    global _tray_icon
    import pystray

    _tray_icon = pystray.Icon(
        name="ClapStartup",
        icon=_create_icon_image("green"),
        title="ClapStartup — Listening",
        menu=pystray.Menu(
            pystray.MenuItem("Stop Music", _on_stop_music),
            pystray.MenuItem("Quit", _on_quit),
        ),
    )
    _tray_icon.run()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    log.info("=" * 60)
    log.info("ClapStartup starting")

    # Verify microphone
    try:
        default_input = sd.query_devices(kind="input")
        log.info("Microphone: %s", default_input["name"])
    except Exception:
        log.exception("No microphone found")
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0,
                "No microphone found. ClapStartup cannot run.",
                "ClapStartup Error",
                0x10,
            )
        except Exception:
            pass
        sys.exit(1)

    # Load speech recognition model
    model = _load_vosk_model()
    if model is None:
        log.error("Could not load vosk model — exiting")
        sys.exit(1)

    # Start recognition loop in background thread
    threading.Thread(
        target=_recognition_loop, args=(model,), daemon=True
    ).start()

    # System tray (blocks main thread)
    try:
        run_tray_icon()
    except KeyboardInterrupt:
        log.info("Interrupted")
    finally:
        stop_music()
        log.info("ClapStartup stopped")


if __name__ == "__main__":
    main()
