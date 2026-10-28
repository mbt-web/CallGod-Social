/**
 * Call God — TikTok poster (Content Posting API)
 * ------------------------------------------------------------------
 * Uploads a video to TikTok with FILE_UPLOAD: the script downloads the
 * video from mediaUrl, then sends the bytes to TikTok. (PULL_FROM_URL is
 * not used because it needs a verified URL prefix, which isn't possible
 * for raw.githubusercontent.com.)
 *
 * TWO MODES, chosen with TIKTOK_MODE (MEDIA_UPLOAD is the default):
 *
 *   inbox / MEDIA_UPLOAD  (default)
 *                     Sends the video to the Call God TikTok account as a
 *                     DRAFT. Needs the "video.upload" scope. TikTok then
 *                     notifies that account's inbox; open TikTok, tap the
 *                     notification, add the caption and tap Post.
 *                     The draft request has no caption or privacy field,
 *                     so the caption is NOT carried over by the API.
 *
 *   direct / DIRECT_POST
 *                     Posts straight to the account with the caption and a
 *                     privacy level. Needs the "video.publish" scope, which
 *                     TikTok must approve for the app (Direct Post). New
 *                     apps may be limited to private (SELF_ONLY) posts until
 *                     TikTok audits them.
 *
 * ENV VARS (GitHub Actions secrets / env):
 *   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN
 *   TIKTOK_MODE            "MEDIA_UPLOAD" (default) or "DIRECT_POST"
 *                          ("direct" / "inbox" also accepted)
 *   TIKTOK_PRIVACY_LEVEL   direct mode only. Default PUBLIC_TO_EVERYONE.
 */

const TIKTOK_API = "https://open.tiktokapis.com/v2";

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.TIKTOK_REFRESH_TOKEN;
// DIRECT_POST = publish with caption (video.publish scope).
// MEDIA_UPLOAD = send to the TikTok inbox as a draft (video.upload scope).
const MODE_ALIASES = { direct_post: "direct", direct: "direct", media_upload: "inbox", inbox: "inbox" };
const RAW_MODE = (process.env.TIKTOK_MODE || "MEDIA_UPLOAD").trim().toLowerCase();
const MODE = MODE_ALIASES[RAW_MODE] || RAW_MODE;
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

function sourceInfo(size, plan) {
  return {
    source: "FILE_UPLOAD",
    video_size: size,
    chunk_size: plan.chunkSize,
    total_chunk_count: plan.totalChunks,
  };
}

// Direct post: caption + privacy go in post_info.
async function initDirect(accessToken, { title, privacyLevel, size, plan }) {
  return tiktokPost(accessToken, "/post/publish/video/init/", {
    post_info: {
      title,
      privacy_level: privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    },
    source_info: sourceInfo(size, plan),
  });
}

// Draft upload: source_info only. TikTok has no caption/privacy field here.
async function initInbox(accessToken, { size, plan }) {
  return tiktokPost(accessToken, "/post/publish/inbox/video/init/", {
    source_info: sourceInfo(size, plan),
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

async function waitForStatus(accessToken, publishId, doneStatuses) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const data = await tiktokPost(accessToken, "/post/publish/status/fetch/", {
      publish_id: publishId,
    });
    if (!isOk(data)) {
      throw new Error(`TikTok status error: ${describeError(data)}`);
    }

    const status = data.data && data.data.status;
    if (doneStatuses.includes(status)) return data.data;
    if (status === "FAILED") {
      throw new Error(`TikTok upload failed: ${data.data.fail_reason || "unknown reason"}`);
    }

    console.log(`  ...TikTok status: ${status || "unknown"}, waiting`);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for TikTok to finish processing the video.");
}

async function postToTikTok({ caption, mediaUrl, mediaType }) {
  if (mediaType !== "video") {
    throw new Error("TikTok posting only supports video media types.");
  }
  if (MODE !== "inbox" && MODE !== "direct") {
    throw new Error(`Unknown TIKTOK_MODE "${RAW_MODE}". Use "DIRECT_POST" or "MEDIA_UPLOAD".`);
  }

  const accessToken = await getAccessToken();

  console.log("  Downloading video for TikTok upload...");
  const videoRes = await fetch(mediaUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to fetch video file from URL: ${videoRes.statusText}`);
  }
  const buffer = Buffer.from(await videoRes.arrayBuffer());
  const plan = planChunks(buffer.length);

  if (MODE === "inbox") {
    const init = await initInbox(accessToken, { size: buffer.length, plan });
    if (!isOk(init)) throw new Error(`TikTok init error: ${describeError(init)}`);

    const { publish_id: publishId, upload_url: uploadUrl } = init.data;
    console.log(`  Uploading draft to TikTok (${plan.totalChunks} chunk(s))...`);
    await uploadChunks(uploadUrl, buffer, plan);

    // SEND_TO_USER_INBOX = the draft reached the account's inbox.
    // PUBLISH_COMPLETE = it has already been posted from there.
    const status = await waitForStatus(accessToken, publishId, ["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]);
    return {
      publishId,
      mode: "inbox",
      status,
      summary: "draft sent to the TikTok inbox. Open TikTok, tap the notification, add the caption and post.",
    };
  }

  // direct mode
  const title = caption.length > 2200 ? caption.slice(0, 2197) + "..." : caption;
  let privacyLevel = await pickPrivacyLevel(accessToken);
  let init = await initDirect(accessToken, { title, privacyLevel, size: buffer.length, plan });

  // Unaudited apps are limited to private posts. Retry privately instead of failing.
  if (!isOk(init) && init.error.code === "unaudited_client_can_only_post_to_private_accounts") {
    console.warn("  ⚠️ TikTok app not audited for public posting yet. Posting as SELF_ONLY (private).");
    privacyLevel = "SELF_ONLY";
    init = await initDirect(accessToken, { title, privacyLevel, size: buffer.length, plan });
  }
  if (!isOk(init)) throw new Error(`TikTok init error: ${describeError(init)}`);

  const { publish_id: publishId, upload_url: uploadUrl } = init.data;
  console.log(`  Uploading to TikTok (${plan.totalChunks} chunk(s), privacy ${privacyLevel})...`);
  await uploadChunks(uploadUrl, buffer, plan);

  const status = await waitForStatus(accessToken, publishId, ["PUBLISH_COMPLETE"]);
  return { publishId, mode: "direct", privacyLevel, status, summary: `posted (${privacyLevel})` };
}

module.exports = { postToTikTok, TIKTOK_MODE: MODE };
