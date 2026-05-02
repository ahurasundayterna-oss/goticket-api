"use strict";

const axios  = require("axios");
const crypto = require("crypto");

const BASE_URL      = process.env.MONNIFY_BASE_URL   || "https://sandbox.monnify.com";
const API_KEY       = process.env.MONNIFY_API_KEY;
const SECRET_KEY    = process.env.MONNIFY_SECRET_KEY;
const CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

const COMMISSION_RATE = 0.03;

/* ── Auth token cache ─────────────────────────────────────────── */
let _cachedToken    = null;
let _tokenExpiresAt = 0;

async function getAuthToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt) return _cachedToken;

  const credentials = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString("base64");

  const { data } = await axios.post(
    `${BASE_URL}/api/v1/auth/login`,
    {},
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify auth failed: ${data.responseMessage}`);
  }

  _cachedToken    = data.responseBody.accessToken;
  _tokenExpiresAt = now + (data.responseBody.expiresIn - 60) * 1000;

  return _cachedToken;
}

/* ── Amount helper ────────────────────────────────────────────── */
function calculateAmounts(ticketPrice) {
  const commission  = Math.round(ticketPrice * COMMISSION_RATE * 100) / 100;
  const totalAmount = Math.round((ticketPrice + commission) * 100) / 100;
  return { ticketPrice, commission, totalAmount };
}

/* ── Webhook signature verification ──────────────────────────── */
function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

/* ══════════════════════════════════════════════
   BANK CODE MAP
   ──────────────────────────────────────────────
   Maps common Nigerian bank names to Monnify
   bank codes. Add more as needed.
   Full list: https://developers.monnify.com
══════════════════════════════════════════════ */
const BANK_CODE_MAP = {
  // Commercial Banks
  "access bank":               "044",
  "access":                    "044",
  "citibank":                  "023",
  "ecobank":                   "050",
  "fidelity bank":             "070",
  "fidelity":                  "070",
  "first bank":                "011",
  "first bank of nigeria":     "011",
  "fbn":                       "011",
  "first city monument bank":  "214",
  "fcmb":                      "214",
  "gtbank":                    "058",
  "guaranty trust bank":       "058",
  "gt bank":                   "058",
  "gtco":                      "058",
  "heritage bank":             "030",
  "keystone bank":             "082",
  "opay":                      "999992",
  "palmpay":                   "999991",
  "polaris bank":              "076",
  "providus bank":             "101",
  "stanbic ibtc":              "221",
  "stanbic ibtc bank":         "221",
  "standard chartered":        "068",
  "sterling bank":             "232",
  "sterling":                  "232",
  "suntrust bank":             "100",
  "taj bank":                  "302",
  "titan trust bank":          "102",
  "union bank":                "032",
  "union bank of nigeria":     "032",
  "united bank for africa":    "033",
  "uba":                       "033",
  "unity bank":                "215",
  "wema bank":                 "035",
  "wema":                      "035",
  "alat":                      "035",
  "zenith bank":               "057",
  "zenith":                    "057",
  // Microfinance / Fintech
  "kuda":                      "50211",
  "kuda bank":                 "50211",
  "moniepoint":                "50515",
  "moniepoint mfb":            "50515",
  "carbon":                    "565",
  "vfd microfinance":          "566",
  "rubies bank":               "125",
  "mint finex mfb":            "50304",
};

/**
 * Resolve bank name string → Monnify bank code.
 * Case-insensitive. Throws if not found.
 */
function resolveBankCode(bankName) {
  if (!bankName) throw new Error("bankName is required to resolve bank code");

  const key  = bankName.trim().toLowerCase();
  const code = BANK_CODE_MAP[key];

  if (!code) {
    throw new Error(
      `Unsupported bank: "${bankName}". ` +
      `Add it to BANK_CODE_MAP in services/monnify.js. ` +
      `Full list: https://developers.monnify.com/docs/banks`
    );
  }

  return code;
}

/* ══════════════════════════════════════════════
   CREATE SUB-ACCOUNT FOR BRANCH
   ──────────────────────────────────────────────
   Called automatically when a new branch is
   created. Registers the branch's bank account
   as a Monnify sub-account so that passenger
   payments route directly to the branch.

   @param {object} branch  Prisma Branch record
     branch.id
     branch.name
     branch.accountNumber   (branch bank acct)
     branch.bankName        (human-readable)
     branch.accountName     (account holder name)

   @returns {string} subAccountCode  e.g. "MFY_SUB_xxx"
   @throws  {Error}  on API failure or missing fields
══════════════════════════════════════════════ */
async function createSubAccountForBranch(branch) {
  const { id, name, accountNumber, bankName, accountName } = branch;

  // ── Guard: fields must exist before calling Monnify ──────────
  if (!accountNumber || !accountNumber.trim()) {
    throw new Error(`Branch "${name}" has no accountNumber — skipping sub-account creation`);
  }
  if (!bankName || !bankName.trim()) {
    throw new Error(`Branch "${name}" has no bankName — skipping sub-account creation`);
  }

  const bankCode = resolveBankCode(bankName); // throws if unsupported

  console.log(`[Monnify] Creating sub-account for branch: "${name}" (${id})`);
  console.log(`[Monnify] Bank: ${bankName} → code: ${bankCode} | Account: ${accountNumber}`);

  const token = await getAuthToken();

  const payload = {
    currencyCode: "NGN",
    contractCode: CONTRACT_CODE,
    subAccountList: [
      {
        // Unique reference for this sub-account
        accountReference:  `BRANCH-${id}`,
        accountName:       accountName || name,
        currencyCode:      "NGN",
        contractCode:      CONTRACT_CODE,
        customerEmail:     `branch.${id.slice(0, 8)}@goticket.ng`,
        customerName:      accountName || name,
        bankCode,
        accountNumber:     accountNumber.trim(),
        splitPercentage:   100,      // 100% of payment goes to branch
      },
    ],
  };

  console.log("[Monnify] Sub-account payload:", JSON.stringify(payload, null, 2));

  const { data } = await axios.post(
    `${BASE_URL}/api/v1/sub-accounts`,
    payload,
    {
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  console.log("[Monnify] Sub-account API response:", JSON.stringify(data, null, 2));

  if (!data.requestSuccessful) {
    throw new Error(`Monnify sub-account creation failed: ${data.responseMessage}`);
  }

  // Monnify returns an array — grab the first item
  const subAccountList = data.responseBody;
  const created = Array.isArray(subAccountList)
    ? subAccountList[0]
    : subAccountList;

  const subAccountCode = created?.subAccountCode;

  if (!subAccountCode) {
    throw new Error("Monnify returned no subAccountCode in response");
  }

  console.log(`[Monnify] ✅ Sub-account created for "${name}": ${subAccountCode}`);

  return subAccountCode;
}

/* ══════════════════════════════════════════════
   RETRY: branches with missing subAccountCode
   ──────────────────────────────────────────────
   Call this from an admin route or cron job
   to backfill branches that failed on creation.

   Usage:
     const prisma = require("../prismaClient");
     await retryMissingSubAccounts(prisma);
══════════════════════════════════════════════ */
async function retryMissingSubAccounts(prisma) {
  const branches = await prisma.branch.findMany({
    where: {
      monnifySubAccountCode: null,
      accountNumber: { not: null },
      bankName:      { not: null },
    },
  });

  if (!branches.length) {
    console.log("[Monnify Retry] No branches missing sub-account codes.");
    return;
  }

  console.log(`[Monnify Retry] Found ${branches.length} branch(es) to backfill.`);

  for (const branch of branches) {
    try {
      const subAccountCode = await createSubAccountForBranch(branch);
      await prisma.branch.update({
        where: { id: branch.id },
        data:  { monnifySubAccountCode: subAccountCode },
      });
      console.log(`[Monnify Retry] ✅ Backfilled: ${branch.name} → ${subAccountCode}`);
    } catch (err) {
      console.error(`[Monnify Retry] ❌ Failed for "${branch.name}": ${err.message}`);
      // Continue to next branch — never stop the loop
    }
  }
}

/* ── Create reserved virtual account ─────────────────────────── */
async function createVirtualAccount({
  reference,
  passengerName,
  passengerPhone,
  ticketPrice,
  description,
  subAccountCode,
}) {
  const token = await getAuthToken();
  const { totalAmount } = calculateAmounts(ticketPrice);

  const safePhone = passengerPhone.replace(/\D/g, "");

  const payload = {
    accountReference:    reference,
    accountName:         passengerName,
    customerEmail:       `${safePhone}@goticket.ng`,
    customerName:        passengerName,
    currencyCode:        "NGN",
    contractCode:        CONTRACT_CODE,
    getAllAvailableBanks: true,
    description:         description || `GoTicket booking — ${reference}`,
  };

  if (subAccountCode) {
    payload.incomeSplitConfig = [
      {
        subAccountCode,
        feePercentage:   0,
        splitPercentage: 100,
        feeBearer:       false,
      },
    ];
    console.log(`[Monnify] Routing payment to sub-account: ${subAccountCode}`);
  } else {
    console.warn("[Monnify] No subAccountCode — payment goes to main account");
  }

  const { data } = await axios.post(
    `${BASE_URL}/api/v2/bank-transfer/reserved-accounts`,
    payload,
    {
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify virtual account failed: ${data.responseMessage}`);
  }

  const body    = data.responseBody;
  const account = Array.isArray(body.accounts) && body.accounts.length
    ? body.accounts[0]
    : body;

  return {
    accountNumber:    account.accountNumber,
    bankName:         account.bankName,
    totalAmount,
    paymentReference: reference,
  };
}

/* ── Verify transaction ───────────────────────────────────────── */
async function verifyTransaction(transactionReference) {
  const token   = await getAuthToken();
  const encoded = encodeURIComponent(transactionReference);

  const { data } = await axios.get(
    `${BASE_URL}/api/v2/transactions/${encoded}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify verify failed: ${data.responseMessage}`);
  }

  return data.responseBody;
}

/* ── Send WhatsApp confirmation ───────────────────────────────── */
async function sendPaymentConfirmation(booking) {
  try {
    const twilio = require("twilio")(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const trip = booking.trip;

    const formatDate = (d) => new Date(d).toLocaleDateString("en-NG", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      timeZone: "Africa/Lagos",
    });
    const formatTime = (d) => new Date(d).toLocaleTimeString("en-NG", {
      hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
    });
    const fmtCurrency = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");

    const message =
`✅ *Payment Confirmed!*

Your seat is now CONFIRMED. Show this at the terminal.

━━━━━━━━━━━━━━━━━━━━
🎟️ *GoTicket Receipt*
━━━━━━━━━━━━━━━━━━━━
👤 ${booking.passengerName}
🎫 Ref: *${booking.reference}*
🚌 ${trip?.branch?.park?.name || "GoTicket"}
📍 ${trip?.departureCity} → ${trip?.destination}
📅 ${trip?.departureTime ? formatDate(trip.departureTime) : "—"}
⏰ ${trip?.departureTime ? formatTime(trip.departureTime) : "—"}
💺 Seat ${booking.seatNumber}
💰 ${fmtCurrency(booking.totalAmount)} — PAID ✓
━━━━━━━━━━━━━━━━━━━━

Safe travels! 🙏
Type *menu* for a new booking.`;

    let to = booking.passengerPhone.replace(/\s/g, "");
    if (!to.startsWith("+")) to = "+234" + to.replace(/^0/, "");

    await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   `whatsapp:${to}`,
      body: message,
    });

    console.log(`[Monnify] WhatsApp confirmation sent to ${to}`);
  } catch (err) {
    console.error("[Monnify] WhatsApp send failed:", err.message);
  }
}

module.exports = {
  getAuthToken,
  createVirtualAccount,
  createSubAccountForBranch,  // ← NEW
  retryMissingSubAccounts,    // ← NEW
  verifyTransaction,
  verifyWebhookSignature,
  calculateAmounts,
  sendPaymentConfirmation,
};