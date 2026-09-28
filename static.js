"use strict";

/* Data source for the GitHub Pages copy of this page: status_publisher.py
   periodically writes data/*.json into this same directory and git-pushes
   it, so there is no live server to talk to here - just whatever the last
   push wrote. See core.js for everything that consumes DATA, and live.js
   for the other driver (monitor_server.py's /api/* endpoints, reached over
   Tailscale) used on the PC-hosted copy of this same page. */

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function slug(name) {
  // Must match scripts/monitor_data.py's slug() exactly - it names the
  // per-run file this reads.
  return name.replace(/[^A-Za-z0-9\-_.]/g, "_");
}

const DATA = {
  bootstrap: () => getJSON("data/bootstrap.json"),
  queue: () => getJSON("data/queue.json"),
  runs: () => getJSON("data/runs.json"),
  runDetail: (name) => getJSON(`data/run_${slug(name)}.json`),
};
