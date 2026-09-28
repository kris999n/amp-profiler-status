"use strict";

/* Ports the pure math from ampprofiler/gui/progress_window.py (gauge_angle,
   chart_y_range, tier bands) so the phone's Dial and Chart draw the exact
   same shapes and thresholds the desktop app does. Colours and tier labels
   come from the bootstrap payload at runtime, not hard-coded here, so a
   palette or threshold change in theme.py/components.py reaches this page
   for free.

   Where the data actually comes from (a live /api/* server, or static
   data/*.json files refreshed by a periodic git push) is NOT this file's
   concern - a driver script loaded before this one defines `window.DATA`
   with that decision made; see live.js and static.js. Everything below
   only ever calls DATA.bootstrap()/queue()/runs()/runDetail(name). */

const GAUGE_WORST = 1.0;
const GAUGE_BEST = 0.003;
const DEPTH_FLOOR = 1e-4;
const DEPTH_CEILING = 100.0;
const CHART_FLOOR = 0.003;
const ESR_LINE_COLOR = "#6BA8EB"; // a DATA SERIES colour, deliberately not a
                                   // theme status colour - see losses/
                                   // progress_window.py's own note on this.

let THEME = null;
let TIERS = [];      // ascending by limit, last one's limit is null (= inf)
let RUNS = [];
let currentRun = null;
let userPicked = false;

// ---------------------------------------------------------------- fetch --

function applyTheme(theme) {
  const root = document.documentElement.style;
  const map = {
    BG: "--bg", BG_PANEL: "--bg-panel", BG_RAISED: "--bg-raised",
    BORDER: "--border", BORDER_SOFT: "--border-soft", TEXT: "--text",
    TEXT_DIM: "--text-dim", TEXT_FAINT: "--text-faint", ACCENT: "--accent",
    ACCENT_SOFT: "--accent-soft", OK: "--ok", OK_SOFT: "--ok-soft",
    WARN: "--warn", WARN_SOFT: "--warn-soft", ERR: "--err", ERR_SOFT: "--err-soft",
  };
  for (const [key, cssVar] of Object.entries(map)) {
    if (theme[key]) root.setProperty(cssVar, theme[key]);
  }
}

// ------------------------------------------------------------------ tabs --

function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// ----------------------------------------------------------------- queue --

function jobBadgeClass(status) {
  return { running: "badge-running", pending: "badge-pending",
          done: "badge-done", failed: "badge-failed" }[status] || "badge-pending";
}

function renderQueue(data) {
  const list = document.getElementById("queue-list");
  if (!data.jobs.length) {
    list.innerHTML = '<div class="empty">Queue is empty</div>';
    return;
  }
  list.innerHTML = data.jobs.map((j) => {
    const mins = j.minutes != null ? `${Math.round(j.minutes)} min` : "";
    return `<div class="job-card">
      <div class="job-name">${escapeHtml(j.name)}</div>
      <div class="job-meta">
        <span class="badge ${jobBadgeClass(j.status)}">${j.status}</span>
        <span>${mins}</span>
      </div>
      <div class="job-cmd">${escapeHtml(j.cmd)}</div>
    </div>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function updateFreshness(serverNow) {
  const el = document.getElementById("freshness");
  if (!el || typeof serverNow !== "number") return;
  const ageS = Math.max(0, Math.round(Date.now() / 1000 - serverNow));
  el.textContent = ageS < 5 ? "Live" : `Updated ${ageS}s ago`;
}

async function pollQueue() {
  try {
    const data = await DATA.queue();
    renderQueue(data);
    updateFreshness(data.now);
  } catch (e) { /* transient - next poll retries */ }
}

// ------------------------------------------------------------ run picker --

function chooseRun(runs) {
  // Mirrors progress_window.choose_run: the user's own pick if it still
  // exists, else the newest ACTIVE run, else just the newest.
  if (!runs.length) return null;
  if (userPicked && runs.some((r) => r.name === currentRun)) return currentRun;
  const active = runs.filter((r) => r.active);
  return (active[0] || runs[0]).name;
}

function renderRunPicker(runs) {
  const picker = document.getElementById("run-picker");
  const wanted = runs.map((r) => r.name + (r.active ? "  ·  active" : ""));
  const have = Array.from(picker.options).map((o) => o.textContent);
  if (JSON.stringify(wanted) !== JSON.stringify(have)) {
    picker.innerHTML = runs.map((r) =>
      `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}${r.active ? "  ·  active" : ""}</option>`
    ).join("");
  }
  const target = chooseRun(runs);
  if (target && picker.value !== target) picker.value = target;
  currentRun = picker.value || target;
}

async function pollRuns() {
  try {
    const data = await DATA.runs();
    RUNS = data.runs;
    if (!RUNS.length) {
      document.getElementById("run-picker").innerHTML = "";
      document.getElementById("run-status").textContent = "No runs yet";
      clearCanvases();
      return;
    }
    renderRunPicker(RUNS);
    await pollRunDetail();
  } catch (e) { /* transient */ }
}

function clearCanvases() {
  ["dial-canvas", "chart-canvas"].forEach((id) => {
    const c = document.getElementById(id);
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
  });
}

async function pollRunDetail() {
  if (!currentRun) return;
  try {
    const detail = await DATA.runDetail(currentRun);
    renderRunStatus(detail);
    drawDial(detail);
    drawChart(detail);
  } catch (e) { /* transient */ }
}

function renderRunStatus(detail) {
  const el = document.getElementById("run-status");
  const pts = detail.points;
  if (!pts.length) {
    el.innerHTML = detail.live ? `<div class="live-line">${escapeHtml(detail.live.line)}</div>` : "No rounds yet";
    return;
  }
  const last = pts[pts.length - 1];
  const epochText = detail.total_epochs ? `${last.epoch}/${detail.total_epochs}` : `${last.epoch}`;
  const v = detail.verdict;
  let html = `<span>epoch ${epochText}</span>
    <span class="esr-big">${last.esr.toFixed(4)}</span>`;
  if (v) html += `<span class="verdict" style="color:${v.color}">${escapeHtml(v.label)}</span>`;
  if (detail.live) html += `<div class="live-line">${escapeHtml(detail.live.line)}</div>`;
  el.innerHTML = html;
}

// ------------------------------------------------------------- dial view --

function gaugeAngle(value) {
  const v = Math.min(Math.max(value, GAUGE_BEST), GAUGE_WORST);
  return 180.0 * Math.log10(v / GAUGE_BEST) / Math.log10(GAUGE_WORST / GAUGE_BEST);
}

function onArc(cx, cy, angleDeg, r) {
  const a = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

function sizeCanvasToCss(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 280);
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function prevLimit(i) {
  if (i === 0) return 0.0;
  return TIERS[i - 1].limit === null ? DEPTH_CEILING : TIERS[i - 1].limit;
}

function drawDial(detail) {
  const canvas = document.getElementById("dial-canvas");
  const { ctx, w, h } = sizeCanvasToCss(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!TIERS.length) return;

  const cx = w / 2;
  const cy = h - 70;
  const rad = Math.max(Math.min(w * 0.34, cy - 30), 50);

  // tier arcs
  TIERS.forEach((band, i) => {
    const aWorse = band.limit === null ? 180.0 : gaugeAngle(band.limit);
    const aBetter = gaugeAngle(Math.max(prevLimit(i), GAUGE_BEST));
    ctx.beginPath();
    const steps = 48;
    for (let s = 0; s <= steps; s++) {
      const a = aBetter + (aWorse - aBetter) * (s / steps);
      const [x, y] = onArc(cx, cy, a, rad);
      if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = band.color;
    ctx.lineWidth = rad * 0.16;
    ctx.lineCap = "butt";
    ctx.stroke();
  });

  const pts = detail.points;
  if (pts.length) {
    // history dots, fading in from oldest to newest
    const n = pts.length;
    pts.forEach((p, i) => {
      const a = gaugeAngle(p.esr);
      const [x, y] = onArc(cx, cy, a, rad * 0.78);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      if (p.spike) {
        ctx.fillStyle = THEME.ERR;
      } else {
        const alpha = 0.16 + 0.7 * ((i + 1) / n);
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(2)})`;
      }
      ctx.fill();
    });

    // best-checkpoint tick
    if (detail.best_esr != null) {
      const a = gaugeAngle(detail.best_esr);
      const [x1, y1] = onArc(cx, cy, a, rad * 0.88);
      const [x2, y2] = onArc(cx, cy, a, rad * 1.08);
      ctx.strokeStyle = THEME.OK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // needle
    const now = pts[pts.length - 1].esr;
    const a = gaugeAngle(now);
    const [nx, ny] = onArc(cx, cy, a, rad * 0.9);
    ctx.strokeStyle = THEME.TEXT;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    ctx.fillStyle = THEME.ACCENT;
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = THEME.TEXT;
    ctx.font = "700 26px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(now.toFixed(4), cx, cy + 44);
  } else {
    ctx.fillStyle = THEME.TEXT_FAINT;
    ctx.font = "13px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No rounds yet", cx, cy);
  }
}

// ------------------------------------------------------------ chart view --

function chartYRange(values) {
  const finite = values.filter((v) => typeof v === "number" && v > 0 && Number.isFinite(v));
  const worst = Math.min(finite.length ? Math.max(...finite) : 1.0, DEPTH_CEILING);
  const best = Math.max(finite.length ? Math.min(...finite) : CHART_FLOOR, DEPTH_FLOOR);
  return [Math.log10(best) - 0.05, Math.log10(Math.max(worst, 1.0)) + 0.15];
}

function drawChart(detail) {
  const canvas = document.getElementById("chart-canvas");
  const { ctx, w, h } = sizeCanvasToCss(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!TIERS.length) return;

  const pts = detail.points;
  const left = 46, right = w - 12, top = 10, bottom = h - 24;
  const xMax = Math.max(detail.span, pts.length ? pts[pts.length - 1].epoch : 1);

  const values = pts.flatMap((p) => [p.loss, p.esr]);
  const [lo, hi] = chartYRange(values.length ? values : [1.0]);

  const xOf = (epoch) => left + (right - left) * (epoch / Math.max(xMax, 1));
  const yOf = (v) => {
    const lv = Math.log10(Math.min(Math.max(v, 1e-9), 1e9));
    const frac = (lv - lo) / (hi - lo || 1);
    return bottom - frac * (bottom - top);
  };

  // tier colour bands
  let edge = CHART_FLOOR / 10;
  TIERS.forEach((band) => {
    const bandTop = band.limit === null ? DEPTH_CEILING * 10 : Math.min(band.limit, DEPTH_CEILING * 10);
    const y1 = yOf(edge), y2 = yOf(bandTop);
    const a = Math.max(Math.min(y1, y2), top), b = Math.min(Math.max(y1, y2), bottom);
    if (b > a) {
      ctx.fillStyle = hexToRgba(band.color, 0.14);
      ctx.fillRect(left, a, right - left, b - a);
    }
    edge = band.limit === null ? edge : band.limit;
  });

  if (!pts.length) {
    ctx.fillStyle = THEME.TEXT_FAINT;
    ctx.font = "13px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No rounds yet", (left + right) / 2, (top + bottom) / 2);
    return;
  }

  drawLine(ctx, pts, "loss", xOf, yOf, THEME.ACCENT);
  drawLine(ctx, pts, "esr", xOf, yOf, ESR_LINE_COLOR);

  // spikes (on the loss series)
  ctx.fillStyle = THEME.ERR;
  pts.filter((p) => p.spike).forEach((p) => {
    ctx.beginPath();
    ctx.arc(xOf(p.epoch), yOf(p.loss), 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // best marker (star, approximated as a filled circle - readable at this size)
  const bestPt = pts.find((p) => p.epoch === detail.best_epoch);
  if (bestPt) {
    ctx.fillStyle = THEME.OK;
    drawStar(ctx, xOf(bestPt.epoch), yOf(bestPt.loss), 6);
  }

  // now marker
  const last = pts[pts.length - 1];
  ctx.fillStyle = THEME.ACCENT;
  ctx.beginPath();
  ctx.arc(xOf(last.epoch), yOf(last.esr), 5, 0, Math.PI * 2);
  ctx.fill();

  // axis labels
  ctx.fillStyle = THEME.TEXT_FAINT;
  ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("epoch", left, h - 6);
}

function drawLine(ctx, pts, key, xOf, yOf, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = xOf(p.epoch), y = yOf(p[key]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawStar(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI / 2) + (i * 4 * Math.PI) / 5;
    const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}

function hexToRgba(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ------------------------------------------------------------------- run --

async function onRunPicked() {
  const picker = document.getElementById("run-picker");
  currentRun = picker.value;
  userPicked = true;
  await pollRunDetail();
}

// ------------------------------------------------------------------ init --

async function init() {
  initTabs();
  try {
    const boot = await DATA.bootstrap();
    THEME = boot.theme;
    TIERS = boot.tiers;
    applyTheme(THEME);
  } catch (e) {
    // Fall back to the CSS defaults baked into style.css; drawing still
    // works, just possibly a shade off from the desktop app until this
    // resolves on a later poll.
    THEME = {
      TEXT: "#EAE8EF", ACCENT: "#F0873A", OK: "#5AC48C", ERR: "#E4685E",
      TEXT_FAINT: "#6E6A7A",
    };
  }
  document.getElementById("run-picker").addEventListener("change", onRunPicked);

  await pollQueue();
  await pollRuns();

  setInterval(pollQueue, 4000);
  setInterval(pollRuns, 5000);
}

window.addEventListener("resize", () => { if (currentRun) pollRunDetail(); });
init();
