import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { defineConfig, loadEnv } from "vite";
import { pipeline } from "@huggingface/transformers";
import { parseBookmarks } from "./src/ghosts.js";

const VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const CACHE_PATH = path.resolve(process.cwd(), "src/tiger-cache.json");
const BOOKMARKS_PATH = path.resolve(process.cwd(), "public/bookmarks.json");

let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
      { dtype: "q8" },
    );
  }
  return embedderPromise;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {
      service: {
        id: "scaj99onpd",
        name: "db-61656",
        engine: "Tiger Cloud TimescaleDB 2.30.2 + pgvector 0.8.7 + pg_textsearch 1.5.1",
      },
      yearlyBuckets: [],
      rested: {},
      rituals: [],
      embeddings: {},
    };
  }
}

function saveCache(cache) {
  const { embeddings, ...rest } = cache;
  const full = { ...rest, embeddings };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(full), "utf8");
}

let cachedBookmarks = null;
function getBookmarksMap() {
  if (!cachedBookmarks) {
    try {
      const p = fs.existsSync(BOOKMARKS_PATH)
        ? BOOKMARKS_PATH
        : path.resolve(process.cwd(), "public/bookmarks-demo.json");
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const list = parseBookmarks(raw);
      cachedBookmarks = new Map(list.map((g) => [g.id, g]));
    } catch {
      cachedBookmarks = new Map();
    }
  }
  return cachedBookmarks;
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function bm25Score(text, terms) {
  const low = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    let idx = low.indexOf(term);
    let tf = 0;
    while (idx !== -1) {
      tf++;
      idx = low.indexOf(term, idx + term.length);
    }
    if (tf > 0) {
      const k1 = 1.2;
      const b = 0.75;
      const dl = Math.max(10, low.split(/\s+/).length);
      const avgdl = 28;
      score += (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)));
    }
  }
  return score;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function apiPlugin(envKey, tigerUrl) {
  let pool = null;
  if (tigerUrl) {
    pool = new pg.Pool({
      connectionString: tigerUrl,
      ssl: { rejectUnauthorized: false },
    });
  }

  const attach = (server) => {
    server.middlewares.use(async (request, response, next) => {
      const urlObj = new URL(request.url || "/", "http://localhost:5173");
      const pathname = urlObj.pathname;

      if (pathname === "/api/voice" && request.method === "GET") {
        return sendJson(response, 200, { eleven: Boolean(envKey) });
      }

      if (pathname === "/api/tiger/overview" && request.method === "GET") {
        const cache = loadCache();
        if (pool) {
          try {
            const [yearly, restedRows, ritualRows] = await Promise.all([
              pool.query(
                `SELECT EXTRACT(YEAR FROM bucket)::INT AS year, ghost_count::INT, total_likes::BIGINT
                 FROM ghost_bookmarks_yearly ORDER BY bucket ASC`,
              ),
              pool.query(
                `SELECT tweet_id, username, epitaph, voice_engine, rested_at, summon_count
                 FROM ghost_souls WHERE epitaph IS NOT NULL ORDER BY rested_at DESC`,
              ),
              pool.query(
                `SELECT summoned_at, tweet_id, username, epitaph, model_id, voice_engine
                 FROM seance_rituals ORDER BY summoned_at DESC LIMIT 12`,
              ),
            ]);
            const rested = {};
            for (const row of restedRows.rows) rested[row.tweet_id] = row;
            return sendJson(response, 200, {
              service: cache.service,
              yearlyBuckets: yearly.rows,
              rested,
              rituals: ritualRows.rows,
            });
          } catch {
            // Fall through to cache snapshot
          }
        }
        return sendJson(response, 200, {
          service: cache.service,
          yearlyBuckets: cache.yearlyBuckets,
          rested: cache.rested,
          rituals: cache.rituals,
        });
      }

      if (pathname === "/api/tiger/search" && request.method === "GET") {
        const q = (urlObj.searchParams.get("q") || "").trim();
        if (!q) return sendJson(response, 200, { results: [] });

        try {
          const embedder = await getEmbedder();
          const out = await embedder([q], { pooling: "mean", normalize: true });
          const queryVec = out.tolist()[0];

          if (pool) {
            try {
              const vecLiteral = `[${queryVec.map((n) => Number(n.toFixed(5))).join(",")}]`;
              const { rows } = await pool.query(
                `SELECT tweet_id, ROUND(rrf_score::numeric, 4)::FLOAT AS rrf_score, semantic_rank::INT, bm25_rank::INT
                 FROM rrf_search_ghosts($1, $2::halfvec(384), 48)`,
                [q, vecLiteral],
              );
              return sendJson(response, 200, {
                mode: "tiger-pgvector-bm25-rrf",
                results: rows,
              });
            } catch {
              // Fall through to local RRF over cached halfvec embeddings
            }
          }

          const cache = loadCache();
          const bookmarks = getBookmarksMap();
          const terms = q
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .filter((t) => t.length >= 2);

          const semCandidates = [];
          for (const [id, vec] of Object.entries(cache.embeddings || {})) {
            semCandidates.push({ id, sim: cosineSim(queryVec, vec) });
          }
          semCandidates.sort((a, b) => b.sim - a.sim);
          const topSem = semCandidates.slice(0, 60);

          const bm25Candidates = [];
          for (const [id, ghost] of bookmarks.entries()) {
            const s = bm25Score(`${ghost.name} ${ghost.username} ${ghost.text}`, terms);
            if (s > 0) bm25Candidates.push({ id, score: s });
          }
          bm25Candidates.sort((a, b) => b.score - a.score);
          const topBm25 = bm25Candidates.slice(0, 60);

          const rrf = new Map();
          topSem.forEach((item, idx) => {
            const rank = idx + 1;
            const prev = rrf.get(item.id) || {
              tweet_id: item.id,
              rrf_score: 0,
              semantic_rank: null,
              bm25_rank: null,
            };
            prev.rrf_score += 2.0 / (60 + rank);
            prev.semantic_rank = rank;
            rrf.set(item.id, prev);
          });
          topBm25.forEach((item, idx) => {
            const rank = idx + 1;
            const prev = rrf.get(item.id) || {
              tweet_id: item.id,
              rrf_score: 0,
              semantic_rank: null,
              bm25_rank: null,
            };
            prev.rrf_score += 1.0 / (60 + rank);
            prev.bm25_rank = rank;
            rrf.set(item.id, prev);
          });

          const results = [...rrf.values()]
            .sort((a, b) => b.rrf_score - a.rrf_score)
            .slice(0, 48)
            .map((r) => ({
              ...r,
              rrf_score: Number(r.rrf_score.toFixed(4)),
            }));

          return sendJson(response, 200, {
            mode: "tiger-pgvector-bm25-rrf",
            results,
          });
        } catch (error) {
          return sendJson(response, 500, {
            error: error instanceof Error ? error.message : "Hybrid search failed",
          });
        }
      }

      if (pathname === "/api/tiger/rest" && request.method === "POST") {
        try {
          const body = JSON.parse((await readBody(request)) || "{}");
          const tweetId = String(body.tweetId || "").trim();
          const username = String(body.username || "unknown").trim();
          const epitaph = String(body.epitaph || "").trim();
          const modelId = String(body.modelId || "google/gemma-3-270m-it").trim();
          const voiceEngine = String(body.voiceEngine || "browser").trim();
          if (!tweetId || !epitaph) {
            return sendJson(response, 400, { error: "Missing tweetId or epitaph" });
          }

          const nowIso = new Date().toISOString();
          if (pool) {
            try {
              await pool.query(
                `INSERT INTO seance_rituals (summoned_at, tweet_id, username, epitaph, model_id, voice_engine)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [nowIso, tweetId, username, epitaph, modelId, voiceEngine],
              );
              await pool.query(
                `UPDATE ghost_souls
                 SET epitaph = $2, voice_engine = $3, rested_at = $4, summon_count = summon_count + 1
                 WHERE tweet_id = $1`,
                [tweetId, epitaph, voiceEngine, nowIso],
              );
            } catch {
              // Also persist in cache snapshot below
            }
          }

          const cache = loadCache();
          const prevCount = cache.rested?.[tweetId]?.summon_count || 0;
          cache.rested = cache.rested || {};
          cache.rested[tweetId] = {
            tweet_id: tweetId,
            username,
            epitaph,
            voice_engine: voiceEngine,
            rested_at: nowIso,
            summon_count: prevCount + 1,
          };
          cache.rituals = [
            {
              summoned_at: nowIso,
              tweet_id: tweetId,
              username,
              epitaph,
              model_id: modelId,
              voice_engine: voiceEngine,
            },
            ...(cache.rituals || []),
          ].slice(0, 20);
          saveCache(cache);

          return sendJson(response, 200, {
            ok: true,
            rested: cache.rested[tweetId],
            rituals: cache.rituals,
          });
        } catch (error) {
          return sendJson(response, 500, {
            error: error instanceof Error ? error.message : "Could not record ritual",
          });
        }
      }

      if (pathname !== "/api/speak" || request.method !== "POST") return next();

      try {
        const body = JSON.parse((await readBody(request)) || "{}");
        const apiKey = envKey || String(body.apiKey || "").trim();
        const text = String(body.text || "").trim();
        if (!apiKey || !text) {
          return sendJson(response, 400, {
            error: "Add an ElevenLabs API key to hear this ghost.",
          });
        }

        const upstream = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: {
              "xi-api-key": apiKey,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            body: JSON.stringify({
              text,
              model_id: "eleven_multilingual_v2",
              voice_settings: {
                stability: 0.3,
                similarity_boost: 0.8,
                style: 0.45,
                speed: 0.88,
              },
            }),
          },
        );

        if (!upstream.ok) {
          const detail = (await upstream.text()).slice(0, 280);
          return sendJson(response, upstream.status, {
            error: detail || "ElevenLabs refused the request.",
          });
        }

        const audio = Buffer.from(await upstream.arrayBuffer());
        response.setHeader("Content-Type", "audio/mpeg");
        response.end(audio);
      } catch (error) {
        return sendJson(response, 500, {
          error: error instanceof Error ? error.message : "Voice request failed.",
        });
      }
    });
  };

  return {
    name: "ghosts-api",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    server: { port: 5173, strictPort: true },
    optimizeDeps: { include: ["@huggingface/transformers"] },
    plugins: [apiPlugin(env.ELEVENLABS_API_KEY || "", env.TIGER_DATABASE_URL || "")],
  };
});
