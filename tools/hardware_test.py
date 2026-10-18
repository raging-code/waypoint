"""Tests the buzzer, LEDs and OLED on the Raspberry Pi, one at a time.

    python tools/hardware_test.py

Uses the pins from your .env file. On a PC it runs in simulated mode.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from app.config import Config  # noqa: E402
from app.hardware import Hardware  # noqa: E402


def main() -> None:
    cfg = Config.from_env()
    hw = Hardware(cfg)
    modes = hw.modes()
    print("Detected:", modes)
    if all(m == "simulated" for m in modes.values()):
        print("Everything is simulated. On a Raspberry Pi run setup_pi.sh first (installs gpiozero + luma.oled).")

    print(f"\nBuzzer  (GPIO{cfg.buzzer_pin}): two beeps")
    hw.buzzer.beep("test")
    time.sleep(1.0)

    print(f"LEDs    (red GPIO{cfg.led_red_pin}, green GPIO{cfg.led_green_pin}):")
    for state, text in [("offline", "red solid"), ("searching", "red blinking"), ("locked", "green solid"), ("off", "both off")]:
        hw.leds.set_state(state)
        print("   ", text)
        time.sleep(2.0)

    print(f"OLED    (I2C 0x{cfg.oled_i2c_address:02X}): showing text for 4 seconds")
    hw.oled.show(["Waypoint GPS", "OLED works!", "Lat 14.599500", "Lon 120.984200"])
    time.sleep(4.0)

    hw.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
