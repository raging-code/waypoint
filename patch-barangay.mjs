#!/usr/bin/env node
/**
 * Waypoint barangay patch: say street, barangay, and city - never the raw
 * latitude / longitude / altitude as long as ANY place name is known.
 *
 * Requires patch-address.mjs to already be applied (it is, on a stock clone
 * of this repo - that's what the app/*.bak-address files next to app/service.py
 * are). This patch only touches app/geocode.py and app/service.py.
 *
 * What changes:
 *   - app/geocode.py: AREA_KEYS now also recognises "barangay" (Nominatim
 *     returns Philippine barangays under that key, or sometimes "suburb" /
 *     "village" / "quarter" - those stay as fallbacks).
 *   - app/service.py: _place_phrase() now builds "Street, Barangay, City",
 *     dropping whichever parts are missing, instead of "Street in City".
 *     speech_text() only falls back to latitude / longitude / altitude when
 *     geocoding has returned nothing at all (e.g. no internet yet).
 *
 * Usage (run from the Waypoint folder, the one that contains run.py):
 *
 *   node patch-barangay.mjs            apply the patch
 *   node patch-barangay.mjs --revert   undo it
 *   node patch-barangay.mjs <folder>   patch a project in another folder
 *
 * Safe to run twice. Nothing is written unless every edit matches exactly.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const folderArg = args.find((a) => !a.startsWith("-"));
const root = resolve(folderArg ?? dirname(fileURLToPath(import.meta.url)));

const FILES = {
  geocode: join(root, "app", "geocode.py"),
  service: join(root, "app", "service.py"),
};
const BACKUP = ".bak-barangay";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

for (const path of Object.values(FILES)) {
  if (!existsSync(path)) {
    fail(
      `Cannot find ${path}\n` +
      `Run this script from the Waypoint folder (the one containing run.py), ` +
      `or pass the folder: node patch-barangay.mjs <folder>\n` +
      `Also make sure patch-address.mjs has been applied first.`
    );
  }
}

// ---------------------------------------------------------------- revert
if (revert) {
  let restored = 0;
  for (const path of Object.values(FILES)) {
    if (existsSync(path + BACKUP)) {
      copyFileSync(path + BACKUP, path);
      unlinkSync(path + BACKUP);
      console.log(`Restored ${path}`);
      restored++;
    }
  }
  console.log(restored ? "\nReverted." : "\nNothing to revert (no .bak-barangay files found).");
  process.exit(0);
}

// ---------------------------------------------------------------- edits
// Each entry: file key, exact text to find, its replacement.
const EDITS = [
  {
    file: "geocode",
    find: `AREA_KEYS = ("neighbourhood", "quarter", "suburb", "city_district", "borough")`,
    replace: `AREA_KEYS = ("barangay", "neighbourhood", "quarter", "suburb", "village", "city_district", "borough")`,
  },
  {
    file: "service",
    find: `    def _place_phrase(self) -> str:
        """'Roxas Boulevard in Manila', or '' while no address is known."""
        a = self.geocoder.snapshot()
        if not a["ok"]:
            return ""
        street = str(a["street"] or a["area"])
        city = str(a["city"])
        if street and city:
            return f"{street} in {city}"
        return street or city`,
    replace: `    def _place_phrase(self) -> str:
        """'Roxas Boulevard, Barangay San Antonio, Manila', or '' while no address is known.

        Prefers street, then barangay (or whatever area name Nominatim gave), then city,
        joining whichever parts are actually known. Never falls back to coordinates here -
        that fallback only kicks in in speech_text() when NOTHING was found at all.
        """
        a = self.geocoder.snapshot()
        if not a["ok"]:
            return ""
        street = str(a["street"])
        area = str(a["area"])  # barangay, or the closest equivalent Nominatim returned
        city = str(a["city"])
        parts = [p for p in (street, area, city) if p]
        return ", ".join(parts)`,
  },
  {
    file: "service",
    find: `        lat, lon = float(snap["lat"]), float(snap["lon"])  # type: ignore[arg-type]
        place = self._place_phrase()
        if place:
            text = f"You are on {place}"
        else:  # no street name yet (for example no internet): say the coordinates instead`,
    replace: `        lat, lon = float(snap["lat"]), float(snap["lon"])  # type: ignore[arg-type]
        place = self._place_phrase()
        if place:
            text = f"You are on {place}"
        else:  # no place name at all yet (for example no internet): say the coordinates instead`,
  },
];

// ---------------------------------------------------------------- apply
let alreadyApplied = true;
for (const { file, find } of EDITS) {
  const text = readFileSync(FILES[file], "utf8");
  if (!text.includes(find)) {
    alreadyApplied = false;
    break;
  }
}
if (alreadyApplied) {
  // Only true if the OLD text is still present, i.e. not yet patched.
  // Fall through to apply.
}

const texts = {};
for (const key of Object.keys(FILES)) {
  texts[key] = readFileSync(FILES[key], "utf8");
}

// Detect "already patched" by checking for the new marker text.
if (texts.geocode.includes('"barangay"') && texts.service.includes("Prefers street, then barangay")) {
  console.log("Already patched. Nothing to do. (Use --revert to undo.)");
  process.exit(0);
}

for (const { file, find, replace } of EDITS) {
  const text = texts[file];
  const count = text.split(find).length - 1;
  if (count === 0) {
    fail(
      `Could not find the expected text in ${FILES[file]}.\n` +
      `This file may already differ from what this patch expects ` +
      `(wrong version, already modified, or patch-address.mjs not applied). Nothing was changed.`
    );
  }
  if (count > 1) {
    fail(`Found more than one match for an edit in ${FILES[file]}. Nothing was changed.`);
  }
  texts[file] = text.split(find).join(replace);
}

// Back up, then write.
for (const key of Object.keys(FILES)) {
  const path = FILES[key];
  if (!existsSync(path + BACKUP)) {
    copyFileSync(path, path + BACKUP);
  }
  writeFileSync(path, texts[key], "utf8");
  console.log(`Patched ${path}`);
}

console.log(
  "\nDone. Street / barangay / city will now be spoken and shown whenever any of them " +
  "are known (coordinates are only used as a last resort). Restart the app to pick it up.\n" +
  "Undo with: node patch-barangay.mjs --revert"
);
