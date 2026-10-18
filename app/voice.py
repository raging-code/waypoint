"""Text-to-speech on the device itself (Raspberry Pi speaker, or your PC's speakers).

No Python packages needed - it uses whatever speech tool the OS already has:
    Raspberry Pi / Linux  espeak-ng (install: sudo apt install espeak-ng)
    Windows               built-in SAPI voice through PowerShell
    macOS                 'say'
"""
from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import threading
from typing import List, Optional, Tuple

log = logging.getLogger("waypoint.voice")


def _detect() -> Tuple[Optional[str], Optional[List[str]]]:
    system = platform.system()
    if system == "Windows":
        ps = shutil.which("powershell") or shutil.which("pwsh")
        if ps:
            script = (
                "Add-Type -AssemblyName System.Speech; "
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                "$s.Speak($env:WAYPOINT_SPEECH)"
            )
            return "windows-sapi", [ps, "-NoProfile", "-NonInteractive", "-Command", script]
        return None, None
    if system == "Darwin" and shutil.which("say"):
        return "say", ["say"]
    for tool in ("espeak-ng", "espeak"):
        if shutil.which(tool):
            return tool, [tool, "-s", "150"]
    if shutil.which("spd-say"):
        return "spd-say", ["spd-say", "-w"]
    return None, None


class Voice:
    def __init__(self, enabled: bool = True):
        self.backend: Optional[str] = None
        self._cmd: Optional[List[str]] = None
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        if enabled:
            self.backend, self._cmd = _detect()
        log.info("Voice backend: %s", self.backend or "none")

    @property
    def available(self) -> bool:
        return self._cmd is not None

    def speak(self, text: str) -> bool:
        if not self._cmd or not text:
            return False
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                self._proc.terminate()  # cut off the previous announcement
            env = dict(os.environ, WAYPOINT_SPEECH=text)
            if self.backend == "windows-sapi":
                cmd = list(self._cmd)
            else:
                cmd = list(self._cmd) + [text]
            try:
                self._proc = subprocess.Popen(
                    cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                return True
            except Exception as exc:
                log.warning("Voice error: %s", exc)
                return False
