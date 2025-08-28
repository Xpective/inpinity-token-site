// API-Token worker – liefert Status, Balances, Intents & Early-Claim QR.
// Keine Onchain-Mints hier, nur Intent/Claim-Queue in KV.
// Optionales NFT-Gate via Helius DAS (collection).

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // not used directly; we call RPC by mint

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/api\/token/, "");

    // CORS
    if (req.method === "OPTIONS") {
      return new Response(null, { status:204, headers: corsHeaders() });
    }

    // --- STATUS ---
    if (req.method === "GET" && p === "/status") {
      const st = await buildStatus(env);
      return J(st);
    }

    // --- Wallet balances (USDC + INPI + gate_ok) ---
    if (req.method === "GET" && p === "/wallet/balances") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return J({ ok:false, error:"wallet_required" }, 400);
      const cfg = await cfgObj(env);

      const [usdc, inpi, gate] = await Promise.all([
        getSplBalance(cfg.rpc_url, wallet, USDC_MINT),
        cfg.inpi_mint ? getSplBalance(cfg.rpc_url, wallet, cfg.inpi_mint) : null,
        gateCheck(env, wallet, cfg.gate_collection)
      ]);

      return J({
        ok: true,
        usdc: usdc ?? null,
        inpi: inpi ?? null,
        gate_ok: !!gate
      });
    }

    // --- Presale intent: creates Solana Pay link + logs intent ---
    if (req.method === "POST" && p === "/presale/intent") {
      const body = await readJson(req); if (!body) return badCT();
      const { wallet, amount_usdc } = body;
      if (!wallet || !Number(amount_usdc)) return J({ ok:false, error:"wallet_and_amount_required" }, 400);

      const cfg = await cfgObj(env);
      if (cfg.presale_state === "closed") return J({ ok:false, error:"presale_closed" }, 400);

      // Gate-Preis
      const gate = await gateCheck(env, wallet, cfg.gate_collection);
      const price = Number(cfg.presale_price_usdc || 0);
      const discBps = gate ? Number(cfg.gate_discount_bps || 0) : 0;
      const effPrice = price * (1 - (discBps/10000));
      const expected_inpi = effPrice > 0 ? Number(amount_usdc) / effPrice : 0;

      // Build Solana Pay
      const sp = solanaPayLink({
        recipient: cfg.deposit_usdc_ata,      // ATA (USDC) – dein Deposit
        amount: Number(amount_usdc),
        splToken: USDC_MINT,
        label: "INPI Presale",
        message: `INPI Presale – ${wallet}`
      });

      // Log intent (KV)
      const ts = Date.now();
      const key = `intent:${wallet}:${ts}`;
      await env.INPI_PRESALE.put(key, JSON.stringify({
        wallet, amount_usdc: String(amount_usdc), expected_inpi, price_usdc: price, gate_ok: !!gate, ts
      }));

      return J({
        ok: true,
        expected_inpi,
        qr_contribute: {
          solana_pay_url: sp,
          phantom_universal_url: `https://phantom.app/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`,
          solflare_universal_url: `https://solflare.com/ul/v1/solana-pay?link=${encodeURIComponent(sp)}`,
          qr_url: qrUrl(sp)
        }
      });
    }

    // --- Early-claim: fee QR ---
    if (req.method === "POST" && p === "/claim/early-intent") {
      const body = await readJson(req); if (!body) return badCT();
      const { wallet } = body;
      if (!wallet) return J({ ok:false, error:"wallet_required" }, 400);

      const cfg = await cfgObj(env);
      if (!cfg.early.enabled) return J({ ok:false, error:"early_claim_disabled" }, 400);

      const dest = cfg.early.fee_dest_wallet || cfg.deposit_usdc_ata;
      const amount = Number(cfg.early.flat_usdc || 1);

      const sp = solanaPayLink({
        recipient: dest,
        amount,
        splToken: USDC_MINT,
        label: "INPI Early-Claim Fee",
        message: `INPI Early-Claim – ${wallet}`
      });

      return J({
        ok: true,
        solana_pay_url: sp,
        qr_url: qrUrl(sp)
      });
    }

    // --- Early-claim confirm: store fee sig & queue amount ---
    if (req.method === "POST" && p === "/claim/confirm") {
      const body = await readJson(req); if (!body) return badCT();
      const { wallet, fee_signature } = body;
      if (!wallet || !fee_signature) return J({ ok:false, error:"wallet_and_fee_signature_required" }, 400);

      const cfg = await cfgObj(env);

      // Neu-Delta seit dem letzten Confirm ermitteln:
      const claimedKey = `claimed_until_ts:${wallet}`;
      const prevStr = await env.INPI_CLAIMS.get(claimedKey);
      const prevTs = Number(prevStr || 0);

      const allIntentKeys = await listAll(env.INPI_PRESALE, { prefix: `intent:${wallet}:` });
      let sumNew = 0, maxTs = prevTs;
      for (const k of allIntentKeys) {
        const ts = Number(k.split(":").pop()||0);
        if (ts <= prevTs) continue;
        const raw = await env.INPI_PRESALE.get(k);
        if (!raw) continue;
        try {
          const j = JSON.parse(raw);
          sumNew += Number(j.expected_inpi || 0);
          if (ts > maxTs) maxTs = ts;
        } catch {}
      }

      // Aggregiere "pending_inpi:wallet"
      const pendKey = `pending_inpi:${wallet}`;
      const prevPend = Number(await env.INPI_CLAIMS.get(pendKey) || 0);
      const newPend = prevPend + sumNew;

      const ts = Date.now();
      await Promise.all([
        env.INPI_CLAIMS.put(`claim:${wallet}:${ts}`, JSON.stringify({ wallet, fee_signature, add_inpi: sumNew, ts })),
        env.INPI_CLAIMS.put(pendKey, String(newPend)),
        env.INPI_CLAIMS.put(claimedKey, String(maxTs))
      ]);

      return J({ ok:true, job_id: `claim-${ts}`, added_inpi: sumNew, pending_inpi: newPend });
    }

    // --- Claim status
    if (req.method === "GET" && p === "/claim/status") {
      const wallet = url.searchParams.get("wallet") || "";
      if (!wallet) return J({ ok:false, error:"wallet_required" }, 400);
      const pendKey = `pending_inpi:${wallet}`;
      const pending = Number(await env.INPI_CLAIMS.get(pendKey) || 0);
      return J({ ok:true, pending_inpi: pending });
    }

    return new Response("Not found", { status:404, headers: baseHeaders() });
  }
}

/* ---------------- helpers ---------------- */
function baseHeaders(){ return { "content-type":"application/json; charset=utf-8", ...corsHeaders() }; }
function corsHeaders(){ return { "access-control-allow-origin":"*", "access-control-allow-methods":"GET,POST,OPTIONS", "access-control-allow-headers":"content-type,accept" }; }
function J(x, status=200){ return new Response(JSON.stringify(x), { status, headers: baseHeaders() }); }
function badCT(){ return new Response("Bad Content-Type", { status:415, headers: baseHeaders() }); }

async function readJson(req){
  const ct = (req.headers.get("content-type")||"").toLowerCase();
  if (!ct.includes("application/json")) return null;
  try{ return await req.json(); }catch{ return null; }
}

async function buildStatus(env){
  const c = await cfgObj(env);
  return {
    rpc_url: c.rpc_url,
    usdc_mint: USDC_MINT,
    inpi_mint: c.inpi_mint || "",
    presale_state: c.presale_state || "pre",
    tge_ts: c.tge_ts ? Number(c.tge_ts) : null,
    presale_price_usdc: c.presale_price_usdc ? Number(c.presale_price_usdc) : null,
    public_price_usdc:  c.public_price_usdc  ? Number(c.public_price_usdc)  : Number(c.presale_price_usdc || 0),
    deposit_usdc_ata: c.deposit_usdc_ata || "",
    cap_per_wallet_usdc: c.cap_per_wallet_usdc ? Number(c.cap_per_wallet_usdc) : null,
    presale_min_usdc: (c.presale_min_usdc != null) ? Number(c.presale_min_usdc) : null,
    presale_max_usdc: (c.presale_max_usdc != null) ? Number(c.presale_max_usdc) : null,
    early_claim: {
      enabled: !!c.early.enabled,
      flat_usdc: Number(c.early.flat_usdc || 1),
      fee_dest_wallet: c.early.fee_dest_wallet || c.deposit_usdc_ata || ""
    },
    airdrop_bonus_bps: c.airdrop_bonus_bps ? Number(c.airdrop_bonus_bps) : null,
    supply_total: c.supply_total ? Number(c.supply_total) : null,
    dist_presale_bps:         num(c.dist_presale_bps),
    dist_dex_liquidity_bps:   num(c.dist_dex_liquidity_bps),
    dist_staking_bps:         num(c.dist_staking_bps),
    dist_ecosystem_bps:       num(c.dist_ecosystem_bps),
    dist_treasury_bps:        num(c.dist_treasury_bps),
    dist_team_bps:            num(c.dist_team_bps),
    dist_airdrop_nft_bps:     num(c.dist_airdrop_nft_bps),
    dist_buyback_reserve_bps: num(c.dist_buyback_reserve_bps),
    updated_at: Date.now()
  };
}
function num(v){ const n=Number(v); return Number.isFinite(n)? n : null; }

async function cfgObj(env){
  const get = (k)=> env.CONFIG.get(k);
  const [
    rpc, inpi, pricePre, pricePub,
    depo, cap, st, tge, minU, maxU,
    disc, coll, earlyFeeAta, earlyFlat,
    supply,
    d_pres, d_dex, d_stake, d_eco, d_treas, d_team, d_air, d_buy,
    creator
  ] = await Promise.all([
    get("public_rpc_url"),
    get("INPI_MINT"),
    get("presale_price_usdc"),
    get("public_price_usdc"),
    get("presale_deposit_usdc"),
    get("cap_per_wallet_usdc"),
    get("presale_state"),
    get("tge_ts"),
    get("presale_min_usdc"),
    get("presale_max_usdc"),
    get("gate_discount_bps"),
    get("gate_collection"),
    get("early_fee_usdc_ata"),
    get("early_flat_usdc"),
    get("supply_total"),
    get("dist_presale_bps"),
    get("dist_dex_liquidity_bps"),
    get("dist_staking_bps"),
    get("dist_ecosystem_bps"),
    get("dist_treasury_bps"),
    get("dist_team_bps"),
    get("dist_airdrop_nft_bps"),
    get("dist_buyback_reserve_bps"),
    get("creator_pubkey")
  ]);

  return {
    rpc_url: rpc || env.RPC_URL || "https://api.mainnet-beta.solana.com",
    inpi_mint: inpi || "",
    presale_price_usdc: pricePre || "",
    public_price_usdc: pricePub || pricePre || "",
    deposit_usdc_ata: depo || "",
    cap_per_wallet_usdc: cap || "",
    presale_state: st || "pre",
    tge_ts: tge || "",
    presale_min_usdc: (minU != null ? minU : env.PRESALE_MIN_USDC),
    presale_max_usdc: (maxU != null ? maxU : env.PRESALE_MAX_USDC),
    gate_discount_bps: disc || "0",
    gate_collection: coll || "",
    early: {
      enabled: true,
      fee_dest_wallet: earlyFeeAta || depo || "",
      flat_usdc: earlyFlat || "1"
    },
    airdrop_bonus_bps: await env.CONFIG.get("airdrop_bonus_bps"),
    supply_total: supply || "",
    dist_presale_bps: d_pres, dist_dex_liquidity_bps: d_dex, dist_staking_bps: d_stake,
    dist_ecosystem_bps: d_eco, dist_treasury_bps: d_treas, dist_team_bps: d_team,
    dist_airdrop_nft_bps: d_air, dist_buyback_reserve_bps: d_buy,
    creator_pubkey: creator || ""
  };
}

/* ---------- Solana helpers ---------- */
async function rpcCall(rpcUrl, method, params){
  const r = await fetch(rpcUrl, {
    method: "POST", headers: { "content-type":"application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

async function getSplBalance(rpcUrl, owner, mint){
  // getTokenAccountsByOwner with mint filter -> parse jsonParsed
  const res = await rpcCall(rpcUrl, "getTokenAccountsByOwner", [
    owner, { mint }, { encoding:"jsonParsed" }
  ]);
  let uiAmount = 0;
  for (const it of (res.value||[])) {
    try{
      const amt = it.account.data.parsed.info.tokenAmount.uiAmount;
      uiAmount += Number(amt||0);
    }catch{}
  }
  return { uiAmount };
}

// Helius DAS collection-gate (optional)
async function gateCheck(env, owner, collectionMint){
  if (!collectionMint) return false;
  const key = env.HELIUS_API_KEY || ""; if (!key) return false;
  const endpoint = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const r = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getAssetsByOwner",
      params: { ownerAddress: owner, page: 1, limit: 100, displayOptions: { showUnverified: true } }
    })
  });
  const j = await r.json().catch(()=>null);
  const items = j?.result?.items || [];
  for (const it of items) {
    const groups = it?.grouping || it?.groups || [];
    for (const g of groups) {
      const k = g?.group_key || g?.groupKey;
      const v = g?.group_value || g?.groupValue;
      if (k === "collection" && v === collectionMint) return true;
    }
  }
  return false;
}

/* ---------- Solana Pay ---------- */
function solanaPayLink({ recipient, amount, splToken, label, message }) {
  // Format: solana:<recipient>?amount=...&spl-token=...&label=...&message=...
  const p = new URLSearchParams();
  if (amount) p.set("amount", String(amount));
  if (splToken) p.set("spl-token", splToken);
  if (label) p.set("label", label);
  if (message) p.set("message", message);
  return `solana:${encodeURIComponent(recipient)}?${p.toString()}`;
}
function qrUrl(data){ return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data)}`; }

/* ---------- KV helpers ---------- */
async function listAll(KV, { prefix="", cap=5000 } = {}) {
  const out=[]; let cursor;
  while(out.length<cap){
    const r = await KV.list({ prefix, cursor });
    (r.keys||[]).forEach(k => out.push(k.name));
    if (!r.list_complete && r.cursor) cursor=r.cursor; else break;
  }
  return out;
}