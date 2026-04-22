// services/seatLock.js
// Handles temporary seat locking to prevent double-booking.
// Called from trips and booking routes.

const prisma = require("../prismaClient");

const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/* ──────────────────────────────────────────────
   cleanExpiredLocks(tripId)
   Removes locks that have expired.
   Called before every seat availability check.
────────────────────────────────────────────── */
async function cleanExpiredLocks(tripId) {
  await prisma.seatLock.deleteMany({
    where: {
      tripId,
      expiresAt: { lte: new Date() }
    }
  });
}

/* ──────────────────────────────────────────────
   getLockedSeats(tripId)
   Returns array of seat numbers currently locked.
────────────────────────────────────────────── */
async function getLockedSeats(tripId) {
  await cleanExpiredLocks(tripId);
  const locks = await prisma.seatLock.findMany({
    where: { tripId },
    select: { seatNumber: true }
  });
  return locks.map(l => l.seatNumber);
}

/* ──────────────────────────────────────────────
   lockSeat(tripId, seatNumber, lockedById)
   Atomically lock a seat.
   Returns { success, message }
────────────────────────────────────────────── */
async function lockSeat(tripId, seatNumber, lockedById) {
  await cleanExpiredLocks(tripId);

  try {
    await prisma.seatLock.create({
      data: {
        tripId,
        seatNumber,
        lockedById,
        expiresAt: new Date(Date.now() + LOCK_DURATION_MS)
      }
    });
    return { success: true };
  } catch (err) {
    // Unique constraint violation = seat already locked
    if (err.code === "P2002") {
      return { success: false, message: `Seat ${seatNumber} is currently being booked by another agent. Try again in a moment.` };
    }
    throw err;
  }
}

/* ──────────────────────────────────────────────
   releaseLock(tripId, seatNumber)
   Release a seat lock (after booking confirmed or cancelled).
────────────────────────────────────────────── */
async function releaseLock(tripId, seatNumber) {
  await prisma.seatLock.deleteMany({ where: { tripId, seatNumber } });
}

/* ──────────────────────────────────────────────
   getAvailableSeats(trip)
   Returns array of available seat numbers.
   Excludes: booked seats + locked seats.
   trip must include: { totalSeats, bookings: [{ seatNumber }] }
────────────────────────────────────────────── */
async function getAvailableSeats(trip) {
  const bookedNums = (trip.bookings || []).map(b => b.seatNumber);
  const lockedNums = await getLockedSeats(trip.id);

  const unavailable = new Set([...bookedNums, ...lockedNums]);
  const available   = [];

  for (let i = 1; i <= trip.totalSeats; i++) {
    if (!unavailable.has(i)) available.push(i);
  }

  return available;
}

/* ──────────────────────────────────────────────
   nextAvailableSeat(trip)
   Returns the lowest available seat number, or null if full.
────────────────────────────────────────────── */
async function nextAvailableSeat(trip) {
  const available = await getAvailableSeats(trip);
  return available.length > 0 ? available[0] : null;
}

module.exports = {
  cleanExpiredLocks,
  getLockedSeats,
  lockSeat,
  releaseLock,
  getAvailableSeats,
  nextAvailableSeat,
  LOCK_DURATION_MS,
};