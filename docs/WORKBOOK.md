# Workbook helper (Activity 6)

## Figure 6.2 block diagram
Use `block_diagram.png` (or `.svg`) as your reference and redraw it by hand.

## Discussion (draft, put it in your own words)

Figure 6.2 shows the Raspberry Pi as the central controller. The NEO-6M GPS module receives signals from GPS satellites and sends NMEA sentences to the Pi through the UART serial port: the module's TX goes to the Pi's RX (GPIO15) and the module's RX goes to the Pi's TX (GPIO14), with a shared ground and 5 V power.

A Python program parses the sentences, checks their checksums and works out the status of the module: not responding, searching for satellites, or locked on a fix. Based on that status it drives the outputs. An active buzzer on GPIO18 gives audible notifications when the module is detected, a fix is acquired or lost. A red LED (GPIO24) and a green LED (GPIO23) show the state visually: red for searching or no signal, green for a locked fix. An I2C OLED display (SDA on GPIO2, SCL on GPIO3) shows the status, latitude, longitude, altitude and speed directly on the device. A speaker plays a voice announcement of the user's location.

The Flask web server runs on the same Pi and exposes the readings and controls over Wi-Fi or Ethernet. A web browser on a PC or phone shows a live map (Google Maps API, with OpenStreetMap as a fallback), a graph of speed, altitude or satellite count over time, and switches to turn the GPS module, buzzer, LEDs and OLED on or off. The browser can also speak the location. The map service is the only part that needs internet access.

## Alert behaviour (for your table)

| State | Buzzer | Red LED | Green LED | OLED |
|---|---|---|---|---|
| Not responding | 2 long beeps | solid | off | GPS not found |
| Searching | 2 short beeps when detected | blinking | off | GPS searching |
| Locked | 3 quick beeps | off | solid | coordinates |
| Fix lost | 1 long beep | blinking | off | GPS searching |
