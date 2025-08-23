/* ===========================================
   Inpinity Token – Frontend (Phantom-only)
   Pfad: /public/token/app.js
   =========================================== */

/* ==================== KONFIG ==================== */
const CFG = {
  // ⚠️ Trage hier DEINE echten Adressen ein, sobald verfügbar:
  RPC: "https://inpinity.online/rpc", // wir legen unten einen Worker-Proxy /rpc an
  INPI_MINT: "<DEIN_INPI_MINT>",      // z. B. 9d... (platzhalter)
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC auf Solana (Mainnet)
  API_BASE: "https://inpinity.online/api/token",
  P0_USDC: 0.0001, // Startpreis
  PRESALE_DISCOUNT: 0.10, // 10 %
};

/* ================ SOLANA / PHANTOM ================ */
const { Connection, PublicKey, Transaction, SystemProgram } = solanaWeb3;

// Helfer
const $ = (sel) => document.querySelector(sel);

// UI-Refs
const btnConnect = $("#btnConnect");
const walletAddr = $("#walletAddr");
const usdcBal = $("#usdcBal");
const inpiBal = $("#inpiBal");
const presaleState = $("#presaleState");
const tgeTime = $("#tgeTime");
const p0 = $("#p0");
const inpAmount = $("#inpAmount");
const inpPrice = $("#inpPrice");
const expectedInpi = $("#expectedInpi");
const btnPresaleIntent = $("#btnPresaleIntent");
const btnHowTo = $("#btnHowTo");
const intentMsg = $("#intentMsg");

// State
let connection = null;
let provider = null; // phantom
let pubkey = null;

function fmt(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return "–";
  return Number(n).toLocaleString("de-DE", { maximumFractionDigits: d });
}

function calcExpectedInpi(usdc) {
  if (!usdc || usdc <= 0) return "–";
  const effPrice = CFG.P0_USDC * (1 - CFG.PRESALE_DISCOUNT); // 0.00009
  return fmt(usdc / effPrice, 0) + " INPI";
}

/* ==================== INIT ==================== */
async function init() {
  connection = new Connection(CFG.RPC, "confirmed");
  p0.textContent = `${CFG.P0_USDC.toFixed(6)} USDC`;

  // TGE/Presale Status von API
  try {
    const res = await fetch(`${CFG.API_BASE}/status`);
    const j = await res.json().catch(() => ({}));
    presaleState.textContent = j?.presale ?? "unbekannt";
    tgeTime.textContent = j?.tge_iso ?? "tbd";
  } catch {
    presaleState.textContent = "API offline";
    tgeTime.textContent = "—";
  }

  // Phantom vorhanden?
  if (window.solana?.isPhantom) {
    btnConnect.disabled = false;
  } else {
    btnConnect.textContent = "Phantom installieren";
    btnConnect.onclick = () => window.open("https://phantom.app", "_blank");
  }
}

btnConnect.addEventListener("click", async () => {
  try {
    provider = window.solana;
    const { publicKey } = await provider.connect();
    pubkey = publicKey;
    walletAddr.textContent = publicKey.toBase58();
    await refreshBalances();
  } catch (e) {
    console.error(e);
    alert("Wallet-Verbindung abgebrochen.");
  }
});

inpAmount.addEventListener("input", () => {
  const usdc = Number(inpAmount.value || "0");
  expectedInpi.textContent = calcExpectedInpi(usdc);
});

btnHowTo.addEventListener("click", () => {
  alert("Kurzanleitung:\n1) Phantom verbinden\n2) USDC auf die angezeigte Presale-Adresse einzahlen (Intent prüfen)\n3) Nach TGE Claim deiner INPI laut Zuteilung");
});

btnPresaleIntent.addEventListener("click", async () => {
  if (!pubkey) return alert("Bitte zuerst mit Phantom verbinden.");
  const usdc = Number(inpAmount.value || "0");
  if (!usdc || usdc <= 0) return alert("Bitte gültigen USDC-Betrag eingeben.");

  intentMsg.textContent = "Prüfe Caps & weise Presale-Adresse zu …";
  try {
    const res = await fetch(`${CFG.API_BASE}/presale/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: pubkey.toBase58(),
        amount_usdc: usdc
      })
    });
    const j = await res.json();
    if (j?.ok) {
      intentMsg.innerHTML =
        `✅ OK. Sende <b>${fmt(usdc, 2)} USDC</b> an: <code>${j.deposit_address}</code><br>` +
        `<small>Dein persönliches Presale-Konto. Einzahlungen werden on-chain getrackt.</small>`;
    } else {
      intentMsg.innerHTML = `❌ ${j?.error || "Fehler beim Intent"}`;
    }
  } catch (e) {
    console.error(e);
    intentMsg.textContent = "API nicht erreichbar.";
  }
});

async function getSplBalance(mint, owner) {
  // via RPC-Proxy (Worker) -> getTokenAccountsByOwner
  const out = await fetch(CFG.RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [owner.toBase58(), { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]
    })
  }).then(r => r.json());
  const arr = out?.result?.value || [];
  let raw = 0n, decimals = 0;
  for (const it of arr) {
    const info = it?.account?.data?.parsed?.info;
    if (!info) continue;
    const uiAmt = info?.tokenAmount;
    decimals = Number(uiAmt?.decimals || 0);
    raw += BigInt(uiAmt?.amount || "0");
  }
  const den = BigInt(10) ** BigInt(decimals);
  return Number(raw) / Number(den);
}

async function refreshBalances() {
  if (!pubkey) return;
  try {
    const [u, i] = await Promise.all([
      getSplBalance(CFG.USDC_MINT, pubkey),
      getSplBalance(CFG.INPI_MINT, pubkey),
    ]);
    usdcBal.textContent = fmt(u, 2) + " USDC";
    inpiBal.textContent = fmt(i, 2) + " INPI";
  } catch (e) {
    console.error(e);
    usdcBal.textContent = "—";
    inpiBal.textContent = "—";
  }
}

window.addEventListener("load", init);