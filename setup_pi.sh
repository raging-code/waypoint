#!/usr/bin/env bash
# One-time setup for Raspberry Pi OS (Bookworm or newer recommended).
# Usage:  chmod +x setup_pi.sh && ./setup_pi.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/4  System packages"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip python3-dev build-essential libjpeg-dev zlib1g-dev i2c-tools espeak-ng
sudo apt-get install -y python3-gpiozero || true
sudo apt-get install -y python3-lgpio    || echo "   (python3-lgpio not available on this OS release - that is fine on older Raspberry Pi OS)"

echo "==> 2/4  Enabling the serial port (GPS) and I2C (OLED)"
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_serial_cons 1 || echo "   could not disable the serial login console - do it in raspi-config"
  sudo raspi-config nonint do_serial_hw 0   || echo "   could not enable the serial hardware - do it in raspi-config"
  sudo raspi-config nonint do_i2c 0         || echo "   could not enable I2C - do it in raspi-config"
else
  echo "   raspi-config not found. Enable 'Serial Port' (hardware on, login shell off) and 'I2C' manually."
fi

echo "==> 3/4  Python environment (.venv)"
python3 -m venv --system-site-packages .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt -r requirements-pi.txt
[ -f .env ] || cp .env.example .env

echo "==> 4/4  Permissions"
sudo usermod -aG dialout,gpio,i2c,audio "$USER" || true

echo
echo "Setup finished. Reboot now so the serial port, I2C and group changes take effect:"
echo "    sudo reboot"
echo "Then start the app with:"
echo "    .venv/bin/python run.py"
