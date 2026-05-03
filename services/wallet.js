// backend/services/wallet.js
"use strict";

const axios  = require("axios");
const crypto = require("crypto");
const prisma  = require("../prismaClient");

const BOOKING_FEE      = 50;
const LOW_BALANCE_WARN = 1000;
const BASE_URL         = process.env.MONNIFY_BASE_URL    || "https://sandbox.monnify.com";
const CONTRACT_CODE    = process.env.MONNIFY_CONTRACT_CODE;
const SECRET_KEY       = process.env.MONNIFY_SECRET_KEY;

/* ══════════════════════════════════════════════
   getMonnifyToken
   Shared auth helper — gets a fresh access token.
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
   ──────────────────────────────────────────────
   Strategy:
   1. Try to create a new reserved account.
   2. If Monnify returns 422 (duplicate accountReference),
      fetch the existing account by that reference instead.
   This makes the endpoint idempotent — safe to retry.
══════════════════════════════════════════════ */
async function initiateMonnifyFunding({ branchId, branchName, amount, reference }) {
  const token   = await getMonnifyToken();
  const safeRef = reference.replace(/[^a-zA-Z0-9_-]/g, "");
  const accountReference = `WALLET-${safeRef}`;

  const payload = {
    accountReference,
    accountName:         `GoTicket Wallet — ${branchName}`,
    customerEmail:       `wallet.${branchId.slice(0, 8)}@goticket.ng`,
    customerName:        branchName,
    currencyCode:        "NGN",
    contractCode:        CONTRACT_CODE,
    getAllAvailableBanks: true,
    description:         `GoTicket wallet top-up — ₦${amount}`,
  };

  console.log("[Monnify] Creating reserved account:", JSON.stringify(payload, null, 2));

  let body;

  try {
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
      console.error("[Monnify] Create failed:", JSON.stringify(data, null, 2));
      throw new Error(`Monnify funding init failed: ${data.responseMessage}`);
    }

    body = data.responseBody;
    console.log("[Monnify] Reserved account created:", accountReference);

  } catch (err) {
    // 422 = accountReference already exists on Monnify — fetch it instead
    if (err.response?.status === 422) {
      console.warn(
        `[Monnify] 422 — accountReference "${accountReference}" already exists. ` +
        `Fetching existing account...`
      );

      try {
        const { data: existing } = await axios.get(
          `${BASE_URL}/api/v2/bank-transfer/reserved-accounts/details`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params:  { accountReference },
          }
        );

        if (!existing.requestSuccessful) {
          console.error("[Monnify] Fetch existing failed:", JSON.stringify(existing, null, 2));
          throw new Error(`Could not fetch existing Monnify account: ${existing.responseMessage}`);
        }

        body = existing.responseBody;
        console.log("[Monnify] Reusing existing reserved account:", accountReference);

      } catch (fetchErr) {
        console.error("[Monnify] Fetch existing account error:", fetchErr.message);
        throw fetchErr;
      }

    } else {
      // Some other error — rethrow
      console.error("[Monnify] Unexpected error:", err.response?.data || err.message);
      throw err;
    }
  }

  // Extract account details — Monnify returns accounts[] array
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
   getExistingMonnifyAccount
   Fetches a previously created reserved account
   from Monnify by its accountReference.
══════════════════════════════════════════════ */
async function getExistingMonnifyAccount(reference) {
  const token            = await getMonnifyToken();
  const accountReference = `WALLET-${reference}`;
  const encodedRef       = encodeURIComponent(accountReference);

  // Monnify sandbox: GET /api/v2/bank-transfer/reserved-accounts/{accountReference}
  const url = `${BASE_URL}/api/v2/bank-transfer/reserved-accounts/${encodedRef}`;
  console.log(`[Monnify] Fetching existing account: GET ${url}`);

  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log("[Monnify] Fetch response:", JSON.stringify(data, null, 2));

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

  } catch (err) {
    const status  = err.response?.status;
    const errBody = err.response?.data;
    console.error(`[Monnify] GET reserved account failed (${status}):`, JSON.stringify(errBody || err.message));
    throw err;
  }
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