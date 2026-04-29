/**
 * jobs/expireBookings.js
 *
 * Auto-releases seats for unpaid bookings whose SeatLock has expired.
 * Run on a schedule — call startExpiryJob() in server.js on startup.
 *
 * Mount in server.js:
 *   require("./jobs/expireBookings").startExpiryJob();
 */

"use strict";

const prisma = require("../prismaClient");

async function releaseExpiredBookings() {
  try {
    const now = new Date();

    // ── Step 1: Find all expired seat locks ──────────────────────
    const expiredLocks = await prisma.seatLock.findMany({
      where: {
        expiresAt: { lt: now },
      },
      select: {
        id:         true,
        tripId:     true,
        seatNumber: true,
      },
    });

    if (!expiredLocks.length) return;

    console.log(`[ExpiryJob] Found ${expiredLocks.length} expired lock(s)...`);

    for (const lock of expiredLocks) {
      try {
        // ── Step 2: Find the matching PENDING booking ─────────────
        const booking = await prisma.booking.findFirst({
          where: {
            tripId:        lock.tripId,
            seatNumber:    lock.seatNumber,
            status:        "PENDING",
            paymentStatus: "PENDING",
          },
          select: { id: true, tripId: true, reference: true },
        });

        await prisma.$transaction(async (tx) => {
          // ── Step 3: Cancel the booking if found ──────────────────
          if (booking) {
            await tx.booking.update({
              where: { id: booking.id },
              data:  {
                status:        "CANCELLED",
                paymentStatus: "FAILED",
              },
            });

            // Mark Payment record as EXPIRED if it exists
            await tx.payment.updateMany({
              where: {
                bookingId: booking.id,
                status:    "PENDING",
              },
              data: { status: "EXPIRED" },
            }).catch(() => {}); // safe — ignore if Payment row doesn't exist

            // Decrement seatsBooked on the trip
            await tx.trip.update({
              where: { id: lock.tripId },
              data:  { seatsBooked: { decrement: 1 } },
            });

            console.log(`[ExpiryJob] Cancelled expired booking: ${booking.reference}`);
          }

          // ── Step 4: Always delete the expired lock ────────────────
          await tx.seatLock.delete({
            where: { id: lock.id },
          });
        });

      } catch (innerErr) {
        // Log per-lock errors but keep processing the rest
        console.error(`[ExpiryJob] Error processing lock ${lock.id}:`, innerErr.message);
      }
    }

  } catch (err) {
    console.error("[ExpiryJob] Error:", err.message);
  }
}

function startExpiryJob() {
  console.log("[ExpiryJob] Seat expiry job started — runs every 60s");
  releaseExpiredBookings();
  setInterval(releaseExpiredBookings, 60 * 1000);
}

module.exports = { startExpiryJob, releaseExpiredBookings };