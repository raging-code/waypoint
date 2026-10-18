"""Run with:  python -m unittest discover -s tests -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import nmea  # noqa: E402
from app.gps_reader import GPSState, SimulatedSource  # noqa: E402

GGA = "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47"
RMC = "$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A"


class NmeaTests(unittest.TestCase):
    def test_checksum_valid(self):
        self.assertIsNotNone(nmea.verify(GGA))
        self.assertIsNotNone(nmea.verify(RMC))

    def test_checksum_invalid(self):
        self.assertIsNone(nmea.verify(GGA.replace("545.4", "545.5")))
        self.assertIsNone(nmea.verify("garbage"))
        self.assertIsNone(nmea.verify("$GPGGA,1,2,3"))

    def test_gga(self):
        m = nmea.parse(GGA)
        self.assertEqual(m["type"], "GGA")
        self.assertAlmostEqual(m["lat"], 48.1173, places=4)
        self.assertAlmostEqual(m["lon"], 11.516667, places=5)
        self.assertEqual(m["satellites"], 8)
        self.assertAlmostEqual(m["altitude"], 545.4)
        self.assertTrue(m["fix"])
        self.assertEqual(m["time"], "12:35:19")

    def test_rmc(self):
        m = nmea.parse(RMC)
        self.assertTrue(m["valid"])
        self.assertAlmostEqual(m["speed_kmh"], 22.4 * 1.852, places=3)
        self.assertAlmostEqual(m["course"], 84.4)
        self.assertEqual(m["date"], "2094-03-23")  # ddmmyy '230394' -> 20 + yy

    def test_south_west_are_negative(self):
        body = "GPGGA,000000,3351.000,S,15112.000,W,1,06,1.0,10.0,M,0.0,M,,"
        m = nmea.parse(nmea.build_sentence(body))
        self.assertLess(m["lat"], 0)
        self.assertLess(m["lon"], 0)
        self.assertAlmostEqual(m["lat"], -(33 + 51 / 60))

    def test_no_fix_has_no_position(self):
        m = nmea.parse(nmea.build_sentence("GPGGA,000000,,,,,0,00,99.99,,,,,,"))
        self.assertFalse(m["fix"])
        self.assertIsNone(m["lat"])

    def test_gsv_and_gsa(self):
        gsv = nmea.parse(nmea.build_sentence("GPGSV,3,1,11,01,40,083,46,02,17,308,41,12,07,344,39,14,22,228,45"))
        self.assertEqual((gsv["message_number"], gsv["in_view"]), (1, 11))
        gsa = nmea.parse(nmea.build_sentence("GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1"))
        self.assertEqual(gsa["fix_type"], 3)
        self.assertAlmostEqual(gsa["hdop"], 1.3)

    def test_other_talkers(self):
        m = nmea.parse(nmea.build_sentence("GNGGA,000000,1436.000,N,12059.000,E,1,10,0.8,20.0,M,0.0,M,,"))
        self.assertEqual(m["talker"], "GN")


class SimulatorTests(unittest.TestCase):
    def test_simulator_roundtrip(self):
        src = SimulatedSource(14.5995, 120.9842, 3.0)
        state = GPSState()
        state.set_link("simulator", "simulator")
        # Generate 12 "seconds" of data without sleeping
        for _ in range(12):
            for line in src._generate():
                msg = nmea.parse(line)
                self.assertIsNotNone(msg, line)
                state.apply(msg)
        snap = state.snapshot(stale_after=5)
        self.assertTrue(snap["fix"])
        self.assertEqual(snap["fix_type"], 3)
        self.assertAlmostEqual(snap["lat"], 14.5995, delta=0.003)
        self.assertAlmostEqual(snap["lon"], 120.9842, delta=0.003)
        self.assertGreater(snap["in_view"], 0)


if __name__ == "__main__":
    unittest.main()
