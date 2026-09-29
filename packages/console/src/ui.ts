/**
 * The Byte console.
 *
 * A single self-contained HTML page, served by the console server. No build step, no
 * framework, no CDN — a page that reports on a privacy protocol should not be loading
 * scripts from third parties who would then see every operator who opens it.
 *
 * ## The visual language
 *
 * Instrumentation, not dashboard. Near-black ground, a hairline measurement grid, corner
 * brackets framing the plate, wide-tracked uppercase micro-labels, numbered index markers in
 * the corners, and a single wireframe object as the focal point.
 *
 * Departure from the reference, deliberately: the type is **bolder and at higher contrast**.
 * The reference's hairline grey is beautiful and hard to read, and this is a page an operator
 * looks at to find out whether they were paid.
 */

export interface ConsoleUiOptions {
  /** Where the owner-only API is mounted, relative to the page. */
  apiBase?: string;
  title?: string;
}

export function consoleHtml(options: ConsoleUiOptions = {}): string {
  const apiBase = options.apiBase ?? "/api";
  const title = options.title ?? "BYTE CONSOLE";

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root {
    --ground: #070807;
    --plate: #0c0e0d;
    --grid: rgba(120, 140, 130, 0.07);
    --rule: rgba(150, 170, 160, 0.22);
    --ink: #eef2ef;
    --ink-dim: #9fada6;
    --ink-faint: #6c7a74;
    --accent: #7ef0b2;
    --warn: #f0c67e;
    --bad: #f08d8d;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--mono);
    -webkit-font-smoothing: antialiased;
  }

  /* The measurement grid. Hairline, never competing with the type. */
  body::before {
    content: "";
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 44px 44px;
    pointer-events: none;
    z-index: 0;
  }

  /* Vignette, so the plate sits in space rather than on a flat field. */
  body::after {
    content: "";
    position: fixed;
    inset: 0;
    background: radial-gradient(ellipse at 50% 40%, transparent 30%, rgba(0,0,0,0.75) 100%);
    pointer-events: none;
    z-index: 0;
  }

  .wrap { position: relative; z-index: 1; max-width: 1180px; margin: 0 auto; padding: 28px 16px 72px; }

  /* ---------------------------------------------------------------- masthead */

  .masthead {
    display: flex; flex-wrap: wrap; gap: 16px;
    align-items: baseline; justify-content: space-between;
    padding-bottom: 18px; border-bottom: 1px solid var(--rule);
  }
  .wordmark { font-size: 15px; font-weight: 700; letter-spacing: 0.34em; margin: 0; }
  .wordmark span { color: var(--accent); }
  .masthead .meta { display: flex; gap: 22px; flex-wrap: wrap; }

  .label {
    font-size: 10px; font-weight: 700; letter-spacing: 0.22em;
    text-transform: uppercase; color: var(--ink-faint);
  }
  .value { font-size: 13px; font-weight: 600; color: var(--ink); }

  /* ------------------------------------------------------------------- plate */

  .plate {
    position: relative; margin-top: 26px; padding: 34px 26px;
    background: var(--plate); border: 1px solid var(--rule);
  }
  /* Corner brackets: drawn, not bordered, so they read as registration marks. */
  .plate .corner {
    position: absolute; width: 16px; height: 16px;
    border-color: var(--accent); border-style: solid; border-width: 0;
  }
  .plate .tl { top: -1px; left: -1px; border-top-width: 2px; border-left-width: 2px; }
  .plate .tr { top: -1px; right: -1px; border-top-width: 2px; border-right-width: 2px; }
  .plate .bl { bottom: -1px; left: -1px; border-bottom-width: 2px; border-left-width: 2px; }
  .plate .br { bottom: -1px; right: -1px; border-bottom-width: 2px; border-right-width: 2px; }

  .index {
    display: grid; gap: 22px;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  }
  .index .cell .label::before { content: attr(data-n) ". "; color: var(--accent); }
  .index .cell .figure {
    font-size: 30px; font-weight: 700; letter-spacing: -0.015em;
    margin-top: 8px; line-height: 1;
  }
  .index .cell .note { font-size: 11px; color: var(--ink-dim); margin-top: 7px; font-weight: 500; }

  /* ------------------------------------------------------------------ object */

  .focal { display: flex; justify-content: center; margin: 34px 0 10px; }
  .focal svg { width: min(230px, 56vw); height: auto; }
  .focal .ring { fill: none; stroke: var(--accent); stroke-width: 0.6; opacity: 0.55; }
  .focal .ring.faint { opacity: 0.2; }
  .focal .core { fill: none; stroke: var(--ink); stroke-width: 1; opacity: 0.85; }
  @media (prefers-reduced-motion: no-preference) {
    .focal .spin { transform-origin: 50% 50%; animation: turn 34s linear infinite; }
  }
  @keyframes turn { to { transform: rotate(360deg); } }

  .focal-caption {
    text-align: center; font-size: 10px; font-weight: 700;
    letter-spacing: 0.22em; text-transform: uppercase; color: var(--ink-faint);
  }

  /* ------------------------------------------------------------------ panels */

  .panels { display: grid; gap: 22px; margin-top: 26px; grid-template-columns: 1fr; }
  @media (min-width: 900px) { .panels { grid-template-columns: 1.35fr 1fr; } }

  .panel { border: 1px solid var(--rule); background: var(--plate); }
  .panel > header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 16px; border-bottom: 1px solid var(--rule);
  }
  .panel > .body { padding: 6px 0; max-height: 420px; overflow-y: auto; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th {
    text-align: left; padding: 9px 16px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-faint);
    border-bottom: 1px solid var(--rule); position: sticky; top: 0; background: var(--plate);
  }
  td { padding: 10px 16px; border-bottom: 1px solid rgba(150,170,160,0.08); font-weight: 500; }
  tr:last-child td { border-bottom: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .trunc { color: var(--ink-dim); }

  .tag {
    display: inline-block; padding: 2px 7px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.12em; text-transform: uppercase; border: 1px solid currentColor;
  }
  .tag.ok { color: var(--accent); }
  .tag.wait { color: var(--warn); }
  .tag.dead { color: var(--ink-faint); }
  .tag.no { color: var(--bad); }

  .empty { padding: 26px 16px; color: var(--ink-faint); font-size: 12px; font-weight: 500; }

  /* ------------------------------------------------------------------- gate */

  .gate { max-width: 460px; margin: 16vh auto 0; }
  .gate p { color: var(--ink-dim); font-size: 12px; line-height: 1.65; font-weight: 500; }
  .gate input {
    width: 100%; margin-top: 14px; padding: 12px 14px;
    background: #060706; color: var(--ink); font-family: var(--mono); font-size: 13px;
    border: 1px solid var(--rule); outline: none;
  }
  .gate input:focus { border-color: var(--accent); }
  .gate button {
    margin-top: 12px; width: 100%; padding: 12px;
    background: transparent; color: var(--accent); font-family: var(--mono);
    font-size: 11px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase;
    border: 1px solid var(--accent); cursor: pointer;
  }
  .gate button:hover { background: rgba(126, 240, 178, 0.09); }
  .gate .err { color: var(--bad); font-size: 12px; margin-top: 12px; font-weight: 600; }

  footer {
    margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--rule);
    display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  }
  footer p { margin: 0; font-size: 11px; color: var(--ink-faint); font-weight: 500; }
  [hidden] { display: none !important; }
</style>
</head>
<body>

<div class="wrap">

  <!-- Token gate. The console reports exactly what Byte keeps off the chain, so it does not
       render anything before it has been let in. -->
  <section id="gate" class="gate">
    <h1 class="wordmark">BYTE<span>/</span>CONSOLE</h1>
    <p>
      This console reports invoice amounts, transaction identifiers and balances &mdash;
      the information Byte keeps off the public chain. It is owner-only.
    </p>
    <form id="gate-form">
      <input id="token" type="password" placeholder="OWNER TOKEN" autocomplete="off" spellcheck="false">
      <button type="submit">Unlock</button>
    </form>
    <p class="err" id="gate-error" hidden></p>
  </section>

  <main id="app" hidden>

    <div class="masthead">
      <h1 class="wordmark">BYTE<span>/</span>CONSOLE</h1>
      <div class="meta">
        <div><div class="label">Network</div><div class="value" id="m-network">&mdash;</div></div>
        <div><div class="label">Sync</div><div class="value" id="m-sync">&mdash;</div></div>
        <div><div class="label">Pool</div><div class="value">IRONWOOD</div></div>
      </div>
    </div>

    <section class="plate">
      <span class="corner tl"></span><span class="corner tr"></span>
      <span class="corner bl"></span><span class="corner br"></span>

      <div class="index">
        <div class="cell">
          <div class="label" data-n="01">Spendable</div>
          <div class="figure" id="f-spendable">&mdash;</div>
          <div class="note">zatoshis, confirmed in Ironwood</div>
        </div>
        <div class="cell">
          <div class="label" data-n="02">Settled</div>
          <div class="figure" id="f-settled">&mdash;</div>
          <div class="note" id="f-settled-note">across consumed invoices</div>
        </div>
        <div class="cell">
          <div class="label" data-n="03">Outstanding</div>
          <div class="figure" id="f-outstanding">&mdash;</div>
          <div class="note">invoices awaiting payment</div>
        </div>
        <div class="cell">
          <div class="label" data-n="04">Guard</div>
          <div class="figure" id="f-guard">&mdash;</div>
          <div class="note" id="f-guard-note">spent in the last 24 hours</div>
        </div>
      </div>

      <div class="focal">
        <svg viewBox="0 0 200 200" role="img" aria-label="Shielded pool">
          <g class="spin">
            <circle class="ring" cx="100" cy="100" r="74"></circle>
            <ellipse class="ring" cx="100" cy="100" rx="74" ry="26"></ellipse>
            <ellipse class="ring faint" cx="100" cy="100" rx="74" ry="48"></ellipse>
            <ellipse class="ring faint" cx="100" cy="100" rx="26" ry="74"></ellipse>
            <ellipse class="ring" cx="100" cy="100" rx="48" ry="74"></ellipse>
          </g>
          <circle class="core" cx="100" cy="100" r="30"></circle>
          <circle class="core" cx="100" cy="100" r="15" opacity="0.4"></circle>
        </svg>
      </div>
      <p class="focal-caption">Amounts, parties and balances &mdash; not on chain</p>
    </section>

    <div class="panels">
      <section class="panel">
        <header>
          <span class="label">Invoices</span>
          <span class="label" id="inv-count"></span>
        </header>
        <div class="body">
          <table>
            <thead><tr><th>Invoice</th><th>Status</th><th class="num">Zatoshis</th></tr></thead>
            <tbody id="invoices"></tbody>
          </table>
          <p class="empty" id="invoices-empty" hidden>No invoices issued yet.</p>
        </div>
      </section>

      <section class="panel">
        <header>
          <span class="label">Spend guard</span>
          <span class="label" id="guard-count"></span>
        </header>
        <div class="body">
          <table>
            <thead><tr><th>Host</th><th>Decision</th><th class="num">Zatoshis</th></tr></thead>
            <tbody id="guard"></tbody>
          </table>
          <p class="empty" id="guard-empty" hidden>No payments attempted.</p>
        </div>
      </section>
    </div>

    <footer>
      <p id="foot-label">&mdash;</p>
      <p>Refreshed <span id="foot-time">&mdash;</span></p>
    </footer>
  </main>
</div>

<script>
(function () {
  "use strict";

  var API = ${JSON.stringify(apiBase)};
  var token = "";

  var $ = function (id) { return document.getElementById(id); };
  var text = function (id, value) { $(id).textContent = value; };

  /** Group digits so a zatoshi figure is readable at a glance. */
  function grouped(value) {
    if (value === null || value === undefined) return "\\u2014";
    return String(value).replace(/\\B(?=(\\d{3})+(?!\\d))/g, "\\u2009");
  }

  function shorten(value) {
    if (!value) return "\\u2014";
    return value.length <= 18 ? value : value.slice(0, 10) + "\\u2026" + value.slice(-6);
  }

  function api(path) {
    return fetch(API + path, { headers: { authorization: "Bearer " + token } })
      .then(function (r) {
        if (r.status === 401) throw new Error("unauthorized");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
  }

  function invoiceState(invoice) {
    if (invoice.consumedAt) return { cls: "ok", label: "Paid" };
    if (Date.now() >= invoice.expiresAt) return { cls: "dead", label: "Expired" };
    return { cls: "wait", label: "Waiting" };
  }

  function renderInvoices(invoices) {
    var body = $("invoices");
    body.innerHTML = "";
    $("invoices-empty").hidden = invoices.length > 0;
    text("inv-count", invoices.length + " shown");

    invoices.forEach(function (invoice) {
      var state = invoiceState(invoice);
      var row = document.createElement("tr");

      var id = document.createElement("td");
      id.className = "trunc";
      id.textContent = shorten(invoice.invoiceId);

      var status = document.createElement("td");
      var tag = document.createElement("span");
      tag.className = "tag " + state.cls;
      tag.textContent = state.label;
      status.appendChild(tag);

      var amount = document.createElement("td");
      amount.className = "num";
      amount.textContent = grouped(invoice.amountZat);

      row.appendChild(id); row.appendChild(status); row.appendChild(amount);
      body.appendChild(row);
    });
  }

  function renderGuard(payload) {
    var entries = (payload && payload.entries) || [];
    var body = $("guard");
    body.innerHTML = "";
    $("guard-empty").hidden = entries.length > 0;
    text("guard-count", entries.length + " decisions");

    entries.forEach(function (entry) {
      var row = document.createElement("tr");

      var host = document.createElement("td");
      host.className = "trunc";
      host.textContent = entry.host;

      var decision = document.createElement("td");
      var tag = document.createElement("span");
      tag.className = "tag " + (entry.allowed ? "ok" : "no");
      // Refusals are shown with their reason. An operator needs to know WHY a payment was
      // stopped, not merely that it was.
      tag.textContent = entry.allowed ? "Paid" : (entry.reason || "Refused");
      decision.appendChild(tag);

      var amount = document.createElement("td");
      amount.className = "num";
      amount.textContent = grouped(entry.amountZat);

      row.appendChild(host); row.appendChild(decision); row.appendChild(amount);
      body.appendChild(row);
    });
  }

  function refresh() {
    return api("/overview").then(function (overview) {
      text("m-network", overview.network.split(":")[0].toUpperCase());

      // An unsynced wallet is reported as unsynced, never as a confident zero.
      text("m-sync", overview.sync && overview.sync.synced
        ? "BLOCK " + overview.sync.syncedHeight
        : "SYNCING");

      text("f-spendable", overview.balance ? grouped(overview.balance.spendableZat) : "\\u2014");
      text("f-settled", grouped(overview.settledZat));
      text("f-settled-note", overview.invoices.consumed + " consumed invoices");
      text("f-outstanding", String(overview.invoices.outstanding));
      text("f-guard", overview.guard ? grouped(overview.guard.spentTodayZat) : "off");
      text("f-guard-note", overview.guard
        ? overview.guard.refusals + " refused of " + overview.guard.decisions
        : "no spend guard configured");
      text("foot-label", overview.label + " \\u00b7 " + overview.network);
      text("foot-time", new Date().toLocaleTimeString());

      return Promise.all([
        api("/invoices?limit=50").then(function (r) { renderInvoices(r.invoices || []); }),
        overview.guard
          ? api("/guard?limit=50").then(renderGuard)
          : Promise.resolve(renderGuard(null))
      ]);
    });
  }

  $("gate-form").addEventListener("submit", function (event) {
    event.preventDefault();
    token = $("token").value.trim();
    $("gate-error").hidden = true;

    refresh().then(function () {
      $("gate").hidden = true;
      $("app").hidden = false;
      setInterval(function () { refresh().catch(function () {}); }, 5000);
    }).catch(function (error) {
      $("gate-error").textContent = error.message === "unauthorized"
        ? "That token was not accepted."
        : "Could not reach the node: " + error.message;
      $("gate-error").hidden = false;
    });
  });
})();
</script>
</body>
</html>`;
}
