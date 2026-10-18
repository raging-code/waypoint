"""Start Waypoint:  python run.py   then open http://localhost:5000"""
import socket

from dotenv import load_dotenv

load_dotenv()  # reads .env if present (must happen before the app reads its config)

from app import create_app  # noqa: E402
from app.config import Config  # noqa: E402


def lan_ip() -> str:
    """Best guess of this machine's address on the local network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is actually sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    cfg = Config.from_env()
    app = create_app(cfg)
    print()
    print("  Waypoint is running")
    print(f"  On this device   http://localhost:{cfg.port}")
    if cfg.host in ("0.0.0.0", "::"):
        print(f"  On your network  http://{lan_ip()}:{cfg.port}")
    print(f"  GPS mode: {cfg.gps_mode}   (Ctrl+C to stop)")
    print()
    app.run(host=cfg.host, port=cfg.port, debug=False, threaded=True, use_reloader=False)
