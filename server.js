// Lightweight dev server for YouTube Thumbnail Powerscaling
// - Serves static files from this folder
// - Exposes /api/video-meta?id=VIDEO_ID using the YouTube Data API v3
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
const fs = require("node:fs/promises");
const path = require("node:path");

if (typeof fetch !== "function") {
    throw new Error("This server requires Node 18+ for global fetch.");
}

const app = express();
const PORT = process.env.PORT || 4173;
const API_KEY = process.env.YT_API_KEY;
const GLOBAL_STATE_FILE = path.join(__dirname, "global-state.json");

const EMPTY_STATE = {
    videosById: {},
    powers: {},
    matches: [],
    usedIds: []
};

// In-memory cache to avoid hammering the API for repeated IDs.
const metaCache = new Map();

app.use(express.static(__dirname));
app.use(express.json({ limit: "1mb" }));

function normalizeState(input) {
    return {
        videosById: input && input.videosById && typeof input.videosById === "object" ? input.videosById : {},
        powers: input && input.powers && typeof input.powers === "object" ? input.powers : {},
        matches: input && Array.isArray(input.matches) ? input.matches : [],
        usedIds: input && Array.isArray(input.usedIds) ? input.usedIds : []
    };
}

async function readGlobalState() {
    try {
        const raw = await fs.readFile(GLOBAL_STATE_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return normalizeState(parsed);
    } catch (err) {
        if (err && err.code === "ENOENT") {
            await writeGlobalState(EMPTY_STATE);
            return { ...EMPTY_STATE };
        }
        return { ...EMPTY_STATE };
    }
}

async function writeGlobalState(state) {
    const normalized = normalizeState(state);
    await fs.writeFile(GLOBAL_STATE_FILE, JSON.stringify(normalized), "utf8");
    return normalized;
}

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

app.get("/api/state", async (_req, res) => {
    try {
        const state = await readGlobalState();
        res.json(state);
    } catch (err) {
        console.error("/api/state GET error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/api/state", async (req, res) => {
    try {
        const saved = await writeGlobalState(req.body || EMPTY_STATE);
        res.json({ ok: true, state: saved });
    } catch (err) {
        console.error("/api/state POST error", err);
        res.status(500).json({ error: "Internal server error" });
    }
});

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

app.listen(PORT, () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
});
