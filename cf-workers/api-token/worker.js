// Pfad: cf-workers/api-token/worker.js
// Bindings (wrangler.toml):
// - KV: CONFIG  (Admin schreibt hier)
// - KV: INTENTS (wir speichern Presale-Intents hier)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---- STATUS ----
    if (req.method === "GET" && p === "/api/token/status") {
      const cfg = await readPublicConfig(env);
      // öffentliche Ansicht
      const out = {
        inpi_mint: cfg.INPI_MINT || "",
        presale_state: cfg.presale_state || "pre",
        tge_ts: cfg.tge_ts, // Sekunden
        presale_price_usdc: toNumOrNull(cfg.presale_price_usdc),
        public_price_usdc:  toNumOrNull(cfg.public_price_usdc),
        deposit_usdc_ata: cfg.presale_deposit_usdc || "",
        updated_at: Date.now()
      };
      return J(out, 200, { "cache-control": "no-store" });
    }

    // ---- PRESALE INTENT ----
    if (req.method === "POST" && p === "/api/token/presale/intent") {
      if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
      const body = await req.json().catch(()=> ({}));
      const wallet = String(body.wallet || "").trim();
      const amount = Number(body.amount_usdc || 0);
      const sig_b58 = (body.sig_b58 || "").trim();
      const msg_str = (body.msg_str || "").trim();

      if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
      if (!(amount > 0))      return J({ ok:false, error:"bad_amount" }, 400);

      const cfg = await readPublicConfig(env);
      const depo = cfg.presale_deposit_usdc || "";
      if (!isAddress(depo)) return J({ ok:false, error:"deposit_not_ready" }, 503);

      // einfache Cap-Prüfung (optional – wenn gesetzt)
      const cap = toNumOrNull(cfg.cap_per_wallet_usdc);
      if (cap != null && amount > cap) {
        return J({ ok:false, error:"over_cap", cap_per_wallet_usdc: cap }, 400);
      }

      // Persistieren
      const key = `intent:${Date.now()}:${wallet}`;
      await env.INTENTS.put(key, JSON.stringify({
        wallet, amount_usdc: amount, sig_b58, msg_str, ts: Date.now()
      }), { expirationTtl: 60*60*24*30 });

      const text =
`✅ Intent registriert.
Bitte sende ${amount} USDC an:
${depo}

Sobald die Zahlung erkannt ist, wird deine Zuteilung im System vermerkt. Claim ab TGE möglich.`;
      return new Response(text, { status:200, headers: secTextHeaders() });
    }

    return new Response("Not found", { status: 404, headers: secTextHeaders() });
  }
};

/* ---------------- Helpers ---------------- */
async function readPublicConfig(env) {
  // Nur Keys lesen, die der Admin-Worker pflegt
  const keys = [
    "INPI_MINT",
    "presale_state",
    "tge_ts",
    "presale_price_usdc",
    "public_price_usdc",
    "presale_deposit_usdc",
    "cap_per_wallet_usdc"
  ];
  const out = {};
  await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
  // tge_ts → Sekunden
  if (out.tge_ts != null) {
    let t = Number(out.tge_ts);
    if (t > 1e12) t = Math.floor(t/1000);
    out.tge_ts = (t > 0) ? t : null;
  } else {
    out.tge_ts = null;
  }
  return out;
}

function isAddress(s){ return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || "")); }
function toNumOrNull(x){ if (x==null || x==="") return null; const n = Number(x); return Number.isFinite(n)? n : null; }
async function isJson(req){ return (req.headers.get("content-type")||"").toLowerCase().includes("application/json"); }

function J(obj, status=200, extra={}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control":"no-store", ...secHeaders(), ...extra }
  });
}
function secHeaders(){
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  };
}
function secTextHeaders(){
  return { "content-type":"text/plain; charset=utf-8", "cache-control":"no-store", ...secHeaders() };
}