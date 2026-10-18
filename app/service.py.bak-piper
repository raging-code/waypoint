"""The Tracker ties everything together once per second:

    GPS reader -> status (off / offline / searching / locked)
               -> LEDs, OLED, buzzer alerts, event log
               -> track history for the map and the chart
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Deque, Dict, List, Optional

from .config import Config
from .geocode import ReverseGeocoder, ascii_text
from .gps_reader import GPSReader, GPSState
from .hardware import Hardware
from .voice import Voice

log = logging.getLogger("waypoint.tracker")

DEVICES = ("gps", "buzzer", "leds", "oled")
HISTORY_SIZE = 3600  # one hour at 1 Hz


def _compass(deg: Optional[float]) -> str:
    if deg is None:
        return ""
    names = ["north", "north east", "east", "south east", "south", "south west", "west", "north west"]
    return names[int((deg % 360) / 45.0 + 0.5) % 8]


class Tracker:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.state = GPSState()
        self.reader = GPSReader(cfg, self.state)
        self.hardware = Hardware(cfg)
        self.voice = Voice(cfg.voice_enabled)
        self.geocoder = ReverseGeocoder()

        self._lock = threading.RLock()
        self.controls: Dict[str, bool] = {d: True for d in DEVICES}
        self.history: Deque[Dict[str, object]] = deque(maxlen=HISTORY_SIZE)
        self.events: Deque[Dict[str, object]] = deque(maxlen=30)
        self._next_point_id = 1
        self._next_event_id = 1
        self.epoch = 1
        self.status = "offline"
        self._prev_status: Optional[str] = None

        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="tracker", daemon=True)

    # -- lifecycle --------------------------------------------------------------------
    def start(self) -> None:
        self.reader.start()
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        self.reader.stop()
        self.hardware.close()

    # -- control ----------------------------------------------------------------------
    def set_enabled(self, device: str, enabled: bool) -> None:
        if device not in DEVICES:
            raise ValueError(f"Unknown device: {device}")
        with self._lock:
            self.controls[device] = enabled
        if device == "gps":
            self.reader.set_enabled(enabled)
        self._wake.set()

    def clear_track(self) -> None:
        with self._lock:
            self.history.clear()
            self.epoch += 1
            self._add_event("info", "Track cleared")

    def test(self, device: str) -> None:
        if device == "buzzer":
            self.hardware.buzzer.beep("test")
        elif device == "leds":
            self.hardware.leds.test()
        elif device == "oled":
            self.hardware.oled.hold(["OLED test", "Waypoint GPS", "Display OK", "1234567890"], 3.0)
        else:
            raise ValueError(f"Cannot test: {device}")
        label = "OLED" if device == "oled" else device.capitalize()
        self._add_event("info", f"{label} test", beep=(device == "buzzer"))

    def _place_phrase(self) -> str:
        """'Roxas Boulevard, Barangay San Antonio, Manila', or '' while no address is known.

        Prefers street, then barangay (or whatever area name Nominatim gave), then city,
        joining whichever parts are actually known. Never falls back to coordinates here -
        that fallback only kicks in in speech_text() when NOTHING was found at all.
        """
        a = self.geocoder.snapshot()
        if not a["ok"]:
            return ""
        street = str(a["street"])
        area = str(a["area"])  # barangay, or the closest equivalent Nominatim returned
        city = str(a["city"])
        parts = [p for p in (street, area, city) if p]
        return ", ".join(parts)

    def speech_text(self) -> str:
        snap = self.state.snapshot(self.cfg.stale_after)
        if not self.controls["gps"]:
            return "The GPS module is switched off."
        if not snap["connected"]:
            return "The GPS module is not responding."
        if not snap["fix"] or snap["lat"] is None:
            return "Searching for satellites. No position yet."
        lat, lon = float(snap["lat"]), float(snap["lon"])  # type: ignore[arg-type]
        place = self._place_phrase()
        if place:
            text = f"You are on {place}"
        else:  # no place name at all yet (for example no internet): say the coordinates instead
            text = (
                f"You are at latitude {abs(lat):.4f} {'north' if lat >= 0 else 'south'}, "
                f"longitude {abs(lon):.4f} {'east' if lon >= 0 else 'west'}"
            )
            if snap["altitude"] is not None:
                text += f", altitude {float(snap['altitude']):.0f} meters"  # type: ignore[arg-type]
        speed = snap["speed_kmh"]
        if speed is not None and float(speed) >= 2.0:  # type: ignore[arg-type]
            text += f", moving {float(speed):.0f} kilometers per hour {_compass(snap['course'])}"  # type: ignore[arg-type]
        return text + "."

    def speak_on_device(self) -> Dict[str, object]:
        text = self.speech_text()
        if not self.voice.available:
            return {"ok": False, "text": text,
                    "error": "No speech engine found on this device (Raspberry Pi: sudo apt install espeak-ng)."}
        return {"ok": self.voice.speak(text), "text": text, "engine": self.voice.backend}

    # -- internals --------------------------------------------------------------------
    def _add_event(self, level: str, message: str, beep: bool = False) -> None:
        with self._lock:
            self.events.append({"id": self._next_event_id, "t": int(time.time()),
                                "level": level, "message": message, "beep": beep})
            self._next_event_id += 1

    def _alert(self, level: str, message: str, pattern: str) -> None:
        """Log an event and sound the buzzer (if the buzzer is switched on)."""
        sounds = self.controls["buzzer"]
        self._add_event(level, message, beep=sounds)
        if sounds:
            self.hardware.buzzer.beep(pattern)

    def _compute_status(self, snap: Dict[str, object]) -> str:
        if not self.controls["gps"]:
            return "off"
        if not snap["connected"]:
            return "offline"
        return "locked" if snap["fix"] else "searching"

    def _handle_transition(self, prev: Optional[str], new: str, snap: Dict[str, object]) -> None:
        if prev == new:
            return
        sats = snap["satellites"]
        if new == "locked":
            self._alert("success", f"Satellite fix acquired ({sats} satellites)", "fix")
        elif new == "searching":
            if prev == "locked":
                self._alert("warn", "Satellite fix lost", "lost")
            else:
                self._alert("success", "GPS module detected", "detected")
        elif new == "offline":
            if prev in ("locked", "searching"):
                self._alert("error", "GPS module not responding", "offline")
            elif prev is None:
                self._add_event("info", "Waiting for the GPS module")
        elif new == "off":
            if prev is not None:
                self._alert("info", "GPS module switched off", "off")

    def _oled_lines(self, status: str, snap: Dict[str, object]) -> List[str]:
        if status == "locked" and snap["lat"] is not None:
            alt = snap["altitude"]
            spd = snap["speed_kmh"]
            last = f"Alt {0 if alt is None else float(alt):.0f}m {0 if spd is None else float(spd):.1f}km/h"  # type: ignore[arg-type]
            addr = self.geocoder.snapshot()
            street = ascii_text(str(addr["street"] or addr["area"]))[:21]
            city = ascii_text(str(addr["city"]))[:21]
            if addr["ok"] and (street or city):
                return [f"GPS LOCK  {snap['satellites']} sat", street or city, city if street else "", last]
            return [
                f"GPS LOCK  {snap['satellites']} sat",
                f"Lat {float(snap['lat']):.6f}",  # type: ignore[arg-type]
                f"Lon {float(snap['lon']):.6f}",  # type: ignore[arg-type]
                last,
            ]
        if status == "searching":
            return ["GPS searching...", f"In view: {snap['in_view']}", "Waiting for fix", ""]
        if status == "offline":
            return ["GPS not found", "Check wiring:", "TX -> GPIO15", "RX -> GPIO14"]
        return ["GPS switched off", "", "", ""]

    def _tick(self) -> None:
        snap = self.state.snapshot(self.cfg.stale_after)
        status = self._compute_status(snap)
        with self._lock:
            prev, self._prev_status, self.status = self._prev_status, status, status
        self._handle_transition(prev, status, snap)

        # LEDs
        self.hardware.leds.set_state(status if self.controls["leds"] else "off")
        # OLED
        self.hardware.oled.show(self._oled_lines(status, snap) if self.controls["oled"] else None)

        # Street and city lookup (runs in the background, at most every 10 seconds)
        if status == "locked" and snap["lat"] is not None:
            self.geocoder.update(float(snap["lat"]), float(snap["lon"]))  # type: ignore[arg-type]

        # History (one point per second while there is a fix)
        if status == "locked" and snap["lat"] is not None:
            with self._lock:
                self.history.append({
                    "id": self._next_point_id,
                    "t": int(time.time()),
                    "lat": round(float(snap["lat"]), 6),  # type: ignore[arg-type]
                    "lon": round(float(snap["lon"]), 6),  # type: ignore[arg-type]
                    "alt": None if snap["altitude"] is None else round(float(snap["altitude"]), 1),  # type: ignore[arg-type]
                    "speed": 0.0 if snap["speed_kmh"] is None else round(float(snap["speed_kmh"]), 1),  # type: ignore[arg-type]
                    "sats": snap["satellites"],
                })
                self._next_point_id += 1

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("Tracker tick failed")
            self._wake.wait(1.0)
            self._wake.clear()

    # -- API view ---------------------------------------------------------------------
    def view(self, since: int = 0) -> Dict[str, object]:
        snap = self.state.snapshot(self.cfg.stale_after)
        with self._lock:
            points = [p for p in self.history if int(p["id"]) > since]  # type: ignore[arg-type]
            last_id = self._next_point_id - 1
            events = list(self.events)[-8:]
            controls = dict(self.controls)
            epoch = self.epoch
            status = self.status
        leds = self.hardware.leds
        voice_available = self.voice.available
        return {
            "status": status,
            "gps": snap,
            "controls": controls,
            "hardware": {**self.hardware.modes(), "voice": self.voice.backend},
            "voice_available": voice_available,
            "device": {
                "leds": leds.state,
                "buzzer": self.hardware.buzzer.active,
                "oled": list(self.hardware.oled.lines),
            },
            "events": events,
            "epoch": epoch,
            "last_id": last_id,
            "points": points,
            "address": self.geocoder.snapshot(),
            "speech": self.speech_text(),
            "server_time": int(time.time()),
        }
