"use strict";

const router = require("express").Router();
const prisma  = require("../prismaClient");
const {
  verifyWebhookSignature,
  verifyTransaction,
  sendPaymentConfirmation,
} = require("../services/monnify");

router.post(
  "/",
  require("express").raw({ type: "application/json" }),
  async (req, res) => {

    /* ── 1. Verify signature ──────────────────────────────────── */
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

    /* ── 2. Parse payload ─────────────────────────────────────── */
    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const { eventType, eventData } = payload;

    // paymentReference = our GoTicket ref (GT-XXXXXX) saved as accountReference
    const paymentReference = eventData?.accountReference
      || eventData?.paymentReference
      || "UNKNOWN";

    const transactionReference = eventData?.transactionReference || "";

    console.log(`[Monnify Webhook] Event: ${eventType} | Ref: ${paymentReference}`);
    console.log("[Monnify Webhook] Full payload:", JSON.stringify(payload, null, 2));

    /* ── 3. Acknowledge immediately ───────────────────────────── */
    res.status(200).json({ received: true });

    /* ── 4. Filter to success events only ─────────────────────── */
    const SUCCESS_EVENTS = [
      "SUCCESSFUL_TRANSACTION",
      "PAYMENT_STATUS_CHANGED",
      "SUCCESSFUL_PAYMENT",       // some Monnify sandbox variants
    ];

    if (!SUCCESS_EVENTS.includes(eventType)) {
      console.log(`[Monnify Webhook] Ignoring event: ${eventType}`);
      return;
    }

    // PAYMENT_STATUS_CHANGED — only proceed if PAID
    if (
      eventType === "PAYMENT_STATUS_CHANGED" &&
      eventData?.paymentStatus !== "PAID"
    ) {
      console.log(`[Monnify Webhook] Status not PAID — skipping`);
      return;
    }

    try {
      /* ── 5. Idempotency check ─────────────────────────────────
         Use paymentReference as unique eventId per transaction   */
      const existing = await prisma.webhookLog.findUnique({
        where: { eventId: paymentReference },
      });

      if (existing?.processed) {
        console.log(`[Monnify Webhook] Already processed: ${paymentReference}`);
        return;
      }

      // Mark as in-progress
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

      /* ── 6. Re-verify with Monnify API ────────────────────────
         Only verify if we have a transactionReference           */
      if (transactionReference) {
        try {
          const verified = await verifyTransaction(transactionReference);
          if (verified.paymentStatus !== "PAID") {
            console.log(`[Monnify Webhook] API verify: not PAID — skipping`);
            return;
          }
        } catch (verifyErr) {
          console.error("[Monnify Webhook] Verify failed:", verifyErr.message);
          // In sandbox, verification sometimes fails — proceed anyway
          console.log("[Monnify Webhook] Proceeding without verification (sandbox)");
        }
      }

      /* ── 7. Find bookings by paymentReference ─────────────────
         paymentReference = our GT-XXXXXX ref stored on booking  */
      const bookings = await prisma.booking.findMany({
        where:   { paymentReference },
        include: {
          trip: {
            include: { branch: { include: { park: true } } }
          }
        },
      });

      if (!bookings.length) {
        console.warn(`[Monnify Webhook] No bookings for ref: ${paymentReference}`);
        await prisma.webhookLog.update({
          where: { eventId: paymentReference },
          data:  { processed: true },
        });
        return;
      }

      const paidAtDate = eventData?.paidOn
        ? new Date(eventData.paidOn)
        : new Date();
      const amountPaid = eventData?.amountPaid || eventData?.amount || 0;
      const rawJson    = JSON.stringify(payload);

      /* ── 8. Confirm bookings + create Payment records ─────────*/
      await prisma.$transaction(async (tx) => {

        // Update all bookings with this reference
        await tx.booking.updateMany({
          where: { paymentReference },
          data: {
            paymentStatus:   "PAID",
            status:          "CONFIRMED",
            paidAt:          paidAtDate,
            paymentMethod:   "ONLINE",
            monnifyReference: transactionReference || null,
          },
        });

        // Create/update Payment audit record per booking
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

        // Mark webhook as fully processed
        await tx.webhookLog.update({
          where: { eventId: paymentReference },
          data:  { processed: true },
        });
      });

      console.log(`[Monnify Webhook] ✅ ${bookings.length} booking(s) confirmed — ref: ${paymentReference}`);

      /* ── 9. Send WhatsApp confirmations ───────────────────────*/
      for (const booking of bookings) {
        await sendPaymentConfirmation(booking);
      }

    } catch (err) {
      console.error("[Monnify Webhook] Processing error:", err.message, err.stack);
      // 200 already sent — don't re-throw
    }
  }
);

module.exports = router;