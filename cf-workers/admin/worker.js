// Admin Config Worker (ohne TOTP)
// Bindings: CONFIG (KV)
// Secrets:  ADMIN_USER, ADMIN_PASS
// Vars:     ADMIN_REALM (optional), IP_ALLOWLIST (optional, CSV mit IPs)

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "Admin"}"`,
          ...secHeaders(),
        },
      });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    // UI
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) {
      return ui();
    }

    // API
    if (req.method === "GET" && p === "/admin/config/keys") {
      const keys = await listAll(env.CONFIG);
      return J({ ok: true, keys });
    }

    if (req.method === "GET" && p === "/admin/config") {
      const key = url.searchParams.get("key");
      if (key) {
        const value = await env.CONFIG.get(key);
        return J({ ok: true, key, value: value ?? null });
      }
      const keys = await listAll(env.CONFIG);
      const values: Record<string, string | null> = {};
      await Promise.all(keys.map(async (k) => (values[k] = await env.CONFIG.get(k))));
      return J({ ok: true, keys, values });
    }

    if (req.method === "POST" && p === "/admin/config/set") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { key, value } = body as { key?: string; value?: string };
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/setmany") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { entries } = body as { entries?: Record<string, string> };
      if (!entries || typeof entries !== "object")
        return J({ ok: false, error: "entries_object_required" }, 400);
      await Promise.all(
        Object.entries(entries).map(([k, v]) =>
          env.CONFIG.put(String(k), String(v ?? "")),
        ),
      );
      return J({ ok: true, written: Object.keys(entries).length });
    }

    if (req.method === "POST" && p === "/admin/config/delete") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { key } = body as { key?: string };
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.delete(String(key));
      return J({ ok: true, deleted: key });
    }

    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = await listAll(env.CONFIG);
      const values: Record<string, string | null> = {};
      await Promise.all(keys.map(async (k) => (values[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), values }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...secHeaders(),
        },
      });
    }

    if (req.method === "POST" && p === "/admin/config/import") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { values } = body as { values?: Record<string, string> };
      if (!values || typeof values !== "object")
        return J({ ok: false, error: "values_object_required" }, 400);
      await Promise.all(
        Object.entries(values).map(([k, v]) =>
          env.CONFIG.put(String(k), String(v ?? "")),
        ),
      );
      return J({ ok: true, written: Object.keys(values).length });
    }

    if (req.method === "GET" && p === "/admin/health") {
      return J({ ok: true, now: Date.now() });
    }

    return new Response("Not found", { status: 404, headers: secHeaders() });
  },
};

interface Env {
  CONFIG: KVNamespace;
  ADMIN_USER: string;
  ADMIN_PASS: string;
  ADMIN_REALM?: string;
  IP_ALLOWLIST?: string; // "1.2.3.4, 5.6.7.8"
}

/* ---------- helpers ---------- */
function authOk(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u = "", p = ""] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req: Request, env: Env): boolean {
  const allow = (env.IP_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}

async function listAll(KV: KVNamespace, { prefix = "", cap = 5000 } = {}) {
  const out: string[] = [];
  let cursor: string | undefined;
  while (out.length < cap) {
    const r = await KV.list({ prefix, cursor });
    (r.keys || []).forEach((k) => out.push(k.name));
    if (!r.list_complete && r.cursor) cursor = r.cursor;
    else break;
  }
  return out;
}

async function readJson(req: Request) {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try {
    return await req.json();
  } catch {
    return null;
  }
}
function badCT() {
  return new Response("Bad Content-Type", { status: 415, headers: secHeaders() });
}
function J(x: unknown, status = 200) {
  return new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...secHeaders() },
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
      "script-src 'self' 'unsafe-inline'; " + // kleines Inline-Script im UI
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'",
  };
}

/* ---------- Mini UI ---------- */
function ui() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin – Config</title>
<style>
  body{margin:0;background:#0b0d10;color:#e9eef6;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto}
  header{position:sticky;top:0;background:#12151a;border-bottom:1px solid #2a3240;padding:10px 14px;display:flex;gap:10px;align-items:center}
  h1{font-size:16px;margin:0}
  main{max-width:1100px;margin:0 auto;padding:16px}
  .card{background:#12151a;border:1px solid #2a3240;border-radius:10px;padding:12px;margin:14px 0}
  input,textarea{width:100%;background:transparent;border:1px solid #2a3240;border-radius:8px;color:#e9eef6;padding:8px}
  table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #2a3240;padding:8px 10px}
  button{cursor:pointer;border:0;background:#6aa2ff;color:#fff;border-radius:8px;padding:8px 12px;font-weight:600}
  button.secondary{background:transparent;border:1px solid #2a3240}
  code{background:#0a1a33;border:1px solid #2a3240;padding:2px 6px;border-radius:8px}
</style>
</head>
<body>
<header>
  <h1>Admin – Config</h1>
  <div style="margin-left:auto;display:flex;gap:8px">
    <button id="btnReload" class="secondary">Neu laden</button>
    <button id="btnExport" class="secondary">Export</button>
  </div>
</header>
<main>
<section class="card">
  <h2 style="margin:0 0 8px">Quick Preset</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px">
    <div><label>Public RPC URL</label><input id="rpc" placeholder="https://rpc.helius.xyz/?api-key=..."></div>
    <div><label>INPI Mint</label><input id="inpi" placeholder="GBfE..."></div>
    <div><label>Deposit USDC ATA</label><input id="depo" placeholder="USDC ATA"></div>
    <div><label>Price USDC/INPI</label><input id="price" type="number" step="0.000001"></div>
    <div><label>Gate Discount (bps)</label><input id="disc" type="number" step="1" placeholder="1000"></div>
    <div><label>Gate Mint</label><input id="gatemint" placeholder="NFT mint"></div>
    <div><label>Early Fee ATA</label><input id="feeata" placeholder="USDC ATA"></div>
    <div><label>Early Fee (USDC)</label><input id="feeflat" type="number" step="0.01" placeholder="1"></div>
    <div><label>Bonus (bps)</label><input id="bonus" type="number" step="1" placeholder="600"></div>
    <div><label>Presale State</label>
      <select id="phase"><option>pre</option><option>public</option><option>closed</option></select>
    </div>
    <div><label>TGE (Unix)</label><input id="tge" type="number"></div>
    <div><label>Cap per Wallet (USDC)</label><input id="cap" type="number" step="0.01"></div>
    <div><label>Supply Total</label><input id="supply" type="number"></div>
  </div>
  <div style="margin-top:8px"><button id="btnPreset">Preset speichern</button></div>
</section>

<section class="card">
  <h2 style="margin:0 0 8px">Alle Keys</h2>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
    <input id="quickKey" placeholder="key" style="max-width:260px">
    <input id="quickVal" placeholder="value">
    <button id="btnSet">Set</button>
    <button id="btnDelete" class="secondary">Delete</button>
    <input id="search" placeholder="Filter..." style="margin-left:auto;max-width:260px">
  </div>
  <table id="tbl"><thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktion</th></tr></thead><tbody></tbody></table>
</section>
</main>

<script>
const TBL = document.querySelector('#tbl tbody');
const txtSearch = document.getElementById('search');
const inpKey = document.getElementById('quickKey');
const inpVal = document.getElementById('quickVal');

async function loadAll(){
  const r = await fetch('/admin/config', { headers:{accept:'application/json'} });
  const j = await r.json().catch(()=>({}));
  render(j.values || {});
}
function render(values){
  const q = (txtSearch.value||'').toLowerCase();
  const rows = Object.keys(values).sort().filter(k => !q || k.toLowerCase().includes(q));
  TBL.innerHTML = '';
  for (const k of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td><code>\${k}</code></td>
      <td><textarea data-k="\${k}" style="min-height:60px;width:100%">\${values[k] ?? ''}</textarea></td>
      <td>
        <button data-act="save" data-k="\${k}">Save</button>
        <button class="secondary" data-act="del" data-k="\${k}">Del</button>
      </td>\`;
    TBL.appendChild(tr);
  }
}
document.getElementById('btnReload').onclick = loadAll;
document.getElementById('btnExport').onclick = ()=> location.href='/admin/config/export';

document.getElementById('btnSet').onclick = async ()=>{
  const key=(inpKey.value||'').trim(); const value=(inpVal.value||'');
  if(!key) return alert('Key fehlt');
  await fetch('/admin/config/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,value})});
  await loadAll();
};
document.getElementById('btnDelete').onclick = async ()=>{
  const key=(inpKey.value||'').trim(); if(!key) return alert('Key fehlt');
  if(!confirm('Delete '+key+'?')) return;
  await fetch('/admin/config/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
  await loadAll();
};
txtSearch.oninput = loadAll;

// Preset
document.getElementById('btnPreset').onclick = async ()=>{
  const pick = (id)=>{ const el=document.getElementById(id); const v=(el.value||'').trim(); return v? v : null; };
  const entries = {};
  const rpc=pick('rpc'); if(rpc) entries.public_rpc_url = rpc;
  const inpi=pick('inpi'); if(inpi) entries.INPI_MINT = inpi;
  const depo=pick('depo'); if(depo) entries.presale_deposit_usdc = depo;
  const price=pick('price'); if(price) entries.presale_price_usdc = price;
  const disc=pick('disc'); if(disc) entries.gate_discount_bps = disc;
  const gm=pick('gatemint'); if(gm){ entries.nft_gate_enabled='true'; entries.gate_mint=gm; }
  const feea=pick('feeata'); if(feea) entries.early_fee_usdc_ata = feea;
  const feef=pick('feeflat'); if(feef) entries.early_flat_usdc = feef;
  const bonus=pick('bonus'); if(bonus) entries.airdrop_bonus_bps = bonus;
  const phase=(document.getElementById('phase').value||'').trim(); if(phase) entries.presale_state = phase;
  const tge=pick('tge'); if(tge) entries.tge_ts = tge;
  const cap=pick('cap'); if(cap) entries.cap_per_wallet_usdc = cap;
  const supply=pick('supply'); if(supply) entries.supply_total = supply;
  if(Object.keys(entries).length===0) return alert('Keine Felder ausgefüllt.');
  await fetch('/admin/config/setmany',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entries})});
  alert('✔ Preset gespeichert'); await loadAll();
};

// Inline save via Cmd/Ctrl+S
document.addEventListener('keydown', async (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
    const el=document.activeElement;
    if(el && el.tagName==='TEXTAREA' && el.dataset.k){
      e.preventDefault();
      await fetch('/admin/config/set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:el.dataset.k,value:el.value})});
      el.style.outline='2px solid #29cc7a'; setTimeout(()=>el.style.outline='',600);
    }
  }
});

loadAll().catch(console.error);
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() } });
}