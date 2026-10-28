#!/usr/bin/env node
/**
 * Call God — Social Auto-Poster (Node.js + GitHub Actions version)
 * ------------------------------------------------------------------
 * Posts the next pending item in content/queue.json to Facebook,
 * Instagram, and YouTube. Supports images and video. After a
 * successful Facebook/Instagram post, automatically drops a follow-up
 * comment (app download link + follow/like/subscribe links) under that post.
 *
 * ENV VARS REQUIRED (set as GitHub Actions secrets):
 *   META_PAGE_ACCESS_TOKEN   System user / page access token
 *   META_PAGE_ID             Facebook Page ID
 *   META_IG_USER_ID          Instagram Business Account ID
 *   YOUTUBE_REFRESH_TOKEN    OAuth2 Refresh Token
 *   YOUTUBE_CLIENT_ID        OAuth2 Client ID
 *   YOUTUBE_CLIENT_SECRET    OAuth2 Client Secret
 */

const fs = require("fs");
const path = require("path");
const { postToTikTok } = require("./post-to-tiktok");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const QUEUE_PATH = path.join(__dirname, "..", "content", "queue.json");

const PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.META_PAGE_ID;
const IG_USER_ID = process.env.META_IG_USER_ID;

const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

const IG_VIDEO_POLL_INTERVAL_MS = 5000;
const IG_VIDEO_POLL_MAX_ATTEMPTS = 24;

// Images are usually ready within seconds, but publishing before the
// container is ready causes "Media ID is not available". Poll briefly,
// then retry the publish call a few times if Instagram still says so.
const IG_IMAGE_POLL_INTERVAL_MS = 2000;
const IG_IMAGE_POLL_MAX_ATTEMPTS = 10;
const IG_PUBLISH_RETRY_DELAY_MS = 3000;
const IG_PUBLISH_MAX_RETRIES = 5;

// Follow-up comments dropped under each post right after it goes live.
// Facebook gets clickable links to every channel. Instagram comments
// aren't clickable, so it gets handles/names instead, and doesn't ask
// people to follow the account they're already on.
//
// Override per queue item with:
//   "comment"          -> used on both Facebook and Instagram
//   "commentFacebook"  -> Facebook only
//   "commentInstagram" -> Instagram only
const DEFAULT_COMMENT_FACEBOOK = [
  "📲 Download Call God free: https://www.call-god.com",
  "",
  "🙏 Stay connected with Call God:",
  "▶️ YouTube: https://www.youtube.com/@CallGodApp",
  "📸 Instagram: https://www.instagram.com/call.god_com/",
  "🎵 TikTok: https://www.tiktok.com/@appcallgod",
  "",
  "👍 Like this post, follow our pages and subscribe so you never miss a daily verse. God bless you! 🕊️",
].join("\n");

const DEFAULT_COMMENT_INSTAGRAM = [
  "📲 Download Call God free: www.call-god.com",
  "",
  "🙏 Follow @call.god_com for your daily verse, and join us on:",
  "▶️ YouTube: @CallGodApp",
  "🎵 TikTok: @appcallgod",
  "",
  "❤️ Like, share and subscribe so you never miss a blessing. God bless you! 🕊️",
].join("\n");

function assertEnv() {
  const missing = [];
  if (!PAGE_ACCESS_TOKEN) missing.push("META_PAGE_ACCESS_TOKEN");
  if (!PAGE_ID) missing.push("META_PAGE_ID");
  if (!IG_USER_ID) missing.push("META_IG_USER_ID");
  if (missing.length) {
    console.error(`Missing required Meta env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) {
    console.error(`Queue file not found at ${QUEUE_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
}

function saveQueue(queue) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n", "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------- Facebook ----------------

// Facebook Page endpoints (video upload, comments as the Page) need a
// PAGE access token. If META_PAGE_ACCESS_TOKEN is a system user token,
// exchange it for the Page's own token once per run. If the secret is
// already a Page token (or the exchange fails), use it as-is.
let cachedPageToken = null;
async function getFacebookPageToken() {
  if (cachedPageToken) return cachedPageToken;
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${PAGE_ID}?fields=access_token&access_token=${PAGE_ACCESS_TOKEN}`
    );
    const data = await res.json();
    if (data.access_token) {
      cachedPageToken = data.access_token;
      console.log("  Using Page access token for Facebook.");
      return cachedPageToken;
    }
    console.warn(
      "  ⚠️ Could not get a Page token, using META_PAGE_ACCESS_TOKEN as-is:",
      data.error ? data.error.message : "no access_token returned"
    );
  } catch (err) {
    console.warn("  ⚠️ Page token lookup failed, using META_PAGE_ACCESS_TOKEN as-is:", err.message);
  }
  cachedPageToken = PAGE_ACCESS_TOKEN;
  return cachedPageToken;
}

async function postToFacebook({ caption, mediaUrl, mediaType }) {
  if (mediaType === "video") {
    const url = `${GRAPH_BASE}/${PAGE_ID}/videos`;
    const params = new URLSearchParams({
      description: caption,
      file_url: mediaUrl,
      access_token: await getFacebookPageToken(),
    });
    const res = await fetch(url, { method: "POST", body: params });
    const data = await res.json();
    if (data.error) throw new Error(`Facebook video error: ${data.error.message}`);
    return data;
  }

  const url = `${GRAPH_BASE}/${PAGE_ID}/photos`;
  const params = new URLSearchParams({
    caption,
    url: mediaUrl,
    access_token: await getFacebookPageToken(),
  });
  const res = await fetch(url, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw new Error(`Facebook error: ${data.error.message}`);
  return data;
}

/**
 * Posts a comment under an existing Facebook post/photo/video.
 * objectId should be the id returned from the original post call
 * (data.id for photos/videos; data.post_id also works for photos
 * if present).
 */
async function postCommentToFacebook(objectId, commentText) {
  const url = `${GRAPH_BASE}/${objectId}/comments`;
  const params = new URLSearchParams({
    message: commentText,
    access_token: await getFacebookPageToken(),
  });
  const res = await fetch(url, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Facebook comment error: ${data.error.message}`);
  }
  return data; // { id: "<comment_id>" }
}

// ---------------- Instagram ----------------

async function createIgContainer({ caption, mediaUrl, mediaType }) {
  const createUrl = `${GRAPH_BASE}/${IG_USER_ID}/media`;
  const params =
    mediaType === "video"
      ? new URLSearchParams({
          media_type: "REELS",
          video_url: mediaUrl,
          caption,
          access_token: PAGE_ACCESS_TOKEN,
        })
      : new URLSearchParams({
          image_url: mediaUrl,
          caption,
          access_token: PAGE_ACCESS_TOKEN,
        });

  const res = await fetch(createUrl, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Instagram (create container) error: ${data.error.message}`);
  }
  return data.id;
}

async function waitForIgContainerReady(creationId, { intervalMs, maxAttempts, label }) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const statusUrl = `${GRAPH_BASE}/${creationId}?fields=status_code&access_token=${PAGE_ACCESS_TOKEN}`;
    const res = await fetch(statusUrl);
    const data = await res.json();

    if (data.error) {
      throw new Error(`Instagram (status check) error: ${data.error.message}`);
    }

    if (data.status_code === "FINISHED") return true;
    if (data.status_code === "ERROR") {
      throw new Error(`Instagram ${label} processing failed (status_code: ERROR).`);
    }

    console.log(`  ...IG container status: ${data.status_code || "unknown"}, waiting`);
    await sleep(intervalMs);
  }
  return false; // not confirmed ready within the allowed time
}

async function publishIgContainer(creationId) {
  const publishUrl = `${GRAPH_BASE}/${IG_USER_ID}/media_publish`;

  for (let attempt = 0; attempt <= IG_PUBLISH_MAX_RETRIES; attempt++) {
    const params = new URLSearchParams({
      creation_id: creationId,
      access_token: PAGE_ACCESS_TOKEN,
    });
    const res = await fetch(publishUrl, { method: "POST", body: params });
    const data = await res.json();

    if (!data.error) return data;

    const notReady = /Media ID is not available|not ready|try again/i.test(data.error.message || "");
    if (notReady && attempt < IG_PUBLISH_MAX_RETRIES) {
      console.log(`  ...IG container not ready to publish yet, retrying (${attempt + 1}/${IG_PUBLISH_MAX_RETRIES})`);
      await sleep(IG_PUBLISH_RETRY_DELAY_MS);
      continue;
    }
    throw new Error(`Instagram (publish) error: ${data.error.message}`);
  }
}

async function postToInstagram({ caption, mediaUrl, mediaType }) {
  const creationId = await createIgContainer({ caption, mediaUrl, mediaType });

  if (mediaType === "video") {
    console.log("  Waiting for Instagram to process the video...");
    const ready = await waitForIgContainerReady(creationId, {
      intervalMs: IG_VIDEO_POLL_INTERVAL_MS,
      maxAttempts: IG_VIDEO_POLL_MAX_ATTEMPTS,
      label: "video",
    });
    if (!ready) {
      throw new Error("Timed out waiting for Instagram video to finish processing.");
    }
  } else {
    // Images: short wait for readiness; if still unconfirmed, the
    // publish retry loop below covers the remaining gap.
    await waitForIgContainerReady(creationId, {
      intervalMs: IG_IMAGE_POLL_INTERVAL_MS,
      maxAttempts: IG_IMAGE_POLL_MAX_ATTEMPTS,
      label: "image",
    });
  }

  return publishIgContainer(creationId);
}

/**
 * Posts a comment under a published Instagram media item.
 * mediaId is the id returned from media_publish (data.id).
 */
async function postCommentToInstagram(mediaId, commentText) {
  const url = `${GRAPH_BASE}/${mediaId}/comments`;
  const params = new URLSearchParams({
    message: commentText,
    access_token: PAGE_ACCESS_TOKEN,
  });
  const res = await fetch(url, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Instagram comment error: ${data.error.message}`);
  }
  return data; // { id: "<comment_id>" }
}

// ---------------- YouTube ----------------

async function getYouTubeAccessToken() {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
    throw new Error("Missing YouTube OAuth environment variables.");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`YouTube token error: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

async function postToYouTube({ caption, mediaUrl, mediaType }) {
  if (mediaType !== "video") {
    throw new Error("YouTube uploads only support video media types.");
  }

  const accessToken = await getYouTubeAccessToken();

  console.log("  Downloading video for YouTube upload...");
  const videoRes = await fetch(mediaUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to fetch video file from URL: ${videoRes.statusText}`);
  }
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());

  const firstLine = caption.split("\n")[0].replace(/[#"]/g, "").trim();
  const title = firstLine.length > 95 ? firstLine.substring(0, 92) + "..." : (firstLine || "Daily Verse #CallGod");

  const description = `${caption}\n\n#Shorts #CallGod`;

  const metadata = {
    snippet: {
      title,
      description,
      tags: ["CallGod", "BibleVerse", "Catholic", "Shorts"],
      categoryId: "22",
    },
    status: {
      privacyStatus: "public",
      selfDeclaredMadeForKids: false,
    },
  };

  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": videoBuffer.length,
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`YouTube init upload failed: ${errText}`);
  }

  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) {
    throw new Error("YouTube resumable upload session did not return a location header.");
  }

  console.log("  Uploading video stream to YouTube...");
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": videoBuffer.length,
    },
    body: videoBuffer,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) {
    throw new Error(`YouTube binary upload failed: ${uploadData.error?.message || "Unknown error"}`);
  }

  return { id: uploadData.id, url: `https://youtu.be/${uploadData.id}` };
}

// ---------------- Posting calendar ----------------

// Queue ids start with the content date (YYYY-MM-DD). Each run posts only
// the item dated TODAY in Manila. Pending items from earlier dates are
// marked "skipped", so a missed day never pushes the queue behind again.
// Set POST_DATE=YYYY-MM-DD to post a specific day's item instead.
const POST_TIMEZONE = "Asia/Manila";

function todayInManila() {
  if (process.env.POST_DATE) return process.env.POST_DATE;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: POST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function itemDate(item) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(item.id || "");
  return m ? m[1] : null;
}

// ---------------- TikTok backfill ----------------

// Videos that went out on Facebook/Instagram/YouTube before TikTok was working (or only sent to the TikTok inbox
// as drafts) never went live on TikTok. Each video run also posts ONE of
// them to TikTok, oldest first, until none are left. Set TIKTOK_BACKFILL=off
// to stop. A video that fails 3 times is left alone.
const TIKTOK_BACKFILL_MAX_ATTEMPTS = 3;

function needsTikTokBackfill(item, today) {
  if ((item.mediaType || "image") !== "video") return false;
  if (item.status === "pending") return false;
  const date = itemDate(item);
  if (!date || date >= today) return false;
  if ((item.tiktokBackfillAttempts || 0) >= TIKTOK_BACKFILL_MAX_ATTEMPTS) return false;
  // Only videos that actually went out on another platform. Skipped ones never did.
  const r = item.result || {};
  if (!r.facebook && !r.instagram && !r.youtube) return false;
  const tiktok = item.result && item.result.tiktok;
  return !tiktok || tiktok.mode === "inbox";
}

async function runTikTokBackfill(queue, today) {
  if ((process.env.TIKTOK_BACKFILL || "on").toLowerCase() === "off") return;

  const waiting = queue.filter((i) => needsTikTokBackfill(i, today));
  if (!waiting.length) {
    console.log("TikTok backfill: all caught up.");
    return;
  }

  const idx = queue.indexOf(waiting[0]);
  const item = queue[idx];
  console.log(`TikTok backfill: "${item.id}" (${waiting.length} left, including this one)`);

  try {
    const tiktok = await postToTikTok({ ...item, mediaType: "video" });
    queue[idx] = {
      ...item,
      result: { ...(item.result || {}), tiktok },
      tiktokBackfilledAt: new Date().toISOString(),
      tiktokBackfillError: null,
    };
    console.log("✅ TikTok backfill:", tiktok.publishId, "-", tiktok.summary);
  } catch (err) {
    // Never fails the run: today's post is what matters.
    queue[idx] = {
      ...item,
      tiktokBackfillAttempts: (item.tiktokBackfillAttempts || 0) + 1,
      tiktokBackfillError: err.message,
    };
    console.warn("⚠️ TikTok backfill failed (today's post not affected):", err.message);
  }
}

// ---------------- Post one item ----------------

async function postItem(queue, nextIndex) {
  const item = queue[nextIndex];
  const mediaType = item.mediaType || "image";
  const platforms = item.platforms || ["facebook", "instagram"];
  const fbCommentText = item.commentFacebook || item.comment || DEFAULT_COMMENT_FACEBOOK;
  const igCommentText = item.commentInstagram || item.comment || DEFAULT_COMMENT_INSTAGRAM;
  // If this item failed on a previous run and was reset to "pending",
  // keep what already succeeded and don't post to those platforms again.
  const result = { ...(item.result || {}) };
  const alreadyDone = (platform) => Boolean(result[platform]);
  let hadError = false;
  let errorMessage = "";

  console.log(`Posting item "${item.id}" (${mediaType}) to: ${platforms.join(", ")}`);

  if (platforms.includes("facebook") && alreadyDone("facebook")) {
    console.log("⏭️  Facebook already posted for this item — skipping.");
  } else if (platforms.includes("facebook")) {
    try {
      result.facebook = await postToFacebook({ ...item, mediaType });
      const fbObjectId = result.facebook.id || result.facebook.post_id;
      console.log("✅ Posted to Facebook:", fbObjectId);

      if (fbCommentText && fbObjectId) {
        try {
          const comment = await postCommentToFacebook(fbObjectId, fbCommentText);
          result.facebookComment = comment;
          console.log("  💬 Comment added to Facebook post:", comment.id);
        } catch (commentErr) {
          // A failed comment shouldn't fail the whole run — the post
          // itself already succeeded. Log it, record the reason in the
          // queue entry so it's visible without digging through logs,
          // and move on.
          result.facebookCommentError = commentErr.message;
          console.warn("  ⚠️ Facebook comment failed (post still succeeded):", commentErr.message);
        }
      }
    } catch (err) {
      hadError = true;
      errorMessage += `FB: ${err.message}. `;
      console.error("❌ Facebook post failed:", err.message);
    }
  }

  if (platforms.includes("instagram") && alreadyDone("instagram")) {
    console.log("⏭️  Instagram already posted for this item — skipping.");
  } else if (platforms.includes("instagram")) {
    try {
      result.instagram = await postToInstagram({ ...item, mediaType });
      console.log("✅ Posted to Instagram:", result.instagram.id);

      if (igCommentText && result.instagram.id) {
        try {
          const comment = await postCommentToInstagram(result.instagram.id, igCommentText);
          result.instagramComment = comment;
          console.log("  💬 Comment added to Instagram post:", comment.id);
        } catch (commentErr) {
          result.instagramCommentError = commentErr.message;
          console.warn("  ⚠️ Instagram comment failed (post still succeeded):", commentErr.message);
        }
      }
    } catch (err) {
      hadError = true;
      errorMessage += `IG: ${err.message}. `;
      console.error("❌ Instagram post failed:", err.message);
    }
  }

  if (platforms.includes("youtube") && alreadyDone("youtube")) {
    console.log("⏭️  YouTube already posted for this item — skipping.");
  } else if (platforms.includes("youtube")) {
    try {
      result.youtube = await postToYouTube({ ...item, mediaType });
      console.log("✅ Posted to YouTube:", result.youtube.url);
    } catch (err) {
      hadError = true;
      errorMessage += `YouTube: ${err.message}. `;
      console.error("❌ YouTube post failed:", err.message);
    }
  }

  if (platforms.includes("tiktok") && alreadyDone("tiktok")) {
    console.log("⏭️  TikTok already posted for this item — skipping.");
  } else if (platforms.includes("tiktok")) {
    try {
      result.tiktok = await postToTikTok({ ...item, mediaType });
      console.log("✅ TikTok:", result.tiktok.publishId, "-", result.tiktok.summary);
    } catch (err) {
      hadError = true;
      errorMessage += `TikTok: ${err.message}. `;
      console.error("❌ TikTok post failed:", err.message);
    }
  }

  queue[nextIndex] = {
    ...item,
    status: hadError ? "failed" : "posted",
    result,
    error: hadError ? errorMessage.trim() : null,
    postedAt: new Date().toISOString(),
  };

  return hadError;
}

// ---------------- Main ----------------

async function main() {
  assertEnv();
  const queue = loadQueue();
  const typeFilter = process.env.MEDIA_TYPE_FILTER;
  const today = todayInManila();
  const matchesType = (item) => !typeFilter || (item.mediaType || "image") === typeFilter;

  console.log(`Posting date (Manila): ${today}${typeFilter ? `, type: ${typeFilter}` : ""}`);

  // 1. Pending items from before today are out of date: skip them.
  const skipped = [];
  queue.forEach((item, i) => {
    const date = itemDate(item);
    if (item.status === "pending" && matchesType(item) && date && date < today) {
      queue[i] = { ...item, status: "skipped", skippedAt: new Date().toISOString() };
      skipped.push(item.id);
    }
  });
  if (skipped.length) {
    console.log(
      `⏭️  Skipped ${skipped.length} out-of-date item(s): ${skipped[0]}` +
        (skipped.length > 1 ? ` ... ${skipped[skipped.length - 1]}` : "")
    );
  }

  // 2. Post today's item (undated items are still allowed, in queue order).
  const nextIndex = queue.findIndex((item) => {
    if (item.status !== "pending" || !matchesType(item)) return false;
    const date = itemDate(item);
    return !date || date === today;
  });

  let hadError = false;
  if (nextIndex === -1) {
    console.log(`No ${typeFilter ? `"${typeFilter}" ` : ""}item dated ${today} in the queue. Nothing to post.`);
  } else {
    hadError = await postItem(queue, nextIndex);
  }

  // 3. Video runs also catch up one old video on TikTok.
  if (!typeFilter || typeFilter === "video") {
    await runTikTokBackfill(queue, today);
  }

  saveQueue(queue);

  if (hadError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
