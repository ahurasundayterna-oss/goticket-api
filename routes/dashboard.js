const express = require("express");
const router  = express.Router();
const prisma  = require("../prismaClient");
const auth    = require("../middleware/auth");

// GET DASHBOARD STATS — today-specific
router.get("/", auth, async (req, res) => {
  try {
    const branchId = req.user.branchId;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // TODAY'S BOOKINGS COUNT
    const todayBookings = await prisma.booking.count({
      where: {
        branchId,
        createdAt: { gte: todayStart, lte: todayEnd }
      }
    });

    // ACTIVE TRIPS TODAY (departure today, not yet departed)
    const activeTrips = await prisma.trip.count({
      where: {
        branchId,
        departureTime: { gte: todayStart, lte: todayEnd }
      }
    });

    // TODAY'S REVENUE — sum of price for bookings made today
    const todayBookingsFull = await prisma.booking.findMany({
      where: {
        branchId,
        createdAt: { gte: todayStart, lte: todayEnd }
      },
      include: { trip: true }
    });

    const revenueToday = todayBookingsFull.reduce((sum, b) => {
      return sum + (b.trip?.price || 0);
    }, 0);

    // SEATS AVAILABLE — across today's trips
    const todayTrips = await prisma.trip.findMany({
      where: {
        branchId,
        departureTime: { gte: todayStart, lte: todayEnd }
      },
      include: { bookings: true }
    });

    const seatsAvailable = todayTrips.reduce((sum, t) => {
      const booked = t.bookings?.length || 0;
      return sum + Math.max(0, t.totalSeats - booked);
    }, 0);

    res.json({
      todayBookings,
      activeTrips,
      revenueToday,
      seatsAvailable
    });

  } catch (error) {
    console.error("DASHBOARD ERROR:", error);
    res.status(500).json({ message: "Dashboard error" });
  }
});

module.exports = router;