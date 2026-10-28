import fs from "node:fs";
import { pipeline } from "@huggingface/transformers";
import { parseBookmarks } from "../src/ghosts.js";

const raw = JSON.parse(
  fs.readFileSync(new URL("../public/bookmarks.json", import.meta.url), "utf8"),
);
const ghosts = parseBookmarks(raw);

const extractor = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2",
  { dtype: "q8" },
);

const batchSize = 64;
const vectors = [];

for (let i = 0; i < ghosts.length; i += batchSize) {
  const slice = ghosts.slice(i, i + batchSize);
  const texts = slice.map((g) => `@${g.username} (${g.name}): ${g.text}`);
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const list = out.tolist();
  for (let j = 0; j < slice.length; j++) {
    const vec = list[j].map((n) => Number(n.toFixed(4)));
    vectors.push({ id: slice[j].id, vec });
  }
}

const byYear = new Map();
for (const g of ghosts) {
  if (!g.spoken) continue;
  const year = new Date(g.spoken).getUTCFullYear();
  const prev = byYear.get(year) || { year, ghost_count: 0, total_likes: 0 };
  prev.ghost_count += 1;
  prev.total_likes += g.likes || 0;
  byYear.set(year, prev);
}

const snapshot = {
  service: {
    id: "scaj99onpd",
    name: "db-61656",
    engine: "Tiger Cloud TimescaleDB 2.30.2 + pgvector 0.8.7 + pg_textsearch 1.5.1",
    hypertables: ["ghost_bookmarks", "seance_rituals"],
    continuousAggregate: "ghost_bookmarks_yearly",
    indexes: ["ghost_souls_hnsw_idx (halfvec_cosine_ops)", "ghost_souls_bm25_idx (bm25)"],
  },
  yearlyBuckets: [...byYear.values()].sort((a, b) => a.year - b.year),
  rested: {
    "1028090817855074304": {
      tweet_id: "1028090817855074304",
      username: "jonjones",
      epitaph:
        "I was a walking excavator with my arms and legs, digging in the soil of my heart. Now I’m just a walking excavator. And you, the one who saw me, I still remember. You never left me. I’ve been with you through the years.\n\nIf you still want to be with me, let’s walk through the world together.",
      voice_engine: "elevenlabs",
      rested_at: new Date().toISOString(),
      summon_count: 1,
    },
  },
  rituals: [
    {
      summoned_at: new Date().toISOString(),
      tweet_id: "1028090817855074304",
      username: "jonjones",
      epitaph:
        "I was a walking excavator with my arms and legs, digging in the soil of my heart. Now I’m just a walking excavator. And you, the one who saw me, I still remember. You never left me. I’ve been with you through the years.\n\nIf you still want to be with me, let’s walk through the world together.",
      model_id: "google/gemma-3-270m-it",
      voice_engine: "elevenlabs",
    },
  ],
  embeddings: Object.fromEntries(vectors.map((v) => [v.id, v.vec])),
};

fs.writeFileSync(
  new URL("../src/tiger-cache.json", import.meta.url),
  JSON.stringify(snapshot),
  "utf8",
);
console.log("Wrote src/tiger-cache.json");
