// backend/services/wallet.js
"use strict";

const axios  = require("axios");
const crypto = require("crypto");

const BOOKING_FEE      = 50;
const LOW_BALANCE_WARN = 1000;
const BASE_URL         = process.env.MONNIFY_BASE_URL   || "https://sandbox.monnify.com";
const CONTRACT_CODE    = process.env.MONNIFY_CONTRACT_CODE;
const SECRET_KEY       = process.env.MONNIFY_SECRET_KEY;

/* ══════════════════════════════════════════════
   checkAndDeductWallet
   Called inside a Prisma $transaction during
   booking creation. Atomic wallet deduction.
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
   Credits wallet after confirmed payment.
   Must be called inside a $transaction.
══════════════════════════════════════════════ */
async function creditWallet(tx, branchId, amount, reference, description) {
  const updated = await tx.branch.update({
    where: { id: branchId },
    data:  { walletBalance: { increment: amount } },
  });

  // Mark the pending transaction as SUCCESS
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
   initiateMonnifyFunding
   Creates a Monnify reserved account for
   the branch to transfer their top-up into.
══════════════════════════════════════════════ */
async function initiateMonnifyFunding({ branchId, branchName, amount, reference }) {
  // Get fresh auth token
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

  const token      = authRes.data.responseBody.accessToken;
  const safeRef    = reference.replace(/[^a-zA-Z0-9_-]/g, "");
  const safePhone  = "08000000000"; // placeholder for wallet funding

  const payload = {
    accountReference:    `WALLET-${safeRef}`,
    accountName:         `GoTicket Wallet — ${branchName}`,
    customerEmail:       `wallet.${branchId.slice(0, 8)}@goticket.ng`,
    customerName:        branchName,
    currencyCode:        "NGN",
    contractCode:        CONTRACT_CODE,
    getAllAvailableBanks: true,
    description:         `GoTicket wallet top-up — ₦${amount}`,
  };

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
    throw new Error(`Monnify funding init failed: ${data.responseMessage}`);
  }

  const body    = data.responseBody;
  const account = Array.isArray(body.accounts) && body.accounts.length
    ? body.accounts[0]
    : body;

  return {
    accountNumber: account.accountNumber,
    bankName:      account.bankName,
    accountName:   body.accountName,
    reference:     safeRef,
  };
}

/* ══════════════════════════════════════════════
   verifyWalletWebhookSignature
   Verifies the Monnify HMAC-SHA512 signature
   on incoming wallet webhook payloads.
══════════════════════════════════════════════ */
function verifyWalletWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

/* ══════════════════════════════════════════════
   retryMissingSubAccounts (unchanged helper)
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