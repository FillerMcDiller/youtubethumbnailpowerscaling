const STATE_KEY = "global-state-v1";
const MAX_MATCH_HISTORY = 250;

const EMPTY_STATE = {
    videosById: {},
    powers: {},
    matches: [],
    usedIds: []
};

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };
}

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...corsHeaders()
        }
    });
}

function normalizeState(input) {
    const normalized = {
        videosById: input && input.videosById && typeof input.videosById === "object" ? input.videosById : {},
        powers: input && input.powers && typeof input.powers === "object" ? input.powers : {},
        matches: input && Array.isArray(input.matches) ? input.matches.slice(-MAX_MATCH_HISTORY) : [],
        usedIds: []
    };

    return normalized;
}

function bucketViewCount(viewCount) {
    const vc = Number(viewCount || 0);
    if (vc < 100000) return "lt100k";
    if (vc < 1000000) return "100k_1m";
    if (vc < 10000000) return "1m_10m";
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

async function readState(env) {
    const raw = await env.POWERSCALING_KV.get(STATE_KEY);
    if (!raw) {
        return { ...EMPTY_STATE };
    }

    try {
        return normalizeState(JSON.parse(raw));
    } catch {
        return { ...EMPTY_STATE };
    }
}

async function writeState(env, incoming) {
    const normalized = normalizeState(incoming);
    await env.POWERSCALING_KV.put(STATE_KEY, JSON.stringify(normalized));
    return normalized;
}

async function handleVideoMeta(request, env) {
    if (!env.YT_API_KEY) {
        return jsonResponse({ error: "Missing YT_API_KEY secret" }, 500);
    }

    const url = new URL(request.url);
    const id = String(url.searchParams.get("id") || "").trim();
    if (!id) {
        return jsonResponse({ error: "Missing id query parameter" }, 400);
    }

    const ytUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
    ytUrl.searchParams.set("part", "snippet,statistics");
    ytUrl.searchParams.set("id", id);
    ytUrl.searchParams.set("key", env.YT_API_KEY);

    const response = await fetch(ytUrl.toString());
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        return jsonResponse({ error: "YouTube API error", status: response.status, body }, 502);
    }

    const json = await response.json();
    if (!json.items || !json.items.length) {
        return jsonResponse({ error: "Video not found" }, 404);
    }

    const item = json.items[0] || {};
    const snippet = item.snippet || {};
    const stats = item.statistics || {};

    const viewCount = Number(stats.viewCount || 0);
    const likeCount = Number(stats.likeCount || 0);

    return jsonResponse({
        id,
        title: snippet.title || `YouTube Video ${id}`,
        channel: snippet.channelTitle || "Unknown channel",
        url: `https://www.youtube.com/watch?v=${id}`,
        language: detectLanguage(snippet),
        viewCount,
        likeCount,
        viewBucket: bucketViewCount(viewCount),
        ageBucket: bucketAge(snippet.publishedAt),
        likeDislikeSentiment: bucketSentiment(viewCount, likeCount),
        genre: mapCategoryToGenre(snippet.categoryId)
    });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/api/state") {
            const state = await readState(env);
            return jsonResponse(state);
        }

        if (request.method === "POST" && url.pathname === "/api/state") {
            let body;
            try {
                body = await request.json();
            } catch {
                return jsonResponse({ error: "Invalid JSON body" }, 400);
            }
            const saved = await writeState(env, body);
            return jsonResponse({ ok: true, state: saved });
        }

        if (request.method === "GET" && url.pathname === "/api/video-meta") {
            return handleVideoMeta(request, env);
        }

        return jsonResponse({ error: "Not found" }, 404);
    }
};
