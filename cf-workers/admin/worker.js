// admin/worker.js
// INPI Admin – minimal, fokus auf CONFIG + UI + Presets

export default {
  async fetch(req, env) {
    // Auth + optional IP-Whitelist
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "INPI Admin"}"`,
          ...secHeaders()
        }
      });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: secHeaders() });

    // ---- UI ----
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) {
      return ui(); // unten
    }

    // ---- CONFIG: list keys ----
    if (req.method === "GET" && p === "/admin/config/keys") {
      const keys = await listAll(env.CONFIG);
      return J({ ok: true, keys });
    }

    // ---- CONFIG: get all or single ----
    if (req.method === "GET" && p === "/admin/config") {
      const qKey = url.searchParams.get("key");
      if (qKey) {
        const v = await env.CONFIG.get(qKey);
        return J({ ok: true, key: qKey, value: v ?? null });
      }
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return J({ ok: true, keys, values });
    }

    // ---- CONFIG: set one ----
    if (req.method === "POST" && p === "/admin/config/set") {
      const body = await readJson(req); if (!body) return badCT();
      const { key, value } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      return J({ ok: true });
    }

    // ---- CONFIG: set many ----
    if (req.method === "POST" && p === "/admin/config/setmany") {
      const body = await readJson(req); if (!body) return badCT();
      const { entries } = body;
      if (!entries || typeof entries !== "object")
        return J({ ok: false, error: "entries_object_required" }, 400);
      await Promise.all(Object.entries(entries).map(([k, v]) =>
        env.CONFIG.put(String(k), String(v ?? ""))
      ));
      return J({ ok: true, written: Object.keys(entries).length });
    }

    // ---- CONFIG: delete one ----
    if (req.method === "POST" && p === "/admin/config/delete") {
      const body = await readJson(req); if (!body) return badCT();
      const { key } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.delete(String(key));
      return J({ ok: true, deleted: key });
    }

    // ---- CONFIG: export/import ----
    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), values }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...secHeaders()
        }
      });
    }
    if (req.method === "POST" && p === "/admin/config/import") {
      const body = await readJson(req); if (!body) return badCT();
      const { values } = body;
      if (!values || typeof values !== "object")
        return J({ ok: false, error: "values_object_required" }, 400);
      await Promise.all(Object.entries(values).map(([k, v]) =>
        env.CONFIG.put(String(k), String(v ?? ""))
      ));
      return J({ ok: true, written: Object.keys(values).length });
    }

    // ---- PRESET: INPI Defaults in einem Rutsch ----
    if (req.method === "POST" && p === "/admin/preset/inpi") {
      // Body kann einzelne Felder überschreiben; sonst verwenden wir unsere Defaults
      const body = await readJson(req) || {};
      const entries = buildInpiPreset(body);
      await Promise.all(Object.entries(entries).map(([k, v]) =>
        env.CONFIG.put(String(k), String(v))
      ));
      return J({ ok: true, written: Object.keys(entries).length, entries });
    }

    // ---- PUBLIC MAPPING für app.js (zur Not) ----
    // Liefert eine kompakte Konfig, die dein Frontend 1:1 versteht.
    if (req.method === "GET" && p === "/public/app-cfg") {
      const map = await toAppCfg(env);
      return J(map);
    }

    // Health
    if (req.method === "GET" && p === "/admin/health") {
      return J({ ok: true, now: Date.now() });
    }
    if (req.method === "GET" && p === "/admin/env") {
      return J({ ok: true, env: {
        CONFIG_KEYS: env.CONFIG_KEYS || null,
        IP_ALLOWLIST: env.IP_ALLOWLIST || "",
        ADMIN_REALM: env.ADMIN_REALM || "",
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
async function listAll(KV, { prefix = "", cap = 5000 } = {}) {
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
function badCT() { return new Response("Bad Content-Type", { status: 415, headers: secHeaders() }); }
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
    // UI hat Inline-Script — nur hier erlaubt:
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
      "connect-src 'self' https://api.mainnet-beta.solana.com https://rpc.helius.xyz; " +
      "img-src 'self' data: https://api.qrserver.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "frame-ancestors 'none'; base-uri 'none'"
  };
}

/* ---- INPI Preset (unsere echten Defaults) ---- */
function buildInpiPreset(over = {}) {
  const def = {
    // On-chain / Adressen
    INPI_MINT:               "GBfEVjkSn3KSmRnqe83Kb8c42DsxkJmiDCb4AbNYBYt1",
    creator_pubkey:          "GEFoNLncuhh4nH99GKvVEUxe59SGe74dbLG7UUtfHrCp",
    presale_deposit_usdc:    "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6", // USDC-ATA des Creators

    // Preise & Gate
    presale_price_usdc:      "0.00031415", // 0.00031415 USDC / INPI
    nft_gate_enabled:        "true",
    gate_discount_bps:       "1000",       // 10%
    gate_collection:         "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",

    // Early Claim
    early_claim_enabled:     "true",
    early_flat_usdc:         "1",
    early_fee_usdc_ata:      "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",

    // Sonstiges
    public_rpc_url:          "https://api.mainnet-beta.solana.com",
    presale_state:           "pre",
    airdrop_bonus_bps:       "600",        // 6% (für "nicht early claim")
    cap_per_wallet_usdc:     "",           // leer = kein Cap
    tge_ts:                  ""            // leer = tbd
  };

  // Overrides anwenden (nur Strings!)
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
    DISC, COLL, EARLY_FEE, EARLY_FLAT
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
  ]);

  // Form für app.js (falls wir direkt füttern wollen)
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
    COLLECTION_MINT: COLL || "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",

    EARLY_CLAIM_FEE_USDC: Number(EARLY_FLAT || "1.0"),

    // Optional: wo die API liegt (falls Frontend das braucht)
    API_BASE: "https://inpinity.online/api/token"
  };
}

/* ---------------- Minimal UI ---------------- */
function ui() {
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>INPI Admin – Config</title>
  <style>
    :root{ --bg:#0b0d10; --elev:#12151a; --line:#2a3240; --txt:#e9eef6; --mut:#9fb0c3; --pri:#6aa2ff; --ok:#29cc7a; --err:#ff5d73; --rad:12px; --sh:0 10px 30px rgba(0,0,0,.25); }
    body{ margin:0; background:var(--bg); color:var(--txt); font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto; }
    header{ position:sticky; top:0; background:var(--elev); border-bottom:1px solid var(--line); padding:12px 16px; display:flex; align-items:center; gap:12px; }
    h1{ font-size:18px; margin:0; }
    main{ max-width:1100px; margin:0 auto; padding:20px 16px 80px; }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .card{ background:var(--elev); border:1px solid var(--line); border-radius:var(--rad); box-shadow:var(--sh); padding:14px; margin:16px 0; }
    label{ display:block; color:var(--mut); margin:6px 0 4px; }
    input, textarea, select{ width:100%; padding:10px 12px; background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:10px; outline:none; }
    textarea{ min-height:100px; font-family:ui-monospace, Menlo, Consolas, monospace; }
    table{ width:100%; border-collapse:collapse; }
    th,td{ padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
    th{ text-align:left; color:var(--mut); }
    code{ background:#0a1a33; border:1px solid var(--line); padding:2px 6px; border-radius:8px; }
    small.mut{ color:var(--mut); }
    button{ cursor:pointer; border:0; background:var(--pri); color:white; padding:8px 12px; border-radius:10px; font-weight:600; }
    button.secondary{ background:transparent; border:1px solid var(--line); color:var(--txt); }
    .kbd{ font: 12px ui-monospace, Menlo, monospace; padding:2px 6px; border:1px solid var(--line); border-radius:6px; background:#091320; }
  </style>
</head>
<body>
  <header>
    <h1>INPI Admin – Config</h1>
    <div class="row" style="margin-left:auto">
      <button id="btnReload" class="secondary">Neu laden</button>
      <button id="btnExport" class="secondary">Export</button>
      <a class="secondary" id="btnAppCfg" href="/public/app-cfg" target="_blank" style="text-decoration:none"><button class="secondary">/public/app-cfg</button></a>
    </div>
  </header>

  <main>
    <section class="card">
      <h2 style="margin:0 0 8px">Quick Presale Preset</h2>
      <div class="row" style="gap:12px">
        <div style="flex:1 1 260px">
          <label>Public RPC URL</label>
          <input id="rpc" placeholder="https://api.mainnet-beta.solana.com" />
        </div>
        <div style="flex:1 1 260px">
          <label>INPI Mint</label>
          <input id="inpi" placeholder="GBfE..." />
        </div>
        <div style="flex:1 1 260px">
          <label>Presale USDC-ATA (Deposit)</label>
          <input id="depo" placeholder="8PEk..." />
        </div>
        <div style="flex:1 1 220px">
          <label>Presale Preis (USDC / INPI)</label>
          <input id="price" type="number" step="0.000001" placeholder="0.00031415" />
        </div>
        <div style="flex:1 1 160px">
          <label>Rabatt (bps)</label>
          <input id="disc" type="number" step="1" placeholder="1000" />
        </div>
        <div style="flex:1 1 260px">
          <label>Gate Collection</label>
          <input id="gatecoll" placeholder="6xvw..." />
        </div>
        <div style="flex:1 1 260px">
          <label>Early Fee USDC-ATA</label>
          <input id="feeata" placeholder="8PEk..." />
        </div>
        <div style="flex:1 1 140px">
          <label>Early Fee (USDC)</label>
          <input id="feeflat" type="number" step="0.01" placeholder="1" />
        </div>
        <div style="flex:1 1 160px">
          <label>Phase</label>
          <select id="phase">
            <option value="pre">pre</option>
            <option value="public">public</option>
            <option value="closed">closed</option>
          </select>
        </div>
        <div style="flex:1 1 220px">
          <label>TGE (Unix s)</label>
          <input id="tge" type="number" placeholder="z.B. 1735689600" />
        </div>
        <div style="flex:1 1 220px">
          <label>Cap / Wallet (USDC)</label>
          <input id="cap" type="number" step="0.01" placeholder="" />
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="btnPreset">Preset speichern</button>
        <button id="btnDefaults" class="secondary">INPI Defaults speichern</button>
        <small class="mut">Schreibt die Felder (oder Defaults) in <code>CONFIG</code>.</small>
      </div>
    </section>

    <section class="card">
      <h2 style="margin:0 0 8px">Alle Keys</h2>
      <div class="row" style="margin-bottom:8px">
        <input id="quickKey" placeholder="key" style="max-width:260px" />
        <input id="quickVal" placeholder="value (string)" style="min-width:320px" />
        <button id="btnSet">Set</button>
        <button id="btnDelete" class="secondary">Delete</button>
        <label style="margin-left:auto">Suche</label>
        <input id="search" placeholder="Filter…" style="max-width:240px" />
      </div>
      <table id="tbl"><thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktionen</th></tr></thead><tbody></tbody></table>
    </section>

    <section class="card">
      <h2 style="margin:0 0 8px">Import / Export</h2>
      <div class="row"><textarea id="importBox" placeholder='{"values":{"presale_state":"pre","presale_deposit_usdc":"..."}}'></textarea></div>
      <div class="row" style="margin-top:8px">
        <button id="btnImport">Import JSON → CONFIG</button>
        <small class="mut">POST /admin/config/import</small>
      </div>
    </section>
  </main>

  <script>
  const TBL = document.querySelector('#tbl tbody');
  const txtSearch = document.getElementById('search');
  const inpKey = document.getElementById('quickKey');
  const inpVal = document.getElementById('quickVal');

  async function loadAll(){
    const r = await fetch('/admin/config', { headers:{'accept':'application/json'} });
    const j = await r.json().catch(()=>({}));
    render(j.values || {});
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

  // Events
  document.getElementById('btnReload').onclick = loadAll;
  document.getElementById('btnExport').onclick = () => { window.location.href = '/admin/config/export'; };
  document.getElementById('btnSet').onclick = async () => {
    const key=(inpKey.value||'').trim(); const value=(inpVal.value||'');
    if(!key) return alert('Key fehlt');
    await fetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key, value}) });
    await loadAll();
  };
  document.getElementById('btnDelete').onclick = async () => {
    const key=(inpKey.value||'').trim(); if(!key) return alert('Key fehlt');
    if(!confirm('Delete '+key+'?')) return;
    await fetch('/admin/config/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key}) });
    await loadAll();
  };
  txtSearch.oninput = loadAll;

  TBL.addEventListener('click', async (ev)=>{
    const btn = ev.target.closest('button'); if(!btn) return;
    const k = btn.getAttribute('data-k'); const act = btn.getAttribute('data-act');
    if (act==='save'){
      const ta = TBL.querySelector('textarea[data-k="'+k+'"]');
      await fetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key:k, value: ta.value}) });
      alert('✔ Gespeichert: '+k);
    } else if (act==='del'){
      if(!confirm('Delete '+k+'?')) return;
      await fetch('/admin/config/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key:k}) });
      await loadAll();
    }
  });

  // Preset speichern (aus Feldern)
  document.getElementById('btnPreset').onclick = async () => {
    const pick = (id)=>{ const el=document.getElementById(id); const v=(el.value||'').trim(); return v? v : null; };
    const entries = {};
    const rpc = pick('rpc'); if(rpc) entries.public_rpc_url = rpc;
    const inpi= pick('inpi'); if(inpi) entries.INPI_MINT = inpi;
    const depo= pick('depo'); if(depo) entries.presale_deposit_usdc = depo;
    const price=pick('price');if(price) entries.presale_price_usdc = price;
    const disc =pick('disc'); if(disc) entries.gate_discount_bps = disc;
    const coll =pick('gatecoll'); if(coll){ entries.nft_gate_enabled='true'; entries.gate_collection = coll; }
    const feeata=pick('feeata'); if(feeata) entries.early_fee_usdc_ata = feeata;
    const feeflat=pick('feeflat'); if(feeflat) entries.early_flat_usdc = feeflat;
    const phase=(document.getElementById('phase').value||'').trim(); if(phase) entries.presale_state = phase;
    const tge  =pick('tge'); if(tge) entries.tge_ts = tge;
    const cap  =pick('cap'); if(cap) entries.cap_per_wallet_usdc = cap;

    if (Object.keys(entries).length===0) return alert('Keine Felder ausgefüllt.');
    await fetch('/admin/config/setmany', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ entries }) });
    alert('✔ Preset gespeichert'); await loadAll();
  };

  // INPI Defaults (echte Projektwerte) direkt setzen
  document.getElementById('btnDefaults').onclick = async () => {
    await fetch('/admin/preset/inpi', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({}) });
    alert('✔ INPI Defaults gespeichert'); await loadAll();
  };

  // Inline Save (Cmd/Ctrl+S) in Textareas
  document.addEventListener('keydown', async (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
      const el=document.activeElement;
      if (el && el.tagName==='TEXTAREA' && el.dataset.k){
        e.preventDefault();
        await fetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key:el.dataset.k, value: el.value}) });
        el.style.outline='2px solid #29cc7a'; setTimeout(()=>el.style.outline='', 600);
      }
    }
  });

  loadAll().catch(console.error);
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() } });
}