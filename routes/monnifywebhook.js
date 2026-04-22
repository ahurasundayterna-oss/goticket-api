/**
 * routes/monnifyWebhook.js
 *
 * Receives Monnify payment notifications after a passenger transfers funds.
 *
 * Flow:
 *   1. Verify HMAC-SHA512 signature to reject spoofed requests
 *   2. Only process PAID events (ignore FAILED / OVERPAID / REVERSED silently)
 *   3. Re-verify the transaction against Monnify API (never trust webhook alone)
 *   4. Find all bookings sharing the paymentReference
 *   5. Mark them PAID, set paidAt, mark seat confirmed
 *   6. Log receipt data
 *
 * Mount in app.js:
 *   app.use("/api/monnify/webhook", require("./routes/monnifyWebhook"));
 *
 * IMPORTANT: This route must receive the raw (unparsed) request body for
 * signature verification. Mount it BEFORE express.json() or use a
 * separate raw-body middleware on this path. See app.js addition notes.
 */

const router = require("express").Router();
const prisma  = require("../prismaClient");
const { verifyWebhookSignature, verifyTransaction } = require("../services/monnify");

/* ══════════════════════════════════════════
   MONNIFY PAYMENT WEBHOOK
══════════════════════════════════════════ */
router.post(
  "/",
  // Raw body middleware — needed only on this route for HMAC verification
  // express.raw() captures the body before JSON.parse mutates it
  require("express").raw({ type: "application/json" }),
  async (req, res) => {

    // ── 1. Signature verification ──────────────────────────────────────────
    const signature = req.headers["monnify-signature"];
    const rawBody   = req.body; // Buffer when using express.raw()

    if (!signature) {
      console.warn("[Monnify Webhook] Missing signature header — rejected");
      return res.status(400).json({ error: "Missing signature" });
    }

    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      console.warn("[Monnify Webhook] Invalid signature — rejected");
      return res.status(401).json({ error: "Invalid signature" });
    }

    // ── 2. Parse payload ───────────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }

    const { eventType, eventData } = payload;

    console.log(`[Monnify Webhook] Event: ${eventType} | Ref: ${eventData?.paymentReference}`);

    // ── 3. Only handle successful payment events ───────────────────────────
    // Acknowledge all events with 200 so Monnify stops retrying non-payment events
    if (eventType !== "SUCCESSFUL_TRANSACTION") {
      return res.status(200).json({ received: true });
    }

    const { paymentReference, transactionReference, amountPaid, paidOn } = eventData;

    try {
      // ── 4. Re-verify with Monnify API (don't trust webhook payload alone) ─
      const verified = await verifyTransaction(transactionReference);

      if (verified.paymentStatus !== "PAID") {
        console.log(`[Monnify Webhook] Transaction ${transactionReference} not PAID — skipping`);
        return res.status(200).json({ received: true });
      }

      // ── 5. Find bookings by paymentReference ──────────────────────────────
      // All seats in a multi-seat booking share the same paymentReference (primaryRef)
      const bookings = await prisma.booking.findMany({
        where: { paymentReference },
        include: {
          trip: {
            include: {
              branch: { include: { park: true } }
            }
          }
        }
      });

      if (!bookings.length) {
        console.warn(`[Monnify Webhook] No bookings found for reference: ${paymentReference}`);
        // Still return 200 — Monnify shouldn't keep retrying an unknown reference
        return res.status(200).json({ received: true });
      }

      const paidAtDate = paidOn ? new Date(paidOn) : new Date();

      // ── 6. Mark all matching bookings as PAID + confirmed ─────────────────
      await prisma.booking.updateMany({
        where: { paymentReference },
        data: {
          paymentStatus: "PAID",
          paidAt:        paidAtDate,
          // Seat is now confirmed — no further action needed at the terminal
        }
      });

      // ── 7. Build receipt data (logged; extend to SMS/email as needed) ─────
      const firstBooking = bookings[0];
      const trip         = firstBooking.trip;

      const receipt = {
        event:              "PAYMENT_CONFIRMED",
        generatedAt:        new Date().toISOString(),
        paymentReference,
        transactionReference,
        amountPaid,
        paidAt:             paidAtDate.toISOString(),
        passengerName:      firstBooking.passengerName,
        passengerPhone:     firstBooking.passengerPhone,
        park:               trip.branch?.park?.name,
        route:              `${trip.departureCity} → ${trip.destination}`,
        departureTime:      trip.departureTime,
        seats:              bookings.map(b => b.seatNumber),
        references:         bookings.map(b => b.reference),
        bankName:           firstBooking.bankName,
        accountNumber:      firstBooking.accountNumber,
        splitSettlement: {
          branch:   {
            subAccountCode: trip.branch?.monnifySubAccountCode,
            name:           trip.branch?.name,
            receives:       "ticket price",
          },
          goticket: {
            receives: "3% commission",
          }
        }
      };

      console.log("[Monnify Webhook] Receipt:", JSON.stringify(receipt, null, 2));

      // ── 8. Respond 200 immediately so Monnify doesn't retry ───────────────
      return res.status(200).json({ received: true });

    } catch (err) {
      console.error("[Monnify Webhook] Error processing payment:", err.message);
      // Return 200 anyway — a 500 causes Monnify to retry, which can cause
      // duplicate processing if the DB write partially succeeded
      return res.status(200).json({ received: true, warning: "Processing error logged" });
    }
  }
);

module.exports = router;