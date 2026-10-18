"""Troubleshooting tool: shows exactly what the GPS module is sending.

    python tools/nmea_monitor.py                  (auto-detect the port)
    python tools/nmea_monitor.py --port /dev/serial0
    python tools/nmea_monitor.py --port COM5 --seconds 30

Stop the Waypoint app first - only one program can use the serial port at a time.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app import nmea  # noqa: E402
from app.gps_reader import SerialSource, find_serial_port  # noqa: E402


def describe(msg):
    kind = msg["type"]
    if kind == "GGA":
        if msg["fix"]:
            return f"position {msg['lat']:.6f}, {msg['lon']:.6f}  alt {msg['altitude']} m  satellites {msg['satellites']}  hdop {msg['hdop']}"
        return f"NO FIX yet  satellites used {msg['satellites']}"
    if kind == "RMC":
        if msg["valid"]:
            return f"valid  speed {msg['speed_kmh']:.1f} km/h  course {msg['course']}  {msg['date']} {msg['time']} UTC"
        return "not valid yet (waiting for satellites)"
    if kind == "GSA":
        return {1: "no fix", 2: "2D fix", 3: "3D fix"}.get(msg["fix_type"], "?")
    if kind == "GSV":
        return f"{msg['in_view']} satellites in view"
    return ""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", help="serial port, e.g. /dev/serial0 or COM5 (default: auto-detect)")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--seconds", type=int, default=0, help="stop after N seconds (default: run until Ctrl+C)")
    args = ap.parse_args()

    port = args.port or find_serial_port()
    if not port:
        print("No serial port found. Use --port, and check the wiring / that the serial port is enabled.")
        return 1
    try:
        source = SerialSource(port, args.baud)
    except Exception as exc:
        print(f"Could not open {port}: {exc}")
        print("Linux: is another program using it? Are you in the 'dialout' group? Did you reboot after setup_pi.sh?")
        return 1

    print(f"Listening on {port} at {args.baud} baud. Press Ctrl+C to stop.\n")
    started = time.time()
    last_warning = started
    received = 0
    try:
        while not args.seconds or time.time() - started < args.seconds:
            line = source.readline().strip()
            if not line:
                if received == 0 and time.time() - last_warning >= 5:
                    print("... nothing received yet. Check: TX/RX crossed, GND connected, serial enabled, baud 9600.")
                    last_warning = time.time()
                continue
            received += 1
            if not line.startswith("$"):
                print(f"[noise]    {line[:70]!r}")
                continue
            msg = nmea.parse(line)
            if nmea.verify(line) is None:
                print(f"[bad sum]  {line}")
            elif msg is None:
                print(f"[ok]       {line}")
            else:
                print(f"[{msg['type']}]".ljust(11) + describe(msg))
    except KeyboardInterrupt:
        pass
    finally:
        source.close()
    print(f"\nLines received: {received}")
    return 0 if received else 2


if __name__ == "__main__":
    sys.exit(main())
