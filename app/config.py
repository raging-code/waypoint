"""Central configuration. Every value can be overridden in the .env file."""
from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip(), 0)  # base 0 lets you write 0x3C for the OLED address
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


def _str(name: str, default: str) -> str:
    raw = os.getenv(name)
    return default if raw is None else raw.strip()


@dataclass(frozen=True)
class Config:
    # Web server
    host: str
    port: int

    # GPS source: auto | serial | simulator
    gps_mode: str
    gps_port: str
    gps_baud: int
    stale_after: float  # seconds without a valid sentence before the module counts as offline

    # Map
    google_maps_api_key: str
    google_map_id: str

    # Hardware: auto | off
    hardware: str
    buzzer_pin: int
    led_green_pin: int
    led_red_pin: int
    oled_mode: str  # auto | off
    oled_driver: str  # ssd1306 (NFP1315-157B Y, 0.96", and most other 0.96" panels) | sh1106 (most 1.3")
    oled_i2c_port: int
    oled_i2c_address: int

    # Voice
    voice_enabled: bool
    piper_model: str
    piper_speed: float

    # Simulator
    sim_lat: float
    sim_lon: float
    sim_speed_ms: float

    @staticmethod
    def from_env() -> "Config":
        gps_mode = _str("GPS_MODE", "auto").lower()
        if gps_mode not in {"auto", "serial", "simulator"}:
            gps_mode = "auto"
        hardware = _str("HARDWARE", "auto").lower()
        if hardware not in {"auto", "off"}:
            hardware = "auto"
        oled_mode = _str("OLED", "auto").lower()
        if oled_mode not in {"auto", "off"}:
            oled_mode = "auto"
        oled_driver = _str("OLED_DRIVER", "ssd1306").lower()
        if oled_driver not in {"ssd1306", "sh1106"}:
            oled_driver = "ssd1306"

        return Config(
            host=_str("HOST", "0.0.0.0"),
            port=_int("PORT", 5000),
            gps_mode=gps_mode,
            gps_port=_str("GPS_PORT", ""),
            gps_baud=_int("GPS_BAUD", 9600),
            stale_after=_float("GPS_STALE_AFTER", 3.0),
            google_maps_api_key=_str("GOOGLE_MAPS_API_KEY", ""),
            google_map_id=_str("GOOGLE_MAP_ID", "DEMO_MAP_ID"),
            hardware=hardware,
            buzzer_pin=_int("BUZZER_PIN", 18),
            led_green_pin=_int("LED_GREEN_PIN", 23),
            led_red_pin=_int("LED_RED_PIN", 24),
            oled_mode=oled_mode,
            oled_driver=oled_driver,
            oled_i2c_port=_int("OLED_I2C_PORT", 1),
            oled_i2c_address=_int("OLED_I2C_ADDRESS", 0x3C),
            voice_enabled=_bool("VOICE_ENABLED", True),
            piper_model=_str("PIPER_MODEL", ""),
            piper_speed=_float("PIPER_SPEED", 1.0),
            sim_lat=_float("SIM_LAT", 14.5995),
            sim_lon=_float("SIM_LON", 120.9842),
            sim_speed_ms=_float("SIM_SPEED", 3.0),
        )
