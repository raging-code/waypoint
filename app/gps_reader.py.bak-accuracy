"""Reads NMEA lines from a GPS module (or a simulator) and keeps the latest fix in memory."""
from __future__ import annotations

import glob
import logging
import math
import os
import platform
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Deque, Dict, List, Optional

from . import nmea
from .config import Config

log = logging.getLogger("waypoint.gps")


# --------------------------------------------------------------------------------------
# Sources: anything with open()/readline()/close(). readline() returns "" on timeout.
# --------------------------------------------------------------------------------------
def find_serial_port() -> Optional[str]:
    """Best-effort guess of where the GPS module is attached."""
    if platform.system() == "Windows":
        try:
            from serial.tools import list_ports

            ports = list(list_ports.comports())
        except Exception:  # pragma: no cover - pyserial missing/unusual
            return None
        # Only pick ports that look like a GPS receiver or a USB-serial adapter, so an
        # unrelated Bluetooth/COM1 port is never mistaken for the GPS module.
        hints = ("u-blox", "gps", "gnss", "usb serial", "usb-serial", "ch340", "cp210", "ftdi", "prolific")
        for p in ports:
            text = f"{p.description} {p.manufacturer or ''}".lower()
            if any(h in text for h in hints):
                return p.device
        return None

    candidates: List[str] = ["/dev/serial0", "/dev/ttyAMA0"]
    candidates += sorted(glob.glob("/dev/ttyACM*")) + sorted(glob.glob("/dev/ttyUSB*"))
    candidates += sorted(glob.glob("/dev/cu.usbmodem*")) + sorted(glob.glob("/dev/cu.usbserial*"))
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


class SerialSource:
    simulated = False

    def __init__(self, port: str, baud: int):
        import serial  # imported lazily so the simulator works without pyserial

        self.name = port
        self._serial = serial.Serial(port, baudrate=baud, timeout=1.0)

    def readline(self) -> str:
        raw = self._serial.readline()
        return raw.decode("ascii", errors="ignore") if raw else ""

    def close(self) -> None:
        try:
            self._serial.close()
        except Exception:
            pass


class SimulatedSource:
    """Generates real NMEA sentences (with checksums) so the whole parser path is exercised."""

    simulated = True
    name = "simulator"
    FIX_AFTER = 8  # seconds of "searching" before the simulated fix appears

    def __init__(self, lat: float, lon: float, speed_ms: float):
        self._lat0, self._lon0 = lat, lon
        self._speed = max(0.5, speed_ms)
        self._radius = 140.0  # metres
        self._angle = 0.0
        self._tick = 0
        self._queue: Deque[str] = deque()
        self._next = time.monotonic()
        self._closed = False

    def readline(self) -> str:
        if not self._queue:
            now = time.monotonic()
            if now < self._next:
                time.sleep(min(self._next - now, 0.25))
                if time.monotonic() < self._next:
                    return ""
            self._next = max(self._next + 1.0, time.monotonic())
            self._queue.extend(self._generate())
        return self._queue.popleft()

    def close(self) -> None:
        self._closed = True

    # -- helpers ----------------------------------------------------------------------
    @staticmethod
    def _fmt(value: float, width: int, pos: str, neg: str):
        hemi = pos if value >= 0 else neg
        a = abs(value)
        deg = int(a)
        minutes = (a - deg) * 60.0
        return f"{deg:0{width}d}{minutes:08.5f}", hemi

    def _generate(self) -> List[str]:
        n = self._tick
        self._tick += 1
        now = datetime.now(timezone.utc)
        hhmmss = now.strftime("%H%M%S") + ".00"
        ddmmyy = now.strftime("%d%m%y")
        has_fix = n >= self.FIX_AFTER
        in_view = min(4 + n, 11)
        lines: List[str] = []

        if has_fix:
            speed = self._speed * (1.0 + 0.25 * math.sin(n / 9.0))
            self._angle += speed / self._radius
            north = self._radius * math.cos(self._angle)
            east = self._radius * math.sin(self._angle)
            lat = self._lat0 + north / 111_320.0
            lon = self._lon0 + east / (111_320.0 * math.cos(math.radians(self._lat0)))
            course = math.degrees(math.atan2(math.cos(self._angle), -math.sin(self._angle))) % 360.0
            alt = 24.0 + 3.0 * math.sin(n / 20.0) + 0.3 * math.sin(n * 1.7)
            sats = 8 + int(round(1.5 * math.sin(n / 15.0)))
            hdop = 1.0 + 0.3 * math.sin(n / 11.0)
            lat_s, ns = self._fmt(lat, 2, "N", "S")
            lon_s, ew = self._fmt(lon, 3, "E", "W")
            knots = speed / 0.514444
            lines.append(nmea.build_sentence(
                f"GPGGA,{hhmmss},{lat_s},{ns},{lon_s},{ew},1,{sats:02d},{hdop:.1f},{alt:.1f},M,0.0,M,,"))
            prns = ",".join(f"{i:02d}" for i in range(1, sats + 1)) + "," * (12 - sats)
            lines.append(nmea.build_sentence(f"GPGSA,A,3,{prns},{hdop * 1.4:.1f},{hdop:.1f},{hdop * 1.1:.1f}"))
            lines.append(nmea.build_sentence(
                f"GPRMC,{hhmmss},A,{lat_s},{ns},{lon_s},{ew},{knots:.2f},{course:.1f},{ddmmyy},,,A"))
        else:
            lines.append(nmea.build_sentence(f"GPGGA,{hhmmss},,,,,0,00,99.99,,,,,,"))
            lines.append(nmea.build_sentence("GPGSA,A,1,,,,,,,,,,,,,99.99,99.99,99.99"))
            lines.append(nmea.build_sentence(f"GPRMC,{hhmmss},V,,,,,,,{ddmmyy},,,N"))

        messages = (in_view + 3) // 4
        for m in range(1, messages + 1):
            sats_txt = ""
            for s in range(4):
                idx = (m - 1) * 4 + s
                if idx >= in_view:
                    break
                sats_txt += f",{idx + 1:02d},{20 + idx * 6 % 60:02d},{(idx * 47) % 360:03d},{25 + (idx * 5) % 20:02d}"
            lines.append(nmea.build_sentence(f"GPGSV,{messages},{m},{in_view:02d}{sats_txt}"))
        return lines


# --------------------------------------------------------------------------------------
# Shared state
# --------------------------------------------------------------------------------------
class GPSState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.reset_link()

    def reset_link(self) -> None:
        with self._lock:
            self.link_open = False
            self.source = ""
            self.port = ""
            self.note = ""
            self.last_rx = 0.0
            self.fix = False
            self.fix_type = 1
            self.quality = 0
            self.lat: Optional[float] = None
            self.lon: Optional[float] = None
            self.altitude: Optional[float] = None
            self.speed_kmh: Optional[float] = None
            self.course: Optional[float] = None
            self.satellites = 0
            self.in_view = 0
            self.hdop: Optional[float] = None
            self.utc_time: Optional[str] = None
            self.utc_date: Optional[str] = None

    def set_link(self, source: str, port: str, note: str = "") -> None:
        with self._lock:
            self.link_open = True
            self.source = source
            self.port = port
            self.note = note
            self.last_rx = 0.0

    def set_note(self, note: str) -> None:
        with self._lock:
            self.note = note

    def apply(self, msg: Dict[str, object]) -> None:
        kind = msg["type"]
        with self._lock:
            self.last_rx = time.monotonic()
            if kind == "GGA":
                self.fix = bool(msg["fix"])
                self.quality = int(msg["quality"])  # type: ignore[arg-type]
                if msg["satellites"] is not None:
                    self.satellites = int(msg["satellites"])  # type: ignore[arg-type]
                if msg["hdop"] is not None:
                    self.hdop = float(msg["hdop"])  # type: ignore[arg-type]
                if self.fix and msg["lat"] is not None and msg["lon"] is not None:
                    self.lat, self.lon = msg["lat"], msg["lon"]  # type: ignore[assignment]
                    if msg["altitude"] is not None:
                        self.altitude = float(msg["altitude"])  # type: ignore[arg-type]
                if msg["time"]:
                    self.utc_time = str(msg["time"])
            elif kind == "RMC":
                self.fix = bool(msg["valid"])
                if self.fix and msg["lat"] is not None and msg["lon"] is not None:
                    self.lat, self.lon = msg["lat"], msg["lon"]  # type: ignore[assignment]
                    if msg["speed_kmh"] is not None:
                        self.speed_kmh = float(msg["speed_kmh"])  # type: ignore[arg-type]
                    if msg["course"] is not None:
                        self.course = float(msg["course"])  # type: ignore[arg-type]
                if not self.fix:
                    self.speed_kmh = None
                if msg["time"]:
                    self.utc_time = str(msg["time"])
                if msg["date"]:
                    self.utc_date = str(msg["date"])
            elif kind == "GSA":
                self.fix_type = int(msg["fix_type"])  # type: ignore[arg-type]
                if msg["hdop"] is not None:
                    self.hdop = float(msg["hdop"])  # type: ignore[arg-type]
            elif kind == "GSV":
                if msg["message_number"] == 1 and msg["in_view"] is not None:
                    self.in_view = int(msg["in_view"])  # type: ignore[arg-type]

    def snapshot(self, stale_after: float) -> Dict[str, object]:
        with self._lock:
            connected = (
                self.link_open
                and self.last_rx > 0
                and (time.monotonic() - self.last_rx) < stale_after
            )
            fix = self.fix and connected
            return {
                "connected": connected,
                "fix": fix,
                "fix_type": self.fix_type if fix else 1,
                "has_position": self.lat is not None and self.lon is not None,
                "lat": self.lat,
                "lon": self.lon,
                "altitude": self.altitude,
                "speed_kmh": self.speed_kmh if fix else None,
                "course": self.course,
                "satellites": self.satellites if connected else 0,
                "in_view": self.in_view if connected else 0,
                "hdop": self.hdop if connected else None,
                "utc_time": self.utc_time if connected else None,
                "utc_date": self.utc_date,
                "source": self.source,
                "port": self.port,
                "note": self.note,
            }


# --------------------------------------------------------------------------------------
# Reader thread
# --------------------------------------------------------------------------------------
class GPSReader(threading.Thread):
    def __init__(self, cfg: Config, state: GPSState):
        super().__init__(name="gps-reader", daemon=True)
        self.cfg = cfg
        self.state = state
        self._enabled = threading.Event()
        self._enabled.set()
        self._stop_flag = threading.Event()
        self._force_simulator = cfg.gps_mode == "simulator"

    def set_enabled(self, enabled: bool) -> None:
        if enabled:
            self._enabled.set()
        else:
            self._enabled.clear()

    def stop(self) -> None:
        self._stop_flag.set()

    def _open_source(self):
        if self._force_simulator:
            self.state.set_link("simulator", "simulator", "Simulated data - no GPS module in use.")
            return SimulatedSource(self.cfg.sim_lat, self.cfg.sim_lon, self.cfg.sim_speed_ms)

        port = self.cfg.gps_port or find_serial_port()
        if not port:
            reason = "No serial port found. Enable the serial port and check the wiring."
        else:
            try:
                src = SerialSource(port, self.cfg.gps_baud)
                self.state.set_link("serial", port)
                log.info("GPS serial port opened: %s @ %d baud", port, self.cfg.gps_baud)
                return src
            except Exception as exc:  # SerialException, PermissionError, ImportError...
                reason = f"Could not open {port}: {exc}"

        log.warning(reason)
        if self.cfg.gps_mode == "auto":
            self._force_simulator = True
            log.warning("Falling back to the simulator (set GPS_MODE=serial to disable this).")
            self.state.set_link("simulator", "simulator", f"{reason} Using simulated data.")
            return SimulatedSource(self.cfg.sim_lat, self.cfg.sim_lon, self.cfg.sim_speed_ms)

        self.state.reset_link()
        self.state.set_note(reason)
        return None

    def run(self) -> None:
        source = None
        while not self._stop_flag.is_set():
            if not self._enabled.is_set():
                if source is not None:
                    source.close()
                    source = None
                    self.state.reset_link()
                time.sleep(0.2)
                continue

            if source is None:
                source = self._open_source()
                if source is None:
                    self._stop_flag.wait(3.0)  # retry in a few seconds (serial mode)
                    continue

            try:
                line = source.readline()
            except Exception as exc:
                log.warning("GPS read error: %s", exc)
                source.close()
                source = None
                self.state.reset_link()
                self.state.set_note(f"Read error: {exc}")
                self._stop_flag.wait(2.0)
                continue

            if not line:
                continue
            parsed = nmea.parse(line)
            if parsed is not None:
                self.state.apply(parsed)

        if source is not None:
            source.close()
