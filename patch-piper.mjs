#!/usr/bin/env node
/**
 * Waypoint Piper voice patch: speak with a Piper neural voice (e.g. Ryan)
 * instead of the robotic OS voice (espeak-ng / Windows SAPI / macOS "say").
 *
 * What changes:
 *   - app/voice.py: adds a Piper backend. If a Piper model is configured and
 *     found, it is used; otherwise Waypoint falls back to the OS voice exactly
 *     as before, so nothing breaks for anyone who hasn't set Piper up.
 *   - app/config.py: adds two settings read from .env -
 *       PIPER_MODEL   path to the .onnx voice model (its .onnx.json must sit
 *                     next to it - that's how Piper already saves it)
 *       PIPER_SPEED   optional, 1.0 = normal, >1 slower, <1 faster (default 1.0)
 *   - app/service.py: passes those settings into Voice(...).
 *   - requirements.txt: adds piper-tts.
 *   - .env: if PIPER_MODEL isn't already set, this patch adds a line pointing
 *     at piper-voices/en_US-ryan-medium.onnx (edit it if your model lives
 *     somewhere else, or if you'd rather use a different voice).
 *
 * Setup (once):
 *   .venv\Scripts\pip install piper-tts        (Windows)
 *   .venv/bin/pip install piper-tts            (Linux / Raspberry Pi / macOS)
 *
 * Usage (run from the Waypoint folder, the one that contains run.py):
 *
 *   node patch-piper.mjs            apply the patch
 *   node patch-piper.mjs --revert   undo it
 *   node patch-piper.mjs <folder>   patch a project in another folder
 *
 * Safe to run twice. Nothing is written unless every edit matches exactly.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const folderArg = args.find((a) => !a.startsWith("-"));
const root = resolve(folderArg ?? dirname(fileURLToPath(import.meta.url)));

const FILES = {
  voice: join(root, "app", "voice.py"),
  config: join(root, "app", "config.py"),
  requirements: join(root, "requirements.txt"),
};
// service.py is patched conditionally (see below) but still needs to be
// restored on --revert if it exists and was touched.
const SERVICE_FILE_PATH = join(root, "app", "service.py");
const ENV_FILE = join(root, ".env");
const BACKUP = ".bak-piper";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

for (const path of Object.values(FILES)) {
  if (!existsSync(path)) {
    fail(
      `Cannot find ${path}\n` +
      `Run this script from the Waypoint folder (the one containing run.py), ` +
      `or pass the folder: node patch-piper.mjs <folder>`
    );
  }
}

// ---------------------------------------------------------------- revert
if (revert) {
  let restored = 0;
  const allPaths = [...Object.values(FILES), SERVICE_FILE_PATH];
  for (const path of allPaths) {
    if (existsSync(path + BACKUP)) {
      copyFileSync(path + BACKUP, path);
      unlinkSync(path + BACKUP);
      console.log(`Restored ${path}`);
      restored++;
    }
  }
  console.log(
    restored
      ? "\nReverted. (The PIPER_MODEL line added to .env, if any, was left alone - remove it by hand if you want.)"
      : "\nNothing to revert (no .bak-piper files found)."
  );
  process.exit(0);
}

// ---------------------------------------------------------------- new file: app/voice.py
const VOICE_PY = String.raw`"""Text-to-speech on the device itself (Raspberry Pi speaker, or your PC's speakers).

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
`;

// ---------------------------------------------------------------- apply
const texts = {};
for (const key of Object.keys(FILES)) {
  texts[key] = readFileSync(FILES[key], "utf8");
}

if (texts.voice.includes("_PiperBackend")) {
  console.log("Already patched. Nothing to do. (Use --revert to undo.)");
  process.exit(0);
}

// -- config.py edits --------------------------------------------------------
const CONFIG_EDITS = [
  {
    find: `    # Voice
    voice_enabled: bool`,
    replace: `    # Voice
    voice_enabled: bool
    piper_model: str
    piper_speed: float`,
  },
  {
    find: `            voice_enabled=_bool("VOICE_ENABLED", True),`,
    replace:
`            voice_enabled=_bool("VOICE_ENABLED", True),
            piper_model=_str("PIPER_MODEL", ""),
            piper_speed=_float("PIPER_SPEED", 1.0),`,
  },
];

for (const { find, replace } of CONFIG_EDITS) {
  const count = texts.config.split(find).length - 1;
  if (count === 0) {
    fail(`Could not find the expected text in ${FILES.config}. This file may already differ from what this patch expects. Nothing was changed.`);
  }
  if (count > 1) {
    fail(`Found more than one match for an edit in ${FILES.config}. Nothing was changed.`);
  }
  texts.config = texts.config.split(find).join(replace);
}

// -- requirements.txt edit ---------------------------------------------------
if (!texts.requirements.includes("piper-tts")) {
  const trimmed = texts.requirements.replace(/\s+$/, "");
  texts.requirements = trimmed + "\npiper-tts>=1.2\n";
}

// -- back up + write ----------------------------------------------------------
for (const key of Object.keys(FILES)) {
  const path = FILES[key];
  if (!existsSync(path + BACKUP)) {
    copyFileSync(path, path + BACKUP);
  }
}
writeFileSync(FILES.voice, VOICE_PY, "utf8");
console.log(`Patched ${FILES.voice}`);
writeFileSync(FILES.config, texts.config, "utf8");
console.log(`Patched ${FILES.config}`);
writeFileSync(FILES.requirements, texts.requirements, "utf8");
console.log(`Patched ${FILES.requirements}`);

// -- service.py: pass the new settings into Voice() --------------------------
if (existsSync(SERVICE_FILE_PATH)) {
  const serviceText = readFileSync(SERVICE_FILE_PATH, "utf8");
  const oldCall = `self.voice = Voice(cfg.voice_enabled)`;
  const newCall = `self.voice = Voice(cfg.voice_enabled, piper_model=cfg.piper_model, piper_speed=cfg.piper_speed)`;
  if (serviceText.includes(newCall)) {
    // already patched (re-run) - nothing to do here
  } else if (serviceText.includes(oldCall)) {
    if (!existsSync(SERVICE_FILE_PATH + BACKUP)) {
      copyFileSync(SERVICE_FILE_PATH, SERVICE_FILE_PATH + BACKUP);
    }
    writeFileSync(SERVICE_FILE_PATH, serviceText.split(oldCall).join(newCall), "utf8");
    console.log(`Patched ${SERVICE_FILE_PATH}`);
  } else {
    fail(`Could not find "${oldCall}" in ${SERVICE_FILE_PATH}. This file may already differ from what this patch expects. Nothing further was changed (voice.py, config.py and requirements.txt were already written - run --revert if you want to undo everything).`);
  }
}

// -- .env: add PIPER_MODEL if not already set ---------------------------------
const DEFAULT_MODEL_LINE = "PIPER_MODEL=piper-voices/en_US-ryan-medium.onnx";
if (existsSync(ENV_FILE)) {
  const envText = readFileSync(ENV_FILE, "utf8");
  if (!/^\s*PIPER_MODEL\s*=/m.test(envText)) {
    const sep = envText.endsWith("\n") || envText.length === 0 ? "" : "\n";
    appendFileSync(ENV_FILE, `${sep}\n# Piper neural voice (added by patch-piper.mjs)\n${DEFAULT_MODEL_LINE}\n`);
    console.log(`Added PIPER_MODEL to ${ENV_FILE}`);
  } else {
    console.log(`${ENV_FILE} already has a PIPER_MODEL line - left it alone.`);
  }
} else {
  writeFileSync(ENV_FILE, `# Piper neural voice (added by patch-piper.mjs)\n${DEFAULT_MODEL_LINE}\n`, "utf8");
  console.log(`Created ${ENV_FILE} with PIPER_MODEL set.`);
}

console.log(
  "\nDone.\n" +
  "1. Make sure piper-tts is installed:  .venv\\Scripts\\pip install piper-tts   (Windows)\n" +
  "                                       .venv/bin/pip install piper-tts       (Linux / Pi / macOS)\n" +
  "2. Check .env has PIPER_MODEL pointing at your downloaded .onnx file (its .onnx.json must sit next to it).\n" +
  "3. Restart Waypoint. The dashboard's voice engine label will show \"piper (<model name>)\" once it's active;\n" +
  "   if it still shows the old OS voice name, check the server log for a Piper warning.\n\n" +
  "Undo with: node patch-piper.mjs --revert"
);
