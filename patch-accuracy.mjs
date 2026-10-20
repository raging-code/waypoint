#!/usr/bin/env node
/**
 * Waypoint accuracy patch: stops the stationary "wandering" (10-20 m) on the map.
 *
 * Why it wanders: the app shows every raw fix straight from the NEO-6M. Indoors or
 * under a weak sky the module's fix drifts around by itself (multipath, few satellites,
 * high HDOP) and the code trusted all of it, from both GGA and RMC.
 *
 * What this patch does:
 *   1. NEW app/position_filter.py
 *        - quality gate: ignores fixes with HDOP > 2.5, fewer than 5 satellites, or a 2D fix
 *        - stationary lock: when speed stays under ~1.5 km/h the dot is frozen on an
 *          averaged anchor (so noise cancels instead of drawing a scribble); it only
 *          unlocks when you really start moving
 *        - moving: light smoothing, and a lone 80 m+ jump is rejected as an outlier
 *        - altitude smoothing, and speed shows 0 while stationary
 *        - optional: tells the u-blox chip to use its Pedestrian model and ignore
 *          satellites below 15 degrees (less multipath). Sent once at startup, RAM only.
 *   2. app/gps_reader.py uses the filter. Position now comes from GGA only (RMC supplies
 *      speed/course), so the two sentences no longer fight each other.
 *
 * Tuning (all optional, put in .env):
 *   GPS_MAX_HDOP=2.5  GPS_MIN_SATS=5  GPS_STILL_KMH=1.5  GPS_MOVE_KMH=3.0
 *   GPS_RELEASE_M=8   GPS_JUMP_M=80   GPS_SMOOTH=0.5     GPS_UBX_TUNE=1 (0 = off)
 *
 * Usage (run from the Waypoint folder, the one that contains run.py):
 *   node patch-accuracy.mjs            apply
 *   node patch-accuracy.mjs --revert   undo
 *   node patch-accuracy.mjs <folder>   patch a project in another folder
 *
 * Safe to run twice. Nothing is written unless every edit matches exactly.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const folderArg = args.find((a) => !a.startsWith("-"));
const root = resolve(folderArg ?? dirname(fileURLToPath(import.meta.url)));

const READER = join(root, "app", "gps_reader.py");
const FILTER = join(root, "app", "position_filter.py");
const BACKUP = ".bak-accuracy";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

if (!existsSync(READER)) {
  fail(`Cannot find ${READER}\nRun this from the Waypoint folder (the one containing run.py), or: node patch-accuracy.mjs <folder>`);
}

// ---------------------------------------------------------------- revert
if (revert) {
  if (existsSync(READER + BACKUP)) {
    copyFileSync(READER + BACKUP, READER);
    unlinkSync(READER + BACKUP);
    console.log(`Restored ${READER}`);
  } else {
    console.log("No .bak-accuracy backup found for gps_reader.py.");
  }
  if (existsSync(FILTER)) {
    unlinkSync(FILTER);
    console.log(`Removed ${FILTER}`);
  }
  console.log("\nReverted.");
  process.exit(0);
}

// ---------------------------------------------------------------- new file
const FILTER_PY = `"""Position filter: turns the raw, wandering GPS fixes into a steady position.

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
`;

// ---------------------------------------------------------------- edits to gps_reader.py
const EDITS = [
  {
    find: `from . import nmea\nfrom .config import Config\n`,
    replace: `from . import nmea\nfrom .config import Config\nfrom .position_filter import UBX_TUNE, PositionFilter, ubx_tune_packet\n`,
  },
  {
    find: `        self.name = port\n        self._serial = serial.Serial(port, baudrate=baud, timeout=1.0)\n`,
    replace: `        self.name = port\n        self._serial = serial.Serial(port, baudrate=baud, timeout=1.0)\n        if UBX_TUNE:  # pedestrian model + ignore low satellites (RAM only, resent each start)\n            try:\n                self._serial.write(ubx_tune_packet())\n            except Exception:\n                pass\n`,
  },
  {
    find: `            self.utc_date: Optional[str] = None\n\n    def set_link`,
    replace: `            self.utc_date: Optional[str] = None\n            self._filter = PositionFilter()  # steady-position filter (see position_filter.py)\n            self._seen_gga = False\n\n    def set_link`,
  },
  {
    find: `                if self.fix and msg["lat"] is not None and msg["lon"] is not None:\n                    self.lat, self.lon = msg["lat"], msg["lon"]  # type: ignore[assignment]\n                    if msg["altitude"] is not None:\n                        self.altitude = float(msg["altitude"])  # type: ignore[arg-type]\n`,
    replace: `                self._seen_gga = True\n                if self.fix and msg["lat"] is not None and msg["lon"] is not None:\n                    out = self._filter.update(\n                        msg["lat"], msg["lon"], sats=msg["satellites"], hdop=msg["hdop"],  # type: ignore[arg-type]\n                        fix_type=self.fix_type, speed_kmh=self.speed_kmh)\n                    if out is not None:\n                        self.lat, self.lon = out\n                        if msg["altitude"] is not None:\n                            self.altitude = self._filter.smooth_alt(float(msg["altitude"]))  # type: ignore[arg-type]\n`,
  },
  {
    find: `                if self.fix and msg["lat"] is not None and msg["lon"] is not None:\n                    self.lat, self.lon = msg["lat"], msg["lon"]  # type: ignore[assignment]\n                    if msg["speed_kmh"] is not None:\n`,
    replace: `                if self.fix and msg["lat"] is not None and msg["lon"] is not None:\n                    if not self._seen_gga:  # no GGA sentences at all: fall back to the RMC position\n                        out = self._filter.update(\n                            msg["lat"], msg["lon"], sats=None, hdop=self.hdop,  # type: ignore[arg-type]\n                            fix_type=self.fix_type, speed_kmh=msg["speed_kmh"])  # type: ignore[arg-type]\n                        if out is not None:\n                            self.lat, self.lon = out\n                    if msg["speed_kmh"] is not None:\n`,
  },
  {
    find: `                "speed_kmh": self.speed_kmh if fix else None,\n`,
    replace: `                "speed_kmh": ((0.0 if self._filter.stationary and self.speed_kmh is not None else self.speed_kmh)\n                              if fix else None),\n                "stationary": bool(fix and self._filter.stationary),\n`,
  },
];

// ---------------------------------------------------------------- apply
let text = readFileSync(READER, "utf8");
if (text.includes("position_filter") && existsSync(FILTER)) {
  console.log("Already applied. Use --revert to undo.");
  process.exit(0);
}
for (const [i, { find }] of EDITS.entries()) {
  const count = text.split(find).length - 1;
  if (count !== 1) {
    fail(`Edit ${i + 1} of ${EDITS.length} did not match exactly (found ${count} times) in app/gps_reader.py.\nNothing was changed. Is gps_reader.py modified from the repo version?`);
  }
}
if (!existsSync(READER + BACKUP)) copyFileSync(READER, READER + BACKUP);
for (const { find, replace } of EDITS) text = text.replace(find, () => replace);
writeFileSync(READER, text);
writeFileSync(FILTER, FILTER_PY);

console.log("Patched app/gps_reader.py  (backup: app/gps_reader.py.bak-accuracy)");
console.log("Created app/position_filter.py");
console.log("\nRestart Waypoint. Stand still for ~15 s: the dot should lock and stop drifting.");
console.log("Tune in .env if needed (e.g. GPS_MAX_HDOP=3.5 indoors). Undo with: node patch-accuracy.mjs --revert");
