// backend/services/wallet.js
"use strict";

const axios  = require("axios");
const crypto = require("crypto");
const prisma = require("../prismaClient");

const BOOKING_FEE      = 50;
const LOW_BALANCE_WARN = 1000;
const BASE_URL         = process.env.MONNIFY_BASE_URL    || "https://sandbox.monnify.com";
const CONTRACT_CODE    = process.env.MONNIFY_CONTRACT_CODE;
const SECRET_KEY       = process.env.MONNIFY_SECRET_KEY;

/* ══════════════════════════════════════════════
   getMonnifyToken
══════════════════════════════════════════════ */
async function getMonnifyToken() {
  const credentials = Buffer.from(
    `${process.env.MONNIFY_API_KEY}:${SECRET_KEY}`
  ).toString("base64");

  const authRes = await axios.post(
    `${BASE_URL}/api/v1/auth/login`,
    {},
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (!authRes.data.requestSuccessful) {
    throw new Error(`Monnify auth failed: ${authRes.data.responseMessage}`);
  }

  return authRes.data.responseBody.accessToken;
}

/* ══════════════════════════════════════════════
   checkAndDeductWallet
══════════════════════════════════════════════ */
async function checkAndDeductWallet(tx, branchId, reference) {
  const branch = await tx.branch.findUnique({
    where:  { id: branchId },
    select: { id: true, name: true, walletBalance: true, walletEnabled: true },
  });

  if (!branch) throw new Error("Branch not found");

  if (!branch.walletEnabled) {
    console.log(`[Wallet] Branch "${branch.name}" wallet disabled — skipping`);
    return branch;
  }

  if (branch.walletBalance < BOOKING_FEE) {
    throw new Error(
      `Insufficient wallet balance. Current: ₦${branch.walletBalance}. ` +
      `Required: ₦${BOOKING_FEE}. Please top up your wallet.`
    );
  }

  const updated = await tx.branch.update({
    where: { id: branchId },
    data:  { walletBalance: { decrement: BOOKING_FEE } },
  });

  await tx.walletTransaction.create({
    data: {
      branchId,
      amount:      BOOKING_FEE,
      type:        "DEBIT",
      status:      "SUCCESS",
      reference,
      description: `Booking fee — ref: ${reference}`,
    },
  });

  if (updated.walletBalance < LOW_BALANCE_WARN) {
    console.warn(
      `[Wallet] ⚠️ LOW BALANCE — Branch "${branch.name}": ` +
      `₦${updated.walletBalance} remaining. ` +
      `~${Math.floor(updated.walletBalance / BOOKING_FEE)} bookings left.`
    );
  }

  return updated;
}

/* ══════════════════════════════════════════════
   creditWallet
══════════════════════════════════════════════ */
async function creditWallet(tx, branchId, amount, reference, description) {
  const updated = await tx.branch.update({
    where: { id: branchId },
    data:  { walletBalance: { increment: amount } },
  });

  await tx.walletTransaction.updateMany({
    where: { reference, branchId, status: "PENDING" },
    data:  { status: "SUCCESS" },
  });

  console.log(
    `[Wallet] Credited ₦${amount} to branch ${branchId} | ` +
    `New balance: ₦${updated.walletBalance} | Ref: ${reference}`
  );

  return updated;
}

/* ══════════════════════════════════════════════
   createMonnifyReservedAccount
   Internal helper — single POST attempt.
══════════════════════════════════════════════ */
async function createMonnifyReservedAccount(token, payload) {
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
    const err = new Error(`Monnify funding init failed: ${data.responseMessage}`);
    err.monnifyResponse = data;
    throw err;
  }

  return data.responseBody;
}

/* ══════════════════════════════════════════════
   initiateMonnifyFunding
   ──────────────────────────────────────────────
   On 422 (Monnify sandbox duplicate-ref bug),
   generates a brand new ref, updates the DB row,
   and retries once. Never attempts a GET since
   sandbox always returns 404 for those.
══════════════════════════════════════════════ */
async function initiateMonnifyFunding({ branchId, branchName, amount, reference }) {
  const token   = await getMonnifyToken();
  const safeRef = reference.replace(/[^a-zA-Z0-9_-]/g, "");

  const buildPayload = (acctRef) => ({
    accountReference:    acctRef,
    accountName:         `GoTicket Wallet — ${branchName}`,
    customerEmail:       `wallet.${branchId.slice(0, 8)}@goticket.ng`,
    customerName:        branchName,
    currencyCode:        "NGN",
    contractCode:        CONTRACT_CODE,
    getAllAvailableBanks: true,
    description:         `GoTicket wallet top-up — ₦${amount}`,
  });

  let finalRef = safeRef;
  let body;

  try {
    const payload = buildPayload(`WALLET-${safeRef}`);
    console.log("[Monnify] Creating reserved account:", JSON.stringify(payload, null, 2));
    body = await createMonnifyReservedAccount(token, payload);
    console.log("[Monnify] Reserved account created: WALLET-" + safeRef);

  } catch (err) {
    if (err.response?.status !== 422) {
      console.error("[Monnify] Unexpected error:", err.response?.data || err.message);
      throw err;
    }

    // 422 — sandbox bug: ref is "taken" but unretrievable.
    // Generate a fresh ref and retry once.
    finalRef = `${safeRef}R${Date.now()}`;
    console.warn(`[Monnify] 422 on WALLET-${safeRef} — retrying with WALLET-${finalRef}`);

    const retryPayload = buildPayload(`WALLET-${finalRef}`);
    console.log("[Monnify] Retry payload:", JSON.stringify(retryPayload, null, 2));

    try {
      body = await createMonnifyReservedAccount(token, retryPayload);
      console.log("[Monnify] Retry succeeded: WALLET-" + finalRef);

      // Update the DB transaction reference to match the new Monnify ref
      await prisma.walletTransaction.update({
        where: { reference: safeRef },
        data:  { reference: finalRef },
      });

    } catch (retryErr) {
      console.error("[Monnify] Retry failed:", retryErr.response?.data || retryErr.message);
      throw retryErr;
    }
  }

  const account = Array.isArray(body.accounts) && body.accounts.length
    ? body.accounts[0]
    : body;

  return {
    accountNumber: account.accountNumber,
    bankName:      account.bankName,
    accountName:   body.accountName,
    reference:     finalRef,
  };
}

/* ══════════════════════════════════════════════
   getExistingMonnifyAccount
   Kept for compatibility — logs clearly if it
   fails since sandbox doesn't support GET.
══════════════════════════════════════════════ */
async function getExistingMonnifyAccount(reference) {
  const token            = await getMonnifyToken();
  const accountReference = `WALLET-${reference}`;
  const encodedRef       = encodeURIComponent(accountReference);
  const url              = `${BASE_URL}/api/v2/bank-transfer/reserved-accounts/${encodedRef}`;

  console.log(`[Monnify] Fetching existing account: GET ${url}`);

  const { data } = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!data.requestSuccessful) {
    throw new Error(`Could not fetch Monnify account: ${data.responseMessage}`);
  }

  const body    = data.responseBody;
  const account = Array.isArray(body.accounts) && body.accounts.length
    ? body.accounts[0]
    : body;

  return {
    accountNumber: account.accountNumber,
    bankName:      account.bankName,
    accountName:   body.accountName,
  };
}

/* ══════════════════════════════════════════════
   verifyWalletWebhookSignature
══════════════════════════════════════════════ */
function verifyWalletWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

/* ══════════════════════════════════════════════
   retryMissingSubAccounts
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

  for (const branch of branches) {
    try {
      const { createSubAccountForBranch } = require("./monnify");
      const subAccountCode = await createSubAccountForBranch(branch);
      await prisma.branch.update({
        where: { id: branch.id },
        data:  { monnifySubAccountCode: subAccountCode },
      });
      console.log(`[Monnify Retry] ✅ ${branch.name} → ${subAccountCode}`);
    } catch (err) {
      console.error(`[Monnify Retry] ❌ ${branch.name}: ${err.message}`);
    }
  }
}

module.exports = {
  checkAndDeductWallet,
  creditWallet,
  initiateMonnifyFunding,
  getExistingMonnifyAccount,
  verifyWalletWebhookSignature,
  retryMissingSubAccounts,
  BOOKING_FEE,
  LOW_BALANCE_WARN,
};