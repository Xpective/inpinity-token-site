// INPI Admin – Whitelist OFF, alle Keys erlaubt, robuste JSON-API + Mini-UI

export default {
  async fetch(req, env) {
    // Basic + optional IP-Allowlist
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "Admin"}"`,
          ...secHeaders()
        }
      });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    // Mini-UI (Dashboard)
    if (req.method === "GET" && (p === "/admin" || p === "/admin/")) {
      return ui();
    }

    // ---- CONFIG API ----
    if (req.method === "GET" && p === "/admin/config/keys") {
      const keys = await listAll(env.CONFIG);
      return J({ ok: true, allow_all: true, keys });
    }

    if (req.method === "GET" && p === "/admin/config") {
      const qKey = url.searchParams.get("key");
      if (qKey) {
        const v = await env.CONFIG.get(qKey);
        return J({ ok: true, allow_all: true, key: qKey, value: v ?? null });
      }
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return J({ ok: true, allow_all: true, keys, values });
    }

    if (req.method === "POST" && p === "/admin/config/set") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { key, value } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.put(String(key), String(value ?? ""));
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/setmany") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { entries } = body;
      if (!entries || typeof entries !== "object")
        return J({ ok: false, error: "entries_object_required" }, 400);
      await Promise.all(
        Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? "")))
      );
      return J({ ok: true, written: Object.keys(entries).length });
    }

    if (req.method === "POST" && p === "/admin/config/delete") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { key } = body;
      if (!key) return J({ ok: false, error: "key_required" }, 400);
      await env.CONFIG.delete(String(key));
      return J({ ok: true, deleted: key });
    }

    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = await listAll(env.CONFIG);
      const values = {};
      await Promise.all(keys.map(async k => (values[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), allow_all: true, values }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...secHeaders()
        }
      });
    }

    if (req.method === "POST" && p === "/admin/config/import") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") return badCT();
      const { values } = body;
      if (!values || typeof values !== "object")
        return J({ ok: false, error: "values_object_required" }, 400);
      await Promise.all(
        Object.entries(values).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? "")))
      );
      return J({ ok: true, allow_all: true, written: Object.keys(values).length });
    }

    if (req.method === "GET" && p === "/admin/health") {
      return J({ ok: true, now: Date.now(), allow_all: true });
    }

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* ---------- helpers ---------- */
function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}
async function listAll(KV, { prefix = "", cap = 5000 } = {}) {
  const out = [];
  let cursor;
  while (out.length < cap) {
    const r = await KV.list({ prefix, cursor });
    (r.keys || []).forEach(k => out.push(k.name));
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
  // UI nutzt Inline-Script; daher 'unsafe-inline' nur im Admin-Bereich
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "content-security-policy":
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; " +
      "connect-src 'self' https://api.mainnet-beta.solana.com https://rpc.helius.xyz; " +
      "img-src 'self' data: https://api.qrserver.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "frame-ancestors 'none'; base-uri 'none'"
  };
}

/* ---------- Minimal UI ---------- */
function ui() {
  const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>INPI Admin – Config</title>
  <style>
    :root{ --bg:#0b0d10; --elev:#12151a; --line:#2a3240; --txt:#e9eef6; --mut:#9fb0c3; --pri:#6aa2ff; --ok:#29cc7a; --err:#ff5d73; --warn:#ffb84d; --rad:12px; --sh:0 10px 30px rgba(0,0,0,.25); }
    body{ margin:0; background:var(--bg); color:var(--txt); font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell; }
    header{ position:sticky; top:0; background:var(--elev); border-bottom:1px solid var(--line); padding:12px 16px; display:flex; align-items:center; gap:12px; }
    h1{ font-size:18px; margin:0; }
    main{ max-width:1100px; margin:0 auto; padding:20px 16px 80px; }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .card{ background:var(--elev); border:1px solid var(--line); border-radius:var(--rad); box-shadow:var(--sh); padding:14px; margin:16px 0; }
    label{ display:block; color:var(--mut); margin:6px 0 4px; }
    input, textarea, select{ width:100%; padding:10px 12px; background:transparent; color:var(--txt); border:1px solid var(--line); border-radius:10px; outline:none; }
    textarea{ min-height:100px; font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, monospace; }
    table{ width:100%; border-collapse:collapse; }
    th,td{ padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
    th{ text-align:left; color:var(--mut); }
    code{ background:#0a1a33; border:1px solid var(--line); padding:2px 6px; border-radius:8px; }
    small.mut{ color:var(--mut); }
    button{ cursor:pointer; border:0; background:var(--pri); color:white; padding:8px 12px; border-radius:10px; font-weight:600; }
    button.secondary{ background:transparent; border:1px solid var(--line); color:var(--txt); }
    .ok{ color:var(--ok); } .err{ color:var(--err); } .warn{ color:var(--warn); }
    .grid{ display:grid; grid-template-columns: repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
    .kbd{ font: 12px ui-monospace,SFMono-Regular,Menlo,Monaco,monospace; padding:2px 6px; border:1px solid var(--line); border-radius:6px; background:#091320; }
  </style>
</head>
<body>
  <header>
    <h1>INPI Admin – Config</h1>
    <div class="row" style="margin-left:auto">
      <button id="btnReload" class="secondary">Neu laden</button>
      <button id="btnExport" class="secondary">Export</button>
    </div>
  </header>

  <main>
    <section class="card">
      <h2 style="margin:0 0 8px">Quick Presale Preset</h2>
      <div class="grid">
        <div>
          <label>Public RPC URL</label>
          <input id="rpc" placeholder="https://api.mainnet-beta.solana.com" />
          <small class="mut">Kann auch Helius sein: https://rpc.helius.xyz/?api-key=…</small>
        </div>
        <div>
          <label>INPI Mint (optional)</label>
          <input id="inpi" placeholder="Token Mint Address" />
        </div>
        <div>
          <label>Presale Deposit USDC (ATA)</label>
          <input id="depo" placeholder="USDC ATA für Presale-Einzahlungen" />
        </div>
        <div>
          <label>Presale Preis (USDC / INPI)</label>
          <input id="price" type="number" step="0.000001" placeholder="z.B. 0.003141" />
        </div>
        <div>
          <label>Gate Rabatt (bps)</label>
          <input id="disc" type="number" step="1" placeholder="1000 = 10%" />
        </div>
        <div>
          <label>Gate Mint (NFT, optional)</label>
          <input id="gatemint" placeholder="NFT Mint für Gatecheck" />
        </div>
        <div>
          <label>Early Fee USDC ATA (optional)</label>
          <input id="feeata" placeholder="USDC ATA für 1 USDC Fee (sonst Deposit ATA)" />
        </div>
        <div>
          <label>Early Fee (USDC)</label>
          <input id="feeflat" type="number" step="0.01" placeholder="1" />
        </div>
        <div>
          <label>Bonus (bps)</label>
          <input id="bonus" type="number" step="1" placeholder="600 = 6%" />
        </div>
        <div>
          <label>Presale Phase</label>
          <select id="phase">
            <option value="pre">pre</option>
            <option value="public">public</option>
            <option value="closed">closed</option>
          </select>
        </div>
        <div>
          <label>TGE (Unix Sekunden)</label>
          <input id="tge" type="number" placeholder="z.B. 1735689600" />
        </div>
        <div>
          <label>Cap pro Wallet (USDC, optional)</label>
          <input id="cap" type="number" step="0.01" placeholder="" />
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="btnPreset">Preset speichern</button>
        <small class="mut">Schreibt alle obigen Felder in <code>CONFIG</code> (leer gelassene Felder werden ausgelassen).</small>
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

      <table id="tbl">
        <thead><tr><th style="width:280px">Key</th><th>Value</th><th style="width:120px">Aktionen</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card">
      <h2 style="margin:0 0 8px">Import / Export</h2>
      <div class="row">
        <textarea id="importBox" placeholder='{"values": { "presale_state":"pre", "presale_deposit_usdc":"..." }}'></textarea>
      </div>
      <div class="row" style="margin-top:8px">
        <button id="btnImport">Import JSON → CONFIG</button>
        <small class="mut">Nutzt <span class="kbd">POST /admin/config/import</span></small>
      </div>
    </section>

    <section class="card">
      <h2 style="margin:0 0 8px">API Hinweise</h2>
      <ul style="margin:0 0 0 18px">
        <li><span class="kbd">GET /api/token/status</span> – Frontend Status</li>
        <li><span class="kbd">GET /api/token/wallet/brief?wallet=…</span> – Wallet USDC/INPI + Gate</li>
        <li><span class="kbd">POST /api/token/presale/intent</span> – 2 QR Links (Beitrag + Early Fee)</li>
        <li><span class="kbd">POST /api/token/claim/confirm</span> – 1 USDC Fee prüfen & Claim-Job enqueuen</li>
        <li><span class="kbd">GET /api/token/claim/status?wallet=…</span> – Claim/Bonus-Preview</li>
      </ul>
    </section>
  </main>

  <script>
  const TBL = document.getElementById('tbl').querySelector('tbody');
  const txtSearch = document.getElementById('search');
  const inpKey = document.getElementById('quickKey');
  const inpVal = document.getElementById('quickVal');

  async function loadAll(){
    const r = await fetch('/admin/config', { headers:{'accept':'application/json'} });
    const j = await r.json().catch(()=>({}));
    const values = j.values || {};
    render(values);
  }

  function render(values){
    const q = (txtSearch.value || '').toLowerCase();
    const rows = Object.keys(values).sort().filter(k => !q || k.toLowerCase().includes(q));
    TBL.innerHTML = '';
    for (const k of rows){
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td><code>\${k}</code></td>
        <td>
          <textarea data-k="\${k}" style="min-height:60px">\${values[k] ?? ''}</textarea>
        </td>
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
    const key = (inpKey.value||'').trim(); const value = (inpVal.value||'');
    if(!key) return alert('Key fehlt');
    await fetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key, value}) });
    await loadAll();
  };
  document.getElementById('btnDelete').onclick = async () => {
    const key = (inpKey.value||'').trim(); if(!key) return alert('Key fehlt');
    if(!confirm('Delete '+key+'?')) return;
    await fetch('/admin/config/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key}) });
    await loadAll();
  };
  txtSearch.oninput = async () => {
    const r = await fetch('/admin/config', { headers:{'accept':'application/json'} });
    const j = await r.json().catch(()=>({}));
    render(j.values||{});
  };

  TBL.addEventListener('click', async (ev)=>{
    const btn = ev.target.closest('button'); if(!btn) return;
    const k = btn.getAttribute('data-k');
    const act = btn.getAttribute('data-act');
    if (act==='save'){
      const ta = TBL.querySelector('textarea[data-k="'+k+'"]');
      const value = ta.value;
      await fetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key:k, value}) });
      alert('✔ Gespeichert: '+k);
    } else if (act==='del'){
      if(!confirm('Delete '+k+'?')) return;
      await fetch('/admin/config/delete', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key:k}) });
      await loadAll();
    }
  });

  // Quick Preset
  document.getElementById('btnPreset').onclick = async () => {
    const pick = (id)=>{ const el=document.getElementById(id); const v=(el.value||'').trim(); return v? v : null; };
    const entries = {};
    const rpc = pick('rpc'); if(rpc) entries.public_rpc_url = rpc;
    const inpi = pick('inpi'); if(inpi) entries.INPI_MINT = inpi;
    const depo = pick('depo'); if(depo) entries.presale_deposit_usdc = depo;
    const price= pick('price'); if(price) entries.presale_price_usdc = price;
    const disc = pick('disc'); if(disc) entries.gate_discount_bps = disc;
    const gm   = pick('gatemint'); if(gm){ entries.nft_gate_enabled = 'true'; entries.gate_mint = gm; }
    const feeata= pick('feeata'); if(feeata) entries.early_fee_usdc_ata = feeata;
    const feeflat = pick('feeflat'); if(feeflat) entries.early_flat_usdc = feeflat;
    const bonus= pick('bonus'); if(bonus) entries.airdrop_bonus_bps = bonus;
    const phase= (document.getElementById('phase').value||'').trim(); if(phase) entries.presale_state = phase;
    const tge  = pick('tge'); if(tge) entries.tge_ts = tge;
    const cap  = pick('cap'); if(cap) entries.cap_per_wallet_usdc = cap;

    if (Object.keys(entries).length===0) return alert('Keine Felder ausgefüllt.');
    await fetch('/admin/config/setmany', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ entries }) });
    alert('✔ Preset gespeichert');
    await loadAll();
  };

  document.getElementById('btnImport').onclick = async () => {
    const txt = document.getElementById('importBox').value;
    let j; try{ j = JSON.parse(txt); }catch{ return alert('Kein gültiges JSON'); }
    if (!j.values || typeof j.values!=='object') return alert('JSON muss { "values": { ... } } enthalten');
    await fetch('/admin/config/import', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ values: j.values }) });
    alert('✔ Import OK');
    await loadAll();
  };

  // Inline save (Strg/Cmd+S) in Textareas
  document.addEventListener('keydown', async (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s'){
      const el = document.activeElement;
      if (el && el.tagName==='TEXTAREA' && el.dataset.k){
        e.preventDefault();
        await fetch('/admin/config/set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({key:el.dataset.k, value: el.value}) });
        el.style.outline='2px solid #29cc7a'; setTimeout(()=>el.style.outline='', 600);
      }
    }
  });

  // Boot
  loadAll().catch(console.error);
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", ...secHeaders() } });
}