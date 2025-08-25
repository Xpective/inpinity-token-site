#!/usr/bin/env bash
set -euo pipefail

# ========== Admin Zugang ==========
: "${ADMIN_USER:?}"
: "${ADMIN_PASS:?}"
# Falls TOTP aktiv ist:
OTP_HEADER=""
if [[ -n "${ADMIN_OTP:-}" ]]; then
  OTP_HEADER="-H x-otp:${ADMIN_OTP}"
fi

ADMIN_BASE="https://inpinity.online/admin"

# ========== Werte ==========
: "${INPI_MINT:?}"      # vom Mint-Skript übernehmen: export INPI_MINT=<...>
: "${MULTISIG:?}"

# TGE in 90 Tagen (ms)
TGE_TS=$(node -e 'console.log(Date.now() + 90*24*60*60*1000)')

# JSON vorbereiten
read -r -d '' PAYLOAD <<JSON
{
  "INPI_MINT":            "${INPI_MINT}",

  "presale_state":        "pre",
  "tge_ts":               "${TGE_TS}",
  "presale_price_usdc":   "0.003141",      // NFT-Gate Preis
  "public_price_usdc":    "0.031",         // (falls genutzt)
  "public_mint_enabled":  "true",
  "public_mint_price_usdc":"0.031",
  "public_mint_fee_bps":  "100",
  "public_mint_fee_dest": "lp",

  "nft_gate_enabled":     "true",
  "gate_collection":      "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",
  "nft_gate_collection":  "6xvwKXMUGfkqhs1f3ZN3KkrdvLh2vF3tX1pqLo9aYPrQ",

  "presale_target_usdc":  "0",             // <--- setz hier euer Ziel in USDC
  "cap_per_wallet_usdc":  "25000",
  "presale_deposit_usdc": "8PEkHngVQJoBMk68b1R5dyXjmqe3UthutSUbAYiGcpg6",

  "buyback_enabled":        "false",
  "buyback_twap_slices":    "6",
  "buyback_cooldown_min":   "30",
  "buyback_min_usdc":       "200",
  "buyback_split_burn_bps": "2500",
  "buyback_split_lp_bps":   "7500",

  "twap_enabled":           "true",

  "supply_total":         "3141592653",
  "governance_multisig":  "${MULTISIG}",
  "project_uri":          "https://inpinity.online/token",

  // Beispiel-Distribution (Summe = 10000 bps)
  "dist_presale_bps":         "3000",
  "dist_dex_liquidity_bps":   "3000",
  "dist_staking_bps":         "1500",
  "dist_ecosystem_bps":       "1000",
  "dist_treasury_bps":        "500",
  "dist_team_bps":            "700",
  "dist_airdrop_nft_bps":     "200",
  "dist_buyback_reserve_bps": "100"
}
JSON

echo "== Push setmany =="
curl -u "${ADMIN_USER}:${ADMIN_PASS}" \
  -H "content-type: application/json" \
  ${OTP_HEADER} \
  -X POST "${ADMIN_BASE}/config/setmany" \
  -d "{\"entries\": ${PAYLOAD}}"

echo
echo "== Readback =="
curl -u "${ADMIN_USER}:${ADMIN_PASS}" ${OTP_HEADER} "${ADMIN_BASE}/config"
echo