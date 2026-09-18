#!/usr/bin/env node
/**
 * Call God — Build queue.json from local media + captions
 * ------------------------------------------------------------------
 * Scans your local CallGod-Assets folders (images/ and videos/) and
 * builds content/queue.json.
 *
 * Images and videos post at SEPARATE scheduled times (images 9am,
 * videos 6pm — triggered externally via cron-job.org), so this
 * creates a SEPARATE queue entry for each media type found per date.
 *
 * PLATFORM RULES (enforced here regardless of what captions.json
 * says, since YouTube only accepts video uploads):
 *   - IMAGE entries: facebook + instagram only — "youtube" is
 *     always stripped out, even if present in captions.json.
 *   - VIDEO entries: facebook + instagram + youtube.
 *
 * USAGE (run from inside CallGod-Social):
 *   node scripts/build-queue-from-media.js
 */
const ASSETS_LOCAL_PATH = "D:\\2026\\Apps\\CallGod-Assets";
const GITHUB_USERNAME = "mbt-web";
const ASSETS_REPO = "CallGod-Assets";

const fs = require("fs");
const path = require("path");

const CAPTIONS_PATH = path.join(__dirname, "captions.json");
const QUEUE_OUTPUT_PATH = path.join(__dirname, "..", "content", "queue.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const VIDEO_EXTENSIONS = [".mp4", ".mov"];

function findLocalFile(folder, baseName, extensions) {
  for (const ext of extensions) {
    const candidate = path.join(ASSETS_LOCAL_PATH, folder, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) {
      return { found: true, ext, absolutePath: candidate };
    }
  }
  return { found: false };
}

function buildRawUrl(folder, baseName, ext) {
  return `https://raw.githubusercontent.com/${GITHUB_USERNAME}/${ASSETS_REPO}/main/${folder}/${baseName}${ext}`;
}

function main() {
  if (!fs.existsSync(CAPTIONS_PATH)) {
    console.error(`captions.json not found at ${CAPTIONS_PATH}`);
    process.exit(1);
  }
  const captions = JSON.parse(fs.readFileSync(CAPTIONS_PATH, "utf8"));

  const queue = [];
  const skippedDates = [];
  let imageCount = 0;
  let videoCount = 0;

  for (const entry of captions) {
    const dateId = entry.id; // e.g. "2026-09-17"

    const video = findLocalFile("videos", dateId, VIDEO_EXTENSIONS);
    const image = findLocalFile("images", dateId, IMAGE_EXTENSIONS);

    if (!video.found && !image.found) {
      console.warn(`⚠️  ${dateId}: no image or video found locally — SKIPPING`);
      skippedDates.push(dateId);
      continue;
    }

    // Whatever captions.json says, treat facebook/instagram as the
    // only base platforms — youtube is decided here, not inherited.
    const rawBase = entry.platforms || ["facebook", "instagram"];
    const basePlatforms = rawBase.filter((p) => p === "facebook" || p === "instagram");

    if (image.found) {
      queue.push({
        id: `${dateId}-daily-verse-image`,
        caption: entry.caption,
        mediaType: "image",
        mediaUrl: buildRawUrl("images", dateId, image.ext),
        platforms: basePlatforms, // images: facebook + instagram ONLY, youtube always excluded
        status: "pending",
        result: null,
        error: null,
        postedAt: null,
      });
      imageCount++;
      console.log(`✅ ${dateId}: queued IMAGE (${image.ext}) -> ${basePlatforms.join(", ")}`);
    }

    if (video.found) {
      const videoPlatforms = [...basePlatforms, "youtube"];
      queue.push({
        id: `${dateId}-daily-verse-video`,
        caption: entry.caption,
        mediaType: "video",
        mediaUrl: buildRawUrl("videos", dateId, video.ext),
        platforms: videoPlatforms, // videos: facebook + instagram + youtube
        status: "pending",
        result: null,
        error: null,
        postedAt: null,
      });
      videoCount++;
      console.log(`✅ ${dateId}: queued VIDEO (${video.ext}) -> ${videoPlatforms.join(", ")}`);
    }
  }

  queue.sort((a, b) => a.id.localeCompare(b.id));

  fs.writeFileSync(QUEUE_OUTPUT_PATH, JSON.stringify(queue, null, 2) + "\n", "utf8");

  console.log(`\nWrote ${queue.length} entries (${imageCount} image, ${videoCount} video) to ${QUEUE_OUTPUT_PATH}`);
  if (skippedDates.length) {
    console.log(`Skipped ${skippedDates.length} dates (no local media found): ${skippedDates.join(", ")}`);
  }
}

main();
