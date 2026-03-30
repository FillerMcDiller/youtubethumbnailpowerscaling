# YouTube Thumbnail Powerscaling

This app can be hosted on GitHub Pages and still keep a global leaderboard + bracket history by using a small API backend.

## Hosting model

- Frontend: GitHub Pages (this repo)
- Backend API: Cloudflare Worker + KV (in cloudflare-worker/index.js)
- Shared data: KV key global-state-v1

## 1) Deploy the API (Cloudflare Worker)

1. Install Wrangler:
   npm install -g wrangler
2. Create a KV namespace:
   wrangler kv namespace create POWERSCALING_KV
3. Copy cloudflare-worker/wrangler.toml.example to cloudflare-worker/wrangler.toml
4. Replace the KV namespace id in wrangler.toml
5. Add your YouTube key secret:
   wrangler secret put YT_API_KEY
6. Deploy:
   wrangler deploy

After deploy, you will get a worker URL like:
https://yt-powerscaling-api.<subdomain>.workers.dev

## 2) Point the frontend to the API

Edit config.js and set apiBase to your worker URL, for example:

window.__POWERSCALING_CONFIG__ = {
   apiBase: "https://yt-powerscaling-api.<subdomain>.workers.dev",
   allowLocalFallback: false
};

Commit config.js and publish to GitHub Pages.

## 3) Enable GitHub Pages

1. Push this repository to GitHub
2. In GitHub: Settings -> Pages
3. Source: Deploy from a branch
4. Branch: main, Folder: / (root)
5. Save and wait for the Pages URL to appear

If apiBase is blank and allowLocalFallback is false, the page will show a clear setup message instead of silently using local state.

## Notes

- Without apiBase, GitHub Pages can fall back to localStorage only if allowLocalFallback is true.
- With apiBase configured, leaderboard and bracket history are global for all users.
- usedIds are intentionally not global, so users do not block each other's matchup rotation.
