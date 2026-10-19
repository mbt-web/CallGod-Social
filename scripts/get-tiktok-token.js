#!/usr/bin/env node
/**
 * Call God — one-time TikTok token helper (run LOCALLY, not in Actions)
 * ------------------------------------------------------------------
 * Step 1: print the authorization URL
 *   PowerShell:
 *     $env:TIKTOK_CLIENT_KEY="your_client_key"
 *     $env:TIKTOK_REDIRECT_URI="the exact redirect URI registered in Login Kit"
 *     node scripts/get-tiktok-token.js url
 *
 * Scopes: by default it asks for "user.info.basic,video.upload". If TikTok
 * shows "Something went wrong ... scope", your app doesn't have one of them.
 * Check Scopes in the TikTok developer portal and request only what is
 * listed there. For direct posting (after TikTok approves it):
 *     $env:TIKTOK_SCOPES="user.info.basic,video.publish"
 *
 * Step 2: open that URL, log in as the Call God TikTok account, approve.
 *   TikTok redirects to your redirect URI with ?code=... in the address bar.
 *   Copy the value after "code=" (up to the next "&"). It is single-use
 *   and expires within minutes, so do step 3 right away.
 *
 * Step 3: exchange the code for tokens
 *   $env:TIKTOK_CLIENT_SECRET="your_client_secret"
 *   node scripts/get-tiktok-token.js exchange "<code>"
 *
 *   Save the printed refresh_token as the GitHub secret TIKTOK_REFRESH_TOKEN
 *   (valid ~365 days). The access token it prints is NOT needed.
 */

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
const SCOPES = process.env.TIKTOK_SCOPES || "user.info.basic,video.upload";

const mode = process.argv[2];

function need(name, value) {
  if (!value) {
    console.error(`Missing ${name}. Set it with: $env:${name}="..."`);
    process.exit(1);
  }
}

async function main() {
  if (mode === "url") {
    need("TIKTOK_CLIENT_KEY", CLIENT_KEY);
    need("TIKTOK_REDIRECT_URI", REDIRECT_URI);
    const params = new URLSearchParams({
      client_key: CLIENT_KEY,
      scope: SCOPES,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      state: "callgod",
    });
    console.log(`\nRequesting scopes: ${SCOPES}`);
    console.log("\nOpen this URL in your browser:\n");
    console.log(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}\n`);
    return;
  }

  if (mode === "exchange") {
    need("TIKTOK_CLIENT_KEY", CLIENT_KEY);
    need("TIKTOK_CLIENT_SECRET", CLIENT_SECRET);
    need("TIKTOK_REDIRECT_URI", REDIRECT_URI);
    const rawCode = process.argv[3];
    if (!rawCode) {
      console.error('Usage: node scripts/get-tiktok-token.js exchange "<code>"');
      process.exit(1);
    }
    // The code in the redirect URL is URL-encoded (contains %2A etc.)
    const code = decodeURIComponent(rawCode);

    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await res.json();

    if (data.error || !data.refresh_token) {
      console.error("Token exchange failed:", data.error_description || data.error || data);
      process.exit(1);
    }

    console.log("\nSuccess. Granted scopes:", data.scope);
    console.log("Refresh token expires in (seconds):", data.refresh_expires_in);
    console.log("\nSave this as the GitHub secret TIKTOK_REFRESH_TOKEN:\n");
    console.log(data.refresh_token + "\n");
    return;
  }

  console.error('Usage: node scripts/get-tiktok-token.js url | exchange "<code>"');
  process.exit(1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
