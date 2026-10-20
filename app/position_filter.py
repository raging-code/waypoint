"""Position filter: turns the raw, wandering GPS fixes into a steady position.

Gate    -> ignore low-quality fixes (high HDOP, few satellites, 2D fix)
Still   -> when (almost) not moving, hold an averaged anchor so the dot stops drifting
Moving  -> light exponential smoothing, reject single huge jumps
"""
from __future__ import annotations

import math
import os
import struct
import time
from typing import Optional, Tuple


def _env(name: str, default: float) -> float:
    try:
        raw = os.getenv(name)
        return float(raw) if raw not in (None, "") else default
    except ValueError:
        return default


MAX_HDOP = _env("GPS_MAX_HDOP", 2.5)      # worse than this -> fix ignored
MIN_SATS = int(_env("GPS_MIN_SATS", 5))   # fewer satellites than this -> fix ignored
STILL_KMH = _env("GPS_STILL_KMH", 1.5)    # under this speed we count as standing still
MOVE_KMH = _env("GPS_MOVE_KMH", 3.0)      # over this speed (and far enough) we unlock
RELEASE_M = _env("GPS_RELEASE_M", 8.0)    # must be this far from the anchor to unlock
JUMP_M = _env("GPS_JUMP_M", 80.0)         # a lone jump bigger than this is an outlier
SMOOTH = min(1.0, max(0.05, _env("GPS_SMOOTH", 0.5)))  # 1.0 = no smoothing
UBX_TUNE = _env("GPS_UBX_TUNE", 1.0) > 0

STILL_AFTER = 4     # slow samples in a row before locking
MOVE_AFTER = 2      # moving samples in a row before unlocking
AVG_CAP = 120       # anchor averages roughly the last two minutes
GAP_RESET_S = 10.0  # no accepted fix for this long -> start over


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dy = (lat2 - lat1) * 111_320.0
    dx = (lon2 - lon1) * 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2.0))
    return math.hypot(dx, dy)


class PositionFilter:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.lat: Optional[float] = None
        self.lon: Optional[float] = None
        self.mode = "moving"
        self.n = 0
        self.still_hits = 0
        self.move_hits = 0
        self.jump_hits = 0
        self.last = 0.0
        self.alt: Optional[float] = None

    @property
    def stationary(self) -> bool:
        return self.mode == "still"

    def _held(self) -> Optional[Tuple[float, float]]:
        if self.lat is None or self.lon is None:
            return None
        return self.lat, self.lon

    def smooth_alt(self, alt: float) -> float:
        self.alt = alt if self.alt is None else self.alt + (alt - self.alt) * 0.2
        return self.alt

    def update(self, lat: float, lon: float, sats: Optional[int], hdop: Optional[float],
               fix_type: int, speed_kmh: Optional[float]) -> Optional[Tuple[float, float]]:
        """Feed one raw fix. Returns the position to show (or None if nothing good yet)."""
        now = time.monotonic()
        if self.lat is not None and now - self.last > GAP_RESET_S:
            self.reset()

        # 1. quality gate: keep showing the last good position instead
        if sats is not None and sats < MIN_SATS:
            return self._held()
        if hdop is not None and hdop > MAX_HDOP:
            return self._held()
        if fix_type == 2:
            return self._held()

        self.last = now
        if self.lat is None or self.lon is None:
            self.lat, self.lon, self.n = lat, lon, 1
            return self.lat, self.lon

        d = distance_m(self.lat, self.lon, lat, lon)

        # 2. outlier: one giant jump is ignored, three in a row means we really moved
        if d > JUMP_M:
            self.jump_hits += 1
            if self.jump_hits < 3:
                return self._held()
            self.reset()
            self.last = now
            self.lat, self.lon, self.n = lat, lon, 1
            return self.lat, self.lon
        self.jump_hits = 0

        known = speed_kmh is not None
        slow = (speed_kmh < STILL_KMH) if known else (d < RELEASE_M)

        if self.mode == "still":
            wants_move = (known and speed_kmh >= MOVE_KMH and d > RELEASE_M) or (not known and d > 3 * RELEASE_M)
            self.move_hits = self.move_hits + 1 if wants_move else 0
            if self.move_hits >= MOVE_AFTER:
                self.mode, self.still_hits = "moving", 0
                self.lat, self.lon = lat, lon
            else:
                # 3. stationary: average into the anchor so noise cancels out
                self.n = min(self.n + 1, AVG_CAP)
                k = 1.0 / self.n
                self.lat += (lat - self.lat) * k
                self.lon += (lon - self.lon) * k
        else:
            # 4. moving: light smoothing
            self.lat += (lat - self.lat) * SMOOTH
            self.lon += (lon - self.lon) * SMOOTH
            self.still_hits = self.still_hits + 1 if slow else 0
            if self.still_hits >= STILL_AFTER:
                self.mode, self.n, self.move_hits = "still", 1, 0
        return self.lat, self.lon


def ubx_tune_packet() -> bytes:
    """UBX-CFG-NAV5: Pedestrian dynamic model + ignore satellites below 15 degrees.

    Sent to the NEO-6M at startup. It only changes RAM, so a power cycle undoes it
    (and it is sent again on the next start). Harmless if only the TX wire is connected.
    """
    payload = bytearray(36)
    struct.pack_into("<HBB", payload, 0, 0x0003, 3, 0)  # mask = dyn + minElev, model 3 = pedestrian
    payload[12] = 15                                      # minElev (degrees)
    body = bytes([0x06, 0x24]) + struct.pack("<H", 36) + bytes(payload)
    a = b = 0
    for byte in body:
        a = (a + byte) & 0xFF
        b = (b + a) & 0xFF
    return bytes([0xB5, 0x62]) + body + bytes([a, b])
