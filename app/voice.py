"""Text-to-speech on the device itself (Raspberry Pi speaker, or your PC's speakers).

Two backends, tried in this order:

  1. Piper (neural, natural-sounding) - used when PIPER_MODEL in .env points at a
     downloaded .onnx voice (get one from https://huggingface.co/rhasspy/piper-voices,
     grab both the .onnx and the matching .onnx.json). Needs: pip install piper-tts
  2. The OS's own voice (robotic, but needs nothing extra):
       Raspberry Pi / Linux  espeak-ng (install: sudo apt install espeak-ng)
       Windows               built-in SAPI voice through PowerShell
       macOS                 'say'

If Piper isn't configured, or fails to load, Waypoint quietly falls back to the OS
voice - nothing breaks.

Settings (optional, put them in .env):
    PIPER_MODEL=piper-voices/en_US-ryan-medium.onnx   path to the voice model
    PIPER_SPEED=1.0                                   1.0 normal, >1 slower, <1 faster
"""
from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import tempfile
import threading
import wave
from typing import List, Optional, Tuple

log = logging.getLogger("waypoint.voice")


def _detect_os_voice() -> Tuple[Optional[str], Optional[List[str]]]:
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


def _wav_player_cmd(path: str) -> Optional[List[str]]:
    """A short-lived command that plays one WAV file and exits, or None if none is available."""
    system = platform.system()
    if system == "Windows":
        ps = shutil.which("powershell") or shutil.which("pwsh")
        if ps:
            script = (
                f"(New-Object Media.SoundPlayer '{path}').PlaySync()"
            )
            return [ps, "-NoProfile", "-NonInteractive", "-Command", script]
        return None
    if system == "Darwin" and shutil.which("afplay"):
        return ["afplay", path]
    for tool in ("paplay", "aplay", "ffplay"):
        which = shutil.which(tool)
        if which:
            if tool == "ffplay":
                return [which, "-nodisp", "-autoexit", "-loglevel", "quiet", path]
            return [which, path]
    return None


class _PiperBackend:
    """Wraps a loaded Piper voice. Raises on construction if it cannot be set up."""

    def __init__(self, model_path: str, speed: float) -> None:
        from piper import PiperVoice  # imported lazily: optional dependency
        from piper.config import SynthesisConfig

        self.voice = PiperVoice.load(model_path)
        self.syn_config = SynthesisConfig(length_scale=speed if speed > 0 else 1.0)

    def synth_to_wav(self, text: str, path: str) -> None:
        with wave.open(path, "wb") as wav_file:
            self.voice.synthesize_wav(text, wav_file, syn_config=self.syn_config)


class Voice:
    def __init__(self, enabled: bool = True, piper_model: str = "", piper_speed: float = 1.0):
        self.backend: Optional[str] = None
        self._cmd: Optional[List[str]] = None
        self._piper: Optional[_PiperBackend] = None
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

        if enabled and piper_model:
            if not os.path.isfile(piper_model):
                log.warning("PIPER_MODEL is set but the file was not found: %s - falling back.", piper_model)
            else:
                try:
                    self._piper = _PiperBackend(piper_model, piper_speed)
                    name = os.path.splitext(os.path.basename(piper_model))[0]
                    self.backend = f"piper ({name})"
                except Exception as exc:  # piper-tts not installed, bad model file, etc.
                    log.warning("Could not load Piper voice (%s) - falling back to the OS voice: %s", piper_model, exc)

        if enabled and self._piper is None:
            self.backend, self._cmd = _detect_os_voice()

        log.info("Voice backend: %s", self.backend or "none")

    @property
    def available(self) -> bool:
        return self._piper is not None or self._cmd is not None

    def speak(self, text: str) -> bool:
        if not self.available or not text:
            return False
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                self._proc.terminate()  # cut off the previous announcement
            if self._piper is not None:
                return self._speak_piper(text)
            return self._speak_os(text)

    # -- Piper: synthesize to a temp WAV, then play it with a short OS command --
    def _speak_piper(self, text: str) -> bool:
        try:
            fd, path = tempfile.mkstemp(suffix=".wav", prefix="waypoint-speech-")
            os.close(fd)
            self._piper.synth_to_wav(text, path)
            play_cmd = _wav_player_cmd(path)
            if not play_cmd:
                log.warning("Piper rendered speech but no audio player was found on this OS.")
                return False
            self._proc = subprocess.Popen(
                play_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            threading.Thread(target=self._cleanup_after, args=(self._proc, path), daemon=True).start()
            return True
        except Exception as exc:
            log.warning("Piper voice error: %s", exc)
            return False

    @staticmethod
    def _cleanup_after(proc: "subprocess.Popen", path: str) -> None:
        try:
            proc.wait(timeout=30)
        except Exception:
            pass
        try:
            os.remove(path)
        except OSError:
            pass

    # -- OS voice (espeak-ng / SAPI / say) - unchanged behaviour --
    def _speak_os(self, text: str) -> bool:
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
