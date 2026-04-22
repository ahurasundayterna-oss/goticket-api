// routes/trips.js — full rewrite
// Supports SCHEDULED and FLEXIBLE trips with role-based access.

const router   = require("express").Router();
const prisma   = require("../prismaClient");
const auth     = require("../middleware/auth");
const { requireBranchAdmin, requireBranchMember } = require("../middleware/role");
const { getAvailableSeats, cleanExpiredLocks }    = require("../services/seatLock");

router.use(auth, requireBranchMember);

/* ══════════════════════════════════════════════
   GET /api/trips
   Branch Admin → all trips for branch
   Staff        → trips on their assigned routes
   ?type=SCHEDULED|FLEXIBLE  ?status=OPEN|FULL|DEPARTED
══════════════════════════════════════════════ */
router.get("/", async (req, res) => {
  try {
    const { branchId, role, assignedRouteIds } = req.user;
    const { type, status } = req.query;

    const where = { branchId };
    if (type)   where.tripType = type;
    if (status) where.status   = status;

    if (role === "STAFF") {
      if (!assignedRouteIds?.length) return res.json([]);
      where.routeId = { in: assignedRouteIds };
    }

    const trips = await prisma.trip.findMany({
      where,
      include: {
        bookings:  { select: { id:true, seatNumber:true, passengerName:true } },
        route:     { select: { id:true, origin:true, destination:true } },
        seatLocks: { where: { expiresAt: { gt: new Date() } }, select: { seatNumber:true } },
      },
      orderBy: { createdAt: "desc" }
    });

    const enriched = trips.map(t => {
      const seatsBooked    = t.bookings.length;
      const seatsLocked    = t.seatLocks.length;
      const threshold      = t.fillThreshold ?? t.totalSeats;
      return {
        ...t,
        seatsBooked,
        seatsLocked,
        seatsAvailable:  Math.max(0, t.totalSeats - seatsBooked - seatsLocked),
        fillPercentage:  Math.round((seatsBooked / t.totalSeats) * 100),
        nearDeparture:   t.tripType === "FLEXIBLE" && seatsBooked >= threshold,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error("GET TRIPS ERROR:", err);
    res.status(500).json({ message: "Error fetching trips" });
  }
});

/* ══════════════════════════════════════════════
   GET /api/trips/:id/seats
   Seat map for a specific trip
══════════════════════════════════════════════ */
router.get("/:id/seats", async (req, res) => {
  try {
    const trip = await prisma.trip.findFirst({
      where:   { id: req.params.id, branchId: req.user.branchId },
      include: { bookings: { select: { seatNumber:true } } }
    });
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    await cleanExpiredLocks(trip.id);

    const activeLocks = await prisma.seatLock.findMany({
      where:  { tripId: trip.id, expiresAt: { gt: new Date() } },
      select: { seatNumber:true, expiresAt:true }
    });

    const bookedSeats = trip.bookings.map(b => b.seatNumber);
    const lockedSeats = activeLocks.map(l => l.seatNumber);
    const available   = await getAvailableSeats(trip);

    res.json({ totalSeats:trip.totalSeats, bookedSeats, lockedSeats, available });
  } catch (err) {
    console.error("GET SEATS ERROR:", err);
    res.status(500).json({ message: "Error fetching seat data" });
  }
});

/* ══════════════════════════════════════════════
   POST /api/trips
══════════════════════════════════════════════ */
router.post("/", async (req, res) => {
  try {
    const { routeId, tripType="SCHEDULED", departureDate, departureTime,
            price, totalSeats, fillThreshold } = req.body;
    const { branchId, role, assignedRouteIds, id: userId } = req.user;

    if (!branchId)   return res.status(400).json({ message: "Branch not assigned" });
    if (!routeId)    return res.status(400).json({ message: "routeId is required" });
    if (!totalSeats) return res.status(400).json({ message: "totalSeats is required" });

    if (role === "STAFF" && !assignedRouteIds?.includes(routeId)) {
      return res.status(403).json({ message: "You are not assigned to this route" });
    }

    const route = await prisma.route.findFirst({ where: { id: routeId, branchId } });
    if (!route) return res.status(404).json({ message: "Route not found" });

    let departureTimeDate = null;
    if (tripType === "SCHEDULED") {
      if (!departureDate || !departureTime) {
        return res.status(400).json({ message: "Date and time required for scheduled trips" });
      }
      departureTimeDate = new Date(`${departureDate}T${departureTime}:00`);
      if (isNaN(departureTimeDate.getTime())) {
        return res.status(400).json({ message: "Invalid date/time" });
      }
    }

    const seats     = parseInt(totalSeats);
    const threshold = fillThreshold ? parseInt(fillThreshold) : seats;

    const trip = await prisma.trip.create({
      data: {
        branchId,
        routeId,
        departureCity:  route.origin,
        destination:    route.destination,
        tripType,
        departureTime:  departureTimeDate,
        price: parseFloat(price || route.price || 0),
        totalSeats:     seats,
        fillThreshold:  threshold,
        status:         "OPEN",
        createdById:    userId,
      }
    });

    res.status(201).json(trip);
  } catch (err) {
    console.error("CREATE TRIP ERROR:", err);
    res.status(500).json({ message: "Error creating trip" });
  }
});

/* PATCH depart */
router.patch("/:id/depart", requireBranchAdmin, async (req, res) => {
  try {
    const trip = await prisma.trip.findFirst({
      where: { id: req.params.id, branchId: req.user.branchId }
    });
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    if (trip.status === "DEPARTED") return res.status(400).json({ message: "Already departed" });

    await prisma.seatLock.deleteMany({ where: { tripId: trip.id } });
    const updated = await prisma.trip.update({
      where: { id: trip.id }, data: { status: "DEPARTED" }
    });
    res.json(updated);
  } catch (err) {
    console.error("FORCE DEPART ERROR:", err);
    res.status(500).json({ message: "Error departing trip" });
  }
});

/* PATCH cancel */
router.patch("/:id/cancel", requireBranchAdmin, async (req, res) => {
  try {
    await prisma.seatLock.deleteMany({ where: { tripId: req.params.id } });
    const updated = await prisma.trip.update({
      where: { id: req.params.id }, data: { status: "CANCELLED" }
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Error cancelling trip" });
  }
});

/* DELETE */
router.delete("/:id", requireBranchAdmin, async (req, res) => {
  try {
    const trip = await prisma.trip.findFirst({
      where:   { id: req.params.id, branchId: req.user.branchId },
      include: { _count: { select: { bookings:true } } }
    });
    if (!trip) return res.status(404).json({ message: "Trip not found" });
    if (trip._count.bookings > 0) {
      return res.status(400).json({ message: "Cannot delete trip with bookings. Cancel it instead." });
    }
    await prisma.seatLock.deleteMany({ where: { tripId: req.params.id } });
    await prisma.trip.delete({ where: { id: req.params.id } });
    res.json({ message: "Trip deleted" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting trip" });
  }
});

module.exports = router;