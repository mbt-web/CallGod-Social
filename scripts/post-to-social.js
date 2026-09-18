#!/usr/bin/env node
/**
 * Call God — Social Auto-Poster (Node.js + GitHub Actions version)
 * ------------------------------------------------------------------
 * Posts the next pending item in content/queue.json to Facebook,
 * Instagram, and YouTube. Supports images and video.
 *
 * ENV VARS REQUIRED (set as GitHub Actions secrets):
 *   META_PAGE_ACCESS_TOKEN   Page Access Token
 *   META_PAGE_ID             Facebook Page ID
 *   META_IG_USER_ID          Instagram Business Account ID
 *   YOUTUBE_REFRESH_TOKEN    OAuth2 Refresh Token
 *   YOUTUBE_CLIENT_ID        OAuth2 Client ID
 *   YOUTUBE_CLIENT_SECRET    OAuth2 Client Secret
 */

const fs = require("fs");
const path = require("path");

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

async function postToFacebook({ caption, mediaUrl, mediaType }) {
  if (!PAGE_ID || PAGE_ID === "me") {
    throw new Error("META_PAGE_ID is missing or incorrectly set to 'me'. You must use a numeric Facebook Page ID.");
  }

  if (mediaType === "video") {
    const url = `${GRAPH_BASE}/${PAGE_ID}/videos`;
    const params = new URLSearchParams({
      description: caption,
      file_url: mediaUrl,
      access_token: PAGE_ACCESS_TOKEN,
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
    access_token: PAGE_ACCESS_TOKEN,
  });
  const res = await fetch(url, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) throw new Error(`Facebook error: ${data.error.message}`);
  return data;
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

async function waitForIgContainerReady(creationId) {
  for (let attempt = 0; attempt < IG_VIDEO_POLL_MAX_ATTEMPTS; attempt++) {
    const statusUrl = `${GRAPH_BASE}/${creationId}?fields=status_code&access_token=${PAGE_ACCESS_TOKEN}`;
    const res = await fetch(statusUrl);
    const data = await res.json();

    if (data.error) {
      throw new Error(`Instagram (status check) error: ${data.error.message}`);
    }

    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR") {
      throw new Error("Instagram video processing failed (status_code: ERROR).");
    }

    console.log(`  ...IG container status: ${data.status_code || "unknown"}, waiting`);
    await sleep(IG_VIDEO_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for Instagram video to finish processing.");
}

async function publishIgContainer(creationId) {
  const publishUrl = `${GRAPH_BASE}/${IG_USER_ID}/media_publish`;
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: PAGE_ACCESS_TOKEN,
  });
  const res = await fetch(publishUrl, { method: "POST", body: params });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Instagram (publish) error: ${data.error.message}`);
  }
  return data;
}

async function postToInstagram({ caption, mediaUrl, mediaType }) {
  const creationId = await createIgContainer({ caption, mediaUrl, mediaType });
  if (mediaType === "video") {
    console.log("  Waiting for Instagram to process the video...");
    await waitForIgContainerReady(creationId);
  }
  return publishIgContainer(creationId);
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

// ---------------- Main ----------------

async function main() {
  assertEnv();
  const queue = loadQueue();
  const typeFilter = process.env.MEDIA_TYPE_FILTER;

  const nextIndex = queue.findIndex((item) => {
    if (item.status !== "pending") return false;
    if (typeFilter && (item.mediaType || "image") !== typeFilter) return false;
    return true;
  });

  if (nextIndex === -1) {
    console.log(
      typeFilter
        ? `No pending "${typeFilter}" posts in the queue. Nothing to do.`
        : "No pending posts in the queue. Nothing to do."
    );
    return;
  }

  const item = queue[nextIndex];
  const mediaType = item.mediaType || "image";
  const platforms = item.platforms || ["facebook", "instagram"];
  const result = {};
  let hadError = false;
  let errorMessage = "";

  console.log(`Posting item "${item.id}" (${mediaType}) to: ${platforms.join(", ")}`);

  if (platforms.includes("facebook")) {
    try {
      result.facebook = await postToFacebook({ ...item, mediaType });
      console.log("✅ Posted to Facebook:", result.facebook.id || result.facebook.post_id);
    } catch (err) {
      hadError = true;
      errorMessage += `FB: ${err.message}. `;
      console.error("❌ Facebook post failed:", err.message);
    }
  }

  if (platforms.includes("instagram")) {
    try {
      result.instagram = await postToInstagram({ ...item, mediaType });
      console.log("✅ Posted to Instagram:", result.instagram.id);
    } catch (err) {
      hadError = true;
      errorMessage += `IG: ${err.message}. `;
      console.error("❌ Instagram post failed:", err.message);
    }
  }

  if (platforms.includes("youtube")) {
    try {
      result.youtube = await postToYouTube({ ...item, mediaType });
      console.log("✅ Posted to YouTube:", result.youtube.url);
    } catch (err) {
      hadError = true;
      errorMessage += `YouTube: ${err.message}. `;
      console.error("❌ YouTube post failed:", err.message);
    }
  }

  queue[nextIndex] = {
    ...item,
    status: hadError ? "failed" : "posted",
    result,
    error: hadError ? errorMessage.trim() : null,
    postedAt: new Date().toISOString(),
  };

  saveQueue(queue);

  if (hadError) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});