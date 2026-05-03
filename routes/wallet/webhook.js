// routes/wallet/webhook.js
"use strict";

const prisma = require("../../prismaClient");
const {
  creditWallet,
  verifyWalletWebhookSignature,
} = require("../../services/wallet");

/**
 * POST /api/wallet/webhook
 * Called by Monnify after a successful wallet top-up transfer.
 * express.raw() is applied in server.js BEFORE this handler runs,
 * so req.body is a raw Buffer here — safe for signature verification.
 */
module.exports = async function walletWebhook(req, res) {
  const signature = req.headers["monnify-signature"];
  const rawBody   = req.body; // Buffer, thanks to express.raw() in server.js

  // ── 1. Verify signature ────────────────────────────────────────
  if (!signature || !verifyWalletWebhookSignature(rawBody, signature)) {
    console.warn("[Wallet Webhook] Invalid or missing signature — rejected");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // ── 2. Parse payload ───────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  console.log("[Wallet Webhook] Received:", JSON.stringify(payload, null, 2));

  // ── 3. Acknowledge immediately (Monnify expects 200 fast) ──────
  res.status(200).json({ received: true });

  const { eventType, eventData } = payload;

  // ── 4. Filter to successful payments only ──────────────────────
  const SUCCESS_EVENTS = ["SUCCESSFUL_TRANSACTION", "PAYMENT_STATUS_CHANGED"];
  if (!SUCCESS_EVENTS.includes(eventType)) {
    console.log(`[Wallet Webhook] Ignoring event type: ${eventType}`);
    return;
  }
  if (eventType === "PAYMENT_STATUS_CHANGED" && eventData?.paymentStatus !== "PAID") {
    console.log(`[Wallet Webhook] Status not PAID — skipping`);
    return;
  }

  // ── 5. Resolve reference ───────────────────────────────────────
  // Monnify sends accountReference as "WALLET-WFUND-xxx"
  // We stored the transaction with reference "WFUND-xxx"
  const accountReference = eventData?.accountReference || "";
  const reference        = accountReference.replace(/^WALLET-/, "");
  const amountPaid       = Number(eventData?.amountPaid || eventData?.amount || 0);

  if (!reference) {
    console.warn("[Wallet Webhook] No reference found in payload — skipping");
    return;
  }

  console.log(`[Wallet Webhook] Reference resolved: "${reference}" | Amount: ₦${amountPaid}`);

  try {
    // ── 6. Find the pending wallet transaction ───────────────────
    const transaction = await prisma.walletTransaction.findUnique({
      where: { reference },
    });

    if (!transaction) {
      console.warn(`[Wallet Webhook] No transaction found for reference: "${reference}"`);
      return;
    }

    // ── 7. Idempotency guard ─────────────────────────────────────
    if (transaction.status === "SUCCESS") {
      console.log(`[Wallet Webhook] Already credited: ${reference} — skipping`);
      return;
    }

    // ── 8. Credit wallet atomically ──────────────────────────────
    const creditAmount = amountPaid || transaction.amount;

    await prisma.$transaction(async (tx) => {
      await creditWallet(
        tx,
        transaction.branchId,
        creditAmount,
        reference,
        `Wallet top-up confirmed — ₦${creditAmount}`
      );
    });

    console.log(
      `[Wallet Webhook] ✅ Credited ₦${creditAmount} to branch ${transaction.branchId} | Ref: ${reference}`
    );

  } catch (err) {
    console.error("[Wallet Webhook] Processing error:", err.message);
  }
};