# Call God — Social Auto-Poster (Node.js + GitHub Actions)

No Firebase, no server — just a script and a scheduled GitHub Actions
workflow. Posts the next pending item in `content/queue.json` to
Facebook and Instagram once a day.

---

## 1. Create the repo

```powershell
mkdir CallGod-Social
cd CallGod-Social
git init
```

Copy in these files (from this download):
```
scripts/post-to-social.js
content/queue.json
.github/workflows/daily-post.yml
package.json
README.md
```

Then push it to GitHub as a **private repo** (important — your queue
file will contain post drafts, and you don't want the workflow or
history public):

```powershell
git add .
git commit -m "Initial setup"
git branch -M main
git remote add origin https://github.com/<your-username>/CallGod-Social.git
git push -u origin main
```

---

## 2. Add your Meta credentials as GitHub Secrets

You already have these from the Business Settings → System User →
Generate Token flow:

1. Go to your repo on GitHub → **Settings → Secrets and variables → Actions**
2. Click **New repository secret**, add each of:
   - `META_PAGE_ACCESS_TOKEN` — your system user access token
   - `META_PAGE_ID` — your Facebook Page ID (`1234653809733571`)
   - `META_IG_USER_ID` — your Instagram Business Account ID (`17841409880406615`)

These are encrypted by GitHub and only exposed to the workflow at
run time — never visible in logs or to anyone browsing the repo.

---

## 3. Queue up content (images and video)

Edit `content/queue.json` and add entries like:

```json
{
  "id": "2026-07-21-gospel-mark2",
  "caption": "Today's Gospel... 🕊️\n\n#CallGod #DailyGospel",
  "mediaType": "image",
  "mediaUrl": "https://raw.githubusercontent.com/<you>/CallGod-Assets/main/images/mark2.jpg",
  "platforms": ["facebook", "instagram"],
  "status": "pending",
  "result": null,
  "error": null,
  "postedAt": null
}
```

For a video/Reel, set `"mediaType": "video"` and point `mediaUrl` at
the video file instead:

```json
{
  "id": "2026-07-22-patron-saint-reel",
  "caption": "Meet the saint whose day it is 🕊️\n\n#CallGod #PatronSaint",
  "mediaType": "video",
  "mediaUrl": "https://raw.githubusercontent.com/<you>/CallGod-Assets/main/videos/saint-of-the-day.mp4",
  "platforms": ["facebook", "instagram"],
  "status": "pending",
  "result": null,
  "error": null,
  "postedAt": null
}
```

On Instagram, videos post as **Reels** by default (set in the script
— change `media_type: "REELS"` to `"VIDEO"` in `post-to-social.js` if
you'd rather post to the regular feed instead).

### Where to host the media files

**Important — `mediaUrl` must be publicly reachable over HTTPS.**
Meta's servers fetch the file themselves; they can't access a private
repo's raw URL, and can't use anything requiring login.

Recommended setup: create a **separate public repo** just for media
(e.g. `CallGod-Assets`), and keep this repo (with your access tokens
and posting logic) private. That way your automation logic and
credentials stay private, while only the media itself — which is
about to be posted publicly anyway — is public.

```
https://raw.githubusercontent.com/<your-username>/CallGod-Assets/main/images/mark2.jpg
https://raw.githubusercontent.com/<your-username>/CallGod-Assets/main/videos/saint-of-the-day.mp4
```

**GitHub's per-file limit is 100MB.** For video, export at a
reasonable size rather than raw/source quality — 1080p H.264, a
sensible bitrate (5-10 Mbps is plenty for a short social clip) will
keep files well under that limit, and Instagram/TikTok/Facebook all
recompress on their end anyway, so there's no benefit to uploading
huge source files.

Add new entries at the bottom of the array whenever you want to
queue up future posts. The script always picks the **first** item
with `"status": "pending"`, top to bottom.

---

## 4. How it runs

- **Scheduled:** every day at 9:00 AM Asia/Manila (the cron is set in
  UTC — `0 1 * * *` = 1:00 AM UTC = 9:00 AM Manila).
- **Manual/test run:** go to your repo's **Actions** tab → "Daily
  Social Post" workflow → **Run workflow** button. This lets you
  test immediately without waiting for the schedule.
- After each run, the workflow **commits the updated `queue.json`**
  back to the repo automatically, so you can see which post ran,
  whether it succeeded, and the resulting post ID — right in your
  git history.

---

## 5. Testing before relying on the schedule

1. Put one test entry in `queue.json` with `"status": "pending"`
2. Go to **Actions → Daily Social Post → Run workflow** to trigger it manually
3. Watch the run logs — you'll see `✅ Posted to Facebook` / `✅ Posted to Instagram` or the specific error message
4. Check your actual Facebook Page and Instagram to confirm the post appeared
5. Check that `queue.json` got updated with `"status": "posted"` and a `result` object

---

## 6. TikTok

Not included — TikTok's Content Posting API requires separate
developer approval (a slower process). Post to TikTok manually for
now; happy to add a TikTok step to this same workflow once you have
API access.

---

## 8. Recommended export sizes

Two presets cover nearly everything:

- **Images (static posts):** 1080 x 1350 px (4:5 portrait) — works well
  for Facebook and Instagram feed posts. Use 1080 x 1080 (square) if
  the source image is naturally square.
- **Video (Reels / TikTok / Stories / YouTube Shorts):** 1080 x 1920 px
  (9:16 vertical), MP4, H.264 codec, 30fps, 5-10 Mbps bitrate. The
  same export works across Reels, TikTok, Stories, and YouTube Shorts
  without reformatting.

Other formats, if needed:
- **YouTube regular videos (landscape):** 1920 x 1080 px (16:9)
- **Facebook/Instagram feed video (non-Reel):** 1080 x 1080 or 1080 x 1350

No benefit to exporting above these resolutions or bitrates — every
platform recompresses on upload, and higher source quality just
means slower uploads and a higher chance of hitting GitHub's 100MB
per-file limit.

## 9. Troubleshooting

- **"Missing required env vars"** — double-check the secret names in
  GitHub match exactly (`META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`,
  `META_IG_USER_ID`), case-sensitive.
- **Facebook/Instagram API errors** — the error message from Meta is
  printed directly in the Action's log output, and also saved into
  `queue.json`'s `"error"` field for that post.
- **Token expired** — system user tokens set to "Never expire" at
  generation time shouldn't need refreshing, but if you didn't select
  that option, you'll need to regenerate and update the GitHub secret
  periodically.
