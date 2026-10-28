import { repairText } from "./repair.js";

export function parseBookmarks(data) {
  const tweets = Array.isArray(data) ? data : data?.tweets;
  if (!Array.isArray(tweets)) {
    throw new Error("This file does not look like a bird bookmarks export.");
  }

  return tweets
    .map((tweet) => {
      const text = repairText(tweet.text || "").replace(/\s+/g, " ").trim();
      if (!tweet.id || !text) return null;
      const username = tweet.author?.username || "unknown";
      const spoken = parseTwitterDate(tweet.createdAt);
      return {
        id: String(tweet.id),
        text,
        username,
        name: repairText(tweet.author?.name || username),
        spoken,
        likes: Number(tweet.likeCount) || 0,
        url: `https://x.com/${username}/status/${tweet.id}`,
      };
    })
    .filter(Boolean);
}

function parseTwitterDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

export function waitingLabel(spoken, now = Date.now()) {
  if (!spoken) return "date unknown";
  const days = Math.max(0, Math.floor((now - spoken) / 86_400_000));
  if (days === 0) return "spoken today";
  if (days === 1) return "waiting 1 day";
  if (days < 60) return `waiting ${days} days`;
  const months = Math.floor(days / 30);
  if (months < 24) return `waiting ${months} months`;
  const years = Math.floor(days / 365);
  return `waiting ${years} years`;
}

export function spokenLabel(spoken) {
  if (!spoken) return "";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(spoken);
}
