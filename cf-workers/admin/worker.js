// Admin v2 – Minimal, robust, keine Key-Whitelist, neue UI
// Bindings: env.CONFIG  (KV Namespace)
// Secrets:  ADMIN_USER, ADMIN_PASS
// Optional: IP_ALLOWLIST (Komma-getrennt)

export default {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;

      // CORS preflight (nur für JSON-APIs; UI ist same-origin)
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }

      // Auth (Basic + optional IP-Whitelist)
      if (!basicOk(req, env) || !ipOk(req, env)) {
        return unauthorized(env);
      }

      // ---- Static UI (erreichbar unter /admin und /admin2) ----
      if (req.method === "GET" && (p === "/admin" || p === "/admin/" || p === "/admin2" || p === "/admin2/")) {
        return ui();
      }

      // ---- KV APIs (unter /admin/kv/* und /admin2/kv/* identisch) ----
      if (isKV(p, "/admin") || isKV(p, "/admin2")) {
        const sub = p.replace(/^\/admin2/, "/admin"); // normalisieren
        if (req.method === "GET" && sub === "/admin/kv/keys") {
          const prefix = url.searchParams.get("prefix") || "";
          const keys = await listAll(env.CONFIG, { prefix });
          return J({ ok: true, keys });
        }

        if (req.method === "GET" && sub === "/admin/kv/all") {
          const keys = await listAll(env.CONFIG);
          const values = {};
          await Promise.all(keys.map(async (k) => (values[k] = await env.CONFIG.get(k))));
          return J({ ok: true, values });
        }

        if (req.method === "POST" && sub === "/admin/kv/set") {
          const body = await readJson(req);
          if (!body || typeof body.key !== "string") return J({ ok: false, error: "key_required" }, 400);
          await env.CONFIG.put(String(body.key), String(body.value ?? ""));
          return J({ ok: true, written: 1 });
        }

        if (req.method === "POST" && sub === "/admin/kv/setmany") {
          const body = await readJson(req);
          if (!body || typeof body.entries !== "object") return J({ ok: false, error: "entries_object_required" }, 400);
          const entries = body.entries;
          await Promise.all(Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
          return J({ ok: true, written: Object.keys(entries).length });
        }

        if (req.method === "POST" && sub === "/admin/kv/delete") {
          const body = await readJson(req);
          if (!body || typeof body.key !== "string") return J({ ok: false, error: "key_required" }, 400);
          await env.CONFIG.delete(String(body.key));
          return J({ ok: true, deleted: body.key });
        }

        if (req.method === "GET" && sub === "/admin/kv/export") {
          const keys = await listAll(env.CONFIG);
          const values = {};
          await Promise.all(keys.map(async (k) => (values[k] = await env.CONFIG.get(k))));
          return new Response(JSON.stringify({ ts: Date.now(), values }, null, 2), {
            headers: {
              "content-type": "application/json",
              "content-disposition": "attachment; filename=inpi-config-export.json",
              ...secHeaders(),
            },
          });
        }

        if (req.method === "POST" && sub === "/admin/kv/import") {
          const body = await readJson(req);
          // Erlaube zwei Formate: {values:{...}} ODER direkt {...}
          const values = body?.values && typeof body.values === "object" ? body.values : body;
          if (!values || typeof values !== "object") return J({ ok: false, error: "values_object_required" }, 400);
          await Promise.all(Object.entries(values).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
          return J({ ok: true, written: Object.keys(values).length });
        }
      }

      // ---- Debug: Admin-Umgebung ----
      if (req.method === "GET" && p === "/admin/env") {
        return J({
          ok: true,
          env: {
            BINDING: "CONFIG",
            ADMIN_REALM: env.ADMIN_REALM || "INPI Admin",
            IP_ALLOWLIST: env.IP_ALLOWLIST || "",
            has_ADMIN_USER: !!env.ADMIN_USER,
            has_ADMIN_PASS: !!env.ADMIN_PASS,
          },
        });
      }

      // ---- Mapping für /public/app-cfg (Frontend expects this) ----
      if (req.method === "GET" && p === "/public/app-cfg") {
        const map = await toAppCfg(env.CONFIG);
        return J(map);
      }

      // Fallback 404
      return new Response("Not found", { status: 404, headers: secHeaders() });
    } catch (e) {
      return J({ ok: false, error: String(e?.message || e) }, 500);
    }
  },
};

/* ---------------- helpers ---------------- */

function isKV(pathname, base) {
  return (
    pathname === `${base}/kv/keys` ||
    pathname === `${base}/kv/all` ||
    pathname === `${base}/kv/set` ||
    pathname === `${base}/kv/setmany` ||
    pathname === `${base}/kv/delete` ||
    pathname === `${base}/kv/export` ||
    pathname === `${base}/kv/import`
  );
}

function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}

function ipOk(req, env) {
  const list = (env.IP_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return list.includes(ip);
}

function unauthorized(env) {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "INPI Admin"}"`, ...secHeaders() },
  });
}

async function listAll(KV, { prefix = "", cap = 5000 } = {}) {
  const out = [];
  let cursor;
  while (out.length < cap) {
    const r = await KV.list({ prefix, cursor });
    (r.keys || []).forEach((k) => out.push(k.name));
    if (!r.list_complete && r.cursor) cursor = r.cursor;
    else break;
  }
  return out;
}

async function readJson(req) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function J(x, status = 200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...secHeaders(), ...corsHeaders() },
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
      "connect-src 'self' https://inpinity.online https://api.mainnet-beta.solana.com; " +
      "img-src 'self' data: https://api.qrserver.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "frame-ancestors 'none'; base-uri 'none'",
  };
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,accept",
  };
}

/* ---- Mapping für /public/app-cfg ---- */
async function toAppCfg(CONFIG) {
  const get = (k) => CONFIG.get(k);
  const [
    RPC,
    INPI_MINT,
    USDC_MINT,
    CREATOR,
    DEPOSIT_ATA,
    PRICE,
    DISC,
    COLL,
    EARLY_FEE_ATA,
    EARLY_FLAT,
    TGE_TS,
    MIN_USDC,
    MAX_USDC,
    AIRDROP_BPS,
    SUPPLY,
    D_PRES,
    D_LP,
    D_STK,
    D_ECO,
    D_TRE,
    D_TEAM,
    D_ADROP,
    D_BUYB,
    API_BASE,
  ] = await Promise.all([
    get("public_rpc_url"),
    get("INPI_MINT"),
    get("USDC_MINT"),
    get("creator_pubkey"),
    get("presale_deposit_usdc"),
    get("presale_price_usdc"),
    get("gate_discount_bps"),
    get("gate_collection"),
    get("early_fee_usdc_ata"),
    get("early_flat_usdc"),
    get("tge_ts"),
    get("presale_min_usdc"),
    get("presale_max_usdc"),
    get("airdrop_bonus_bps"),
    get("supply_total"),
    get("dist_presale_bps"),
    get("dist_dex_liquidity_bps"),
    get("dist_staking_bps"),
    get("dist_ecosystem_bps"),
    get("dist_treasury_bps"),
    get("dist_team_bps"),
    get("dist_airdrop_nft_bps"),
    get("dist_buyback_reserve_bps"),
    get("api_base"),
  ]);

  const num = (v, d = null) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  return {
    CLUSTER: "mainnet-beta",
    RPC: RPC || "https://api.mainnet-beta.solana.com",
    API_BASE: API_BASE || "https://inpinity.online/api/token",
    INPI_MINT: INPI_MINT || "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
    USDC_MINT: USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    CREATOR_WALLET: CREATOR || "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
    CREATOR_USDC_ATA: DEPOSIT_ATA || "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",
    PRICE_USDC_PER_INPI: num(PRICE, 0.00031415),
    DISCOUNT_BPS: num(DISC, 1000),
    COLLECTION_MINT: COLL || "",
    EARLY_CLAIM_FEE_USDC: num(EARLY_FLAT, 1),
    EARLY_FEE_USDC_ATA: EARLY_FEE_ATA || null,
    TGE_TS: num(TGE_TS, Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90),

    PRESALE_MIN_USDC: num(MIN_USDC, null),
    PRESALE_MAX_USDC: num(MAX_USDC, null),

    AIRDROP_BONUS_BPS: num(AIRDROP_BPS, 600),

    SUPPLY_TOTAL: num(SUPPLY, 3141592653),
    DISTR_BPS: {
      dist_presale_bps: num(D_PRES, 1000),
      dist_dex_liquidity_bps: num(D_LP, 2000),
      dist_staking_bps: num(D_STK, 700),
      dist_ecosystem_bps: num(D_ECO, 2000),
      dist_treasury_bps: num(D_TRE, 1500),
      dist_team_bps: num(D_TEAM, 1000),
      dist_airdrop_nft_bps: num(D_ADROP, 1000),
      dist_buyback_reserve_bps: num(D_BUYB, 800),
    },
  };
}

/* ---- Minimal UI ---- */
function ui() {
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>INPI Admin – KV</title>
  <style>
    :root{ --bg:#0b0d10; --elev:#12151a; --line:#2a3240; --txt:#e9eef6; --mut:#9fb0c3; --pri:#6aa2ff; --ok:#29cc7a; --err:#ff5d73; --rad:12px; }
    body{ margin:0; background:var(--bg); color:var(--txt); font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto; }
    header{ position:sticky; top:0; background:var(--elev); border-bottom:1px solid var(--line); padding:10px 14px; display:flex; gap:10px; align-items:center; z-index:10;}
    main{ max-width:1100px; margin:0 auto; padding:18px; }
    .card{ background:var(--elev); border:1px solid var(--line); border-radius:var(--rad); padding:14px; margin:12px 0; }
    label{ display:block; color:var(--mut); margin:6px 0 4px; }
    input, textarea{ width:100%; padding:10px; background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:10px; outline:none; }
    textarea{ min-height:120px; font-family:ui-monospace,Menlo,Consolas,monospace; }
    button{ cursor:pointer; border:0; background:var(--pri); color:#fff; padding:8px 12px; border-radius:10px; font-weight:600; }
    button.secondary{ background:transparent; border:1px solid var(--line); color:var(--txt); }
    table{ width:100%; border-collapse:collapse; }
    th,td{ padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
    th{ text-align:left; color:var(--mut);}
    code{ background:#0a1a33; border:1px solid var(--line); padding:2px 6px; border-radius:8px; }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  </style>
</head>
<body>
  <header>
    <strong>INPI Admin – KV</strong>
    <div style="margin-left:auto" class="row">
      <button id="btnReload" class="secondary">Neu laden</button>
      <a href="/admin/kv/export"><button class="secondary">Export</button></a>
      <a href="/public/app-cfg" target="_blank"><button class="secondary">/public/app-cfg</button></a>
    </div>
  </header>

  <main>
    <section class="card">
      <h3 style="margin:0 0 8px;">Schnell-Preset</h3>
      <div class="row">
        <div style="flex:1 1 240px"><label>RPC</label><input id="rpc" placeholder="https://api.mainnet-beta.solana.com"/></div>
        <div style="flex:1 1 240px"><label>INPI Mint</label><input id="inpi" placeholder="GBfE..."/></div>
        <div style="flex:1 1 240px"><label>USDC-ATA (Deposit)</label><input id="depo" placeholder="8PEk..."/></div>
        <div style="flex:1 1 160px"><label>Preis (USDC/INPI)</label><input id="price" type="number" step="0.000001" placeholder="0.00031415"/></div>
        <div style="flex:1 1 160px"><label>Cap/Wallet (USDC)</label><input id="cap" type="number" step="1" placeholder="1000"/></div>
      </div>
      <div class="row">
        <div style="flex:1 1 240px"><label>Gate Collection</label><input id="gatecoll" placeholder="6xvwKX..."/></div>
        <div style="flex:1 1 140px"><label>Discount bps</label><input id="disc" type="number" step="1" placeholder="1000"/></div>
        <div style="flex:1 1 140px"><label>Phase</label>
          <select id="phase"><option value="pre">pre</option><option value="public">public</option><option value="closed">closed</option></select>
        </div>
        <div style="flex:1 1 200px"><label>TGE (unix s)</label><input id="tge" type="number" placeholder="1764003600"/></div>
        <div style="flex:1 1 140px"><label>Min USDC</label><input id="minu" type="number" step="1" placeholder="5"/></div>
        <div style="flex:1 1 140px"><label>Max USDC</label><input id="maxu" type="number" step="1" placeholder="25000"/></div>
      </div>
      <div class="row" style="margin-top:8px">
        <button id="btnPreset">Speichern</button>
        <small style="color:#9fb0c3">Schreibt direkt in KV (CONFIG)</small>
      </div>
    </section>

    <section class="card">
      <h3 style="margin:0 0 8px;">Alle Keys</h3>
      <div class="row" style="margin-bottom:8px">
        <input id="filter" placeholder="Filter (Prefix/Substring)" style="flex:1 0 280px"/>
        <button id="btnReload2" class="secondary">Neu laden</button>
      </div>
      <table id="tbl"><thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktionen</th></tr></thead><tbody></tbody></table>
    </section>

    <section class="card">
      <h3 style="margin:0 0 8px;">Set / Delete</h3>
      <div class="row">
        <input id="kvKey" placeholder="key" style="flex:1 0 260px"/>
        <input id="kvVal" placeholder="value" style="flex:2 0 360px"/>
        <button id="btnSet">Set</button>
        <button id="btnDel" class="secondary">Delete</button>
      </div>
    </section>

    <section class="card">
      <h3 style="margin:0 0 8px;">Import</h3>
      <textarea id="importBox" placeholder='{"values":{"presale_state":"pre","INPI_MINT":"..."}} OR {"presale_state":"pre",...}'></textarea>
      <div class="row" style="margin-top:8px">
        <button id="btnImport">Import JSON</button>
        <small style="color:#9fb0c3">POST /admin/kv/import</small>
      </div>
    </section>
  </main>

<script>
const TBL = document.querySelector('#tbl tbody');
const $ = (s)=>document.querySelector(s);

async function api(path, opt={}){
  const r = await fetch(path, { headers:{'accept':'application/json','content-type':'application/json'}, credentials:'include', ...opt });
  const ct = r.headers.get('content-type')||'';
  if (!ct.includes('application/json')) {
    const t = await r.text();
    throw new Error('Non-JSON response '+r.status+': '+t);
  }
  const j = await r.json();
  if (!r.ok || j?.ok===false) throw new Error(j?.error||('HTTP '+r.status));
  return j;
}

async function loadAll(){
  const j = await api('/admin/kv/all');
  render(j.values||{});
}
function render(values){
  const q = ($('#filter').value||'').toLowerCase();
  const keys = Object.keys(values).sort().filter(k => !q || k.toLowerCase().includes(q));
  TBL.innerHTML='';
  for (const k of keys){
    const tr=document.createElement('tr');
    tr.innerHTML = \`
      <td><code>\${k}</code></td>
      <td><textarea data-k="\${k}" style="min-height:80px">\${values[k]??''}</textarea></td>
      <td>
        <button data-act="save" data-k="\${k}">Save</button>
        <button class="secondary" data-act="del" data-k="\${k}">Del</button>
      </td>\`;
    TBL.appendChild(tr);
  }
}

document.getElementById('btnReload').onclick = loadAll;
document.getElementById('btnReload2').onclick = loadAll;

document.getElementById('btnSet').onclick = async ()=>{
  const key = ($('#kvKey').value||'').trim(); const value = $('#kvVal').value||'';
  if(!key) return alert('Key fehlt');
  await api('/admin/kv/set', { method:'POST', body: JSON.stringify({key,value}) });
  await loadAll();
};
document.getElementById('btnDel').onclick = async ()=>{
  const key = ($('#kvKey').value||'').trim(); if(!key) return alert('Key fehlt');
  if(!confirm('Delete '+key+'?')) return;
  await api('/admin/kv/delete', { method:'POST', body: JSON.stringify({key}) });
  await loadAll();
};

TBL.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest('button'); if(!btn) return;
  const k = btn.getAttribute('data-k'); const act = btn.getAttribute('data-act');
  if (act==='save'){
    const ta = TBL.querySelector('textarea[data-k="'+k+'"]');
    await api('/admin/kv/set', { method:'POST', body: JSON.stringify({key:k,value:ta.value}) });
    alert('✔ Gespeichert: '+k);
  } else if (act==='del'){
    if(!confirm('Delete '+k+'?')) return;
    await api('/admin/kv/delete', { method:'POST', body: JSON.stringify({key:k}) });
    await loadAll();
  }
});

document.getElementById('btnImport').onclick = async ()=>{
  let t = $('#importBox').value.trim(); if(!t) return alert('Box leer');
  try{
    const obj = JSON.parse(t);
    await api('/admin/kv/import', { method:'POST', body: JSON.stringify(obj) });
    alert('✔ Import ok'); await loadAll();
  }catch(e){ alert('Import-Fehler: '+(e?.message||e)); }
};

document.getElementById('btnPreset').onclick = async ()=>{
  const pick = (id)=>{ const el=document.getElementById(id); const v=(el?.value||'').trim(); return v||null; };
  const entries = {};
  const rpc = pick('rpc'); if(rpc) entries.public_rpc_url = rpc;
  const inpi = pick('inpi'); if(inpi) entries.INPI_MINT = inpi;
  const depo = pick('depo'); if(depo) entries.presale_deposit_usdc = depo;
  const price= pick('price'); if(price) entries.presale_price_usdc = price;
  const cap  = pick('cap'); if(cap) entries.cap_per_wallet_usdc = cap;

  const gate = pick('gatecoll'); if(gate){ entries.nft_gate_enabled='true'; entries.gate_collection=gate; }
  const disc = pick('disc'); if(disc) entries.gate_discount_bps = disc;

  const phase = (document.getElementById('phase').value||'').trim(); if(phase) entries.presale_state = phase;
  const tge = pick('tge'); if(tge) entries.tge_ts = tge;

  const minu = pick('minu'); if(minu) entries.presale_min_usdc = minu;
  const maxu = pick('maxu'); if(maxu) entries.presale_max_usdc = maxu;

  if (Object.keys(entries).length===0) return alert('Keine Felder ausgefüllt.');
  await api('/admin/kv/setmany', { method:'POST', body: JSON.stringify({ entries }) });
  alert('✔ Preset gespeichert'); await loadAll();
};

document.addEventListener('keydown', async (e)=>{
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
    const el=document.activeElement;
    if (el && el.tagName==='TEXTAREA' && el.dataset.k){
      e.preventDefault();
      await api('/admin/kv/set',{method:'POST',body:JSON.stringify({key:el.dataset.k,value:el.value})});
      el.style.outline='2px solid #29cc7a'; setTimeout(()=>el.style.outline='',600);
    }
  }
});

loadAll().catch(err=>alert('Load error: '+(err?.message||err)));
</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() } });
}