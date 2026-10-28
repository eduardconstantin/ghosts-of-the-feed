import "./style.css";
import { parseBookmarks, spokenLabel, waitingLabel } from "./ghosts.js";
import { speakGhost, stopVoice, unlockAudio } from "./voice.js";

const PAGE = 36;
const grid = document.querySelector("#grid");
const more = document.querySelector("#more");
const count = document.querySelector("#count");
const searchCaption = document.querySelector("#search-caption");
const query = document.querySelector("#query");
const filterState = document.querySelector("#filter-state");
const order = document.querySelector("#order");
const file = document.querySelector("#file");
const summon = document.querySelector("#summon");
const title = document.querySelector("#seance-title");
const meta = document.querySelector("#seance-meta");
const words = document.querySelector("#seance-words");
const status = document.querySelector("#status");
const speech = document.querySelector("#speech");
const source = document.querySelector("#source");
const hear = document.querySelector("#hear");
const seanceSeal = document.querySelector("#seance-seal");
const niche = document.querySelector(".niche");
const restBadge = document.querySelector("#rest-badge");
const timelineBars = document.querySelector("#timeline-bars");
const clearYear = document.querySelector("#clear-year");
const ritualList = document.querySelector("#ritual-list");
const restedCounter = document.querySelector("#rested-counter");

const worker = new Worker(new URL("./seance.worker.js", import.meta.url), {
  type: "module",
});

let ghosts = [];
let ghostById = new Map();
let shown = PAGE;
let selected = null;
let modelReady = false;
let busy = false;
let lastSpeech = "";

// Tiger Data state
let restedById = {};
let rituals = [];
let yearlyBuckets = [];
let selectedYear = null;
let hybridMatches = null; // Map<tweet_id, { rrf_score, semantic_rank, bm25_rank }>
let searchTimer = null;

query.addEventListener("input", () => {
  shown = PAGE;
  const q = query.value.trim();
  clearTimeout(searchTimer);
  if (!q) {
    hybridMatches = null;
    searchCaption.textContent =
      "Hybrid RRF search enabled (`pgvector` HNSW cosine + `pg_textsearch` BM25)";
    render();
    return;
  }
  searchCaption.textContent = "Querying Tiger Data hybrid RRF (`pgvector` <=> + BM25 <@>)…";
  searchTimer = setTimeout(() => runHybridSearch(q), 210);
});

filterState.addEventListener("change", () => {
  shown = PAGE;
  render();
});

order.addEventListener("change", () => {
  shown = PAGE;
  render();
});

clearYear.addEventListener("click", () => {
  selectedYear = null;
  clearYear.hidden = true;
  shown = PAGE;
  renderTimeline();
  render();
});

more.addEventListener("click", () => {
  shown += PAGE;
  render();
});

file.addEventListener("change", async () => {
  const picked = file.files?.[0];
  if (!picked) return;
  try {
    ghosts = parseBookmarks(JSON.parse(await picked.text()));
    ghostById = new Map(ghosts.map((g) => [g.id, g]));
    shown = PAGE;
    render();
  } catch (error) {
    count.textContent = error instanceof Error ? error.message : String(error);
  }
});

hear.addEventListener("click", () => {
  if (!lastSpeech) return;
  unlockAudio();
  voiceFor(lastSpeech, false);
});

summon.addEventListener("click", () => {
  if (!selected || busy) return;
  unlockAudio();
  stopVoice();
  busy = true;
  summon.disabled = true;
  hear.disabled = true;
  speech.textContent = "";
  lastSpeech = "";
  status.textContent = modelReady
    ? "Gemma is finding the words…"
    : "Downloading Gemma 3 270M. The first time takes a while.";
  worker.postMessage({
    type: modelReady ? "summon" : "load",
    id: selected.id,
    messages: modelReady ? messagesFor(selected) : undefined,
  });
});

worker.onmessage = (event) => {
  const message = event.data;
  if (message.type === "progress") {
    status.textContent = progressLabel(message.update);
    return;
  }
  if (message.type === "ready") {
    modelReady = true;
    if (selected) {
      status.textContent = "Gemma is here. It is writing…";
      worker.postMessage({
        type: "summon",
        id: selected.id,
        messages: messagesFor(selected),
      });
    }
    return;
  }
  if (message.type === "speech") {
    busy = false;
    summon.disabled = !selected;
    lastSpeech = message.text || "";
    speech.textContent = lastSpeech || "The ghost said nothing.";
    hear.disabled = !lastSpeech;
    status.textContent = "Written by Gemma 3 270M. Recording in Tiger Data & calling ElevenLabs…";
    if (lastSpeech) voiceFor(lastSpeech, true);
    return;
  }
  if (message.type === "error") {
    busy = false;
    summon.disabled = !selected;
    niche.classList.remove("is-speaking");
    status.textContent = message.message;
  }
};

async function voiceFor(text, persistToTiger = false) {
  niche.classList.add("is-speaking");
  let voice = "browser";
  try {
    voice = await speakGhost(text);
    status.textContent =
      voice === "elevenlabs"
        ? "Spoken by ElevenLabs, from words Gemma wrote — persisted in Tiger Data."
        : "Gemma wrote this & Tiger Data saved the epitaph. Set ELEVENLABS_API_KEY in .env for neural voice.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    niche.classList.remove("is-speaking");
  }

  if (persistToTiger && selected) {
    await recordTigerRitual(selected, text, voice);
  }
}

async function recordTigerRitual(ghost, epitaph, voiceEngine) {
  try {
    const response = await fetch("/api/tiger/rest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tweetId: ghost.id,
        username: ghost.username,
        epitaph,
        modelId: "google/gemma-3-270m-it",
        voiceEngine,
      }),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data.rested) {
      restedById[ghost.id] = data.rested;
      restBadge.hidden = false;
    }
    if (Array.isArray(data.rituals)) {
      rituals = data.rituals;
    }
    renderRituals();
    render();
  } catch {
    // Ignore transient network errors
  }
}

async function runHybridSearch(q) {
  try {
    const response = await fetch(`/api/tiger/search?q=${encodeURIComponent(q)}`);
    if (!response.ok) throw new Error("Hybrid search failed");
    const data = await response.json();
    const map = new Map();
    for (const row of data.results || []) {
      map.set(String(row.tweet_id), row);
    }
    hybridMatches = map;
    searchCaption.textContent = `Tiger Data RRF matched ${map.size} souls (fused pgvector HNSW cosine + BM25 rank)`;
    render();
  } catch {
    hybridMatches = null;
    searchCaption.textContent = "Falling back to substring filter";
    render();
  }
}

function messagesFor(ghost) {
  return [
    {
      role: "system",
      content:
        "You are the ghost of one saved social-media post. Speak in the first person as that post. Two short paragraphs, under 90 words. First, what you were when they bookmarked you. Second, one concrete thing they could still do with you. No hashtags, no emoji, no mention that you are a language model.",
    },
    {
      role: "user",
      content: `Author: @${ghost.username} (${ghost.name}). Posted: ${spokenLabel(ghost.spoken) || "unknown"}. Text: ${ghost.text}`,
    },
  ];
}

function progressLabel(update) {
  if (!update) return "Loading the model…";
  if (update.status === "progress" && update.file) {
    const pct = update.progress ? `${Math.round(update.progress)}%` : "";
    return `Bringing the model across: ${update.file} ${pct}`.trim();
  }
  if (update.status === "ready" || update.status === "done") {
    return "The model is in the room.";
  }
  return update.status ? `Model: ${update.status}` : "Loading the model…";
}

function visibleGhosts() {
  const needle = query.value.trim().toLowerCase();
  const stateMode = filterState.value;

  let list = ghosts.filter((ghost) => {
    if (selectedYear !== null && ghost.spoken) {
      const y = new Date(ghost.spoken).getUTCFullYear();
      if (y !== selectedYear) return false;
    }
    const isRested = Boolean(restedById[ghost.id]?.epitaph);
    if (stateMode === "unanswered" && isRested) return false;
    if (stateMode === "rested" && !isRested) return false;

    if (!needle) return true;
    if (hybridMatches) {
      return hybridMatches.has(ghost.id);
    }
    return (
      ghost.text.toLowerCase().includes(needle) ||
      ghost.username.toLowerCase().includes(needle) ||
      ghost.name.toLowerCase().includes(needle)
    );
  });

  const sorted = [...list];
  if (needle && hybridMatches) {
    sorted.sort((a, b) => {
      const sa = hybridMatches.get(a.id)?.rrf_score || 0;
      const sb = hybridMatches.get(b.id)?.rrf_score || 0;
      return sb - sa;
    });
    return sorted;
  }

  if (order.value === "newest") {
    sorted.sort((a, b) => (b.spoken || 0) - (a.spoken || 0));
  } else if (order.value === "loved") {
    sorted.sort((a, b) => b.likes - a.likes);
  } else {
    sorted.sort((a, b) => (a.spoken || 0) - (b.spoken || 0));
  }
  return sorted;
}

function renderTimeline() {
  if (!yearlyBuckets.length) return;
  const maxCount = Math.max(...yearlyBuckets.map((b) => Number(b.ghost_count) || 1), 1);
  timelineBars.replaceChildren(
    ...yearlyBuckets.map((bucket) => {
      const year = Number(bucket.year);
      const c = Number(bucket.ghost_count) || 0;
      const pct = Math.max(10, Math.round((c / maxCount) * 72));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "year-bar";
      if (selectedYear === year) btn.classList.add("is-active");
      btn.innerHTML = `
        <span class="year-count">${c}</span>
        <span class="year-pillar" style="height:${pct}px"></span>
        <span class="year-label">${year}</span>
      `;
      btn.addEventListener("click", () => {
        selectedYear = selectedYear === year ? null : year;
        clearYear.hidden = selectedYear === null;
        shown = PAGE;
        renderTimeline();
        render();
      });
      return btn;
    }),
  );
}

function renderRituals() {
  const restedTotal = Object.keys(restedById).length;
  restedCounter.textContent = `${restedTotal} put to rest`;

  if (!rituals.length) {
    ritualList.innerHTML = `<li class="ritual-item">No ghosts summoned yet.</li>`;
    return;
  }

  ritualList.replaceChildren(
    ...rituals.slice(0, 6).map((item) => {
      const li = document.createElement("li");
      li.className = "ritual-item";
      const snippet = String(item.epitaph || "").replace(/\s+/g, " ").slice(0, 115);
      li.innerHTML = `<b>@${escapeHtml(item.username)}</b> · “${escapeHtml(snippet)}…”`;
      li.addEventListener("click", () => {
        const g = ghostById.get(String(item.tweet_id));
        if (g) choose(g, true);
      });
      return li;
    }),
  );
}

function render() {
  const list = visibleGhosts();
  const page = list.slice(0, shown);
  const yearNote = selectedYear ? ` from ${selectedYear}` : "";
  count.textContent = `${list.length.toLocaleString()} ghosts${yearNote} on the ofrenda`;
  grid.replaceChildren(...page.map(card));
  more.hidden = shown >= list.length;
}

const PLEAS = [
  "Still waiting to be opened",
  "Saved for a night like this",
  "Unheard since you bookmarked me",
  "Tap the flame to hear why you kept me",
  "A spark you tucked away in the dark",
  "Call me back into the room",
];

function card(ghost, index = 0) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.style.setProperty("--stagger", `${(index % 7) * -0.45}s`);
  if (selected?.id === ghost.id) button.classList.add("is-chosen");

  const rested = restedById[ghost.id];
  if (rested?.epitaph) button.classList.add("is-rested");

  const match = hybridMatches?.get(ghost.id);
  const initial = escapeHtml((ghost.name || "?").trim().charAt(0).toUpperCase());
  const cleanText = ghost.text.replace(/https?:\/\/\S+/g, "").trim() || ghost.text;

  const badges = [];
  if (match) {
    const ranks = [
      match.semantic_rank ? `vec #${match.semantic_rank}` : null,
      match.bm25_rank ? `bm25 #${match.bm25_rank}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    badges.push(`<span class="rrf-pill" title="Tiger Data Reciprocal Rank Fusion">${escapeHtml(ranks || "hybrid")}</span>`);
  }
  if (rested?.epitaph) {
    badges.push(`<span class="epitaph-pill">At rest</span>`);
  } else {
    badges.push(`<span class="when">${escapeHtml(waitingLabel(ghost.spoken))}</span>`);
  }

  const pleaIndex = Math.abs(Number(ghost.id.slice(-3)) || index) % PLEAS.length;
  const whisperLine = rested?.epitaph
    ? `<span class="carved-epitaph">“${escapeHtml(rested.epitaph.replace(/\s+/g, " "))}”</span>`
    : `<span class="plea"><span class="pulse-dot" aria-hidden="true"></span>${escapeHtml(PLEAS[pleaIndex])}</span>`;

  const ctaLabel = rested?.epitaph ? "Hear this epitaph again →" : "Light candle & listen →";

  button.innerHTML = `
    <span class="marigold-arch" aria-hidden="true"></span>
    <span class="card-top">
      <span class="votive">
        <span class="seal" aria-hidden="true">${initial}</span>
        <span class="mini-flame" aria-hidden="true"></span>
      </span>
      <span class="badges">${badges.join("")}</span>
    </span>
    <span class="who"><b>${escapeHtml(ghost.name)}</b> <span>@${escapeHtml(ghost.username)}</span></span>
    <span class="last">“${escapeHtml(cleanText)}”</span>
    <span class="card-foot">
      ${whisperLine}
      <span class="beckon">${ctaLabel}</span>
    </span>
  `;
  button.addEventListener("click", () => choose(ghost));
  return button;
}

function choose(ghost, scroll = true) {
  selected = ghost;
  if (seanceSeal) {
    seanceSeal.textContent = (ghost.name || "?").trim().charAt(0).toUpperCase();
  }
  title.textContent = ghost.name;
  meta.textContent = `@${ghost.username} · ${spokenLabel(ghost.spoken)} · ${waitingLabel(ghost.spoken)}`;
  words.textContent = ghost.text;
  source.href = ghost.url;
  source.hidden = false;

  const rested = restedById[ghost.id];
  if (rested?.epitaph) {
    lastSpeech = rested.epitaph;
    speech.textContent = rested.epitaph;
    hear.disabled = false;
    restBadge.hidden = false;
    status.textContent = `Carved in Tiger Data (${rested.summon_count || 1}× summoned). Press Speak again or Summon anew.`;
  } else {
    lastSpeech = "";
    speech.textContent =
      "Press Summon this ghost. Gemma will answer as this post, ElevenLabs will speak it, and Tiger Data will carve its epitaph.";
    hear.disabled = true;
    restBadge.hidden = true;
    if (!busy) {
      status.textContent = modelReady
        ? "Gemma is loaded. Summon, and ElevenLabs + Tiger Data will record the séance."
        : "First summon downloads Gemma 3 270M into this browser.";
    }
  }

  summon.disabled = busy;
  render();
  if (scroll) {
    document.querySelector("#seance").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function boot() {
  try {
    let bookmarksRes = await fetch("/bookmarks.json");
    if (!bookmarksRes.ok) {
      bookmarksRes = await fetch("/bookmarks-demo.json");
    }
    const tigerRes = await fetch("/api/tiger/overview").catch(() => null);
    if (!bookmarksRes.ok) throw new Error("No local export found.");
    ghosts = parseBookmarks(await bookmarksRes.json());
    ghostById = new Map(ghosts.map((g) => [g.id, g]));

    if (tigerRes && tigerRes.ok) {
      const tiger = await tigerRes.json();
      yearlyBuckets = tiger.yearlyBuckets || [];
      restedById = tiger.rested || {};
      rituals = tiger.rituals || [];
      renderTimeline();
      renderRituals();
    }

    const oldest = visibleGhosts()[0];
    if (oldest) choose(oldest, false);
    else render();
  } catch {
    count.textContent = "Drop your x-bookmarks.json export to fill the ofrenda.";
  }
}

boot();
