// INPI Admin – neu, minimal & robust
// - Bindings: env.CONFIG (KV), optional ADMIN_USER/ADMIN_PASS, ADMIN_REALM, IP_ALLOWLIST
// - UI: /admin
// - API:
//   GET  /admin/api/kv/keys?prefix=
//   GET  /admin/api/kv/get?key=K
//   POST /admin/api/kv/put  {key,value}
//   POST /admin/api/kv/delete {key}
//   POST /admin/api/kv/setmany {entries:{k:v}}
//   GET  /admin/api/kv/export
//   POST /admin/api/kv/import {values:{k:v}}
//   POST /admin/api/preset/inpi {overrides?}
//   GET  /admin/api/env
//   GET  /admin/api/health
// - PUBLIC bridge:
//   GET /public/app-cfg

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: secHeaders() });
    }

    // PUBLIC: /public/app-cfg (kein Login nötig)
    if (req.method === "GET" && p === "/public/app-cfg") {
      const map = await toAppCfg(env);
      return J(map);
    }

    // ---- alles unter /admin braucht Auth + optional IP-Whitelist
    if (p.startsWith("/admin")) {
      if (!basicOk(req, env) || !ipOk(req, env)) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "INPI Admin"}"`,
            ...secHeaders()
          }
        });
      }

      // UI
      if (req.method === "GET" && (p === "/admin" || p === "/admin/"))
        return ui();

      // Health / Env
      if (req.method === "GET" && p === "/admin/api/health")
        return J({ ok: true, now: Date.now() });

      if (req.method === "GET" && p === "/admin/api/env") {
        return J({
          ok: true,
          env: {
            realm: env.ADMIN_REALM || "",
            ip_allowlist: env.IP_ALLOWLIST || "",
            has_ADMIN_USER: !!env.ADMIN_USER,
            has_ADMIN_PASS: !!env.ADMIN_PASS
          }
        });
      }

      // KV: keys
      if (req.method === "GET" && p === "/admin/api/kv/keys") {
        const prefix = url.searchParams.get("prefix") || "";
        const keys = await listAll(env.CONFIG, { prefix });
        return J({ ok: true, keys });
      }

      // KV: get
      if (req.method === "GET" && p === "/admin/api/kv/get") {
        const key = url.searchParams.get("key") || "";
        if (!key) return J({ ok: false, error: "key_required" }, 400);
        const value = await env.CONFIG.get(key);
        return J({ ok: true, key, value: value ?? null });
      }

      // KV: put (einzeln)
      if (req.method === "POST" && p === "/admin/api/kv/put") {
        const body = await readJson(req); if (!body) return badCT();
        const { key, value } = body || {};
        if (!key) return J({ ok: false, error: "key_required" }, 400);
        await env.CONFIG.put(String(key), String(value ?? ""));
        return J({ ok: true });
      }

      // KV: delete
      if (req.method === "POST" && p === "/admin/api/kv/delete") {
        const body = await readJson(req); if (!body) return badCT();
        const { key } = body || {};
        if (!key) return J({ ok: false, error: "key_required" }, 400);
        await env.CONFIG.delete(String(key));
        return J({ ok: true, deleted: key });
      }

      // KV: setmany
      if (req.method === "POST" && p === "/admin/api/kv/setmany") {
        const body = await readJson(req); if (!body) return badCT();
        const { entries } = body || {};
        if (!entries || typeof entries !== "object")
          return J({ ok: false, error: "entries_object_required" }, 400);
        await Promise.all(
          Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? "")))
        );
        return J({ ok: true, written: Object.keys(entries).length });
      }

      // Export
      if (req.method === "GET" && p === "/admin/api/kv/export") {
        const keys = await listAll(env.CONFIG);
        const values = {};
        await Promise.all(keys.map(async (k) => (values[k] = (await env.CONFIG.get(k)) ?? "")));
        return new Response(JSON.stringify({ ts: Date.now(), values }, null, 2), {
          headers: {
            "content-type": "application/json",
            "content-disposition": "attachment; filename=inpi-config-export.json",
            ...secHeaders()
          }
        });
      }

      // Import
      if (req.method === "POST" && p === "/admin/api/kv/import") {
        const body = await readJson(req); if (!body) return badCT();
        const { values } = body || {};
        if (!values || typeof values !== "object")
          return J({ ok: false, error: "values_object_required" }, 400);
        // Nur nicht-null/undefined – leere Strings werden geschrieben (bewusst)
        await Promise.all(
          Object.entries(values).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? "")))
        );
        return J({ ok: true, written: Object.keys(values).length });
      }

      // PRESET: INPI (alle relevanten Keys in einem Rutsch)
      if (req.method === "POST" && p === "/admin/api/preset/inpi") {
        const over = (await readJson(req)) || {};
        const entries = buildInpiPreset(over);
        await Promise.all(Object.entries(entries).map(([k, v]) => env.CONFIG.put(k, v)));
        return J({ ok: true, written: Object.keys(entries).length, entries });
      }

      // Not found
      return new Response("Not found", { status: 404, headers: secHeaders() });
    }

    // Fallback
    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* ---------------- helpers ---------------- */

function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  const U = env.ADMIN_USER || "888888";
  const P = env.ADMIN_PASS || "888888";
  return u === U && p === P;
}

function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}

async function listAll(KV, { prefix = "", cap = 10000 } = {}) {
  const out = [];
  let cursor;
  while (out.length < cap) {
    const r = await KV.list({ prefix, cursor });
    (r.keys || []).forEach(k => out.push(k.name));
    if (!r.list_complete && r.cursor) cursor = r.cursor; else break;
  }
  return out;
}

async function readJson(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}

function badCT() {
  return new Response("Bad Content-Type", { status: 415, headers: secHeaders() });
}

function J(x, status = 200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...secHeaders() }
  });
}

function secHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
      "connect-src 'self' https://api.mainnet-beta.solana.com https://rpc.helius.xyz https://inpinity.online; " +
      "img-src 'self' data: https://api.qrserver.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "frame-ancestors 'none'; base-uri 'none'",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization, content-type"
  };
}

/* ---- INPI Preset (echte Defaults, alles Strings) ---- */
function buildInpiPreset(over = {}) {
  const def = {
    // Core
    INPI_MINT:               "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
    creator_pubkey:          "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
    public_rpc_url:          "https://api.mainnet-beta.solana.com",

    // Phasen / TGE
    presale_state:           "pre",            // pre | public | closed
    tge_ts:                  "1764003600",

    // Preise
    presale_price_usdc:      "0.00031415",
    public_mint_price_usdc:  "0.00031415",
    public_price_usdc:       "0.00031415",

    // Deposit + Limits
    presale_deposit_usdc:    "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
    presale_min_usdc:        "5",
    presale_max_usdc:        "25000",
    cap_per_wallet_usdc:     "1000",

    // NFT-Gate
    nft_gate_enabled:        "true",
    gate_discount_bps:       "1000",
    gate_collection:         "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",
    gate_mint:               "",

    // Early Claim
    early_claim_enabled:     "true",
    early_flat_usdc:         "1",
    early_fee_usdc_ata:      "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",

    // Airdrop/Tokenomics
    airdrop_bonus_bps:       "600",
    supply_total:            "3141592653",
    dist_presale_bps:        "1000",
    dist_dex_liquidity_bps:  "2000",
    dist_staking_bps:        "700",
    dist_ecosystem_bps:      "2000",
    dist_treasury_bps:       "1500",
    dist_team_bps:           "1000",
    dist_airdrop_nft_bps:    "1000",
    dist_buyback_reserve_bps:"800",

    // API base (Frontend-Fallback)
    api_base:                "https://inpinity.online/api/token"
  };
  for (const [k, v] of Object.entries(over || {})) {
    if (v === undefined || v === null) continue;
    def[k] = String(v);
  }
  return def;
}

/* ---- Mapping für Frontend (/public/app-cfg) ---- */
async function toAppCfg(env) {
  const get = (k) => env.CONFIG.get(k);

  const [
    RPC, INPI_MINT, CREATOR, DEPOSIT_ATA, PRICE,
    DISC, COLL, EARLY_FEE, EARLY_FLAT, API_BASE,
    P_MIN, P_MAX, TGE, BONUS,
    SUPPLY,
    D_PRESALE, D_LP, D_STAKE, D_ECO, D_TREAS, D_TEAM, D_AIRDROP, D_BUYBACK
  ] = await Promise.all([
    get("public_rpc_url"),
    get("INPI_MINT"),
    get("creator_pubkey"),
    get("presale_deposit_usdc"),
    get("presale_price_usdc"),
    get("gate_discount_bps"),
    get("gate_collection"),
    get("early_fee_usdc_ata"),
    get("early_flat_usdc"),
    get("api_base"),
    get("presale_min_usdc"),
    get("presale_max_usdc"),
    get("tge_ts"),
    get("airdrop_bonus_bps"),
    get("supply_total"),
    get("dist_presale_bps"),
    get("dist_dex_liquidity_bps"),
    get("dist_staking_bps"),
    get("dist_ecosystem_bps"),
    get("dist_treasury_bps"),
    get("dist_team_bps"),
    get("dist_airdrop_nft_bps"),
    get("dist_buyback_reserve_bps")
  ]);

  return {
    CLUSTER: "mainnet-beta",
    RPC: RPC || "https://api.mainnet-beta.solana.com",

    CREATOR_WALLET: CREATOR || "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",

    INPI_MINT: INPI_MINT || "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
    INPI_DECIMALS: 9,

    USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDC_DECIMALS: 6,

    CREATOR_USDC_ATA: DEPOSIT_ATA || "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",

    PRICE_USDC_PER_INPI: Number(PRICE || "0.00031415"),
    DISCOUNT_BPS: Number(DISC || "1000"),
    COLLECTION_MINT: COLL || "",

    EARLY_CLAIM_FEE_USDC: Number(EARLY_FLAT || "1"),
    API_BASE: API_BASE || "https://inpinity.online/api/token",

    // optional für UI
    PRESALE_MIN_USDC: numOrNull(P_MIN),
    PRESALE_MAX_USDC: numOrNull(P_MAX),
    TGE_TS: numOrNull(TGE),
    AIRDROP_BONUS_BPS: numOrNull(BONUS),

    SUPPLY_TOTAL: numOrNull(SUPPLY),
    DISTR_BPS: {
      dist_presale_bps:        numOrNull(D_PRESALE),
      dist_dex_liquidity_bps:  numOrNull(D_LP),
      dist_staking_bps:        numOrNull(D_STAKE),
      dist_ecosystem_bps:      numOrNull(D_ECO),
      dist_treasury_bps:       numOrNull(D_TREAS),
      dist_team_bps:           numOrNull(D_TEAM),
      dist_airdrop_nft_bps:    numOrNull(D_AIRDROP),
      dist_buyback_reserve_bps:numOrNull(D_BUYBACK)
    }
  };
}
function numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- UI (Single File) ---------------- */
function ui() {
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>INPI Admin – KV</title>
<style>
:root{ --bg:#0b0f16; --elev:#111826; --line:#223048; --txt:#eaf1fb; --mut:#9fb0c3; --pri:#66a3ff; --ok:#2ecc71; --err:#ff5d73; --rad:12px; --sh:0 10px 30px rgba(0,0,0,.25); }
*{ box-sizing: border-box; }
body{ margin:0; background:var(--bg); color:var(--txt); font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto; }
header{ position:sticky; top:0; background:var(--elev); border-bottom:1px solid var(--line); padding:10px 14px; display:flex; gap:10px; align-items:center; z-index:10; }
h1{ font-size:18px; margin:0; }
main{ max-width:1100px; margin:0 auto; padding:18px 14px 80px; }
.card{ background:var(--elev); border:1px solid var(--line); border-radius:var(--rad); box-shadow:var(--sh); padding:14px; margin:16px 0; }
label{ color:var(--mut); display:block; margin:6px 0 4px; font-size:13px; }
input, textarea, select{ width:100%; padding:10px 12px; background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:10px; outline:none; }
textarea{ min-height:90px; font-family:ui-monospace, Menlo, Consolas, monospace; }
button{ cursor:pointer; border:0; background:var(--pri); color:#fff; padding:8px 12px; border-radius:10px; font-weight:600; }
button.secondary{ background:transparent; border:1px solid var(--line); color:var(--txt); }
.kbd{ font:12px ui-monospace, Menlo, monospace; padding:2px 6px; border:1px solid var(--line); border-radius:6px; background:#0a1422; }
table{ width:100%; border-collapse:collapse; }
th,td{ padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th{ text-align:left; color:var(--mut); }
code{ background:#0a1a33; border:1px solid var(--line); padding:2px 6px; border-radius:8px; }
.row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.mut{ color:var(--mut); }
small.mut{ color:var(--mut); }
</style>
</head>
<body>
<header>
  <h1>INPI Admin – KV</h1>
  <div class="row" style="margin-left:auto">
    <button id="btnReload" class="secondary">Neu laden</button>
    <button id="btnExport" class="secondary">Export</button>
    <a class="secondary" id="btnAppCfg" href="/public/app-cfg" target="_blank" style="text-decoration:none"><button class="secondary">/public/app-cfg</button></a>
  </div>
</header>

<main>
  <section class="card">
    <h2 style="margin:0 0 8px">Quick Preset (INPI)</h2>
    <div class="row">
      <div style="flex:1 1 260px"><label>Public RPC URL</label><input id="rpc" placeholder="https://api.mainnet-beta.solana.com"></div>
      <div style="flex:1 1 260px"><label>INPI Mint</label><input id="inpi" placeholder="GBfE..."></div>
      <div style="flex:1 1 260px"><label>USDC Deposit ATA</label><input id="depo" placeholder="8PEk..."></div>
      <div style="flex:1 1 220px"><label>Presale Preis (USDC/INPI)</label><input id="price" type="number" step="0.000001" placeholder="0.00031415"></div>
      <div style="flex:1 1 160px"><label>Rabatt (bps)</label><input id="disc" type="number" step="1" placeholder="1000"></div>
      <div style="flex:1 1 260px"><label>Gate Collection</label><input id="gatecoll" placeholder="6xvwKX..."></div>
      <div style="flex:1 1 140px"><label>Early Fee (USDC)</label><input id="feeflat" type="number" step="0.01" placeholder="1"></div>
      <div style="flex:1 1 260px"><label>Early Fee USDC-ATA</label><input id="feeata" placeholder="8PEk..."></div>
      <div style="flex:1 1 160px"><label>Phase</label>
        <select id="phase">
          <option value="pre">pre</option>
          <option value="public">public</option>
          <option value="closed">closed</option>
        </select>
      </div>
      <div style="flex:1 1 220px"><label>TGE (unix s)</label><input id="tge" type="number" placeholder="1764003600"></div>
      <div style="flex:1 1 220px"><label>Cap / Wallet (USDC)</label><input id="cap" type="number" step="1" placeholder="1000"></div>
      <div style="flex:1 1 220px"><label>Min USDC</label><input id="minu" type="number" step="0.01" placeholder="5"></div>
      <div style="flex:1 1 220px"><label>Max USDC</label><input id="maxu" type="number" step="1" placeholder="25000"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button id="btnPreset">Preset speichern</button>
      <button id="btnDefaults" class="secondary">INPI Defaults (voll)</button>
      <small class="mut">Schreibt die Felder (oder Defaults) nach <code>CONFIG</code>.</small>
    </div>
  </section>

  <section class="card">
    <h2 style="margin:0 0 8px">Alle Keys</h2>
    <div class="row" style="margin-bottom:8px">
      <input id="quickKey" placeholder="key" style="max-width:260px">
      <input id="quickVal" placeholder="value (string)" style="min-width:320px">
      <button id="btnSet">Set</button>
      <button id="btnDelete" class="secondary">Delete</button>
      <label style="margin-left:auto">Suche</label>
      <input id="search" placeholder="Filter…" style="max-width:240px">
    </div>
    <table id="tbl"><thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktionen</th></tr></thead><tbody></tbody></table>
  </section>

  <section class="card">
    <h2 style="margin:0 0 8px">Import / Export</h2>
    <div class="row">
      <textarea id="importBox" placeholder='{"values":{"presale_state":"pre","presale_deposit_usdc":"..."}}'></textarea>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="btnImport">Import JSON → CONFIG</button>
      <small class="mut">POST /admin/api/kv/import</small>
    </div>
  </section>
</main>

<script>
const TBL = document.querySelector('#tbl tbody');
const txtSearch = document.getElementById('search');
const inpKey = document.getElementById('quickKey');
const inpVal = document.getElementById('quickVal');

async function GET(p){ const r=await fetch(p,{headers:{accept:'application/json'}}); return await r.json().catch(()=>({})); }
async function POST(p,b){ const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'}, body:JSON.stringify(b||{})}); return await r.json().catch(()=>({})); }

async function loadAll(){
  const r = await GET('/admin/api/kv/keys');
  if (!r?.ok) return alert('Fehler: keys');
  const vals = {};
  for (const k of r.keys||[]){
    const g = await GET('/admin/api/kv/get?key='+encodeURIComponent(k));
    vals[k] = g?.value ?? '';
  }
  render(vals);
}
function render(values){
  const q=(txtSearch.value||'').toLowerCase();
  const rows=Object.keys(values).sort().filter(k=>!q || k.toLowerCase().includes(q));
  TBL.innerHTML='';
  for (const k of rows){
    const tr=document.createElement('tr');
    tr.innerHTML = \`
      <td><code>\${k}</code></td>
      <td><textarea data-k="\${k}" style="min-height:60px">\${values[k] ?? ''}</textarea></td>
      <td>
        <button data-act="save" data-k="\${k}">Save</button>
        <button class="secondary" data-act="del" data-k="\${k}">Del</button>
      </td>\`;
    TBL.appendChild(tr);
  }
}

document.getElementById('btnReload').onclick = loadAll;
document.getElementById('btnExport').onclick = ()=>{ window.location.href='/admin/api/kv/export'; };
document.getElementById('btnSet').onclick = async ()=>{
  const key=(inpKey.value||'').trim(); const value=(inpVal.value||'');
  if(!key) return alert('Key fehlt');
  const j = await POST('/admin/api/kv/put', {key,value});
  if(!j?.ok) return alert('Fehler: put');
  await loadAll();
};
document.getElementById('btnDelete').onclick = async ()=>{
  const key=(inpKey.value||'').trim(); if(!key) return alert('Key fehlt');
  if(!confirm('Delete '+key+'?')) return;
  const j = await POST('/admin/api/kv/delete', {key});
  if(!j?.ok) return alert('Fehler: delete');
  await loadAll();
};
txtSearch.oninput = ()=>render(window.__lastVals||{});
TBL.addEventListener('click', async (ev)=>{
  const btn=ev.target.closest('button'); if(!btn) return;
  const k=btn.getAttribute('data-k'); const act=btn.getAttribute('data-act');
  if (act==='save'){
    const ta=TBL.querySelector('textarea[data-k="'+k+'"]');
    const j = await POST('/admin/api/kv/put', {key:k, value:ta.value});
    if(!j?.ok) return alert('Fehler beim Speichern');
    ta.style.outline='2px solid #2ecc71'; setTimeout(()=>ta.style.outline='', 600);
  } else if (act==='del'){
    if(!confirm('Delete '+k+'?')) return;
    const j = await POST('/admin/api/kv/delete', {key:k});
    if(!j?.ok) return alert('Fehler beim Löschen');
    await loadAll();
  }
});

document.getElementById('btnImport').onclick = async ()=>{
  let txt=document.getElementById('importBox').value||'';
  if(!txt.trim()) return alert('Bitte JSON einfügen.');
  try{
    const j = JSON.parse(txt);
    if (!j.values || typeof j.values!=='object') return alert('Erwarte {"values":{...}}');
    const r = await POST('/admin/api/kv/import', j);
    if(!r?.ok) return alert('Import fehlgeschlagen');
    alert('✔ Import ok: '+r.written+' Keys'); await loadAll();
  }catch(e){ alert('Ungültiges JSON'); }
};

document.getElementById('btnDefaults').onclick = async ()=>{
  const r = await POST('/admin/api/preset/inpi', {});
  if(!r?.ok) return alert('Preset fehlgeschlagen');
  alert('✔ Defaults geschrieben: '+r.written); await loadAll();
};

document.getElementById('btnPreset').onclick = async ()=>{
  const pick=(id)=>{ const el=document.getElementById(id); const v=(el?.value||'').trim(); return v? v : null; };
  const entries = {};
  const rpc=pick('rpc'); if(rpc) entries.public_rpc_url=rpc;
  const inpi=pick('inpi'); if(inpi) entries.INPI_MINT=inpi;
  const depo=pick('depo'); if(depo) entries.presale_deposit_usdc=depo;
  const price=pick('price'); if(price) entries.presale_price_usdc=price;
  const disc=pick('disc'); if(disc) entries.gate_discount_bps=disc;
  const coll=pick('gatecoll'); if(coll){ entries.nft_gate_enabled='true'; entries.gate_collection=coll; }
  const feeflat=pick('feeflat'); if(feeflat) entries.early_flat_usdc=feeflat;
  const feeata=pick('feeata'); if(feeata) entries.early_fee_usdc_ata=feeata;
  const phase=(document.getElementById('phase').value||'').trim(); if(phase) entries.presale_state=phase;
  const tge=pick('tge'); if(tge) entries.tge_ts=tge;
  const cap=pick('cap'); if(cap) entries.cap_per_wallet_usdc=cap;
  const minu=pick('minu'); if(minu) entries.presale_min_usdc=minu;
  const maxu=pick('maxu'); if(maxu) entries.presale_max_usdc=maxu;

  if(Object.keys(entries).length===0) return alert('Keine Felder ausgefüllt.');
  const r = await POST('/admin/api/kv/setmany', { entries });
  if(!r?.ok) return alert('Preset speichern fehlgeschlagen');
  alert('✔ Preset gespeichert'); await loadAll();
};

(async function boot(){
  await loadAll();
})();
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() } });
}