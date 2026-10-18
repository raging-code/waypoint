"""HTTP routes: the dashboard page and a small JSON API."""
from __future__ import annotations

from flask import Blueprint, current_app, jsonify, render_template, request

from .service import DEVICES, Tracker

bp = Blueprint("main", __name__)


def _tracker() -> Tracker:
    return current_app.extensions["tracker"]


@bp.get("/")
def index():
    cfg = current_app.config["WAYPOINT"]
    client_cfg = {
        "googleMapsKey": cfg.google_maps_api_key,
        "googleMapId": cfg.google_map_id,
    }
    return render_template("index.html", client_cfg=client_cfg)


@bp.get("/api/state")
def state():
    try:
        since = int(request.args.get("since", "0"))
    except ValueError:
        since = 0
    resp = jsonify(_tracker().view(since))
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.post("/api/control")
def control():
    data = request.get_json(silent=True) or {}
    device = data.get("device")
    enabled = data.get("enabled")
    if device not in DEVICES or not isinstance(enabled, bool):
        return jsonify(ok=False, error="Expected {device: gps|buzzer|leds|oled, enabled: true|false}"), 400
    _tracker().set_enabled(device, enabled)
    return jsonify(ok=True, device=device, enabled=enabled)


@bp.post("/api/test/<device>")
def test_device(device: str):
    if device not in ("buzzer", "leds", "oled"):
        return jsonify(ok=False, error="Unknown device"), 404
    _tracker().test(device)
    return jsonify(ok=True)


@bp.post("/api/track/clear")
def clear_track():
    _tracker().clear_track()
    return jsonify(ok=True)


@bp.post("/api/voice/speak")
def speak():
    result = _tracker().speak_on_device()
    return jsonify(result), 200


@bp.get("/healthz")
def healthz():
    return jsonify(ok=True)
