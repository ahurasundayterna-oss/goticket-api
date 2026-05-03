// backend/services/wallet.js
"use strict";

const axios  = require("axios");
const crypto = require("crypto");
const prisma = require("../prismaClient");

const BOOKING_FEE      = 50;
const LOW_BALANCE_WARN = 1000;
const BASE_URL         = process.env.MONNIFY_BASE_URL     || "https://sandbox.monnify.com";
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
   Strategy: DB-first.

   Monnify reserved accounts are permanent per
   customer. We store the account details on the
   Branch record (walletAccountNumber / walletBankName /
   walletAccountName) after first creation and read
   from DB on every subsequent request — Monnify
   is only called once per branch, ever.
══════════════════════════════════════════════ */
async function initiateMonnifyFunding({ branchId, branchName, amount, reference }) {
  // ── 1. Check DB — return stored account if it exists ────────────
  const branch = await prisma.branch.findUnique({
    where:  { id: branchId },
    select: {
      walletAccountNumber: true,
      walletBankName:      true,
      walletAccountName:   true,
    },
  });

  if (branch?.walletAccountNumber && branch?.walletBankName) {
    console.log(`[Monnify] ✅ Returning stored wallet account for ${branchName}`);
    return {
      accountNumber: branch.walletAccountNumber,
      bankName:      branch.walletBankName,
      accountName:   branch.walletAccountName,
      reference,
    };
  }

  // ── 2. No stored account — create one on Monnify ────────────────
  const token         = await getMonnifyToken();
  const customerEmail = `wallet.${branchId.slice(0, 8)}@goticket.ng`;
  const acctRef       = `WALLET-${customerEmail}`;

  const payload = {
    accountReference:    acctRef,
    accountName:         `GoTicket Wallet — ${branchName}`,
    customerEmail,
    customerName:        branchName,
    currencyCode:        "NGN",
    contractCode:        CONTRACT_CODE,
    getAllAvailableBanks: true,
    description:         `GoTicket wallet top-up — ₦${amount}`,
  };

  console.log("[Monnify] Creating reserved account:", JSON.stringify(payload, null, 2));
  const body = await createMonnifyReservedAccount(token, payload);
  console.log(`[Monnify] ✅ Reserved account created for ${branchName}`);

  const account     = Array.isArray(body.accounts) && body.accounts.length
    ? body.accounts[0]
    : body;
  const accountName = body.accountName || `GoTicket Wallet — ${branchName}`;

  // ── 3. Persist to Branch — never call Monnify for this again ────
  await prisma.branch.update({
    where: { id: branchId },
    data: {
      walletAccountNumber: account.accountNumber,
      walletBankName:      account.bankName,
      walletAccountName:   accountName,
    },
  });

  console.log(
    `[Monnify] Stored wallet account for ${branchName} | ` +
    `${account.bankName} — ${account.accountNumber}`
  );

  return {
    accountNumber: account.accountNumber,
    bankName:      account.bankName,
    accountName,
    reference,
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
  verifyWalletWebhookSignature,
  retryMissingSubAccounts,
  BOOKING_FEE,
  LOW_BALANCE_WARN,
};