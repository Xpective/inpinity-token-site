// INPI Admin Worker (Basic + optional TOTP, Cron-Proxies, Config-API)
// Bindings/Secrets:
// - KV: CONFIG (required), OPS (optional für Audit)
// - Secrets: ADMIN_USER, ADMIN_PASS
// - Optional Secrets: ADMIN_TOTP_SECRET, ADMIN_TOTP_PERIOD, ADMIN_TOTP_WINDOW
// - ENV/Secret: CRON_BASE (z.B. https://inpinity.online/cron), OPS_API_KEY, OPS_HMAC_ALGO
// - Optional: IP_ALLOWLIST (CSV), CONFIG_KEYS (CSV Whitelist)

export default {
  async fetch(req, env) {
    // Basic + IP-Check
    if (!basicOk(req, env) || !ipOk(req, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${env.ADMIN_REALM || "Admin"}"`,
          ...secHeaders(),
          "x-require-otp": "1"
        }
      });
    }

    const url = new URL(req.url);
    const p = url.pathname;

    // OTP für sensible Routen (Config & Cron-Proxies)
    const mustOtp = needsOtp(p);
    if (mustOtp && env.ADMIN_TOTP_SECRET) {
      const otp = getOtpFromReq(req);
      const ok = await verifyTOTP(env.ADMIN_TOTP_SECRET, otp, {
        period: toNum(env.ADMIN_TOTP_PERIOD, 30),
        window: toNum(env.ADMIN_TOTP_WINDOW, 1),
        digits: 6,
        algo: "SHA-1"
      });
      if (!ok) return J({ ok: false, error: "bad_otp" }, 401, { "x-require-otp": "1" });
    }

    // UI
    if (req.method === "GET" && p === "/admin") return ui(env);

    // -------- CONFIG API --------
    if (req.method === "GET" && p === "/admin/config") {
      const qKey = url.searchParams.get("key");
      if (qKey) {
        const v = await env.CONFIG.get(qKey);
        return J({ ok: true, key: qKey, value: v });
      }
      const keys = getConfigKeys(env);
      const out = {};
      await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
      return J({ ok: true, keys, values: out });
    }

    if (req.method === "GET" && p === "/admin/config/keys") {
      return J({ ok: true, keys: getConfigKeys(env) });
    }

    if (req.method === "POST" && p === "/admin/config/set") {
      if (!(await requireJson(req))) return badCT();
      const { key, value } = await req.json().catch(() => ({}));
      if (!keyAllowed(env, key)) return J({ ok: false, error: "key_not_allowed" }, 403);
      await env.CONFIG.put(String(key), String(value ?? ""));
      await audit(env, "config_set", { key });
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/setmany") {
      if (!(await requireJson(req))) return badCT();
      const { entries } = await req.json().catch(() => ({}));
      if (!entries || typeof entries !== "object") return J({ ok: false, error: "entries_object_required" }, 400);
      for (const [k] of Object.entries(entries)) {
        if (!keyAllowed(env, k)) return J({ ok: false, error: `key_not_allowed:${k}` }, 403);
      }
      await Promise.all(Object.entries(entries).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_setmany", { count: Object.keys(entries).length });
      return J({ ok: true });
    }

    if (req.method === "POST" && p === "/admin/config/delete") {
      if (!(await requireJson(req))) return badCT();
      const { key } = await req.json().catch(() => ({}));
      if (!keyAllowed(env, key)) return J({ ok: false, error: "key_not_allowed" }, 403);
      await env.CONFIG.delete(key);
      await audit(env, "config_delete", { key });
      return J({ ok: true });
    }

    if (req.method === "GET" && p === "/admin/config/export") {
      const keys = getConfigKeys(env);
      const out = {};
      await Promise.all(keys.map(async (k) => (out[k] = await env.CONFIG.get(k))));
      return new Response(JSON.stringify({ ts: Date.now(), values: out }, null, 2), {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=inpi-config-export.json",
          ...secHeaders()
        }
      });
    }

    if (req.method === "POST" && p === "/admin/config/import") {
      if (!(await requireJson(req))) return badCT();
      const { values } = await req.json().catch(() => ({}));
      if (!values || typeof values !== "object") return J({ ok: false, error: "values_object_required" }, 400);
      const allowed = getConfigKeys(env);
      const write = {};
      for (const [k, v] of Object.entries(values)) if (allowed.includes(k)) write[k] = v;
      await Promise.all(Object.entries(write).map(([k, v]) => env.CONFIG.put(String(k), String(v ?? ""))));
      await audit(env, "config_import", { count: Object.keys(write).length });
      return J({ ok: true, written: Object.keys(write).length });
    }

    // -------- CRON PROXIES (mit Bearer + HMAC) --------
    if (req.method === "GET" && p === "/admin/cron/status") {
      const r = await proxyCron(env, "/status", "GET", null);
      return pass(r);
    }

    if (req.method === "POST" && p === "/admin/cron/reconcile") {
      if (!(await requireJson(req))) return badCT();
      const body = await req.json().catch(() => ({}));
      const r = await proxyCron(env, "/reconcile-presale", "POST", body);
      return pass(r);
    }

    // Early-Claims in OPS anstoßen
    if (req.method === "POST" && p === "/admin/cron/early-claims") {
      if (!(await requireJson(req))) return badCT();
      const body = await req.json().catch(() => ({}));
      const r = await proxyCron(env, "/early-claims", "POST", body);
      return pass(r);
    }

    if (req.method === "GET" && p === "/admin/ops/peek") {
      const q = url.searchParams.toString();
      const r = await proxyCron(env, `/ops/peek${q ? "?" + q : ""}`, "GET", null);
      return pass(r);
    }

    // Health
    if (req.method === "GET" && p === "/admin/health") return J({ ok: true, now: Date.now() });

    return new Response("Not found", { status: 404, headers: secHeaders() });
  }
};

/* --------------------- Auth / Allowlist --------------------- */
function basicOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  const [u, p] = atob(h.slice(6)).split(":");
  return u === env.ADMIN_USER && p === env.ADMIN_PASS;
}
function ipOk(req, env) {
  const allow = (env.IP_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return true;
  const ip = req.headers.get("cf-connecting-ip") || "";
  return allow.includes(ip);
}
function needsOtp(path) {
  if (path === "/admin" || path === "/admin/health") return false;
  return path.startsWith("/admin/config") || path.startsWith("/admin/cron") || path.startsWith("/admin/ops");
}

/* --------------------- Config Keys --------------------- */
/* Falls ENV.CONFIG_KEYS nicht gesetzt ist, verwenden wir eine
   umfangreiche Default-Whitelist, die deine bisherigen Keys abdeckt,
   plus gate_*, tier_*, early_* und public_rpc_url. */
const DEFAULT_KEYS = [
  // Core / Phasen / Preise / Wallets / RPC
  "INPI_MINT","presale_state","tge_ts","presale_price_usdc","public_price_usdc",
  "presale_target_usdc","cap_per_wallet_usdc","presale_deposit_usdc","public_rpc_url",
  // Gate
  "nft_gate_enabled","gate_collection","nft_gate_collection","gate_mint",
  // Public Mint
  "public_mint_enabled","public_mint_price_usdc","public_mint_fee_bps","public_mint_fee_dest",
  // Quoten / Overflow
  "sale_nft_quota_bps","sale_public_quota_bps","sale_overflow_action",
  // LP
  "lp_split_bps","lp_bucket_usdc","lp_lock_initial_days","lp_lock_rolling_days",
  // Staking
  "staking_total_inpi","staking_fee_bps","staking_start_ts","staking_end_ts",
  // Buyback / Circuit Breaker / Floor
  "buyback_enabled","buyback_min_usdc","buyback_twap_slices","buyback_cooldown_min",
  "buyback_split_burn_bps","buyback_split_lp_bps",
  "cb_enabled","cb_drop_pct_1h","cb_vol_mult","cb_cooldown_min",
  "floor_enabled","floor_min_usdc_per_inpi","floor_window_min","floor_daily_cap_usdc",
  // Creator Streams
  "creator_usdc_stream_monthly_usdc","creator_usdc_stream_months","creator_usdc_stream_next_ts",
  "creator_inpi_stream_bps_per_month","