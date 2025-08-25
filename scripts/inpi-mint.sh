#!/usr/bin/env bash
set -euo pipefail

: "${MULTISIG:?set MULTISIG pubkey first}"
: "${META_URI:?set META_URI first}"

echo "== 1) Token (decimals=9) erstellen =="
MINT=$(spl-token create-token --decimals 9 | awk '/Creating token/ {print $3}')
echo "INPI_MINT: $MINT"

echo "== 2) ATA für Multisig erstellen =="
# Ermittelt + erzeugt die Associated Token Address (ATA) für den Multisig-Owner
ATA=$(spl-token address --token "$MINT" --owner "$MULTISIG")
spl-token create-account "$MINT" --owner "$MULTISIG" >/dev/null || true
echo "INPI_ATA_MULTISIG: $ATA"

echo "== 3) Exakten Gesamtvorrat minten (human readable) =="
# WICHTIG: Da decimals=9, interpretiert das CLI die Zahl als Tokens, nicht als Atome.
# -> 3141592653 = 3,141,592,653 INPI
spl-token mint "$MINT" 3141592653 "$ATA"

echo "== 4) Metadata setzen (Name/Symbol/URI) =="
spl-token create-metadata "$MINT" \
  --name "Inpinity" \
  --symbol "INPI" \
  --uri "$META_URI"

echo "== 5) Authorities auf Multisig festziehen =="
spl-token authorize "$MINT" mint   "$MULTISIG"
spl-token authorize "$MINT" freeze "$MULTISIG"

echo "== DONE =="
echo "INPI_MINT=$MINT"
echo "INPI_ATA_MULTISIG=$ATA"
spl-token supply "$MINT"