"""Buzzer, LEDs and OLED. Each class works on a PC too: if the real hardware (or its
library) is missing it silently becomes a software stand-in, and the dashboard shows
the same state in its Device panel."""
from __future__ import annotations

import logging
import threading
import time
from typing import List, Optional, Sequence, Tuple

from .config import Config

log = logging.getLogger("waypoint.hardware")

# (on_seconds, off_seconds, repeat)
BEEP_PATTERNS = {
    "detected": (0.12, 0.12, 2),   # module found / enabled
    "fix": (0.08, 0.08, 3),        # satellite fix acquired
    "lost": (0.80, 0.00, 1),       # satellite fix lost
    "offline": (0.40, 0.20, 2),    # module stopped responding
    "off": (0.20, 0.00, 1),        # module switched off
    "test": (0.15, 0.10, 2),
}


class Buzzer:
    """Active buzzer on one GPIO pin (HIGH = sound)."""

    def __init__(self, cfg: Config):
        self.mode = "simulated"
        self._dev = None
        self.active = False
        self._generation = 0
        self._lock = threading.Lock()
        if cfg.hardware == "auto":
            try:
                from gpiozero import Buzzer as GpioBuzzer

                self._dev = GpioBuzzer(cfg.buzzer_pin)
                self.mode = "gpio"
                log.info("Buzzer ready on GPIO%d", cfg.buzzer_pin)
            except Exception as exc:
                log.info("Buzzer simulated (%s)", exc)

    def _set(self, on: bool) -> None:
        self.active = on
        if self._dev is not None:
            try:
                self._dev.on() if on else self._dev.off()
            except Exception as exc:  # pragma: no cover
                log.warning("Buzzer error: %s", exc)

    def beep(self, pattern: str) -> None:
        on_s, off_s, count = BEEP_PATTERNS.get(pattern, BEEP_PATTERNS["test"])
        with self._lock:
            self._generation += 1
            gen = self._generation

        def run() -> None:
            for i in range(count):
                if gen != self._generation:
                    break
                self._set(True)
                time.sleep(on_s)
                self._set(False)
                if i < count - 1:
                    time.sleep(off_s)
            if gen == self._generation:
                self._set(False)

        threading.Thread(target=run, name="buzzer", daemon=True).start()

    def close(self) -> None:
        self._generation += 1
        self._set(False)
        if self._dev is not None:
            try:
                self._dev.close()
            except Exception:
                pass


class Leds:
    """Two LEDs. States: off | offline (red solid) | searching (red blink) | locked (green)."""

    def __init__(self, cfg: Config):
        self.mode = "simulated"
        self._red = None
        self._green = None
        self.state = "off"          # what the LEDs show right now
        self._desired = "off"       # what the GPS status wants them to show
        self._testing = False
        if cfg.hardware == "auto":
            try:
                from gpiozero import LED

                self._red = LED(cfg.led_red_pin)
                self._green = LED(cfg.led_green_pin)
                self.mode = "gpio"
                log.info("LEDs ready (red GPIO%d, green GPIO%d)", cfg.led_red_pin, cfg.led_green_pin)
            except Exception as exc:
                self._red = self._green = None
                log.info("LEDs simulated (%s)", exc)

    def _apply(self, state: str) -> None:
        self.state = state
        if self._red is None or self._green is None:
            return
        try:
            if state == "locked":
                self._red.off()
                self._green.on()
            elif state == "searching":
                self._green.off()
                self._red.blink(on_time=0.5, off_time=0.5, background=True)
            elif state == "offline":
                self._green.off()
                self._red.on()
            elif state == "test":
                self._red.on()
                self._green.on()
            else:
                self._red.off()
                self._green.off()
        except Exception as exc:  # pragma: no cover
            log.warning("LED error: %s", exc)

    def set_state(self, state: str) -> None:
        self._desired = state
        if not self._testing and state != self.state:
            self._apply(state)

    def test(self) -> None:
        def run() -> None:
            self._testing = True
            self._apply("test")
            time.sleep(1.2)
            self._testing = False
            self._apply(self._desired)

        threading.Thread(target=run, name="led-test", daemon=True).start()

    def close(self) -> None:
        self._apply("off")
        for led in (self._red, self._green):
            try:
                if led is not None:
                    led.close()
            except Exception:
                pass


class Oled:
    """128x64 I2C OLED (SSD1306 or SH1106). Shows four short text lines."""

    LINE_HEIGHT = 16

    def __init__(self, cfg: Config):
        self.mode = "simulated"
        self.lines: List[str] = ["", "", "", ""]
        self._device = None
        self._hold_until = 0.0
        self._lock = threading.Lock()
        if cfg.hardware == "auto" and cfg.oled_mode == "auto":
            try:
                from luma.core.interface.serial import i2c

                if cfg.oled_driver == "sh1106":
                    from luma.oled.device import sh1106 as driver
                else:
                    from luma.oled.device import ssd1306 as driver
                serial = i2c(port=cfg.oled_i2c_port, address=cfg.oled_i2c_address)
                self._device = driver(serial, width=128, height=64)
                self.mode = "i2c"
                log.info("OLED ready (%s at 0x%02X)", cfg.oled_driver, cfg.oled_i2c_address)
            except Exception as exc:
                self._device = None
                log.info("OLED simulated (%s)", exc)

    def _draw(self, lines: Sequence[str]) -> None:
        if self._device is None:
            return
        try:
            from luma.core.render import canvas

            if not any(lines):
                self._device.clear()
                return
            with canvas(self._device) as draw:
                for i, text in enumerate(lines[:4]):
                    draw.text((0, i * self.LINE_HEIGHT), text, fill="white")
        except Exception as exc:  # pragma: no cover
            log.warning("OLED error: %s", exc)

    def show(self, lines: Optional[Sequence[str]]) -> None:
        """Show lines (None = blank the screen). Ignored while a test message is held."""
        with self._lock:
            if time.monotonic() < self._hold_until:
                return
            new = list(lines) if lines else []
            new = (new + ["", "", "", ""])[:4]
            if new == self.lines:
                return
            self.lines = new
            self._draw(new)

    def hold(self, lines: Sequence[str], seconds: float) -> None:
        with self._lock:
            self._hold_until = time.monotonic() + seconds
            self.lines = (list(lines) + ["", "", "", ""])[:4]
            self._draw(self.lines)

    def close(self) -> None:
        if self._device is not None:
            try:
                self._device.clear()
                self._device.hide()
            except Exception:
                pass


class Hardware:
    def __init__(self, cfg: Config):
        self.buzzer = Buzzer(cfg)
        self.leds = Leds(cfg)
        self.oled = Oled(cfg)

    def modes(self) -> dict:
        return {"buzzer": self.buzzer.mode, "leds": self.leds.mode, "oled": self.oled.mode}

    def close(self) -> None:
        self.buzzer.close()
        self.leds.close()
        self.oled.close()
