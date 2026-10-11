/**
 * Call God — TikTok poster (Content Posting API, Direct Post)
 * ------------------------------------------------------------------
 * Uploads a video to TikTok using FILE_UPLOAD (the script downloads
 * the video from mediaUrl, then uploads the bytes to TikTok).
 * FILE_UPLOAD is used instead of PULL_FROM_URL because PULL_FROM_URL
 * requires a URL prefix verified in the TikTok portal, which isn't
 * possible for raw.githubusercontent.com.
 *
 * ENV VARS (GitHub Actions secrets):
 *   TIKTOK_CLIENT_KEY      From the TikTok developer portal
 *   TIKTOK_CLIENT_SECRET   From the TikTok developer portal
 *   TIKTOK_REFRESH_TOKEN   From scripts/get-tiktok-token.js (one-time)
 *   TIKTOK_PRIVACY_LEVEL   Optional. Default PUBLIC_TO_EVERYONE.
 *                          Unaudited apps can only post privately
 *                          (SELF_ONLY); this module falls back to
 *                          SELF_ONLY automatically if needed.
 */

const TIKTOK_API = "https://open.tiktokapis.com/v2";

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.TIKTOK_REFRESH_TOKEN;
const PREFERRED_PRIVACY = process.env.TIKTOK_PRIVACY_LEVEL || "PUBLIC_TO_EVERYONE";

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_ATTEMPTS = 36; // ~3 minutes

const MB = 1024 * 1024;
const SINGLE_CHUNK_MAX = 64 * MB;
const MULTI_CHUNK_SIZE = 32 * MB;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAccessToken() {
  if (!CLIENT_KEY || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error(
      "Missing TikTok env vars (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN)."
    );
  }

  const res = await fetch(`${TIKTOK_API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
    }),
  });
  const data = await res.json();

  if (data.error || !data.access_token) {
    throw new Error(
      `TikTok token error: ${data.error_description || data.error || JSON.stringify(data)}`
    );
  }

  if (data.refresh_token && data.refresh_token !== REFRESH_TOKEN) {
    console.warn(
      "  ⚠️ TikTok returned a NEW refresh token. If posting starts failing with token " +
        "errors later, re-run scripts/get-tiktok-token.js and update TIKTOK_REFRESH_TOKEN."
    );
  }
  return data.access_token;
}

async function tiktokPost(accessToken, endpoint, body) {
  const res = await fetch(`${TIKTOK_API}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function isOk(data) {
  return !data.error || data.error.code === "ok";
}

function describeError(data) {
  return data.error
    ? `${data.error.code}: ${data.error.message}`
    : JSON.stringify(data);
}

async function pickPrivacyLevel(accessToken) {
  const info = await tiktokPost(accessToken, "/post/publish/creator_info/query/");
  if (!isOk(info)) {
    throw new Error(`TikTok creator info error: ${describeError(info)}`);
  }
  const options = (info.data && info.data.privacy_level_options) || [];
  if (options.includes(PREFERRED_PRIVACY)) return PREFERRED_PRIVACY;
  console.warn(
    `  ⚠️ TikTok privacy "${PREFERRED_PRIVACY}" not available (options: ${options.join(", ") || "none"}). ` +
      `Using ${options[0] || "SELF_ONLY"}.`
  );
  return options[0] || "SELF_ONLY";
}

function planChunks(size) {
  if (size <= SINGLE_CHUNK_MAX) {
    return { chunkSize: size, totalChunks: 1 };
  }
  // Remainder is merged into the last chunk (TikTok allows up to 128MB there).
  return {
    chunkSize: MULTI_CHUNK_SIZE,
    totalChunks: Math.floor(size / MULTI_CHUNK_SIZE),
  };
}

async function initUpload(accessToken, { title, privacyLevel, size, plan }) {
  return tiktokPost(accessToken, "/post/publish/video/init/", {
    post_info: {
      title,
      privacy_level: privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.totalChunks,
    },
  });
}

async function uploadChunks(uploadUrl, buffer, plan) {
  const size = buffer.length;
  for (let i = 0; i < plan.totalChunks; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.totalChunks - 1 ? size : start + plan.chunkSize;
    const chunk = buffer.subarray(start, end);

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end - 1}/${size}`,
      },
      body: chunk,
    });

    if (res.status !== 201 && res.status !== 206 && res.status !== 200) {
      const text = await res.text();
      throw new Error(`TikTok chunk ${i + 1}/${plan.totalChunks} upload failed (${res.status}): ${text}`);
    }
  }
}

async function waitForPublish(accessToken, publishId) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const data = await tiktokPost(accessToken, "/post/publish/status/fetch/", {
      publish_id: publishId,
    });
    if (!isOk(data)) {
      throw new Error(`TikTok status error: ${describeError(data)}`);
    }

    const status = data.data && data.data.status;
    if (status === "PUBLISH_COMPLETE") return data.data;
    if (status === "FAILED") {
      throw new Error(`TikTok publish failed: ${data.data.fail_reason || "unknown reason"}`);
    }

    console.log(`  ...TikTok status: ${status || "unknown"}, waiting`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for TikTok to finish publishing.");
}

async function postToTikTok({ caption, mediaUrl, mediaType }) {
  if (mediaType !== "video") {
    throw new Error("TikTok posting only supports video media types.");
  }

  const accessToken = await getAccessToken();

  console.log("  Downloading video for TikTok upload...");
  const videoRes = await fetch(mediaUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to fetch video file from URL: ${videoRes.statusText}`);
  }
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  const plan = planChunks(buffer.length);
  const title = caption.length > 2200 ? caption.slice(0, 2197) + "..." : caption;

  let privacyLevel = await pickPrivacyLevel(accessToken);
  let init = await initUpload(accessToken, { title, privacyLevel, size: buffer.length, plan });

  // Unaudited apps are limited to private posts. Retry privately instead of failing.
  if (!isOk(init) && init.error.code === "unaudited_client_can_only_post_to_private_accounts") {
    console.warn("  ⚠️ TikTok app not audited for public posting yet — posting as SELF_ONLY (private).");
    privacyLevel = "SELF_ONLY";
    init = await initUpload(accessToken, { title, privacyLevel, size: buffer.length, plan });
  }

  if (!isOk(init)) {
    throw new Error(`TikTok init error: ${describeError(init)}`);
  }

  const { publish_id: publishId, upload_url: uploadUrl } = init.data;
  console.log(`  Uploading to TikTok (${plan.totalChunks} chunk(s), privacy ${privacyLevel})...`);
  await uploadChunks(uploadUrl, buffer, plan);

  const status = await waitForPublish(accessToken, publishId);
  return { publishId, privacyLevel, status };
}

module.exports = { postToTikTok };
