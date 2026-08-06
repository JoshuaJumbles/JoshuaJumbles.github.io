#!/usr/bin/env node
// Pulls public GitHub stats for JoshuaJumbles via the GraphQL API and writes
// assets/stats.json. Run by .github/workflows/update-stats.yml on a daily
// cron (and via workflow_dispatch); index.html fetches the JSON at runtime
// and swaps it into the static fallback numbers already baked into the page.
//
// Deliberately reads only public data (repositories(privacy: PUBLIC), plus
// contributionsCollection which mirrors what's shown on the public profile
// for a non-owner viewer) so the default Actions GITHUB_TOKEN is enough —
// no personal access token / repo secret required.

import { mkdir, writeFile } from "node:fs/promises";

const LOGIN = "JoshuaJumbles";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is not set");
  process.exit(1);
}

const QUERY = `
  query ($login: String!, $cursor: String) {
    user(login: $login) {
      createdAt
      repositories(privacy: PUBLIC, isFork: false, ownerAffiliations: [OWNER], first: 50, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name } }
          }
        }
      }
      contributionsCollection {
        totalCommitContributions
      }
    }
  }
`;

async function fetchPage(cursor) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "joshuajumbles-portfolio-stats",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN, cursor } }),
  });
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data.user;
}

let createdAt;
let contributions;
let repoCount = 0;
const languageBytes = new Map();

let cursor = null;
for (;;) {
  const user = await fetchPage(cursor);
  createdAt ??= user.createdAt;
  contributions ??= user.contributionsCollection;
  repoCount = user.repositories.totalCount;
  for (const repo of user.repositories.nodes) {
    for (const edge of repo.languages.edges) {
      languageBytes.set(edge.node.name, (languageBytes.get(edge.node.name) ?? 0) + edge.size);
    }
  }
  if (!user.repositories.pageInfo.hasNextPage) break;
  cursor = user.repositories.pageInfo.endCursor;
}

const totalBytes = [...languageBytes.values()].reduce((a, b) => a + b, 0);
const sortedLanguages = [...languageBytes.entries()].sort((a, b) => b[1] - a[1]);
const TOP_N = 3;
const top = sortedLanguages.slice(0, TOP_N);
const restBytes = sortedLanguages.slice(TOP_N).reduce((sum, [, bytes]) => sum + bytes, 0);

const languages = top.map(([name, bytes]) => ({
  name,
  pct: totalBytes ? Math.round((bytes / totalBytes) * 100) : 0,
}));
if (restBytes > 0) {
  languages.push({ name: "Other", pct: totalBytes ? Math.round((restBytes / totalBytes) * 100) : 0 });
}
// Rounding can drift the total off 100 by a point or two; nudge the largest
// bucket so the displayed percentages always sum to 100.
if (languages.length) {
  const drift = 100 - languages.reduce((sum, l) => sum + l.pct, 0);
  languages[0].pct += drift;
}

const yearsOnGithub = Math.floor((Date.now() - new Date(createdAt)) / (365.25 * 24 * 3600 * 1000));
const weeklyCommitCadence = Math.round(contributions.totalCommitContributions / 52);

const stats = {
  generatedAt: new Date().toISOString(),
  publicRepos: repoCount,
  yearsOnGithub,
  weeklyCommitCadence,
  languages,
};

await mkdir(new URL("../assets/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../assets/stats.json", import.meta.url),
  JSON.stringify(stats, null, 2) + "\n"
);
console.log(JSON.stringify(stats, null, 2));
