/**
 * INPI Token API – Presale + Early Claim
 * Liest Konfiguration aus KV: CONFIG (neu), robust mit Synonymen.
 * Endpunkte in diesem Snippet: /api/token/status  (+ CORS / OPTIONS)
 */

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** ---------- kleine Utils ---------- */
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function json(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders, ...headers },
  });
}

function noContent() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

const parseNum = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const parseIntOrNull = (v) => (v === null || v === undefined || v === "" ? null : parseInt(v, 10));

/** Lies einen Key aus CONFIG oder gib null zurück */
async function cfgGet(env, key) {
  return env.CONFIG.get(key);
}

/** Versuche mehrere Key-Namen in Reihenfolge (Synonyme) */
async function cfgGetFirst(env, keys) {
  for (const k of keys) {
    const v = await cfgGet(env, k);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Baue die RPC-URL gemäß Priorität */
async function computeRpcUrl(env) {
  const fromCfg = await cfgGet(env, "public_rpc_url");
  if (fromCfg && fromCfg.trim() !== "") return fromCfg.trim();

  if (env.RPC_URL && String(env.RPC_URL).trim() !== "") return String(env.RPC_URL).trim();

  // Optional: Helius nur verwenden, wenn KEIN expliziter RPC gesetzt wurde
  if (env.HELIUS_API_KEY && String(env.HELIUS_API_KEY).trim() !== "") {
    return `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY.trim()}`;
  }

  return "https://api.mainnet-beta.solana.com";
}

/** Lies Min/Max mit Synonymen + Fallback auf [vars] */
async function getPresaleLimits(env) {
  const minRaw = await cfgGetFirst(env, ["presale_min_usdc", "min_usdc"]);
  const maxRaw = await cfgGetFirst(env, ["presale_max_usdc", "max_usdc"]);

  const min =
    parseNum(minRaw) ??
    (env.PRESALE_MIN_USDC ? parseNum(env.PRESALE_MIN_USDC) : null);

  const max =
    parseNum(maxRaw) ??
    (env.PRESALE_MAX_USDC ? parseNum(env.PRESALE_MAX_USDC) : null);

  return { min, max };
}

async function statusHandler(env) {
  const rpc_url = await computeRpcUrl(env);

  const inpi_mint = (await cfgGetFirst(env, ["INPI_MINT", "inpi_mint"])) || "";

  const presale_state = (await cfgGetFirst(env, ["presale_state"])) || "pre";
  const tge_ts = parseIntOrNull(await cfgGetFirst(env, ["tge_ts", "tge_time", "tge_unix"]));

  const presale_price_usdc = parseNum(await cfgGetFirst(env, ["presale_price_usdc", "presale_price"]));
  const public_price_usdc = parseNum(await cfgGetFirst(env, ["public_price_usdc", "public_price"]));

  const deposit_usdc_ata =
    (await cfgGetFirst(env, ["presale_deposit_usdc", "deposit_usdc_ata"])) || "";

  const cap_per_wallet_usdc = parseNum(await cfgGetFirst(env, ["cap_per_wallet_usdc", "wallet_cap_usdc"]));

  const { min: presale_min_usdc, max: presale_max_usdc } = await getPresaleLimits(env);

  return json({
    rpc_url,
    usdc_mint: USDC_MINT_MAINNET,
    inpi_mint,
    presale_state,
    tge_ts,
    presale_price_usdc,
    public_price_usdc,
    deposit_usdc_ata,
    cap_per_wallet_usdc,
    presale_min_usdc,
    presale_max_usdc,
    updated_at: Date.now(),
  });
}

/** ---------- Router ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return noContent();

    // erlaubt sowohl /api/token/status (Route gebunden) als auch nur /status lokal
    if (request.method === "GET" && (path === "/api/token/status" || path.endsWith("/status"))) {
      return statusHandler(env);
    }

    if (request.method === "GET" && (path === "/api/token/health" || path.endsWith("/health"))) {
      return json({ ok: true, service: "api-token" });
    }

    return json({ ok: false, error: "not_found" }, { status: 404 });
  },
};