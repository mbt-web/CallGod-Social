#!/usr/bin/env node
/**
 * Call God — Update caption footer across queue.json
 * ------------------------------------------------------------------
 * One-time patch: replaces the OLD caption footer with the NEW one
 * on every entry in content/queue.json, regardless of status
 * (pending, posted, or failed) — so historical entries stay
 * consistent with what actually went out, and future ones use the
 * new footer.
 *
 * Run once from CallGod-Social:
 *   node scripts/update-caption-footer.js
 */

const fs = require("fs");
const path = require("path");

const QUEUE_PATH = path.join(__dirname, "..", "content", "queue.json");

const OLD_FOOTER =
  "Shared from Call God. Free to download: https://www.call-god.com\n\n#CallGod #TalkToGod #BibleVerse #DailyVerse #CatholicApp #ChristianApp #FaithApp";

// Fallback in case some entries used a slightly different lead-in
// (e.g. missing the "Shared from Call God." line)
const OLD_FOOTER_ALT =
  "Free to download: https://www.call-god.com\n\n#CallGod #TalkToGod #BibleVerse #DailyVerse #CatholicApp #ChristianApp #FaithApp";

const NEW_FOOTER = `➕Get daily Gospels 
📖Read the Bible
📿Pray the rosary 
👏Prayers of the Saints 
📜Enhance your knowledge on Bible Quiz.
⛪Search Churches near you

✅Download the app now!
https://www.call-god.com

#PrayerTok #CatholicTok #ChristianTok #FaithTok #BibleVerse #PatronSaint #CatholicApp #PrayWithMe #GodIsGood #PrayerApp #AppReview #ChristianApp #DailyDevotional #SpiritualApp #CallGod #CallGodApp #TalkToGod`;

function main() {
  if (!fs.existsSync(QUEUE_PATH)) {
    console.error(`queue.json not found at ${QUEUE_PATH}`);
    process.exit(1);
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  let updated = 0;
  let skipped = 0;

  for (const item of queue) {
    if (item.caption.includes(OLD_FOOTER)) {
      item.caption = item.caption.replace(OLD_FOOTER, NEW_FOOTER);
      updated++;
    } else if (item.caption.includes(OLD_FOOTER_ALT)) {
      item.caption = item.caption.replace(OLD_FOOTER_ALT, NEW_FOOTER);
      updated++;
    } else {
      console.warn(`⚠️  ${item.id}: old footer not found — left unchanged, check manually`);
      skipped++;
    }
  }

  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(`\nUpdated ${updated} entries. ${skipped} skipped (footer pattern not matched).`);
}

main();
