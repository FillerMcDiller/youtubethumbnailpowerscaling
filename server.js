// Lightweight dev server for YouTube Thumbnail Powerscaling
// - Serves static files from this folder
// - Exposes /api/video-meta?id=VIDEO_ID using the YouTube Data API v3
// - Exposes /api/global/* for persistent cross-user leaderboard and bracket feed
//
// Requirements:
// - Node.js 18+ (for built-in fetch)
// - YT_API_KEY set in a .env file (copy .env.example → .env and fill in your key)
//   or exported as an environment variable before running.
//
// Quick start:
//   cp .env.example .env        # then edit .env and set YT_API_KEY
//   npm install
//   npm start

require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");

if (typeof fetch !== "function") {
    throw new Error("This server requires Node 18+ for global fetch.");
}

const app = express();
const PORT = process.env.PORT || 4173;
const API_KEY = process.env.YT_API_KEY;

// Global state is persisted to .data/global-state.json (excluded from git and
// from static file serving because dotfiles directories are ignored by express).
const DATA_DIR = path.join(__dirname, ".data");
const GLOBAL_STATE_FILE = path.join(DATA_DIR, "global-state.json");
const MAX_GLOBAL_MATCHES = 5000;

function loadGlobalState() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (!fs.existsSync(GLOBAL_STATE_FILE)) {
            return { powers: {}, videosById: {}, matches: [] };
        }
        const raw = fs.readFileSync(GLOBAL_STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return {
            powers: parsed.powers && typeof parsed.powers === "object" ? parsed.powers : {},
            videosById: parsed.videosById && typeof parsed.videosById === "object" ? parsed.videosById : {},
            matches: Array.isArray(parsed.matches) ? parsed.matches : []
        };
    } catch {
        return { powers: {}, videosById: {}, matches: [] };
    }
}

function saveGlobalState() {
    // Fire-and-forget async write so the event loop is not blocked.
    fs.promises.writeFile(GLOBAL_STATE_FILE, JSON.stringify(globalState))
        .catch((err) => console.error("Failed to save global state:", err));
}

let globalState = loadGlobalState();

// In-memory cache to avoid hammering the API for repeated IDs.
const metaCache = new Map();

app.use(express.json({ limit: "16kb" }));
app.use(express.static(__dirname));

function bucketViewCount(viewCount) {
    const vc = Number(viewCount || 0);
    if (vc < 100_000) return "lt100k";
    if (vc < 1_000_000) return "100k_1m";
    if (vc < 10_000_000) return "1m_10m";
    return "gt10m";
}

function bucketAge(publishedAt) {
    if (!publishedAt) return "any";
    const published = new Date(publishedAt).getTime();
    if (Number.isNaN(published)) return "any";
    const days = (Date.now() - published) / (1000 * 60 * 60 * 24);
    if (days < 365) return "lt1y";
    if (days < 365 * 5) return "1_5y";
    if (days < 365 * 10) return "5_10y";
    return "gt10y";
}

function detectLanguage(snippet) {
    const lang = snippet.defaultAudioLanguage || snippet.defaultLanguage || "en";
    return String(lang).toLowerCase();
}

function bucketSentiment(viewCount, likeCount) {
    const vc = Number(viewCount || 0);
    const lc = Number(likeCount || 0);
    if (vc <= 0 || lc <= 0) return "mixed";
    const ratio = lc / vc;
    if (ratio >= 0.04) return "liked";
    if (ratio >= 0.015) return "mixed";
    return "controversial";
}

function mapCategoryToGenre(categoryId) {
    const map = {
        "1": "other",
        "2": "other",
        "10": "music",
        "17": "other",
        "19": "education",
        "20": "gaming",
        "22": "other",
        "23": "documentary",
        "24": "meme",
        "25": "other",
        "26": "education",
        "27": "education",
        "28": "education"
    };
    return map[String(categoryId)] || "other";
}

app.get("/api/video-meta", async (req, res) => {
    if (!API_KEY) {
        return res.status(500).json({ error: "Missing YT_API_KEY environment variable" });
    }

    const id = String(req.query.id || "").trim();
    if (!id) {
        return res.status(400).json({ error: "Missing id query parameter" });
    }

    if (metaCache.has(id)) {
        return res.json(metaCache.get(id));
    }

    try {
        const url = new URL("https://www.googleapis.com/youtube/v3/videos");
        url.searchParams.set("part", "snippet,statistics");
        url.searchParams.set("id", id);
        url.searchParams.set("key", API_KEY);

        const response = await fetch(url.toString());
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            return res.status(502).json({ error: "YouTube API error", status: response.status, body: text });
        }

        const json = await response.json();
        if (!json.items || !json.items.length) {
            return res.status(404).json({ error: "Video not found" });
        }

        const item = json.items[0];
        const snippet = item.snippet || {};
        const stats = item.statistics || {};

        const title = snippet.title || `YouTube Video ${id}`;
        const channel = snippet.channelTitle || "Unknown channel";
        const language = detectLanguage(snippet);
        const viewCount = Number(stats.viewCount || 0);
        const likeCount = Number(stats.likeCount || 0);
        const viewBucket = bucketViewCount(viewCount);
        const ageBucket = bucketAge(snippet.publishedAt);
        const likeDislikeSentiment = bucketSentiment(viewCount, likeCount);
        const genre = mapCategoryToGenre(snippet.categoryId);

        const payload = {
            id,
            title,
            channel,
            url: `https://www.youtube.com/watch?v=${id}`,
            language,
            viewCount,
            likeCount,
            viewBucket,
            ageBucket,
            likeDislikeSentiment,
            genre
        };

        metaCache.set(id, payload);
        res.json(payload);
    } catch (err) {
        console.error("/api/video-meta error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

// POST /api/global/match — record a match result into the global state
app.post("/api/global/match", (req, res) => {
    const body = req.body || {};
    const winnerId = typeof body.winnerId === "string" ? body.winnerId.trim().slice(0, 64) : "";
    const loserId = typeof body.loserId === "string" ? body.loserId.trim().slice(0, 64) : "";
    const winnerTitle = typeof body.winnerTitle === "string" ? body.winnerTitle.slice(0, 256) : null;
    const loserTitle = typeof body.loserTitle === "string" ? body.loserTitle.slice(0, 256) : null;
    const winnerChannel = typeof body.winnerChannel === "string" ? body.winnerChannel.slice(0, 128) : null;
    const winnerUrl = typeof body.winnerUrl === "string" ? body.winnerUrl.slice(0, 256) : null;

    if (!winnerId || !loserId) {
        return res.status(400).json({ error: "winnerId and loserId are required" });
    }

    globalState.powers[winnerId] = (globalState.powers[winnerId] || 0) + 1;

    const existingVideo = globalState.videosById[winnerId] || {};
    globalState.videosById[winnerId] = {
        id: winnerId,
        title: winnerTitle || existingVideo.title || `YouTube Video ${winnerId}`,
        channel: winnerChannel || existingVideo.channel || "Unknown",
        url: winnerUrl || existingVideo.url || `https://www.youtube.com/watch?v=${winnerId}`
    };

    globalState.matches.push({
        winnerId,
        loserId,
        winnerTitle: winnerTitle || `YouTube Video ${winnerId}`,
        loserTitle: loserTitle || `YouTube Video ${loserId}`,
        winnerPowerAfter: globalState.powers[winnerId],
        happenedAt: Date.now()
    });

    if (globalState.matches.length > MAX_GLOBAL_MATCHES) {
        globalState.matches = globalState.matches.slice(-MAX_GLOBAL_MATCHES);
    }

    saveGlobalState();
    res.json({ ok: true, winnerPowerAfter: globalState.powers[winnerId] });
});

// GET /api/global/leaderboard — top 50 videos sorted by power
app.get("/api/global/leaderboard", (req, res) => {
    const entries = Object.entries(globalState.powers)
        .map(([id, power]) => {
            const info = globalState.videosById[id] || {};
            return {
                id,
                title: info.title || `YouTube Video ${id}`,
                channel: info.channel || "Unknown",
                url: info.url || `https://www.youtube.com/watch?v=${id}`,
                power
            };
        })
        .sort((a, b) => b.power - a.power)
        .slice(0, 50);
    res.json(entries);
});

// GET /api/global/feed — last 100 matches (most recent first)
app.get("/api/global/feed", (req, res) => {
    const feed = [...globalState.matches].reverse().slice(0, 100);
    res.json(feed);
});

app.listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
});
