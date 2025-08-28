// Admin worker – minimal, alles was wir brauchen.
// - Basic Auth auf /admin/*
// - Volles KV-CRUD auf env.CONFIG (keine Whitelist)
// - /public/app-cfg ohne Auth (für Frontend)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Public mapping fürs Frontend:
    if (req.method === "GET" && p === "/public/app-cfg") {
      const map = await toAppCfg(env);
      return J(map);
    }

    // Alles unter /admin* ist geschützt
    if (!p.startsWith("/admin")) {
      return new Response("Not found", { status: 404, headers: baseHeaders() });
    }
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "INPI Admin"}"`,
          ...baseHeaders()
        }
      });
    }

    // UI
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) {
      return ui();
    }

    // KV — list keys
    if (req.method === "GET" && p === "/admin/kv/keys") {
      const prefix = url.searchParams.get("prefix") || "";
      const keys = await listAll(env.CONFIG, { prefix });
      return J({ ok: true, keys });
    }

    // KV — get all (key -> value)
    if (req.method === "GET" && p === "/admin/kv/all") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => { values[k] = await env.CONFIG.get(k); }));
      return J({ ok: true, values });
    }

    // KV — set one
    if (req.method === "POST" && p === "/admin/kv/set") {
      const body = await readJson(req); if (!body) return badCT();
      const { key, value } = body || {};
      if (!key) return J({ ok:false, error:"key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      return J({ ok:true });
    }

    // KV — set many
    if (req.method === "POST" && p === "/admin/kv/setmany") {
      const body = await readJson(req); if (!body) return badCT();
      const { entries } = body || {};
      if (!entries || typeof entries !== "object") return J({ ok:false, error:"entries_object_required" }, 400);
      await Promise.all(Object.entries(entries).map(([k,v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      return J({ ok:true, written: Object.keys(entries).length });
    }

    // KV — delete one
    if (req.method === "POST" && p === "/admin/kv/delete") {
      const body = await readJson(req); if (!body) return badCT();
      const { key } = body || {};
      if (!key) return J({ ok:false, error:"key_required" }, 400);
      await env.CONFIG.delete(String(key));
      return J({ ok:true, deleted:key });
    }

    // KV — export / import
    if (req.method === "GET" && p === "/admin/kv/export") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => { values[k] = await env.CONFIG.get(k); }));
      const payload = JSON.stringify({ ts: Date.now(), values }, null, 2);
      return new Response(payload, {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...baseHeaders()
        }
      });
    }
    if (req.method === "POST" && p === "/admin/kv/import") {
      const body = await readJson(req); if (!body) return badCT();
      const { values } = body || {};
      if (!values || typeof values !== "object") return J({ ok:false, error:"values_object_required" }, 400);
      await Promise.all(Object.entries(values).map(([k,v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      return J({ ok:true, written: Object.keys(values).length });
    }

    // Debug: Mapping anzeigen (auth)
    if (req.method === "GET" && p === "/admin/app-cfg") {
      const map = await toAppCfg(env);
      return J({ ok:true, map });
    }

    return new Response("Not found", { status: 404, headers: baseHeaders() });
  }
}

/* ---------------- helpers ---------------- */
function baseHeaders() {
  return {
    "x-content-type-options":"nosniff",
    "referrer-policy":"strict-origin-when-cross-origin",
    "permissions-policy":"geolocation=(), microphone=(), camera=()",
    "strict-transport-security":"max-age=31536000; includeSubDomains; preload",
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
      "connect-src 'self' https://api.mainnet-beta.solana.com https://rpc.helius.xyz https://mainnet.helius-rpc.com https://inpinity.online; " +
      "img-src 'self' data: https://api.qrserver.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "frame-ancestors 'none'; base-uri 'none'",
    ...corsHeaders()
  };
}
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,accept"
  };
}
function J(x, status=200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: { "content-type":"application/json; charset=utf-8", ...baseHeaders() }
  });
}
function badCT(){ return new Response("Bad Content-Type", { status:415, headers: baseHeaders() }); }
async function readJson(req) {
  const ct = (req.headers.get("content-type")||"").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}
function basicOk(req, env) {
  const h = req.headers.get("authorization")||"";
  if (!h.startsWith("Basic ")) return false;
  const [u,p] = atob(h.slice(6)).split(":");
  return (u===env.ADMIN_USER && p===env.ADMIN_PASS);
}
function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST||"").split(",").map(s=>s.trim()).filter(Boolean);
  if (!allow.length) return true;
  const ip = req.headers.get("cf-connecting-ip")||"";
  return allow.includes(ip);
}
async function listAll(KV, { prefix="", cap=5000 } = {}) {
  const out=[]; let cursor;
  while(out.length<cap){
    const r = await KV.list({ prefix, cursor });
    (r.keys||[]).forEach(k => out.push(k.name));
    if (!r.list_complete && r.cursor) cursor=r.cursor; else break;
  }
  return out;
}

/* ---- Mapping für Frontend (/public/app-cfg) ---- */
async function toAppCfg(env){
  const get = (k)=> env.CONFIG.get(k);
  const [
    RPC, INPI, CREATOR, DEPO, PRICE, DISC, COLL, EARLY_FEE, EARLY_FLAT, API_BASE
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
    get("api_base")
  ]);

  return {
    CLUSTER: "mainnet-beta",
    RPC: RPC || "https://api.mainnet-beta.solana.com",
    CREATOR_WALLET: CREATOR || "",
    INPI_MINT: INPI || "",
    INPI_DECIMALS: 9,
    USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDC_DECIMALS: 6,
    CREATOR_USDC_ATA: DEPO || "",
    PRICE_USDC_PER_INPI: Number(PRICE || "0"),
    DISCOUNT_BPS: Number(DISC || "0"),
    COLLECTION_MINT: COLL || "",
    EARLY_CLAIM_FEE_USDC: Number(EARLY_FLAT || "1"),
    API_BASE: API_BASE || "https://inpinity.online/api/token"
  };
}

/* ---- Minimal UI ---- */
function ui(){
  const html = `<!doctype html><html lang="de"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>INPI Admin – KV</title>
<style>
  body{margin:0;background:#0b0d10;color:#e9eef6;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto}
  header{position:sticky;top:0;background:#12151a;border-bottom:1px solid #273042;padding:10px 14px;display:flex;gap:10px;align-items:center}
  h1{font-size:16px;margin:0}
  main{max-width:1100px;margin:0 auto;padding:14px}
  .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .card{background:#12151a;border:1px solid #273042;border-radius:12px;padding:12px;margin:12px 0}
  input,textarea{width:100%;padding:10px 12px;background:transparent;color:#e9eef6;border:1px solid #273042;border-radius:10px;outline:none}
  textarea{min-height:90px;font-family:ui-monospace,Menlo,Consolas,monospace}
  table{width:100%;border-collapse:collapse}
  th,td{padding:8px 10px;border-bottom:1px solid #1f2836;vertical-align:top}
  button{cursor:pointer;border:0;background:#6aa2ff;color:#fff;padding:8px 12px;border-radius:10px;font-weight:600}
  button.secondary{background:transparent;border:1px solid #273042}
  code{background:#0a1a33;border:1px solid #273042;padding:2px 6px;border-radius:8px}
  .mut{color:#9fb0c3}
</style>
</head><body>
<header>
  <h1>INPI Admin – KV</h1>
  <div class="row" style="margin-left:auto">
    <button id="btnReload" class="secondary">Neu laden</button>
    <a class="secondary" href="/admin/kv/export"><button class="secondary">Export</button></a>
    <a class="secondary" href="/admin/app-cfg" target="_blank"><button class="secondary">/admin/app-cfg</button></a>
    <a class="secondary" href="/public/app-cfg" target="_blank"><button class="secondary">/public/app-cfg</button></a>
  </div>
</header>
<main>
  <section class="card">
    <h2 style="margin:0 0 8px">Quick Preset</h2>
    <div class="row">
      <input id="rpc" placeholder="public_rpc_url"/>
      <input id="inpi" placeholder="INPI_MINT"/>
      <input id="creator" placeholder="creator_pubkey"/>
      <input id="depo" placeholder="presale_deposit_usdc (USDC ATA)"/>
      <input id="price" type="number" step="0.000001" placeholder="presale_price_usdc"/>
      <input id="disc" type="number" step="1" placeholder="gate_discount_bps"/>
      <input id="coll" placeholder="gate_collection (collection mint)"/>
      <input id="tge" type="number" placeholder="tge_ts (unix)"/>
      <input id="cap" type="number" placeholder="cap_per_wallet_usdc"/>
      <input id="minu" type="number" placeholder="presale_min_usdc"/>
      <input id="maxu" type="number" placeholder="presale_max_usdc"/>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="btnPreset">Preset speichern</button>
      <small class="mut">Schreibt direkt in <code>CONFIG</code>.</small>
    </div>
  </section>

  <section class="card">
    <h2 style="margin:0 0 8px">Alle Keys</h2>
    <div class="row" style="margin-bottom:8px">
      <input id="quickKey" placeholder="key" style="max-width:260px"/>
      <input id="quickVal" placeholder="value" style="min-width:320px"/>
      <button id="btnSet">Set</button>
      <button id="btnDelete" class="secondary">Delete</button>
      <input id="search" placeholder="Filter…" style="max-width:240px;margin-left:auto"/>
    </div>
    <table id="tbl"><thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktionen</th></tr></thead><tbody></tbody></table>
  </section>

  <section class="card">
    <h2 style="margin:0 0 8px">Import JSON</h2>
    <textarea id="importBox" placeholder='{"values":{"INPI_MINT":"...","public_rpc_url":"..."}}'></textarea>
    <div class="row" style="margin-top:8px">
      <button id="btnImport">Import → CONFIG</button>
    </div>
  </section>
</main>
<script>
const TBL = document.querySelector('#tbl tbody');
const txtSearch = document.getElementById('search');
const inpKey = document.getElementById('quickKey');
const inpVal = document.getElementById('quickVal');

async function loadAll(){
  const r = await fetch('/admin/kv/all',{headers:{accept:'application/json'}});
  const j = await r.json().catch(()=>({values:{}}));
  render(j.values||{});
}
function render(values){
  const q=(txtSearch.value||'').toLowerCase();
  const rows=Object.keys(values).sort().filter(k=>!q || k.toLowerCase().includes(q));
  TBL.innerHTML='';
  for (const k of rows){
    const tr=document.createElement('tr');
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
document.getElementById('btnSet').onclick = async ()=>{
  const key=(inpKey.value||'').trim(); const value=(inpVal.value||'');
  if(!key) return alert('Key fehlt');
  await fetch('/admin/kv/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})});
  await loadAll();
};
document.getElementById('btnDelete').onclick = async ()=>{
  const key=(inpKey.value||'').trim(); if(!key) return alert('Key fehlt');
  if(!confirm('Delete '+key+'?')) return;
  await fetch('/admin/kv/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
  await loadAll();
};
txtSearch.oninput = loadAll;
TBL.addEventListener('click', async (ev)=>{
  const btn=ev.target.closest('button'); if(!btn) return;
  const k=btn.getAttribute('data-k'); const act=btn.getAttribute('data-act');
  if(act==='save'){
    const ta=TBL.querySelector('textarea[data-k="'+k+'"]');
    await fetch('/admin/kv/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k,value:ta.value})});
    alert('✔ Gespeichert: '+k);
  }else if(act==='del'){
    if(!confirm('Delete '+k+'?')) return;
    await fetch('/admin/kv/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})});
    await loadAll();
  }
});
document.getElementById('btnImport').onclick = async ()=>{
  try{
    const parsed = JSON.parse(document.getElementById('importBox').value||"{}");
    await fetch('/admin/kv/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(parsed)});
    alert('✔ Import ok'); await loadAll();
  }catch(e){ alert('JSON invalid'); }
};
document.getElementById('btnPreset').onclick = async ()=>{
  const pick = (id)=>{const el=document.getElementById(id);const v=(el.value||'').trim();return v? v : null;}
  const entries = {};
  [["rpc","public_rpc_url"],["inpi","INPI_MINT"],["creator","creator_pubkey"],
   ["depo","presale_deposit_usdc"],["price","presale_price_usdc"],["disc","gate_discount_bps"],
   ["coll","gate_collection"],["tge","tge_ts"],["cap","cap_per_wallet_usdc"],
   ["minu","presale_min_usdc"],["maxu","presale_max_usdc"]]
   .forEach(([id,key])=>{const v=pick(id); if(v!=null) entries[key]=v;});
  if(!Object.keys(entries).length) return alert('Keine Felder');
  await fetch('/admin/kv/setmany',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entries})});
  alert('✔ Preset gespeichert'); await loadAll();
};
document.addEventListener('keydown', async (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
    const el=document.activeElement;
    if(el && el.tagName==='TEXTAREA' && el.dataset.k){
      e.preventDefault();
      await fetch('/admin/kv/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:el.dataset.k,value:el.value})});
      el.style.outline='2px solid #29cc7a'; setTimeout(()=>el.style.outline='',600);
    }
  }
});
loadAll().catch(console.error);
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type":"text/html; charset=utf-8", ...baseHeaders() }});
}