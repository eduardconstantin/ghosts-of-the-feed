import fs from "node:fs";
import { pipeline } from "@huggingface/transformers";
import { parseBookmarks } from "../src/ghosts.js";

const raw = JSON.parse(
  fs.readFileSync(new URL("../public/bookmarks.json", import.meta.url), "utf8"),
);
const ghosts = parseBookmarks(raw);
console.log(`Parsed ${ghosts.length} ghosts. Loading MiniLM embedding model...`);

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
    const vec = list[j].map((n) => Number(n.toFixed(5)));
    vectors.push({ id: slice[j].id, vec });
  }
  if ((i / batchSize) % 5 === 0) {
    console.log(`Embedded ${Math.min(i + batchSize, ghosts.length)} / ${ghosts.length}`);
  }
}

function sqlLiteral(str) {
  return "'" + String(str).replaceAll("'", "''") + "'";
}

const bookmarkValues = ghosts
  .map((g) => {
    const iso = new Date(g.spoken || Date.now()).toISOString();
    return `(${sqlLiteral(iso)}, ${sqlLiteral(g.id)}, ${sqlLiteral(g.username)}, ${sqlLiteral(g.name)}, ${sqlLiteral(g.text)}, ${g.likes || 0}, ${sqlLiteral(g.url)})`;
  })
  .join(",\n");

const vecMap = new Map(vectors.map((v) => [v.id, `[${v.vec.join(",")}]`]));

const soulValues = ghosts
  .map((g) => {
    const iso = new Date(g.spoken || Date.now()).toISOString();
    const vecStr = vecMap.get(g.id);
    return `(${sqlLiteral(g.id)}, ${sqlLiteral(g.username)}, ${sqlLiteral(g.name)}, ${sqlLiteral(iso)}, ${g.likes || 0}, ${sqlLiteral(g.url)}, ${sqlLiteral(g.text)}, ${sqlLiteral(vecStr)}::halfvec(384))`;
  })
  .join(",\n");

const sql = `
INSERT INTO ghost_bookmarks (spoken_at, tweet_id, username, author_name, content, likes, url)
VALUES
${bookmarkValues}
ON CONFLICT (tweet_id, spoken_at) DO NOTHING;

INSERT INTO ghost_souls (tweet_id, username, author_name, spoken_at, likes, url, content, embedding)
VALUES
${soulValues}
ON CONFLICT (tweet_id) DO UPDATE SET
  embedding = EXCLUDED.embedding,
  content = EXCLUDED.content;

CREATE INDEX IF NOT EXISTS ghost_souls_bm25_idx ON ghost_souls USING bm25 (content) WITH (text_config = 'english');
CREATE INDEX IF NOT EXISTS ghost_souls_hnsw_idx ON ghost_souls USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
`;

fs.writeFileSync(new URL("./seed-tiger.sql", import.meta.url), sql, "utf8");
console.log("Wrote scripts/seed-tiger.sql");
