"use strict";

const router = require("express").Router();
const prisma  = require("../prismaClient");
const {
  verifyWebhookSignature,
  verifyTransaction,
  sendPaymentConfirmation,
} = require("../services/monnify");
const {
  creditWallet,
  verifyWalletWebhookSignature,
} = require("../services/wallet");

router.post(
  "/",
  require("express").raw({ type: "application/json" }),
  async (req, res) => {

    const signature = req.headers["monnify-signature"];
    const rawBody   = req.body;

    if (!signature) {
      console.warn("[Monnify Webhook] Missing signature");
      return res.status(400).json({ error: "Missing signature" });
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn("[Monnify Webhook] Invalid signature — rejected");
      return res.status(401).json({ error: "Invalid signature" });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const { eventType, eventData } = payload;

    console.log(`[Monnify Webhook] Event: ${eventType}`);
    console.log("[Monnify Webhook] Full payload:", JSON.stringify(payload, null, 2));

    // Acknowledge immediately
    res.status(200).json({ received: true });

    const SUCCESS_EVENTS = [
      "SUCCESSFUL_TRANSACTION",
      "PAYMENT_STATUS_CHANGED",
      "SUCCESSFUL_PAYMENT",
    ];

    if (!SUCCESS_EVENTS.includes(eventType)) {
      console.log(`[Monnify Webhook] Ignoring event: ${eventType}`);
      return;
    }

    if (
      eventType === "PAYMENT_STATUS_CHANGED" &&
      eventData?.paymentStatus !== "PAID"
    ) {
      console.log(`[Monnify Webhook] Status not PAID — skipping`);
      return;
    }

    /* ══════════════════════════════════════════════
       ROUTE BY PRODUCT TYPE
       ──────────────────────────────────────────────
       RESERVED_ACCOUNT → wallet top-up
       Everything else  → booking payment
    ══════════════════════════════════════════════ */
    const productType = eventData?.product?.type || "";
    const productRef  = eventData?.product?.reference || "";

    if (productType === "RESERVED_ACCOUNT" && productRef.startsWith("WALLET-")) {
      return handleWalletTopUp({ eventData, productRef, payload });
    }

    return handleBookingPayment({ eventType, eventData, payload });
  }
);

/* ══════════════════════════════════════════════
   WALLET TOP-UP HANDLER
══════════════════════════════════════════════ */
async function handleWalletTopUp({ eventData, productRef, payload }) {
  // productRef = "WALLET-WFUND-xxx" → strip prefix to get stored reference
  const reference  = productRef.replace(/^WALLET-/, "");
  const amountPaid = Number(eventData?.amountPaid || eventData?.amount || 0);

  console.log(`[Wallet Webhook] Processing top-up | Ref: ${reference} | Amount: ₦${amountPaid}`);

  try {
    const transaction = await prisma.walletTransaction.findUnique({
      where: { reference },
    });

    if (!transaction) {
      console.warn(`[Wallet Webhook] No transaction found for reference: "${reference}"`);
      return;
    }

    if (transaction.status === "SUCCESS") {
      console.log(`[Wallet Webhook] Already credited: ${reference} — skipping`);
      return;
    }

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
}

/* ══════════════════════════════════════════════
   BOOKING PAYMENT HANDLER
══════════════════════════════════════════════ */
async function handleBookingPayment({ eventType, eventData, payload }) {
  const paymentReference = eventData?.accountReference
    || eventData?.paymentReference
    || "UNKNOWN";

  const transactionReference = eventData?.transactionReference || "";

  console.log(`[Booking Webhook] Processing payment | Ref: ${paymentReference}`);

  try {
    const existing = await prisma.webhookLog.findUnique({
      where: { eventId: paymentReference },
    });

    if (existing?.processed) {
      console.log(`[Booking Webhook] Already processed: ${paymentReference}`);
      return;
    }

    await prisma.webhookLog.upsert({
      where:  { eventId: paymentReference },
      create: {
        eventId:   paymentReference,
        provider:  "MONNIFY",
        event:     eventType,
        processed: false,
      },
      update: {},
    });

    if (transactionReference) {
      try {
        const verified = await verifyTransaction(transactionReference);
        if (verified.paymentStatus !== "PAID") {
          console.log(`[Booking Webhook] API verify: not PAID — skipping`);
          return;
        }
      } catch (verifyErr) {
        console.error("[Booking Webhook] Verify failed:", verifyErr.message);
        console.log("[Booking Webhook] Proceeding without verification (sandbox)");
      }
    }

    const bookings = await prisma.booking.findMany({
      where:   { paymentReference },
      include: {
        trip: { include: { branch: { include: { park: true } } } },
      },
    });

    if (!bookings.length) {
      console.warn(`[Booking Webhook] No bookings for ref: ${paymentReference}`);
      await prisma.webhookLog.update({
        where: { eventId: paymentReference },
        data:  { processed: true },
      });
      return;
    }

    const paidAtDate = eventData?.paidOn ? new Date(eventData.paidOn) : new Date();
    const amountPaid = eventData?.amountPaid || eventData?.amount || 0;
    const rawJson    = JSON.stringify(payload);

    await prisma.$transaction(async (tx) => {
      await tx.booking.updateMany({
        where: { paymentReference },
        data: {
          paymentStatus:    "PAID",
          status:           "CONFIRMED",
          paidAt:           paidAtDate,
          paymentMethod:    "ONLINE",
          monnifyReference: transactionReference || null,
        },
      });

      for (const booking of bookings) {
        await tx.payment.upsert({
          where:  { bookingId: booking.id },
          create: {
            bookingId:         booking.id,
            provider:          "MONNIFY",
            providerReference: transactionReference || null,
            amount:            amountPaid || booking.totalAmount || 0,
            status:            "PAID",
            rawPayload:        rawJson,
          },
          update: {
            providerReference: transactionReference || null,
            amount:            amountPaid || booking.totalAmount || 0,
            status:            "PAID",
            rawPayload:        rawJson,
          },
        });
      }

      await tx.webhookLog.update({
        where: { eventId: paymentReference },
        data:  { processed: true },
      });
    });

    console.log(`[Booking Webhook] ✅ ${bookings.length} booking(s) confirmed — ref: ${paymentReference}`);

    for (const booking of bookings) {
      await sendPaymentConfirmation(booking);
    }

  } catch (err) {
    console.error("[Booking Webhook] Processing error:", err.message, err.stack);
  }
}

module.exports = router;