#!/usr/bin/env node
/**
 * Call God — Build / refresh content/queue.json from captions + media
 * ------------------------------------------------------------------
 * Safe to re-run any time. It MERGES into the existing queue instead
 * of rebuilding it from scratch:
 *
 *   - Item already POSTED       -> left completely untouched.
 *   - Item pending or FAILED    -> caption / mediaUrl / mediaType are
 *                                  refreshed from captions.json and the
 *                                  media folders. Its status, result,
 *                                  error, platforms and any "comment"
 *                                  overrides are kept as they are.
 *   - New date / new media type -> appended as "pending".
 *   - Queue item with no matching media found now -> KEPT, with a
 *                                  warning. Nothing is ever deleted
 *                                  automatically; remove it by hand.
 *
 * Images and videos are separate queue entries (they post at different
 * times). Platform defaults for NEW entries:
 *   image -> facebook, instagram
 *   video -> facebook, instagram, youtube
 *
 * USAGE (run from inside CallGod-Social, after `git pull origin main`):
 *   node scripts/build-queue-from-media.js            # apply
 *   node scripts/build-queue-from-media.js --dry-run  # preview only
 *
 * FILES IT READS:
 *   scripts/captions.json and any other scripts/captions*.json (for example
 *   captions-oct19-dec31.json). All are combined; if the same id appears in
 *   more than one file, the first one wins (captions.json is read first).
 *   Each entry: { "id": "2026-10-19", "caption": "...", "platforms": [...],
 *                 "commentFacebook": "...", "commentInstagram": "..." }
 *   commentFacebook / commentInstagram are optional per-day comments; when
 *   present they are copied onto the queue item and refreshed on pending or
 *   failed items. Without them the poster uses its default comments.
 *   <ASSETS>\images\YYYY-MM-DD.jpg|jpeg|png
 *   <ASSETS>\videos\YYYY-MM-DD.mp4|mov
 */
const ASSETS_LOCAL_PATH = process.env.CALLGOD_ASSETS_PATH || "D:\\2026\\Apps\\CallGod-Assets";
const GITHUB_USERNAME = "mbt-web";
const ASSETS_REPO = "CallGod-Assets";

const fs = require("fs");
const path = require("path");

const QUEUE_PATH = path.join(__dirname, "..", "content", "queue.json");
const DRY_RUN = process.argv.includes("--dry-run");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png"];
const VIDEO_EXTENSIONS = [".mp4", ".mov"];

function findLocalFile(folder, baseName, extensions) {
  for (const ext of extensions) {
    const candidate = path.join(ASSETS_LOCAL_PATH, folder, `${baseName}${ext}`);
    if (fs.existsSync(candidate)) return { found: true, ext };
  }
  return { found: false };
}

function buildRawUrl(folder, baseName, ext) {
  return `https://raw.githubusercontent.com/${GITHUB_USERNAME}/${ASSETS_REPO}/main/${folder}/${baseName}${ext}`;
}

// "2026-10-21, 2026-10-22, 2026-10-23, 2026-10-25" -> "2026-10-21 to 2026-10-23 (3 days), 2026-10-25"
function compressDates(dates) {
  const sorted = [...dates].sort();
  const dayMs = 24 * 60 * 60 * 1000;
  const groups = [];
  for (const d of sorted) {
    const last = groups[groups.length - 1];
    if (last && new Date(d) - new Date(last[last.length - 1]) === dayMs) last.push(d);
    else groups.push([d]);
  }
  return groups
    .map((g) => (g.length === 1 ? g[0] : `${g[0]} to ${g[g.length - 1]} (${g.length} days)`))
    .join(", ");
}

function newEntry({ id, caption, mediaType, mediaUrl, platforms, comments }) {
  return {
    id,
    caption,
    mediaType,
    mediaUrl,
    platforms,
    ...(comments || {}),
    status: "pending",
    result: null,
    error: null,
    postedAt: null,
  };
}

function loadCaptions() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => /^captions.*\.json$/.test(f))
    .sort((a, b) => (a === "captions.json" ? -1 : b === "captions.json" ? 1 : a.localeCompare(b)));
  if (!files.length) {
    console.error(`No captions*.json file found in ${__dirname}`);
    process.exit(1);
  }
  const seen = new Map();
  const all = [];
  for (const f of files) {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));
    for (const entry of list) {
      if (seen.has(entry.id)) {
        console.warn(`⚠️  duplicate id ${entry.id} in ${f} (already in ${seen.get(entry.id)}); keeping the first`);
        continue;
      }
      seen.set(entry.id, f);
      all.push(entry);
    }
  }
  console.log(`Loaded ${all.length} caption entries from: ${files.join(", ")}`);
  return all;
}

function main() {
  if (!fs.existsSync(ASSETS_LOCAL_PATH)) {
    console.error(
      `Assets folder not found: ${ASSETS_LOCAL_PATH}\n` +
        `Set CALLGOD_ASSETS_PATH or fix ASSETS_LOCAL_PATH. Nothing was changed.`
    );
    process.exit(1);
  }

  const captions = loadCaptions();
  const existing = fs.existsSync(QUEUE_PATH)
    ? JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"))
    : [];
  const existingById = new Map(existing.map((item) => [item.id, item]));

  const merged = new Map(existing.map((item) => [item.id, item])); // start from what's there
  const stats = { added: [], updated: [], unchanged: 0, keptPosted: 0, noMedia: [] };

  for (const entry of captions) {
    const dateId = entry.id; // e.g. "2026-10-19"
    const video = findLocalFile("videos", dateId, VIDEO_EXTENSIONS);
    const image = findLocalFile("images", dateId, IMAGE_EXTENSIONS);

    if (!video.found && !image.found) {
      stats.noMedia.push(dateId);
      continue;
    }

    const basePlatforms = (entry.platforms || ["facebook", "instagram"]).filter(
      (p) => p === "facebook" || p === "instagram"
    );

    const comments = {};
    if (entry.commentFacebook) comments.commentFacebook = entry.commentFacebook;
    if (entry.commentInstagram) comments.commentInstagram = entry.commentInstagram;

    const wanted = [];
    if (image.found) {
      wanted.push({
        id: `${dateId}-daily-verse-image`,
        caption: entry.caption,
        mediaType: "image",
        mediaUrl: buildRawUrl("images", dateId, image.ext),
        platforms: basePlatforms,
        comments,
      });
    }
    if (video.found) {
      wanted.push({
        id: `${dateId}-daily-verse-video`,
        caption: entry.caption,
        mediaType: "video",
        mediaUrl: buildRawUrl("videos", dateId, video.ext),
        platforms: [...basePlatforms, "youtube"],
        comments,
      });
    }

    for (const w of wanted) {
      const current = existingById.get(w.id);

      if (!current) {
        merged.set(w.id, newEntry(w));
        stats.added.push(w.id);
        continue;
      }

      if (current.status === "posted") {
        stats.keptPosted++; // history: never touch
        continue;
      }

      const commentsChanged = Object.keys(w.comments).some((k) => current[k] !== w.comments[k]);
      const changed =
        current.caption !== w.caption ||
        current.mediaUrl !== w.mediaUrl ||
        current.mediaType !== w.mediaType ||
        commentsChanged;

      if (changed) {
        // Refresh content only; keep status, result, error, platforms, overrides.
        merged.set(w.id, {
          ...current,
          caption: w.caption,
          mediaType: w.mediaType,
          mediaUrl: w.mediaUrl,
          ...w.comments,
        });
        stats.updated.push(`${w.id} (${current.status})`);
      } else {
        stats.unchanged++;
      }
    }
  }

  const result = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Queue items that no longer have media / a caption entry: warn, keep.
  const regenerated = new Set();
  for (const entry of captions) {
    regenerated.add(`${entry.id}-daily-verse-image`);
    regenerated.add(`${entry.id}-daily-verse-video`);
  }
  const orphaned = existing.filter(
    (item) => item.status !== "posted" && !regenerated.has(item.id)
  );

  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Queue merge summary`);
  console.log(`  added:            ${stats.added.length}${stats.added.length ? "  -> " + stats.added.join(", ") : ""}`);
  console.log(`  content updated:  ${stats.updated.length}${stats.updated.length ? "  -> " + stats.updated.join(", ") : ""}`);
  console.log(`  unchanged:        ${stats.unchanged}`);
  console.log(`  posted (kept):    ${stats.keptPosted}`);
  if (stats.noMedia.length) {
    console.log(`  ⚠️  no image/video yet for ${stats.noMedia.length} date(s): ${compressDates(stats.noMedia)}`);
  }
  if (orphaned.length) {
    console.log(
      `  ⚠️  in queue but not in captions.json (kept, remove by hand if unwanted): ` +
        orphaned.map((i) => i.id).join(", ")
    );
  }

  if (DRY_RUN) {
    console.log("\nDry run: queue.json was NOT written.");
    return;
  }

  fs.writeFileSync(QUEUE_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${result.length} entries to ${QUEUE_PATH}`);
}

main();
