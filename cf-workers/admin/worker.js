// admin-lite – cleaner Admin nur für CONFIG-KV, ohne Key-Whitelist
// Endpunkte:
//   UI:               GET  /admin2
//   Keys:             GET  /admin2/kv/keys?prefix=opt
//   Get one:          GET  /admin2/kv/get?key=K
//   Get all:          GET  /admin2/kv/all
//   Set one:          POST /admin2/kv/set           { key, value }
//   Set many:         POST /admin2/kv/setmany       { entries: {k:v,...} }
//   Delete one:       POST /admin2/kv/delete        { key }
//   Export:           GET  /admin2/kv/export        (Download JSON)
//   Import:           POST /admin2/kv/import        { values: {k:v,...} }
//   Public app-cfg:   GET  /admin2/public/app-cfg   (für Frontend-Fallback)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: secHeaders() });
    }

    // Public Mapping (ohne Auth)
    if (req.method === "GET" && p === "/admin2/public/app-cfg") {
      const map = await toPublicAppCfg(env);
      return J(map);
    }

    // alles andere: /admin2/* mit Auth
    if (!p.startsWith("/admin2")) {
      return new Response("Not found", { status: 404, headers: secHeaders() });
    }
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "Admin"}"`, ...secHeaders() }
      });
    }

    // UI
    if (req.method === "GET" && (p === "/admin2" || p === "/admin2/")) {
      return ui();
    }

    // KV – Keys
    if (req.method === "GET" && p === "/admin2/kv/keys") {
      const prefix = url.searchParams.get("prefix") || "";
      const keys = await listAll(env.CONFIG, { prefix });
      return J({ ok: true, keys });
    }

    // KV – all
    if (req.method === "GET" && p === "/admin2/kv/all") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return J({ ok: true, values });
    }

    // KV – get one
    if (req.method === "GET" && p === "/admin2/kv/get") {
      const key = url.searchParams.get("key");
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      const value = await env.CONFIG.get(key);
      return J({ ok: true, key, value: value ?? null });
    }

    // KV – set one
    if (req.method === "POST" && p === "/admin2/kv/set") {
      const body = await readJson(req); if (!body) return badCT();
      const { key, value } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      return J({ ok: true, written: 1 });
    }

    // KV – set many (keine Whitelist!)
    if (req.method === "POST" && p === "/admin2/kv/setmany") {
      const body = await readJson(req); if (!body) return badCT();
      const { entries } = body;
      if (!entries || typeof entries !== "object") {
        return J({ ok: false, error: "entries_object_required" }, 400);
      }
      const ops = Object.entries(entries).map(([k, v]) =>
        env.CONFIG.put(String(k), String(v ?? "")));
      await Promise.all(ops);
      return J({ ok: true, written: Object.keys(entries).length });
    }

    // KV – delete
    if (req.method === "POST" && p === "/admin2/kv/delete") {
      const body = await readJson(req); if (!body) return badCT();
      const { key } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.delete(String(key));
      return J({ ok: true, deleted: key });
    }

    // Export
    if (req.method === "GET" && p === "/admin2/kv/export") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), values }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=config-export.json",
          ...secHeaders()
        }
      });
    }

    // Import
    if (req.method === "POST" && p === "/admin2/kv/import") {
      const body = await readJson(req); if (!body) return badCT();
      const { values } = body;
      if (!values || typeof values !== "object") {
        return J({ ok: false, error: "values_object_required" }, 400);
      }
      const ops = Object.entries(values).map(([k, v]) =>
        env.CONFIG.put(String(k), String(v ?? "")));
      await Promise.all(ops);
      return J({ ok: true, written: Object.keys(values).length });
    }

    // Health / Env
    if (req.method === "GET" && p === "/admin2/health") {
      return J({ ok: true, now: Date.now() });
    }
    if (req.method === "GET" && p === "/admin2/env") {
      return J({ ok: true, env: {
        realm: env.ADMIN_REALM || "",
        ip_allowlist: env.IP_ALLOWLIST || "",
        has_ADMIN_USER: !!env.ADMIN_USER,
        has_ADMIN_PASS: !!env.ADMIN_PASS
      }});
    }

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* ---------------- helpers ---------------- */

function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}
async function listAll(KV, { prefix = "", cap = 20000 } = {}) {
  const out = []; let cursor;
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
function J(x, status = 200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...secHeaders() }
  });
}
function badCT() { return J({ ok:false, error:"Bad Content-Type" }, 415); }
function secHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "content-security-policy":
      "default-src 'self'; connect-src 'self' https://api.mainnet-beta.solana.com https://rpc.helius.xyz https://inpinity.online; img-src 'self' data: https://api.qrserver.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"
  };
}

/* ---- Public App-Cfg Mapping (für dein Frontend) ---- */
async function toPublicAppCfg(env) {
  const get = (k) => env.CONFIG.get(k);
  const [
    RPC, INPI_MINT, USDC_MINT,
    CREATOR, DEPOSIT_ATA, PRICE,
    DISC, COLL,
    EARLY_FLAT, API_BASE,
    MIN_U, MAX_U, TGE, BONUS,
    SUPPLY,
    D_PRESALE, D_LP, D_STAKE, D_ECO, D_TREAS, D_TEAM, D_AIRDROP, D_BUYBACK
  ] = await Promise.all([
    get("public_rpc_url"),
    get("INPI_MINT"),
    get("USDC_MINT"), // optional
    get("creator_pubkey"),
    get("presale_deposit_usdc"),
    get("presale_price_usdc"),
    get("gate_discount_bps"),
    get("gate_collection"),
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

  // Zahlen sauber casten
  const num = (x, d=null) => {
    const n = Number(x); return Number.isFinite(n) ? n : d;
  };

  return {
    RPC: RPC || "https://api.mainnet-beta.solana.com",
    INPI_MINT: INPI_MINT || "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
    USDC_MINT: USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",

    CREATOR_USDC_ATA: DEPOSIT_ATA || "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
    // Optional, falls du sie mal separat pflegst:
    // DEPOSIT_OWNER: await get("deposit_usdc_owner") || null,

    PRICE_USDC_PER_INPI: num(PRICE, 0.00031415),
    DISCOUNT_BPS: num(DISC, 1000),
    COLLECTION_MINT: COLL || "",

    PRESALE_MIN_USDC: num(MIN_U, null),
    PRESALE_MAX_USDC: num(MAX_U, null),

    TGE_TS: num(TGE, Math.floor(Date.now()/1000) + 60*60*24*90),
    AIRDROP_BONUS_BPS: num(BONUS, 600),

    SUPPLY_TOTAL: num(SUPPLY, 3141592653),
    DISTR_BPS: {
      dist_presale_bps:         num(D_PRESALE, 1000),
      dist_dex_liquidity_bps:   num(D_LP, 2000),
      dist_staking_bps:         num(D_STAKE, 700),
      dist_ecosystem_bps:       num(D_ECO, 2000),
      dist_treasury_bps:        num(D_TREAS, 1500),
      dist_team_bps:            num(D_TEAM, 1000),
      dist_airdrop_nft_bps:     num(D_AIRDROP, 1000),
      dist_buyback_reserve_bps: num(D_BUYBACK, 800)
    },

    EARLY_CLAIM_FEE_USDC: num(EARLY_FLAT, 1),
    API_BASE: API_BASE || "https://inpinity.online/api/token"
  };
}

/* ---------------- Minimal UI ---------------- */
function ui() {
  const html = String.raw`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>INPI Admin Lite</title>
<style>
:root{--bg:#0b0d10;--elev:#12151a;--line:#2a3240;--txt:#e9eef6;--mut:#9fb0c3;--pri:#6aa2ff;--ok:#29cc7a;--err:#ff5d73;--rad:12px}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto}
header{position:sticky;top:0;background:var(--elev);border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:10px;align-items:center;z-index:5}
h1{font-size:18px;margin:0} main{max-width:1100px;margin:0 auto;padding:16px}
.card{background:var(--elev);border:1px solid var(--line);border-radius:12px;padding:12px;margin:14px 0}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input,textarea,select{width:100%;background:transparent;color:var(--txt);border:1px solid var(--line);border-radius:10px;padding:8px 10px;outline:none}
textarea{min-height:100px;font-family:ui-monospace,Menlo,Consolas,monospace}
button{cursor:pointer;border:0;background:var(--pri);color:#fff;padding:8px 12px;border-radius:10px;font-weight:600}
button.secondary{background:transparent;border:1px solid var(--line);color:var(--txt)}
table{width:100%;border-collapse:collapse} th,td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top} th{text-align:left;color:var(--mut)}
code{background:#0a1a33;border:1px solid var(--line);padding:2px 6px;border-radius:8px}
.mut{color:var(--mut)}
</style>
</head>
<body>
<header>
  <h1>INPI Admin Lite</h1>
  <div class="row" style="margin-left:auto">
    <button id="btnReload" class="secondary">Neu laden</button>
    <button id="btnExport" class="secondary">Export</button>
    <a href="/admin2/public/app-cfg" target="_blank" class="secondary" style="text-decoration:none"><button class="secondary">/public/app-cfg</button></a>
  </div>
</header>

<main>
  <section class="card">
    <h2 style="margin:0 0 8px">SetMany – Bulk schreiben</h2>
    <p class="mut" style="margin:.2rem 0 .8rem">Beliebige Keys erlaubt. Beispiel ist vorausgefüllt.</p>
    <textarea id="boxMany"></textarea>
    <div class="row" style="margin-top:8px">
      <button id="btnWriteMany">Schreiben</button>
      <small class="mut">POST /admin2/kv/setmany</small>
    </div>
  </section>

  <section class="card">
    <h2 style="margin:0 0 8px">Key/Value</h2>
    <div class="row">
      <input id="k" placeholder="key" style="flex:1 1 280px">
      <input id="v" placeholder="value" style="flex:3 1 420px">
      <button id="btnSet">Set</button>
      <button id="btnDel" class="secondary">Delete</button>
      <input id="search" placeholder="Suche..." style="margin-left:auto;max-width:240px">
    </div>
    <table id="tbl">
      <thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktionen</th></tr></thead>
      <tbody></tbody>
    </table>
  </section>

  <section class="card">
    <h2 style="margin:0 0 8px">Import</h2>
    <textarea id="boxImport" placeholder='{"values":{"presale_state":"pre","presale_deposit_usdc":"..."}}'></textarea>
    <div class="row" style="margin-top:8px">
      <button id="btnImport">Import JSON → CONFIG</button>
      <small class="mut">POST /admin2/kv/import</small>
    </div>
  </section>
</main>

<script>
const TBL=document.querySelector('#tbl tbody');
const S=document.getElementById('search'); const K=document.getElementById('k'); const V=document.getElementById('v');

const DEFAULT_MANY = {
  INPI_MINT: "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
  creator_pubkey: "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
  public_rpc_url: "https://api.mainnet-beta.solana.com",

  presale_state: "pre",
  tge_ts: "1764003600",

  presale_price_usdc: "0.00031415",
  public_mint_price_usdc: "0.00031415",
  public_price_usdc: "0.00031415",

  presale_deposit_usdc: "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
  presale_min_usdc: "5",
  presale_max_usdc: "25000",
  cap_per_wallet_usdc: "1000",

  nft_gate_enabled: "true",
  gate_discount_bps: "1000",
  gate_collection: "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",
  gate_mint: "",

  early_claim_enabled: "true",
  early_flat_usdc: "1",
  early_fee_usdc_ata: "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",

  airdrop_bonus_bps: "600",
  supply_total: "3141592653",
  dist_presale_bps: "1000",
  dist_dex_liquidity_bps: "2000",
  dist_staking_bps: "700",
  dist_ecosystem_bps: "2000",
  dist_treasury_bps: "1500",
  dist_team_bps: "1000",
  dist_airdrop_nft_bps: "1000",
  dist_buyback_reserve_bps: "800",

  api_base: "https://inpinity.online/api/token",
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
};

document.getElementById('boxMany').value = JSON.stringify({ entries: DEFAULT_MANY }, null, 2);

async function loadAll(){
  const r = await fetch('/admin2/kv/all', { headers:{accept:'application/json'} });
  const j = await r.json().catch(()=>({}));
  render(j.values||{});
}
function render(values){
  const q=(S.value||'').toLowerCase();
  const rows=Object.keys(values).sort().filter(k=>!q||k.toLowerCase().includes(q));
  TBL.innerHTML='';
  for (const k of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td><code>\${k}</code></td>
      <td><textarea data-k="\${k}" style="min-height:60px">\${values[k]??''}</textarea></td>
      <td>
        <button data-act="save" data-k="\${k}">Save</button>
        <button class="secondary" data-act="del" data-k="\${k}">Del</button>
      </td>\`;
    TBL.appendChild(tr);
  }
}

document.getElementById('btnReload').onclick = loadAll;
document.getElementById('btnExport').onclick = ()=>{ window.location.href = '/admin2/kv/export'; };

document.getElementById('btnSet').onclick = async ()=>{
  const key=(K.value||'').trim(); if(!key) return alert('Key fehlt');
  const value=V.value||'';
  await fetch('/admin2/kv/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key,value}) });
  await loadAll();
};
document.getElementById('btnDel').onclick = async ()=>{
  const key=(K.value||'').trim(); if(!key) return alert('Key fehlt');
  if(!confirm('Delete '+key+'?')) return;
  await fetch('/admin2/kv/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key}) });
  await loadAll();
};
S.oninput = loadAll;

TBL.addEventListener('click', async (ev)=>{
  const btn=ev.target.closest('button'); if(!btn) return;
  const k=btn.getAttribute('data-k'); const act=btn.getAttribute('data-act');
  if (act==='save'){
    const ta=TBL.querySelector('textarea[data-k="'+k+'"]');
    await fetch('/admin2/kv/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,value:ta.value})});
    alert('✔ Gespeichert: '+k);
  } else if (act==='del'){
    if(!confirm('Delete '+k+'?')) return;
    await fetch('/admin2/kv/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})});
    await loadAll();
  }
});

document.getElementById('btnWriteMany').onclick = async ()=>{
  let payload=null;
  try{ payload = JSON.parse(document.getElementById('boxMany').value); }catch(e){ alert('JSON ungültig'); return; }
  if(!payload || typeof payload !== 'object') return alert('Payload fehlt.');
  await fetch('/admin2/kv/setmany', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  alert('✔ SetMany geschrieben'); await loadAll();
};

document.getElementById('btnImport').onclick = async ()=>{
  let payload=null;
  try{ payload = JSON.parse(document.getElementById('boxImport').value); }catch(e){ alert('JSON ungültig'); return; }
  await fetch('/admin2/kv/import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
  alert('✔ Import OK'); await loadAll();
};

document.addEventListener('keydown', async (e)=>{
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
    const el=document.activeElement;
    if (el && el.tagName==='TEXTAREA' && el.dataset.k){
      e.preventDefault();
      await fetch('/admin2/kv/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:el.dataset.k,value:el.value})});
      el.style.outline='2px solid #29cc7a'; setTimeout(()=>el.style.outline='', 600);
    }
  }
});

loadAll().catch(console.error);
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type":"text/html; charset=utf-8", ...secHeaders() } });
}