"""Waypoint - live GPS tracker for Raspberry Pi + NEO-6M."""
from __future__ import annotations

import atexit
import logging
from typing import Optional

from flask import Flask

from .config import Config
from .service import Tracker


def create_app(cfg: Optional[Config] = None) -> Flask:
    cfg = cfg or Config.from_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    app = Flask(__name__)
    app.config["WAYPOINT"] = cfg

    tracker = Tracker(cfg)
    app.extensions["tracker"] = tracker

    from .routes import bp

    app.register_blueprint(bp)

    tracker.start()
    atexit.register(tracker.stop)
    return app
