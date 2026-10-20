#!/usr/bin/env node
/**
 * Waypoint OLED patch: switch the documented/default display to the
 * NFP1315-157B Y, a 0.96" 128x64 I2C OLED.
 *
 * That panel is SSD1306-driven, same as the OLED Waypoint already ships
 * with (app/hardware.py uses luma.oled's ssd1306 driver by default), so
 * no new driver code is needed. This patch just makes that explicit:
 *   - .env.example: OLED_DRIVER left as "ssd1306" but labelled with the
 *     exact panel name, and the I2C address comment spells out the
 *     3C/3D check for this panel.
 *   - README.md: hardware table and OLED_DRIVER row now name the
 *     NFP1315-157B Y instead of the generic "most 0.96"" wording.
 *   - app/config.py: the oled_driver dataclass field comment names the
 *     panel so the default isn't a mystery when you read the code.
 *
 * Street / barangay / city on the OLED (and spoken aloud) already works
 * in this repo - app/service.py's _oled_lines() and _place_phrase() show
 * "street, barangay, city" whenever geocoding has an answer, falling
 * back to raw lat/lon only when it doesn't. This patch does not touch
 * that logic; it's listed in the summary below so you can confirm it.
 *
 * Usage (run from the Waypoint folder, the one that contains run.py):
 *
 *   node patch-oled-nfp1315.mjs            apply the patch
 *   node patch-oled-nfp1315.mjs --revert   undo it
 *   node patch-oled-nfp1315.mjs <folder>   patch a project in another folder
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
  env: join(root, ".env.example"),
  readme: join(root, "README.md"),
  config: join(root, "app", "config.py"),
};
const BACKUP = ".bak-oled-nfp1315";

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

for (const path of Object.values(FILES)) {
  if (!existsSync(path)) {
    fail(
      `Cannot find ${path}\n` +
      `Run this script from the Waypoint folder (the one containing run.py), ` +
      `or pass the folder: node patch-oled-nfp1315.mjs <folder>`
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
  console.log(restored ? "\nReverted." : "\nNothing to revert (no .bak-oled-nfp1315 files found).");
  process.exit(0);
}

// ---------------------------------------------------------------- edits
// Each entry: file key, exact text to find, its replacement.
const EDITS = [
  {
    file: "env",
    find: `HARDWARE=auto
BUZZER_PIN=18
LED_GREEN_PIN=23
LED_RED_PIN=24
OLED=auto
OLED_DRIVER=ssd1306
OLED_I2C_PORT=1
OLED_I2C_ADDRESS=0x3C`,
    replace: `HARDWARE=auto
BUZZER_PIN=18
LED_GREEN_PIN=23
LED_RED_PIN=24
OLED=auto
# Display: NFP1315-157B Y, 0.96" 128x64 I2C OLED (SSD1306-compatible)
OLED_DRIVER=ssd1306
OLED_I2C_PORT=1
# i2cdetect -y 1 should show 3c for this panel; some boards ship at 3d
OLED_I2C_ADDRESS=0x3C`,
  },
  {
    file: "readme",
    find: `| OLED 128x64 (I2C, SSD1306) | VCC to 3.3V (pin 1), GND to GND, SDA to GPIO2 (pin 3), SCL to GPIO3 (pin 5) |`,
    replace: `| OLED 128x64 (I2C, SSD1306) - NFP1315-157B Y, 0.96" | VCC to 3.3V (pin 1), GND to GND, SDA to GPIO2 (pin 3), SCL to GPIO3 (pin 5) |`,
  },
  {
    file: "readme",
    find: `| \`OLED_DRIVER\` | \`ssd1306\` (most 0.96") or \`sh1106\` (most 1.3") |`,
    replace: `| \`OLED_DRIVER\` | \`ssd1306\` - NFP1315-157B Y and most other 0.96" panels - or \`sh1106\` (most 1.3") |`,
  },
  {
    file: "config",
    find: `    oled_mode: str  # auto | off
    oled_driver: str  # ssd1306 | sh1106`,
    replace: `    oled_mode: str  # auto | off
    oled_driver: str  # ssd1306 (NFP1315-157B Y, 0.96", and most other 0.96" panels) | sh1106 (most 1.3")`,
  },
];

// ---------------------------------------------------------------- apply
const texts = {};
for (const key of Object.keys(FILES)) {
  texts[key] = readFileSync(FILES[key], "utf8");
}

if (texts.readme.includes("NFP1315-157B Y") && texts.config.includes("NFP1315-157B Y")) {
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
      `(wrong version, already modified). Nothing was changed.`
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
  "\nDone. .env, README and config.py now name the NFP1315-157B Y, 0.96\" OLED explicitly.\n" +
  "No driver change was needed: that panel is SSD1306-compatible, which was already the\n" +
  "default (OLED_DRIVER=ssd1306, address 0x3C). If i2cdetect -y 1 shows 3d instead, set\n" +
  "OLED_I2C_ADDRESS=0x3D in your .env.\n\n" +
  "Street, barangay, and city were already shown on the OLED (and spoken) before this\n" +
  "patch - see app/service.py's _oled_lines() and _place_phrase() - so that behavior is\n" +
  "untouched here.\n\n" +
  "Undo with: node patch-oled-nfp1315.mjs --revert"
);
