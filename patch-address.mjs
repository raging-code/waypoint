#!/usr/bin/env node
/**
 * Waypoint address patch: show the STREET and CITY instead of latitude / longitude.
 *
 * What changes:
 *   - Dashboard: the big readout is now the street (and area / city underneath).
 *     The coordinates stay as one small line below it. Without internet it falls back
 *     to showing the coordinates, so nothing breaks.
 *   - Voice: "You are on Roxas Boulevard in Manila."
 *   - OLED: street and city on the screen instead of Lat / Lon.
 *   - New file app/geocode.py: looks the address up with OpenStreetMap's free Nominatim
 *     service (no API key, no extra packages). At most one lookup every 10 seconds, and only
 *     after you move about 25 m, to respect Nominatim's usage policy.
 *
 * Usage (run from the Waypoint folder, the one that contains run.py):
 *
 *   node patch-address.mjs            apply the patch
 *   node patch-address.mjs --revert   undo it
 *   node patch-address.mjs <folder>   patch a project in another folder
 *
 * Optional settings for .env:  REVERSE_GEOCODE=false   GEOCODE_LANGUAGE=en
 *                              GEOCODE_USER_AGENT="Waypoint (you@example.com)"
 *
 * Safe to run twice. Nothing is written unless every edit matches exactly.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const folderArg = args.find((a) => !a.startsWith("-"));
const root = resolve(folderArg ?? dirname(fileURLToPath(import.meta.url)));

const FILES = {
  service: join(root, "app", "service.py"),
  js: join(root, "app", "static", "js", "app.js"),
  html: join(root, "app", "templates", "index.html"),
  css: join(root, "app", "static", "css", "style.css"),
};
const GEOCODE_PATH = join(root, "app", "geocode.py");
const BACKUP = ".bak-address";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

for (const path of Object.values(FILES)) {
  if (!existsSync(path)) {
    fail(`Cannot find ${path}\nRun this script from the Waypoint folder (the one containing run.py), or pass the folder: node patch-address.mjs <folder>`);
  }
}

// ---------------------------------------------------------------- revert
if (revert) {
  let restored = 0;
  for (const path of Object.values(FILES)) {
    if (existsSync(path + BACKUP)) {
      copyFileSync(path + BACKUP, path);
      restored++;
    }
  }
  if (restored && existsSync(GEOCODE_PATH)) unlinkSync(GEOCODE_PATH);
  console.log(restored ? `Reverted ${restored} file(s) and removed app/geocode.py.` : "No backups found, nothing to revert.");
  process.exit(0);
}

const serviceRaw = readFileSync(FILES.service, "utf8");
if (serviceRaw.includes("ReverseGeocoder")) {
  console.log("Already patched. Nothing to do. (Use --revert to undo.)");
  process.exit(0);
}

// ---------------------------------------------------------------- new file: app/geocode.py
const GEOCODE_PY = String.raw`"""Street and city lookup (reverse geocoding) with OpenStreetMap's free Nominatim service.

No API key and no extra packages. It needs internet access; without it the dashboard
simply keeps showing coordinates. To follow Nominatim's usage policy it looks up at most
once every 10 seconds, and only after you have moved about 25 metres.

Settings (all optional, put them in .env):
    REVERSE_GEOCODE=true|false     turn the lookup on or off
    GEOCODE_LANGUAGE=en            language of street and city names
    GEOCODE_USER_AGENT=...         identify your project (put your email in it)
    GEOCODE_URL=...                use your own Nominatim server
"""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Optional

log = logging.getLogger("waypoint.geocode")

STREET_KEYS = ("road", "pedestrian", "footway", "path", "cycleway", "residential", "service", "highway")
AREA_KEYS = ("neighbourhood", "quarter", "suburb", "city_district", "borough")
CITY_KEYS = ("city", "town", "municipality", "village", "hamlet", "county")
REGION_KEYS = ("state", "region", "province", "state_district")


def ascii_text(text: str) -> str:
    """Strip accents so the small OLED font can show it (Peña -> Pena)."""
    return unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")


def _first(address: Dict[str, str], keys) -> str:
    for key in keys:
        value = address.get(key)
        if value:
            return str(value)
    return ""


def parse_address(payload: Dict[str, object]) -> Dict[str, str]:
    """Turn a Nominatim reverse-geocoding answer into street / area / city / region / country."""
    address = payload.get("address") or {}
    if not isinstance(address, dict):
        address = {}
    return {
        "street": _first(address, STREET_KEYS),
        "area": _first(address, AREA_KEYS),
        "city": _first(address, CITY_KEYS),
        "region": _first(address, REGION_KEYS),
        "country": str(address.get("country") or ""),
    }


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371000.0 * 2 * math.asin(math.sqrt(a))


def _empty() -> Dict[str, object]:
    return {"ok": False, "street": "", "area": "", "city": "", "region": "", "country": "", "error": ""}


class ReverseGeocoder:
    MIN_INTERVAL = 10.0   # seconds between lookups
    MIN_MOVE_M = 25.0     # metres you must move before looking up again

    def __init__(self) -> None:
        flag = os.getenv("REVERSE_GEOCODE", "true").strip().lower()
        self.enabled = flag not in ("0", "false", "no", "off")
        self.url = os.getenv("GEOCODE_URL", "https://nominatim.openstreetmap.org/reverse").strip()
        self.language = os.getenv("GEOCODE_LANGUAGE", "en").strip() or "en"
        self.user_agent = os.getenv("GEOCODE_USER_AGENT", "Waypoint-GPS-Tracker/1.0 (student project)").strip()
        self._lock = threading.Lock()
        self._busy = False
        self._last_try = float("-inf")
        self._last_pos: Optional[tuple] = None
        self._failures = 0
        self._data = _empty()

    def update(self, lat: float, lon: float) -> None:
        """Call every second with the current position. Starts a lookup only when it is time."""
        if not self.enabled:
            return
        now = time.monotonic()
        with self._lock:
            if self._busy:
                return
            wait = self.MIN_INTERVAL if self._failures == 0 else min(300.0, 15.0 * 2 ** min(self._failures, 5))
            if now - self._last_try < wait:
                return
            if self._data["ok"] and self._last_pos is not None and _distance_m(lat, lon, *self._last_pos) < self.MIN_MOVE_M:
                return
            self._busy = True
            self._last_try = now
        threading.Thread(target=self._fetch, args=(lat, lon), name="geocode", daemon=True).start()

    def _fetch(self, lat: float, lon: float) -> None:
        params = urllib.parse.urlencode({
            "format": "jsonv2", "lat": f"{lat:.6f}", "lon": f"{lon:.6f}",
            "zoom": 18, "addressdetails": 1, "accept-language": self.language,
        })
        sep = "&" if "?" in self.url else "?"
        request = urllib.request.Request(f"{self.url}{sep}{params}", headers={
            "User-Agent": self.user_agent, "Accept-Language": self.language,
        })
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict) or "error" in payload:
                raise ValueError("No address found for this spot")
            parts = parse_address(payload)
            with self._lock:
                self._data = {"ok": True, "error": "", **parts}
                self._last_pos = (lat, lon)
                self._failures = 0
            log.info("Address: %s, %s", parts["street"] or "(no street)", parts["city"] or "(no city)")
        except Exception as exc:  # no internet, timeout, blocked, no address...
            with self._lock:
                self._failures += 1
                far = self._last_pos is None or _distance_m(lat, lon, *self._last_pos) > 150
                if far:
                    self._data = {**_empty(), "error": str(exc)[:120]}
                else:
                    self._data = {**self._data, "error": str(exc)[:120]}
            log.warning("Address lookup failed: %s", exc)
        finally:
            with self._lock:
                self._busy = False

    def snapshot(self) -> Dict[str, object]:
        with self._lock:
            data = dict(self._data)
        data["enabled"] = self.enabled
        return data
`;

// ---------------------------------------------------------------- edits
// "find" edits: the text must occur exactly once.
// "block" edits: everything from "start" (included) up to "end" (not included) is replaced.
const EDITS = [
  {
    file: "service", why: "import the geocoder",
    find: String.raw`from .gps_reader import GPSReader, GPSState`,
    replace: String.raw`from .geocode import ReverseGeocoder, ascii_text
from .gps_reader import GPSReader, GPSState`,
  },
  {
    file: "service", why: "create the geocoder",
    find: String.raw`        self.voice = Voice(cfg.voice_enabled)`,
    replace: String.raw`        self.voice = Voice(cfg.voice_enabled)
        self.geocoder = ReverseGeocoder()`,
  },
  {
    file: "service", why: "voice says the street and city",
    start: String.raw`    def speech_text(self) -> str:
`,
    end: String.raw`    def speak_on_device(self)`,
    replace: String.raw`    def _place_phrase(self) -> str:
        """'Roxas Boulevard in Manila', or '' while no address is known."""
        a = self.geocoder.snapshot()
        if not a["ok"]:
            return ""
        street = str(a["street"] or a["area"])
        city = str(a["city"])
        if street and city:
            return f"{street} in {city}"
        return street or city

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
        else:  # no street name yet (for example no internet): say the coordinates instead
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

`,
  },
  {
    file: "service", why: "OLED shows the street and city",
    start: String.raw`    def _oled_lines(self, status: str, snap: Dict[str, object]) -> List[str]:
`,
    end: String.raw`    def _tick(self) -> None:`,
    replace: String.raw`    def _oled_lines(self, status: str, snap: Dict[str, object]) -> List[str]:
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

`,
  },
  {
    file: "service", why: "look the address up while there is a fix",
    find: String.raw`        # History (one point per second while there is a fix)
`,
    replace: String.raw`        # Street and city lookup (runs in the background, at most every 10 seconds)
        if status == "locked" and snap["lat"] is not None:
            self.geocoder.update(float(snap["lat"]), float(snap["lon"]))  # type: ignore[arg-type]

        # History (one point per second while there is a fix)
`,
  },
  {
    file: "service", why: "send the address to the dashboard",
    find: String.raw`            "speech": self.speech_text(),`,
    replace: String.raw`            "address": self.geocoder.snapshot(),
            "speech": self.speech_text(),`,
  },
  {
    file: "html", why: "street and city readout instead of latitude / longitude",
    start: String.raw`        <div class="coord">
          <span class="coord-label">Latitude</span>`,
    end: String.raw`        <div class="coord-actions">`,
    replace: String.raw`        <div class="place">
          <span id="placeStreet" class="place-street">Waiting for position</span>
          <span id="placeCity" class="place-city"></span>
          <span id="coordLine" class="coord-line"></span>
        </div>
`,
  },
  {
    file: "html", why: "clearer label on the copy button",
    find: String.raw`<button id="btnCopy" class="link-btn" type="button">Copy</button>`,
    replace: String.raw`<button id="btnCopy" class="link-btn" type="button">Copy coordinates</button>`,
  },
  {
    file: "js", why: "show the address in the dashboard",
    start: String.raw`  function renderPosition(s) {
`,
    end: String.raw`  function renderReadings(s) {`,
    replace: String.raw`  function degrees(value, pos, neg) {
    return Math.abs(value).toFixed(6) + "° " + (value >= 0 ? pos : neg);
  }

  function renderPosition(s) {
    const g = s.gps;
    const a = s.address || {};
    $("#position").classList.toggle("is-stale", !g.fix);
    const street = $("#placeStreet");
    const city = $("#placeCity");
    const coords = $("#coordLine");

    if (!g.has_position) {
      street.classList.remove("is-coords");
      street.textContent = s.status === "searching" ? "Finding your position" : "No position yet";
      city.textContent = "";
      coords.textContent = "";
    } else {
      const text = degrees(g.lat, "N", "S") + ", " + degrees(g.lon, "E", "W");
      coords.textContent = text;
      const main = a.ok ? (a.street || a.area || a.city) : "";
      street.classList.toggle("is-coords", !main);
      if (main) {
        street.textContent = main;
        const parts = [];
        if (a.street && a.area) parts.push(a.area);
        if (a.city && a.city !== main) parts.push(a.city);
        city.textContent = parts.join(", ");
      } else {
        // No street name yet: show the coordinates and say why.
        street.textContent = text;
        city.textContent = a.enabled === false ? "Street lookup is turned off"
          : a.error ? "Street name needs internet access" : "Looking up the street";
      }
    }

    const link = $("#btnOpenMaps");
    if (g.has_position) {
      link.href = "https://www.google.com/maps?q=" + g.lat.toFixed(6) + "," + g.lon.toFixed(6);
      link.setAttribute("aria-disabled", "false");
    } else {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
    }
  }

`,
  },
  {
    file: "css", why: "style the street and city readout",
    find: String.raw`.coord-actions { display: flex; gap: 6px; margin: 0 -10px -6px; }`,
    replace: String.raw`.place { display: flex; flex-direction: column; gap: 4px; }
.place-street { font-size: 30px; font-weight: 400; letter-spacing: -0.025em; line-height: 1.12; overflow-wrap: anywhere; transition: color 0.2s; }
.place-street.is-coords { font-size: 21px; font-weight: 450; letter-spacing: -0.01em; }
.place-city { font-size: 17px; color: var(--ink-2); min-height: 1.4em; }
.coord-line { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
.position.is-stale .place-street { color: #9aa6ac; }
.coord-actions { display: flex; gap: 6px; margin: 0 -10px -6px; }`,
  },
];

// ---------------------------------------------------------------- apply (all or nothing)
const texts = {};
const crlf = {};
for (const [key, path] of Object.entries(FILES)) {
  const raw = readFileSync(path, "utf8");
  crlf[key] = raw.includes("\r\n");
  texts[key] = raw.replace(/\r\n/g, "\n");
}

const count = (haystack, needle) => haystack.split(needle).length - 1;
function stop(edit, detail) {
  fail(
    `Could not apply: "${edit.why}" (${FILES[edit.file]}).\n${detail}\n` +
      `Your files may have been edited. Nothing was changed.`
  );
}

for (const edit of EDITS) {
  const text = texts[edit.file];
  if (edit.find !== undefined) {
    const n = count(text, edit.find);
    if (n !== 1) stop(edit, `Expected to find the original text exactly once but found it ${n} times.`);
    texts[edit.file] = text.replace(edit.find, () => edit.replace);
  } else {
    const ns = count(text, edit.start);
    const ne = count(text, edit.end);
    if (ns !== 1 || ne !== 1) stop(edit, `Expected the start and end markers once each but found ${ns} and ${ne}.`);
    const a = text.indexOf(edit.start);
    const b = text.indexOf(edit.end);
    if (b <= a) stop(edit, "The start and end markers are in the wrong order.");
    texts[edit.file] = text.slice(0, a) + edit.replace + text.slice(b);
  }
}

for (const [key, path] of Object.entries(FILES)) {
  if (!existsSync(path + BACKUP)) copyFileSync(path, path + BACKUP);
  writeFileSync(path, crlf[key] ? texts[key].replace(/\n/g, "\r\n") : texts[key], "utf8");
}
writeFileSync(GEOCODE_PATH, GEOCODE_PY, "utf8");

console.log("Patched: the dashboard, voice and OLED now show the street and city.");
console.log("New file: app/geocode.py (uses OpenStreetMap Nominatim, no key needed).");
console.log("Restart the app and hard-refresh the page (Ctrl+F5). It needs internet to look up addresses.");
console.log("Undo with: node patch-address.mjs --revert");
