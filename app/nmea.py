"""Minimal NMEA 0183 parser for the sentences a NEO-6M sends.

Supported sentences (any talker: GP, GN, GL, ...):
    GGA  position, altitude, fix quality, satellites used, HDOP
    RMC  position, speed, course, date/time, valid flag
    GSA  fix type (none / 2D / 3D) and DOP values
    GSV  number of satellites in view

A sentence looks like:   $GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47
The two hex digits after '*' are an XOR checksum of everything between '$' and '*'.
"""
from __future__ import annotations

from typing import Dict, Optional

KNOTS_TO_KMH = 1.852


def checksum(body: str) -> str:
    """Return the 2-digit hex XOR checksum of a sentence body (text between $ and *)."""
    value = 0
    for ch in body:
        value ^= ord(ch)
    return f"{value:02X}"


def build_sentence(body: str) -> str:
    """Wrap a body into a full sentence with checksum and CRLF."""
    return f"${body}*{checksum(body)}\r\n"


def verify(sentence: str) -> Optional[str]:
    """Validate framing + checksum. Returns the body, or None if the sentence is invalid."""
    sentence = sentence.strip()
    if len(sentence) < 9 or sentence[0] != "$" or "*" not in sentence:
        return None
    body, _, given = sentence[1:].rpartition("*")
    given = given.strip().upper()
    if len(given) != 2 or checksum(body) != given:
        return None
    return body


def to_degrees(value: str, hemisphere: str) -> Optional[float]:
    """Convert NMEA (d)ddmm.mmmm + N/S/E/W into signed decimal degrees."""
    if not value or "." not in value:
        return None
    try:
        dot = value.index(".")
        degrees = int(value[: dot - 2] or "0")
        minutes = float(value[dot - 2 :])
    except ValueError:
        return None
    decimal = degrees + minutes / 60.0
    if hemisphere in ("S", "W"):
        decimal = -decimal
    return decimal


def _float(text: str) -> Optional[float]:
    try:
        return float(text) if text != "" else None
    except ValueError:
        return None


def _int(text: str) -> Optional[int]:
    try:
        return int(text) if text != "" else None
    except ValueError:
        return None


def _utc_time(text: str) -> Optional[str]:
    """hhmmss(.ss) -> 'HH:MM:SS'."""
    if len(text) < 6 or not text[:6].isdigit():
        return None
    return f"{text[0:2]}:{text[2:4]}:{text[4:6]}"


def _utc_date(text: str) -> Optional[str]:
    """ddmmyy -> 'YYYY-MM-DD' (GPS dates are always 20yy for current hardware)."""
    if len(text) != 6 or not text.isdigit():
        return None
    return f"20{text[4:6]}-{text[2:4]}-{text[0:2]}"


def parse(sentence: str) -> Optional[Dict[str, object]]:
    """Parse one sentence. Returns a dict with a 'type' key, or None if invalid/unsupported."""
    body = verify(sentence)
    if body is None:
        return None
    fields = body.split(",")
    head = fields[0]
    if len(head) != 5:
        return None
    talker, kind = head[:2], head[2:]

    if kind == "GGA" and len(fields) >= 10:
        quality = _int(fields[6]) or 0
        return {
            "type": "GGA",
            "talker": talker,
            "time": _utc_time(fields[1]),
            "lat": to_degrees(fields[2], fields[3]),
            "lon": to_degrees(fields[4], fields[5]),
            "quality": quality,
            "satellites": _int(fields[7]),
            "hdop": _float(fields[8]),
            "altitude": _float(fields[9]),
            "fix": quality > 0,
        }

    if kind == "RMC" and len(fields) >= 10:
        speed_knots = _float(fields[7])
        return {
            "type": "RMC",
            "talker": talker,
            "time": _utc_time(fields[1]),
            "valid": fields[2] == "A",
            "lat": to_degrees(fields[3], fields[4]),
            "lon": to_degrees(fields[5], fields[6]),
            "speed_kmh": None if speed_knots is None else speed_knots * KNOTS_TO_KMH,
            "course": _float(fields[8]),
            "date": _utc_date(fields[9]),
        }

    if kind == "GSA" and len(fields) >= 18:
        return {
            "type": "GSA",
            "talker": talker,
            "fix_type": _int(fields[2]) or 1,  # 1 = no fix, 2 = 2D, 3 = 3D
            "pdop": _float(fields[15]),
            "hdop": _float(fields[16]),
            "vdop": _float(fields[17]),
        }

    if kind == "GSV" and len(fields) >= 4:
        return {
            "type": "GSV",
            "talker": talker,
            "message_number": _int(fields[2]),
            "in_view": _int(fields[3]),
        }

    return None
