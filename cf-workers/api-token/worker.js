// INPI Token API
// KV-Bindings (wrangler.toml):
//  - CONFIG       (Admin pflegt öffentlich lesbare Konfig-Werte)
//  - PRESALE      (hier speichern wir Presale-Intents)
//  - INPI_CLAIMS  (für spätere Claim-Daten – derzeit nur vorbereitet)
//
// Vars:
//  - RPC_URL, GATE_MINT, PRESALE_MIN_USDC, PRESALE_MAX_USDC

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // offizieller Solana-USDC

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;

      // ---- STATUS (public) ----
      if (req.method === "GET" && p === "/api/token/status") {
        const cfg = await readPublicConfig(env);
        const rpc_url = await getPublicRpcUrl(env);

        const out = {
          rpc_url,
          usdc_mint: USDC_MINT,

          inpi_mint: cfg.INPI_MINT || "",
          presale_state: cfg.presale_state || "pre",
          tge_ts: cfg.tge_ts, // Sekunden (normalisiert)
          presale_price_usdc: toNumOrNull(cfg.presale_price_usdc),
          public_price_usdc:  toNumOrNull(cfg.public_price_usdc),
          deposit_usdc_ata:   cfg.presale_deposit_usdc || "",
          cap_per_wallet_usdc: toNumOrNull(cfg.cap_per_wallet_usdc),

          // hilfreiche Limits fürs Frontend
          presale_min_usdc: toNumOrNull(env.PRESALE_MIN_USDC),
          presale_max_usdc: toNumOrNull(env.PRESALE_MAX_USDC),

          updated_at: Date.now()
        };
        return J(out);
      }

      // ---- PRESALE INTENT (public; validiert) ----
      if (req.method === "POST" && p === "/api/token/presale/intent") {
        if (!(await isJson(req))) return J({ ok:false, error:"bad_content_type" }, 415);
        const body   = await req.json().catch(() => ({}));
        const wallet = String(body.wallet || "").trim();
        const amount = Number(body.amount_usdc || 0);
        const sig_b58 = (body.sig_b58 || "").trim();
        const msg_str = (body.msg_str || "").trim();

        if (!isAddress(wallet)) return J({ ok:false, error:"bad_wallet" }, 400);
        if (!(amount > 0))      return J({ ok:false, error:"bad_amount" }, 400);

        // Hard-Limits aus Vars
        const minAmt = toNumOrNull(env.PRESALE_MIN_USDC);
        const maxAmt = toNumOrNull(env.PRESALE_MAX_USDC);
        if (minAmt != null && amount < minAmt) return J({ ok:false, error:"below_min", min_usdc:minAmt }, 400);
        if (maxAmt != null && amount > maxAmt) return J({ ok:false, error:"above_max", max_usdc:maxAmt }, 400);

        const cfg = await readPublicConfig(env);

        // Phase prüfen
        const state = String(cfg.presale_state || "pre");
        if (state !== "pre" && state !== "public") {
          return J({ ok:false, error:"phase_closed", phase: state }, 403);
        }

        // Cap/WALLET (optional)
        const cap = toNumOrNull(cfg.cap_per_wallet_usdc);
        if (cap != null && amount > cap) {
          return J({ ok:false, error:"over_cap", cap_per_wallet_usdc: cap }, 400);
        }

        // Deposit-Adresse muss gesetzt & valide sein
        const depo = cfg.presale_deposit_usdc || "";
        if (!isAddress(depo)) return J({ ok:false, error:"deposit_not_ready" }, 503);

        // Optional: NFT-Gate (nur wenn GATE_MINT gesetzt ist)
        const gateMint = String(env.GATE_MINT || "").trim();
        if (gateMint && !await passesNftGate(env, wallet, gateMint)) {
          return J({ ok:false, error:"gate_denied" }, 403);
        }

        // Persistieren in PRESALE
        const key = `intent:${Date.now()}:${wallet}`;
        await env.PRESALE.put(key, JSON.stringify({
          wallet,
          amount_usdc: amount,
          sig_b58,
          msg_str,
          ts: Date.now()
        }), { expirationTtl: 60*60*24*30 });

        const text =
`✅ Intent registriert.
Bitte sende ${amount} USDC an:
${depo}

Sobald die Zahlung erkannt ist, wird deine Zuteilung im System vermerkt. Claim ab TGE möglich.`;
        return new Response(text, { status: 200, headers: secTextHeaders() });
      }

      // ---- 404 ----
      return new Response("Not found", { status: 404, headers: secTextHeaders() });
    } catch (e) {
      return J({ ok:false, error:"internal", detail: String(e?.message || e) }, 500);
    }
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

  // tge_ts → Sekunden normalisieren
  if (out.tge_ts != null) {
    let t = Number(out.tge_ts);
    if (Number.isFinite(t)) {
      if (t > 1e12) t = Math.floor(t / 1000); // ms → s
      if (t <= 0) t = null;
      out.tge_ts = t;
    } else {
      out.tge_ts = null;
    }
  } else {
    out.tge_ts = null;
  }

  return out;
}

async function getPublicRpcUrl(env) {
  try {
    const fromCfg = await env.CONFIG.get("public_rpc_url");
    return fromCfg || env.RPC_URL || "https://inpinity.online/rpc";
  } catch {
    return env.RPC_URL || "https://inpinity.online/rpc";
  }
}

// Optionales NFT-Gate: hält Wallet mind. 1 Token von gateMint?
async function passesNftGate(env, owner, gateMint) {
  try {
    const rpc = await getPublicRpcUrl(env);
    if (!rpc) return true; // kein RPC → Gate nicht blocken
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner, { mint: gateMint }, { encoding: "jsonParsed", commitment: "confirmed" }]
    };
    const r = await fetch(rpc, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    const arr = j?.result?.value || [];
    for (const it of arr) {
      const info = it?.account?.data?.parsed?.info;
      const amt = info?.tokenAmount?.uiAmount || 0;
      if (amt > 0) return true;
    }
    return false;
  } catch {
    // Fallback: wenn RPC hakt, nicht blocken
    return true;
  }
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
    "x-proxy": "api-token"
  };
}
function secTextHeaders(){
  return { "content-type":"text/plain; charset=utf-8", "cache-control":"no-store", ...secHeaders() };
}