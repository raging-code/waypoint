# Waypoint: live GPS tracker for Raspberry Pi

A Raspberry Pi reads a NEO-6M GPS module, serves a clean web dashboard (live map, readings, chart, controls) and drives a buzzer, two LEDs, an OLED and a voice that says where you are.

It runs on **your PC too**, with simulated GPS and simulated hardware, so you can develop in VS Code first and move to the Pi later.

| Workbook requirement | Where it is |
|---|---|
| Read NMEA from the GPS module (Python) | `app/gps_reader.py`, `app/nmea.py` |
| Flask web app showing live coordinates | `app/routes.py`, `app/templates/index.html` |
| Google Maps API map, track over time | map card (falls back to OpenStreetMap with no key) |
| Website to control and monitor the module | **Controls** panel (GPS on/off, buzzer, LEDs, OLED, voice) |
| Buzzer, LEDs, OLED notifications | `app/hardware.py`, `app/service.py` |
| Voice says the user's location | **Voice** row (browser or device speaker) |
| Graph of readings | **Trace** chart (speed, altitude, satellites) |
| Block diagram (Figure 6.2) | `docs/block_diagram.svg` and `.png`, notes in `docs/WORKBOOK.md` |

---

## 1. Run it on your PC (Windows, macOS, Linux)

Needs Python 3.9 or newer.

**Windows:** double-click `start_pc.bat`.
**macOS / Linux:** `bash start.sh`

Or by hand in VS Code's terminal:

```bash
python -m venv .venv
# Windows:      .venv\Scripts\python -m pip install -r requirements.txt
# macOS/Linux:  .venv/bin/python -m pip install -r requirements.txt
python run.py          # on Windows use:  .venv\Scripts\python run.py
```

Open **http://localhost:5000**. With no GPS attached it shows simulated data (an amber "Simulated data" badge appears). After about 8 seconds the simulated satellite fix is acquired.

**VS Code:** open this folder, then *Run and Debug* and pick **Waypoint: simulator only**. Select the `.venv` interpreter if VS Code asks.

**USB GPS on your PC:** find its port (Windows Device Manager, for example `COM5`; Linux `/dev/ttyACM0`), then in `.env` set `GPS_PORT=COM5` and `GPS_MODE=serial`.

---

## 2. Run it on the Raspberry Pi

### Wiring (BCM numbers, physical pin in brackets)

| GPS module (NEO-6M) | Raspberry Pi |
|---|---|
| VCC | 5V (pin 2) |
| GND | GND (pin 6) |
| **TX** | **GPIO15 / RXD (pin 10)** |
| **RX** | **GPIO14 / TXD (pin 8)** |

TX and RX are **crossed**: the module sends, the Pi receives. Most NEO-6M boards accept 3.3 V to 5 V on VCC; the workbook uses 5 V.

| Part | Connection |
|---|---|
| Active buzzer (or buzzer module) | signal to GPIO18 (pin 12), other side to GND |
| Green LED | GPIO23 (pin 16) through a 220 ohm resistor to GND |
| Red LED | GPIO24 (pin 18) through a 220 ohm resistor to GND |
| OLED 128x64 (I2C, SSD1306) | VCC to 3.3V (pin 1), GND to GND, SDA to GPIO2 (pin 3), SCL to GPIO3 (pin 5) |
| Speaker | 3.5 mm jack, HDMI, USB or Bluetooth audio |

A bare buzzer that draws more than about 15 mA needs a transistor; use a buzzer *module* or an NPN transistor to be safe. Change pins in `.env` if you wire differently.

### Install (once)

Copy the project folder to the Pi (USB stick, `scp`, or open it in the Pi's VS Code), then:

```bash
cd waypoint
chmod +x setup_pi.sh
./setup_pi.sh
sudo reboot
```

The script installs the system packages, turns on the serial port (and turns off the serial login console), turns on I2C, creates `.venv` and installs everything.

### Start

```bash
cd waypoint
.venv/bin/python run.py
```

The terminal prints two addresses. Open the **"On your network"** one from any phone or laptop on the same Wi-Fi. In VS Code on the Pi, pick **Waypoint: real GPS module** in *Run and Debug*.

### Check the parts one by one

```bash
.venv/bin/python tools/nmea_monitor.py     # raw sentences straight from the GPS module
.venv/bin/python tools/hardware_test.py    # buzzer, LEDs and OLED
```

A GPS module needs a clear view of the sky. Indoors, put it next to a window. The first fix can take a few minutes (cold start).

---

## 3. Using the dashboard

- **Map**: the orange dot is the device, the teal line is the track. The crosshair button follows the device, the corners button fits the whole track, the bin clears it.
- **Latitude / longitude**: *Copy* copies them; *Open in Google Maps* opens the spot in Google Maps.
- **Readings**: altitude, speed, heading, satellites used (and in view), accuracy (HDOP) and GPS time.
- **Controls**: switch the GPS module, buzzer, LEDs and OLED on or off; **Test** checks each part.
- **Voice**: *Speak* says your position. Pick *This browser* (the device you are looking at) or *Device speaker* (the Pi's speaker). *Repeat every 30 s* announces automatically.
- **Device**: a live preview of the OLED text and LEDs, so it works even without the hardware.

What the hardware does:

| Event | Buzzer | Green LED | Red LED | OLED |
|---|---|---|---|---|
| Module not responding | 2 long beeps | off | solid | "GPS not found" |
| Module detected, no fix | 2 short beeps | off | blinking | "GPS searching..." |
| Fix acquired | 3 quick beeps | solid | off | lat, lon, altitude, speed |
| Fix lost | 1 long beep | off | blinking | "GPS searching..." |

## 4. Google Maps (optional)

1. In Google Cloud Console create an API key and enable **Maps JavaScript API** (billing must be on; there is a monthly free allowance).
2. Restrict the key to your site/IP addresses.
3. Put it in `.env`: `GOOGLE_MAPS_API_KEY=your-key`, then restart.

With no key, or if Google rejects it, the dashboard shows OpenStreetMap automatically and says so with a notice. The label at the top-left of the map shows which one is active.

## 5. Settings (`.env`)

Copy `.env.example` to `.env`. The most useful:

| Setting | Meaning |
|---|---|
| `GPS_MODE` | `auto` (real module if the port opens, else simulator), `serial`, `simulator` |
| `GPS_PORT` | blank = auto-detect. `/dev/serial0` on the Pi GPIO wiring, `/dev/ttyACM0` for USB, `COM5` on Windows |
| `HARDWARE` | `auto` or `off` (force simulated buzzer/LEDs/OLED) |
| `OLED_DRIVER` | `ssd1306` (most 0.96") or `sh1106` (most 1.3") |
| `OLED_I2C_ADDRESS` | `0x3C` (try `0x3D` if `i2cdetect -y 1` shows that) |
| `HOST` | `0.0.0.0` = reachable on your network, `127.0.0.1` = this device only |

## 6. Troubleshooting

| Problem | Fix |
|---|---|
| "Simulated data" badge on the Pi | The serial port could not be opened. Hover the badge or read the terminal for the reason. Run `setup_pi.sh`, reboot, and check `ls -l /dev/serial0`. |
| "No GPS signal" | Nothing is arriving. Check TX/RX are crossed, GND is shared, and run `tools/nmea_monitor.py`. Stop the app first; only one program can hold the port. |
| Searching forever | Move the antenna outside or next to a window. Wait up to 5 minutes for a cold start. |
| Garbage characters in the monitor | Wrong baud rate. The NEO-6M default is 9600. |
| Permission denied on `/dev/serial0` | Log out and in (or reboot) after `setup_pi.sh`, or run `sudo usermod -aG dialout $USER`. |
| OLED stays dark | Run `i2cdetect -y 1`. If you see `3c` it is wired right; if you see `3d` set `OLED_I2C_ADDRESS=0x3D`. Try `OLED_DRIVER=sh1106`. |
| No voice from the Pi | `sudo apt install espeak-ng`, then test `espeak-ng "hello"`. Choose the output in the Pi's volume menu. |
| Browser voice is silent | Some browsers have no voices installed. Use *Device speaker*. |
| Windows: PowerShell blocks activation | Use `.venv\Scripts\python ...` directly, as in the commands above. |

The dashboard has no login, so only run it on a network you trust.

## 7. Project layout

```
run.py                  start the app
app/nmea.py             NMEA sentence parser (checksum, GGA, RMC, GSA, GSV)
app/gps_reader.py       serial source, simulator, background reader thread
app/hardware.py         buzzer, LEDs, OLED (fall back to simulated on a PC)
app/voice.py            text-to-speech through the OS (espeak-ng / Windows / macOS)
app/service.py          status logic, alerts, history, voice text
app/routes.py           web pages and JSON API
app/templates, static   dashboard (Leaflet and Chart.js are bundled, no CDN needed)
tools/                  nmea_monitor.py, hardware_test.py
tests/                  python -m unittest discover -s tests -v
docs/                   block diagram and workbook notes
```

Map tiles (OpenStreetMap or Google) still need an internet connection. Everything else works offline.
#   w a y p o i n t  
 