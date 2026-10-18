"""Street and city lookup (reverse geocoding) with OpenStreetMap's free Nominatim service.

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
AREA_KEYS = ("barangay", "neighbourhood", "quarter", "suburb", "village", "city_district", "borough")
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
