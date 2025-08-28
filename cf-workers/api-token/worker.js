// ============================================
// INPI Token API – Presale + Early Claim
// Routes: /api/token/*
// KV: env.CONFIG, env.INPI_PRESALE, env.INPI_CLAIMS
// ============================================

export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const p = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") return noContent();

      // ---------- ROUTES ----------
      if (p === "/api/token/status" && req.method === "GET") {
        return status(env);
      }
      if (p === "/api/token/wallet/balances" && req.method === "GET") {
        return walletBalances(req, env);
      }
      if (p === "/api/token/presale/intent" && req.method === "POST") {
        return presaleIntent(req, env);
      }
      if (p === "/api/token/claim/early-intent" && req.method === "POST") {
        return earlyIntent(req, env);
      }
      if (p === "/api/token/claim/confirm" && req.method === "POST") {
        return earlyConfirm(req, env);
      }
      if (p === "/api/token/claim/status" && req.method === "GET") {
        return claimStatus(req, env);
      }

      return json({ ok:false, error:"not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ ok:false, error:String(e?.message||e) }, 500);
    }
  }
};

/* ================== CONSTS ================== */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/* ================== HELPERS ================== */

function CFG_KV(env){ return env.CONFIG; }

function cors(h={}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, accept",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...h
  };
}
function noContent(){ return new Response(null,{ status:204, headers: cors() }); }
function json(x, status=200){ return new Response(JSON.stringify(x), { status, headers: cors({ "content-type":"application/json; charset=utf-8" })}); }
async function readJson(req){ try{
  if(!(req.headers.get("content-type")||"").toLowerCase().includes("application/json")) return null;
  return await req.json();
}catch{ return null; }}

/* ---- bs58 encode (für Reference Keys) ---- */
const B58_ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes){
  if(!(bytes&&bytes.length)) return "";
  let zeros=0; while(zeros<bytes.length && bytes[zeros]===0) zeros++;
  let n=0n; for(const b of bytes) n=(n<<8n)+BigInt(b);
  let out=""; while(n>0n){ const r=Number(n%58n); out=B58_ALPH[r]+out; n=n/58n; }
  for(let i=0;i=zeros;i++) out="1"+out;
  return out || "1".repeat(zeros);
}
function randPubkeyB58(){
  const a=new Uint8Array(32);
  crypto.getRandomValues(a);
  return bs58(a);
}

/* ---- RPC ---- */
async function rpc(env, method, params){
  const kv = CFG_KV(env);
  const kvRpc = await kv.get("public_rpc_url");
  const endpoint = kvRpc || env.RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method, params });
  const r = await fetch(endpoint, { method:"POST", headers:{ "content-type":"application/json" }, body });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

async function getParsedTokenAccountsByOwner(env, owner, mint){
  return await rpc(env, "getParsedTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" }
  ]);
}

function sumUi(accts){
  let ui=0, raw="0", dec=0;
  for (const it of (accts?.value||[])){
    const t = it.account?.data?.parsed?.info?.tokenAmount;
    if (!t) continue;
    ui += Number(t.uiAmount || 0);
    raw = (BigInt(raw) + BigInt(t.amount || "0")).toString();
    dec = Number(t.decimals || dec);
  }
  return { uiAmount: ui, amount: raw, decimals: dec };
}

/* ---- Helius NFT Gate (optional) ---- */
async function hasGateNft(env, owner){
  const kv = CFG_KV(env);
  if ((await kv.get("nft_gate_enabled")) !== "true") return false;
  const coll = await kv.get("gate_collection");
  if (!coll) return false;

  if (env.HELIUS_API_KEY){
    const url = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`;
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getAssetsByOwner",
      params: {
        ownerAddress: owner,
        page: 1,
        limit: 1000,
        displayOptions: { showCollectionMetadata: true }
      }
    };
    const r = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(()=>null);
    const items = j?.result?.items || [];
    return items.some(a =>
      (a?.grouping?.some(g => (g.group_key==="collection" && g.group_value===coll)) ) ||
      (a?.collection?.address === coll)
    );
  }
  return false;
}

/* ================== ENDPOINTS ================== */

// ---------- /api/token/status ----------
async function status(env){
  const kv = CFG_KV(env);
  const get = (k)=> kv.get(k);

  const [
    rpcUrl, inpi, presale_state, tge,
    presale_price, public_mint_price, public_price,
    deposit_ata, cap_wallet,
    min_usdc, max_usdc,
    early_on, early_flat, early_fee_ata,
    airdrop_bps,
    supply_total,
    d_presale, d_dex, d_stake, d_eco, d_treas, d_team, d_air, d_buyback
  ] = await Promise.all([
    get("public_rpc_url"),
    get("INPI_MINT"),
    get("presale_state"),
    get("tge_ts"),
    get("presale_price_usdc"),
    get("public_mint_price_usdc"),
    get("public_price_usdc"),
    get("presale_deposit_usdc"),
    get("cap_per_wallet_usdc"),
    get("presale_min_usdc"),
    get("presale_max_usdc"),
    get("early_claim_enabled"),
    get("early_flat_usdc"),
    get("early_fee_usdc_ata"),
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

  const out = {
    rpc_url: rpcUrl || env.RPC_URL || "https://api.mainnet-beta.solana.com",
    usdc_mint: USDC_MINT,
    inpi_mint: inpi || "",
    presale_state: presale_state || "pre",
    tge_ts: tge ? Number(tge) : null,
    presale_price_usdc: presale_price ? Number(presale_price) : null,
    public_price_usdc: (public_price??public_mint_price) ? Number(public_price??public_mint_price) : null,
    deposit_usdc_ata: deposit_ata || "",
    cap_per_wallet_usdc: cap_wallet ? Number(cap_wallet) : null,
    presale_min_usdc: min_usdc ? Number(min_usdc) : null,
    presale_max_usdc: max_usdc ? Number(max_usdc) : null,
    early_claim: {
      enabled: (early_on === "true"),
      flat_usdc: early_flat ? Number(early_flat) : 1,
      fee_dest_wallet: early_fee_ata || deposit_ata || ""
    },
    airdrop_bonus_bps: airdrop_bps ? Number(airdrop_bps) : 600,
    supply_total: supply_total ? Number(supply_total) : 3141592653,
    dist_presale_bps:         d_presale ? Number(d_presale) : 1000,
    dist_dex_liquidity_bps:   d_dex     ? Number(d_dex)     : 2000,
    dist_staking_bps:         d_stake   ? Number(d_stake)   : 700,
    dist_ecosystem_bps:       d_eco     ? Number(d_eco)     : 2000,
    dist_treasury_bps:        d_treas   ? Number(d_treas)   : 1500,
    dist_team_bps:            d_team    ? Number(d_team)    : 1000,
    dist_airdrop_nft_bps:     d_air     ? Number(d_air)     : 1000,
    dist_buyback_reserve_bps: d_buyback ? Number(d_buyback) : 800,
    updated_at: Date.now()
  };
  return json(out);
}

// ---------- /api/token/wallet/balances?wallet=... ----------
async function walletBalances(req, env){
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet");
  if (!wallet) return json({ ok:false, error:"wallet_required" }, 400);

  const kv = CFG_KV(env);
  const inpiMint = await kv.get("INPI_MINT");
  if (!inpiMint) return json({ ok:false, error:"missing_INPI_MINT" }, 500);

  const usdcAccs = await getParsedTokenAccountsByOwner(env, wallet, USDC_MINT);
  const inpiAccs = await getParsedTokenAccountsByOwner(env, wallet, inpiMint);
  const usdc = sumUi(usdcAccs);
  const inpi = sumUi(inpiAccs);

  const gate_ok = await hasGateNft(env, wallet);
  return json({ ok:true, usdc, inpi, gate_ok });
}

// ---------- /api/token/presale/intent (POST) ----------
async function presaleIntent(req, env){
  const kv = CFG_KV(env);
  const body = await readJson(req) || {};
  const wallet = String(body.wallet||"").trim();
  const amount = Number(body.amount_usdc || 0);
  if (!wallet || !Number.isFinite(amount) || amount<=0) return json({ ok:false, error:"bad_params" }, 400);

  const [minS, maxS, capS, priceS, depATA] = await Promise.all([
    kv.get("presale_min_usdc"), kv.get("presale_max_usdc"),
    kv.get("cap_per_wallet_usdc"),
    kv.get("presale_price_usdc"),
    kv.get("presale_deposit_usdc")
  ]);
  const min = minS? Number(minS):0, max = maxS? Number(maxS):null, cap = capS? Number(capS):null;
  if (min && amount<min) return json({ ok:false, error:`min_${min}` }, 400);
  if (max && amount>max) return json({ ok:false, error:`max_${max}` }, 400);
  if (!depATA) return json({ ok:false, error:"missing_deposit_ata" }, 500);

  const price = priceS? Number(priceS):0.00031415;
  const expected_inpi = Math.floor((amount/price)*1e0); // glatte INPI, UI rechnet eh

  // Solana Pay URL
  const reference = randPubkeyB58();
  const label = "INPI Presale";
  const message = `INPI Presale ${amount} USDC`;
  const sp = new URL(`solana:${depATA}`);
  sp.searchParams.set("amount", String(amount));
  sp.searchParams.set("spl-token", USDC_MINT);
  sp.searchParams.set("reference", reference);
  sp.searchParams.set("label", label);
  sp.searchParams.set("message", message);
  const solana_pay_url = sp.toString();
  const phantom_universal_url  = `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(solana_pay_url)}`;
  const solflare_universal_url = `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(solana_pay_url)}`;
  const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(solana_pay_url)}`;

  // persist intent (für spätere Reconcile/Airdrop)
  const rec = {
    wallet, amount_usdc: amount, price_used: price,
    expected_inpi, reference,
    sig_b58: body.sig_b58 || null, msg_str: body.msg_str || null,
    created_at: Date.now()
  };
  const key = `intent:${wallet}:${reference}`;
  await env.INPI_PRESALE.put(key, JSON.stringify(rec));

  return json({
    ok:true,
    reference, expected_inpi,
    solana_pay_url, phantom_universal_url, solflare_universal_url, qr_url
  });
}

// ---------- /api/token/claim/early-intent (POST) ----------
async function earlyIntent(req, env){
  const kv = CFG_KV(env);
  const body = await readJson(req) || {};
  const wallet = String(body.wallet||"").trim();
  if (!wallet) return json({ ok:false, error:"wallet_required" }, 400);

  const [enabledS, flatS, feeATA, depATA] = await Promise.all([
    kv.get("early_claim_enabled"),
    kv.get("early_flat_usdc"),
    kv.get("early_fee_usdc_ata"),
    kv.get("presale_deposit_usdc")
  ]);
  const enabled = (enabledS==="true");
  if (!enabled) return json({ ok:false, error:"early_disabled" }, 400);

  const amount = flatS? Number(flatS) : 1;
  const dest = feeATA || depATA;
  if (!dest) return json({ ok:false, error:"missing_fee_dest" }, 500);

  const reference = randPubkeyB58();
  const label = "INPI Claim Fee";
  const message = `INPI early-claim fee ${amount} USDC`;

  const sp = new URL(`solana:${dest}`);
  sp.searchParams.set("amount", String(amount));
  sp.searchParams.set("spl-token", USDC_MINT);
  sp.searchParams.set("reference", reference);
  sp.searchParams.set("label", label);
  sp.searchParams.set("message", message);
  const solana_pay_url = sp.toString();
  const phantom_universal_url  = `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(solana_pay_url)}`;
  const solflare_universal_url = `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(solana_pay_url)}`;
  const qr_url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(solana_pay_url)}`;

  const rec = { wallet, reference, fee_usdc: amount, dest, created_at: Date.now() };
  await env.INPI_CLAIMS.put(`early-intent:${wallet}:${reference}`, JSON.stringify(rec));

  return json({ ok:true, reference, solana_pay_url, phantom_universal_url, solflare_universal_url, qr_url });
}

// ---------- /api/token/claim/confirm (POST) ----------
async function earlyConfirm(req, env){
  const body = await readJson(req) || {};
  const wallet = String(body.wallet||"").trim();
  const fee_signature = String(body.fee_signature||"").trim();
  if (!wallet || !fee_signature) return json({ ok:false, error:"bad_params" }, 400);

  // Hier nur persistieren + "queued" zurückgeben.
  // (Reconcile/Distribution macht dein Offchain-Job/Bot.)
  const job_id = `job:${wallet}:${Date.now()}`;
  const rec = { wallet, fee_signature, job_id, queued_at: Date.now() };
  await env.INPI_CLAIMS.put(`early-confirm:${wallet}:${fee_signature}`, JSON.stringify(rec));

  return json({ ok:true, job_id });
}

// ---------- /api/token/claim/status?wallet=... ----------
async function claimStatus(req, env){
  const url = new URL(req.url);
  const wallet = String(url.searchParams.get("wallet")||"").trim();
  if (!wallet) return json({ ok:false, error:"wallet_required" }, 400);

  // Minimal: pending_inpi = 0 (bis Reconcile-Job Zahlungen matched)
  // Du kannst später hier die bestätigten Intents summieren.
  return json({ ok:true, pending_inpi: 0 });
}