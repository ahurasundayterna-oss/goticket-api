// routes/bookings.js
//
// Changes from previous version:
//   1. POST /manual now accepts + validates nextOfKinName, nextOfKinPhone (required)
//   2. GET  /:tripId/manifest  — passenger list sorted by seat, auth required
//   3. GET  /:tripId/manifest/print — plain-text formatted manifest, auth required
//
// All other routes (GET /, POST /:id/cancel, DELETE /:id) are byte-for-byte identical.

const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");
const { requireBranchAdmin, requireBranchMember } = require("../middleware/role");
const { lockSeat, releaseLock, nextAvailableSeat, cleanExpiredLocks } = require("../services/seatLock");

function generateRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "GT-";
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

/* ══════════════════════════════════════════════
   GET /api/bookings  — unchanged
══════════════════════════════════════════════ */
router.get("/", auth, requireBranchMember, async (req, res) => {
  try {
    const { branchId, role, assignedRouteIds } = req.user;
    const { date, tripId, source } = req.query;

    const where = { branchId };
    if (tripId) where.tripId        = tripId;
    if (source) where.bookingSource = source;

    if (date) {
  const start = new Date(date + "T00:00:00");
  const end   = new Date(date + "T23:59:59");

  where.trip = {
    OR: [
      {
        tripType: "SCHEDULED",
        departureTime: { gte: start, lte: end }
      },
      {
        tripType: "FLEXIBLE"
      }
    ]
  };
}

    if (role === "STAFF") {
      if (!assignedRouteIds?.length) return res.json([]);
      where.trip = { ...(where.trip || {}), routeId: { in: assignedRouteIds } };
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        trip:      true,
        createdBy: { select: { id:true, name:true, role:true } }
      },
      orderBy: { createdAt: "desc" }
    });

    res.json(bookings);
  } catch (err) {
    console.error("GET BOOKINGS ERROR:", err);
    res.status(500).json({ message: "Error fetching bookings" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/bookings/manual
   CHANGED: now requires nextOfKinName + nextOfKinPhone
══════════════════════════════════════════════ */
router.post("/manual", auth, requireBranchMember, async (req, res) => {
  const {
    tripId, passengerName, passengerPhone, seatNumber,
    nextOfKinName, nextOfKinPhone,            // ← NEW
  } = req.body;
  const { branchId, role, assignedRouteIds, id: userId } = req.user;

  // ── Validation ────────────────────────────────────────────────────────────
  if (!tripId || !passengerName || !passengerPhone) {
    return res.status(400).json({ message: "tripId, passengerName and passengerPhone required" });
  }

  // Next of kin — required for manual bookings
  if (!nextOfKinName || !nextOfKinName.trim()) {
    return res.status(400).json({ message: "nextOfKinName is required" });
  }
  if (!nextOfKinPhone || !nextOfKinPhone.trim()) {
    return res.status(400).json({ message: "nextOfKinPhone is required" });
  }
  if (!/^\+?[0-9]{7,15}$/.test(nextOfKinPhone.replace(/\s/g, ""))) {
    return res.status(400).json({ message: "nextOfKinPhone must be a valid phone number" });
  }

  const trip = await prisma.trip.findFirst({
    where:   { id: tripId, branchId },
    include: { bookings: { where: { status:"CONFIRMED" }, select: { seatNumber:true } } }
  });

  if (!trip)                  return res.status(404).json({ message: "Trip not found" });
  if (trip.status !== "OPEN") return res.status(400).json({ message: `Trip is ${trip.status.toLowerCase()}` });

  if (role === "STAFF" && trip.routeId && !assignedRouteIds?.includes(trip.routeId)) {
    return res.status(403).json({ message: "You are not assigned to this route" });
  }

  await cleanExpiredLocks(tripId);
  let targetSeat = seatNumber ? parseInt(seatNumber) : null;

  if (!targetSeat) {
    targetSeat = await nextAvailableSeat(trip);
    if (!targetSeat) return res.status(400).json({ message: "No seats available" });
  } else {
    const bookedSeats = trip.bookings.map(b => b.seatNumber);
    if (bookedSeats.includes(targetSeat)) {
      return res.status(400).json({ message: `Seat ${targetSeat} is already booked` });
    }
    if (targetSeat < 1 || targetSeat > trip.totalSeats) {
      return res.status(400).json({ message: `Seat ${targetSeat} does not exist` });
    }
  }

  const lockResult = await lockSeat(tripId, targetSeat, userId);
  if (!lockResult.success) return res.status(409).json({ message: lockResult.message });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          tripId, branchId, passengerName, passengerPhone,
          seatNumber:    targetSeat,
          reference:     generateRef(),
          bookingSource: "MANUAL",
          status:        "CONFIRMED",
          createdById:   userId,
          // ── NEW ──────────────────────────────────────────────────────────
          nextOfKinName:  nextOfKinName.trim(),
          nextOfKinPhone: nextOfKinPhone.trim(),
        }
      });

      const updatedTrip = await tx.trip.update({
        where: { id: tripId },
        data:  { seatsBooked: { increment: 1 } }
      });

      const threshold = updatedTrip.fillThreshold ?? updatedTrip.totalSeats;
      if (updatedTrip.seatsBooked >= threshold) {
        await tx.trip.update({ where: { id: tripId }, data: { status: "FULL" } });
      }

      return booking;
    });

    await releaseLock(tripId, targetSeat);

    const full = await prisma.booking.findUnique({
      where: { id: result.id }, include: { trip: true }
    });

    return res.status(201).json(full);
  } catch (err) {
    await releaseLock(tripId, targetSeat);
    console.error("MANUAL BOOKING ERROR:", err);
    return res.status(500).json({ message: "Error creating booking" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/bookings/:id/cancel — unchanged
══════════════════════════════════════════════ */
router.post("/:id/cancel", auth, requireBranchMember, async (req, res) => {
  try {
    const { role, id: userId, branchId } = req.user;

    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, branchId }
    });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (role === "STAFF" && booking.createdById !== userId) {
      return res.status(403).json({ message: "You can only cancel your own bookings" });
    }
    if (booking.status === "CANCELLED") {
      return res.status(400).json({ message: "Already cancelled" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });
      const updatedTrip = await tx.trip.update({
        where: { id: booking.tripId }, data: { seatsBooked: { decrement: 1 } }
      });
      if (updatedTrip.status === "FULL") {
        await tx.trip.update({ where: { id: booking.tripId }, data: { status: "OPEN" } });
      }
    });

    res.json({ message: "Booking cancelled" });
  } catch (err) {
    console.error("CANCEL BOOKING ERROR:", err);
    res.status(500).json({ message: "Error cancelling booking" });
  }
});

/* ══════════════════════════════════════════════
   DELETE /api/bookings/:id — unchanged
══════════════════════════════════════════════ */
router.delete("/:id", auth, requireBranchAdmin, async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, branchId: req.user.branchId }
    });
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    await prisma.$transaction(async (tx) => {
      await tx.booking.delete({ where: { id: booking.id } });
      if (booking.status === "CONFIRMED") {
        await tx.trip.update({
          where: { id: booking.tripId }, data: { seatsBooked: { decrement: 1 } }
        });
      }
    });

    res.json({ message: "Booking removed" });
  } catch (err) {
    console.error("DELETE BOOKING ERROR:", err);
    res.status(500).json({ message: "Error deleting booking" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/bookings/:tripId/manifest
   NEW — passenger manifest for a trip.
   Auth required. Branch members only (same branchId check).
   Returns bookings sorted by seatNumber ascending.
══════════════════════════════════════════════ */
router.get("/:tripId/manifest", auth, requireBranchMember, async (req, res) => {
  try {
    const { tripId } = req.params;
    const { branchId } = req.user;

    // Verify trip belongs to this branch
    const trip = await prisma.trip.findFirst({
      where:   { id: tripId, branchId },
      include: { branch: { include: { park: true } } }
    });

    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const bookings = await prisma.booking.findMany({
      where:   { tripId, status: { not: "CANCELLED" } },
      select: {
        seatNumber:     true,
        passengerName:  true,
        passengerPhone: true,
        nextOfKinName:  true,
        nextOfKinPhone: true,
        paymentStatus:  true,
        reference:      true,
        bookingSource:  true,
      },
      orderBy: { seatNumber: "asc" }
    });

    return res.json({
      trip: {
        id:            trip.id,
        route:         `${trip.departureCity} → ${trip.destination}`,
        departureTime: trip.departureTime,
        totalSeats:    trip.totalSeats,
        seatsBooked:   trip.seatsBooked,
        park:          trip.branch?.park?.name,
        branch:        trip.branch?.name,
      },
      totalPassengers: bookings.length,
      bookings,
    });
  } catch (err) {
    console.error("MANIFEST ERROR:", err);
    res.status(500).json({ message: "Error fetching manifest" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/bookings/:tripId/manifest/print
   NEW — plain-text printable manifest.
   Returns Content-Type: text/plain so it can be
   opened directly or piped to a printer.
══════════════════════════════════════════════ */
router.get("/:tripId/manifest/print", auth, requireBranchMember, async (req, res) => {
  try {
    const { tripId } = req.params;
    const { branchId } = req.user;

    const trip = await prisma.trip.findFirst({
      where:   { id: tripId, branchId },
      include: { branch: { include: { park: true } } }
    });

    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const bookings = await prisma.booking.findMany({
      where:   { tripId, status: { not: "CANCELLED" } },
      select: {
        seatNumber:     true,
        passengerName:  true,
        passengerPhone: true,
        nextOfKinName:  true,
        nextOfKinPhone: true,
        paymentStatus:  true,
        reference:      true,
        bookingSource:  true,
      },
      orderBy: { seatNumber: "asc" }
    });

    // ── Format helpers ────────────────────────────────────────────────────
    const pad  = (str, len) => String(str ?? "").padEnd(len);
    const line = (char = "─", len = 72) => char.repeat(len);

    const departureDate = new Date(trip.departureTime).toLocaleDateString("en-NG", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
    const departureTime = new Date(trip.departureTime).toLocaleTimeString("en-NG", {
      hour: "2-digit", minute: "2-digit"
    });

    // ── Build manifest text ───────────────────────────────────────────────
    const rows = [];

    rows.push(line("═"));
    rows.push("  GOTICKET — PASSENGER MANIFEST");
    rows.push(line("═"));
    rows.push(`  Park:       ${trip.branch?.park?.name || "N/A"}`);
    rows.push(`  Branch:     ${trip.branch?.name || "N/A"}`);
    rows.push(`  Route:      ${trip.departureCity} → ${trip.destination}`);
    rows.push(`  Date:       ${departureDate}`);
    rows.push(`  Departure:  ${departureTime}`);
    rows.push(`  Seats:      ${bookings.length} / ${trip.totalSeats} booked`);
    rows.push(`  Printed:    ${new Date().toLocaleString("en-NG")}`);
    rows.push(line("─"));
    rows.push("");

    // Column headers
    rows.push(
      `${pad("#",    4)}` +
      `${pad("NAME",          22)}` +
      `${pad("PHONE",         16)}` +
      `${pad("NEXT OF KIN",   22)}` +
      `${pad("NOK PHONE",     16)}` +
      `${pad("PMT",            8)}` +
      `REF`
    );
    rows.push(line("─"));

    if (!bookings.length) {
      rows.push("  No passengers booked.");
    } else {
      bookings.forEach(b => {
        const payStatus = b.paymentStatus
          ? (b.paymentStatus === "PAID" ? "PAID" : "PEND")
          : (b.bookingSource === "MANUAL" ? "CASH" : "PEND");

        rows.push(
          `${pad(b.seatNumber,   4)}` +
          `${pad(b.passengerName,  22)}` +
          `${pad(b.passengerPhone, 16)}` +
          `${pad(b.nextOfKinName  || "—", 22)}` +
          `${pad(b.nextOfKinPhone || "—", 16)}` +
          `${pad(payStatus,  8)}` +
          `${b.reference}`
        );
      });
    }

    rows.push("");
    rows.push(line("─"));
    rows.push(`  TOTAL PASSENGERS: ${bookings.length}`);
    rows.push(line("═"));
    rows.push("");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="manifest-${tripId}-${Date.now()}.txt"`
    );
    return res.send(rows.join("\n"));

  } catch (err) {
    console.error("MANIFEST PRINT ERROR:", err);
    res.status(500).json({ message: "Error generating manifest" });
  }
});

module.exports = router;