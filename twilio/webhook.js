/**
 * twilio/webhook.js
 */

const router = require("express").Router();
const prisma  = require("../prismaClient");
const { parseIntent, resolveDate, getTodayWAT, getTomorrowWAT } = require("../services/nlp");
const { createVirtualAccount, calculateAmounts } = require("../services/monnify");
const { checkAndDeductWallet }          = require("../services/wallet");

/* ══════════════════════════════════════════════
   SESSION STORE
══════════════════════════════════════════════ */
const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, {});
  return sessions.get(phone);
}
function clearSession(phone) { sessions.delete(phone); }

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
function twimlReply(res, message) {
  res.type("text/xml");
  res.send(`<Response><Message>${message}</Message></Response>`);
}

function formatTime(dateStr) {
  if (!dateStr) return "Flexible";
  return new Date(dateStr).toLocaleTimeString("en-NG", {
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
  });
}

function formatDate(dateStr) {
  if (!dateStr) return "Flexible departure";
  return new Date(dateStr).toLocaleDateString("en-NG", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    timeZone: "Africa/Lagos",
  });
}

function formatCurrency(amount) {
  return "₦" + Number(amount).toLocaleString("en-NG");
}

function generateRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "GT-";
  for (let i = 0; i < 6; i++) ref += chars[Math.floor(Math.random() * chars.length)];
  return ref;
}

function isValidPhone(phone) {
  return /^\+?[0-9]{7,15}$/.test(phone.replace(/\s/g, ""));
}

/* ══════════════════════════════════════════════
   DATE PARSING — WAT TIMEZONE
══════════════════════════════════════════════ */
function parseDate(text) {
  const cleaned = text.trim().replace(/\//g, "-");
  const parts   = cleaned.split("-");
  if (parts.length !== 3) return null;

  const [dd, mm, yyyy] = parts;
  const fullYear = yyyy.length === 2 ? "20" + yyyy : yyyy;
  const date = new Date(`${fullYear}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}T00:00:00+01:00`);
  if (isNaN(date.getTime())) return null;

  if (date < getTodayWAT()) return null;

  return date;
}


/* ══════════════════════════════════════════════
   PASSENGER DETAILS PARSER
   ──────────────────────────────────────────────
   Accepts a block like:
     Name of traveler: Emeka Okafor
     Phone no: 08012345678
     Next of kin: Ngozi Okafor
     Next of kin phone no: 08087654321
   Returns { name, phone, nokName, nokPhone } or null.
══════════════════════════════════════════════ */
function parsePassengerDetails(text) {
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  const result = {};

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key   = line.slice(0, colonIdx).toLowerCase().trim();
    const value = line.slice(colonIdx + 1).trim();

    if (!value) continue;

    if (/name of travell?er/.test(key) || key === "name") {
      result.name = value;
    } else if (/^phone/.test(key) && !/kin/.test(key)) {
      result.phone = value;
    } else if (/next of kin phone|nok phone|kin phone/.test(key)) {
      result.nokPhone = value;
    } else if (/next of kin|nok name|kin/.test(key)) {
      result.nokName = value;
    }
  }

  const valid =
    result.name    && result.name.length >= 3    && /^[a-zA-Z\s\-']+$/.test(result.name) &&
    result.phone   && isValidPhone(result.phone) &&
    result.nokName && result.nokName.length >= 3 && /^[a-zA-Z\s\-']+$/.test(result.nokName) &&
    result.nokPhone && isValidPhone(result.nokPhone);

  return valid ? result : null;
}

/* ══════════════════════════════════════════════
   NLU PRE-PROCESSOR
══════════════════════════════════════════════ */
function applyNLU(rawMsg, session) {
  const parsed = parseIntent(rawMsg);
  if (parsed.intent === "MENU" || parsed.intent === "CANCEL") return false;

  const nluEligibleSteps = [
    undefined, "MAIN_MENU", "ASK_FROM", "ASK_TO", "ASK_DATE",
    "SELECT_PARK", "SELECT_TRIP", "ASK_SEATS",
  ];
  if (!nluEligibleSteps.includes(session.step)) return false;
  if (parsed.intent !== "BOOK" && !parsed.from && !parsed.to && !parsed.date) return false;

  let mutated = false;
  if (parsed.from  && !session.from)  { session.from  = parsed.from;  mutated = true; }
  if (parsed.to    && !session.to)    { session.to    = parsed.to;    mutated = true; }
  if (parsed.date  && !session.date)  { session.date  = parsed.date;  mutated = true; }
  if (parsed.seats && !session.seats) { session.seats = parsed.seats; mutated = true; }
  if (!mutated) return false;

  if (session.from && session.to) {
    session.step = "ASK_DATE";
  } else if (session.from) {
    session.step = "ASK_TO";
  } else {
    session.step = "ASK_FROM";
  }

  session._nluApplied = true;
  return true;
}

/* ══════════════════════════════════════════════
   BUILD PARK OPTIONS
══════════════════════════════════════════════ */
function buildParkOptions(trips) {
  const map = new Map();

  for (const trip of trips) {
    const parkName = trip.branch?.park?.name || "Unknown";
    const key      = `${parkName}::${trip.price}::${trip.tripType}`;

    if (!map.has(key)) {
      const isFlexible = trip.tripType === "INSTANT" || trip.tripType === "FLEXIBLE";
      map.set(key, {
        label:    `${parkName} — ${formatCurrency(trip.price)}${isFlexible ? " (Flexible)" : ""}`,
        park:     parkName,
        price:    trip.price,
        tripType: trip.tripType,
        trips:    [],
      });
    }
    map.get(key).trips.push(trip);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return a.park.localeCompare(b.park);
  });
}

/* ══════════════════════════════════════════════
   TRIP SEARCH HELPER
══════════════════════════════════════════════ */
async function searchTrips(from, to, date) {
  const watDateStr = new Date(date).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const dayStart   = new Date(`${watDateStr}T00:00:00+01:00`);
  const dayEnd     = new Date(`${watDateStr}T23:59:59+01:00`);

  const trips = await prisma.trip.findMany({
    where: {
      departureCity: { equals: from, mode: "insensitive" },
      destination:   { equals: to,   mode: "insensitive" },
      status:        "OPEN",
      OR: [
        { tripType: "SCHEDULED", departureTime: { gte: dayStart, lte: dayEnd } },
        { tripType: "INSTANT"  },
        { tripType: "FLEXIBLE" },
      ],
    },
    include: {
      bookings: true,
      branch:   { include: { park: true } },
    },
    orderBy: { departureTime: "asc" },
  });

  return trips.filter(t => (t.bookings?.length || 0) < t.totalSeats);
}

/* ══════════════════════════════════════════════
   MAIN WEBHOOK HANDLER
══════════════════════════════════════════════ */
router.post("/", async (req, res) => {
  const rawMsg = req.body.Body?.trim() || "";
  const phone  = req.body.From;
  const msg    = rawMsg.toLowerCase();

  console.log(`[WhatsApp] ${phone} → "${rawMsg}"`);

  const session   = getSession(phone);
  const GREETINGS = ["hi","hello","hey","start","menu","restart","back","0"];

  if (GREETINGS.includes(msg) && session.step !== undefined) {
    clearSession(phone);
    sessions.set(phone, {});
  }

  try {
    if (!GREETINGS.includes(msg)) applyNLU(rawMsg, session);

    /* ─── INITIAL / MAIN MENU ─── */
    if (!session.step || GREETINGS.includes(msg)) {
      session.step = "MAIN_MENU";
      return twimlReply(res,
`🎟️ *GoTicket*
Nigeria's Digital Transport Booking

1️⃣  Book a trip
2️⃣  Check my booking
3️⃣  Customer support

_Or just say where you're going:_
_"Lagos to Abuja tomorrow"_`);
    }

    /* ─── MAIN MENU SELECTION ─── */
    if (session.step === "MAIN_MENU") {
      if (session._nluApplied && session.from && session.to) {
        // NLU caught a full route — fall through to ASK_DATE below
      } else if (session._nluApplied && session.from && !session.to) {
        session.step = "ASK_TO";
        return twimlReply(res, `Where are you traveling to?`);
      } else if (msg === "1") {
        session.step = "ASK_FROM";
        return twimlReply(res,
          `🗺️ Where are you traveling *from*?\n_e.g. Makurdi, Lagos_`);
      } else if (msg === "2") {
        session.step = "CHECK_BOOKING";
        return twimlReply(res, `🔍 Enter your booking reference:\nExample: *GT-A3K7RX*`);
      } else if (msg === "3") {
        clearSession(phone);
        return twimlReply(res,
`📞 *Support*
• Phone: +234 800 000 0000
• Email: support@goticket.ng
• Hours: Mon–Sat, 6am–10pm`);
      } else {
        return twimlReply(res,
          `Reply *1*, *2*, or *3*.\nOr say your route: _"Makurdi to Abuja tomorrow"_`);
      }
    }

    /* ─── CHECK BOOKING ─── */
    if (session.step === "CHECK_BOOKING") {
      const parsed = parseIntent(rawMsg);
      const ref    = (parsed.ref || rawMsg.trim()).toUpperCase();

      const booking = await prisma.booking.findFirst({
        where:   { reference: ref },
        include: { trip: { include: { branch: { include: { park: true } } } } },
      });
      clearSession(phone);

      if (!booking) {
        return twimlReply(res,
          `❌ No booking found for *${ref}*.\nCheck the code and try again.\nType *menu* to go back.`);
      }

      const trip       = booking.trip;
      const isFlexible = trip.tripType === "INSTANT" || trip.tripType === "FLEXIBLE";

      return twimlReply(res,
`✅ *Booking Found*

👤 ${booking.passengerName}
🎟️ Ref: *${booking.reference}*
🚌 ${trip.branch?.park?.name || "N/A"}
📍 ${trip.departureCity} → ${trip.destination}
📅 ${isFlexible ? "Flexible (departs when full)" : formatDate(trip.departureTime)}
⏰ ${isFlexible ? "—" : formatTime(trip.departureTime)}
💺 Seat ${booking.seatNumber}
💰 ${formatCurrency(trip.price)}
💳 Payment: ${booking.paymentStatus === "PAID" ? "✅ PAID" : "⏳ Pending"}

Show this at the terminal.
Type *menu* to go back.`);
    }

    /* ─── ASK FROM ─── */
    if (session.step === "ASK_FROM") {
      const city = rawMsg.trim();
      if (city.length < 2) {
        return twimlReply(res,
          `⚠️ Please enter a valid departure city.\n_e.g. Makurdi, Lagos_`);
      }
      session.from = city;
      session.step = "ASK_TO";
      return twimlReply(res,
        `Where are you traveling *to*?\n_e.g. Lagos, Abuja_`);
    }

    /* ─── ASK TO ─── */
    if (session.step === "ASK_TO") {
      const city = rawMsg.trim();
      if (city.length < 2) {
        return twimlReply(res,
          `⚠️ Please enter a valid destination city.\n_e.g. Abuja, Port Harcourt_`);
      }
      session.to   = city;
      session.step = "ASK_DATE";

      // If NLU already resolved a date, skip the prompt
      if (session.date) {
        session._skipDatePrompt = true;
      } else {
        return twimlReply(res,
`📅 When are you traveling?

*1.* Today
*2.* Tomorrow
*3.* Enter date _(DD-MM-YY)_`);
      }
    }

    /* ─── ASK DATE ─── */
    if (session.step === "ASK_DATE") {
      if (!session._skipDatePrompt) {
        let date = null;

        if (msg === "1") {
          date = getTodayWAT();
        } else if (msg === "2") {
          date = getTomorrowWAT();
        } else {
          date = resolveDate(rawMsg) || parseDate(rawMsg);
        }

        if (!date) {
          return twimlReply(res,
`⚠️ Couldn't read that date.

*1.* Today
*2.* Tomorrow
*3.* Enter date _(DD-MM-YY)_`);
        }

        session.date = date;
      }
      session._skipDatePrompt = false;

      const available = await searchTrips(session.from, session.to, session.date);

      if (!available.length) {
        clearSession(phone);
        return twimlReply(res,
`😔 No seats available for:
📍 ${session.from} → ${session.to}
📅 ${formatDate(session.date)}

Type *menu* to try another date.`);
      }

      const parkOptions   = buildParkOptions(available);
      session.trips       = available;
      session.parkOptions = parkOptions;
      session.step        = "SELECT_PARK";

      if (parkOptions.length === 1 && session._nluApplied) {
        session._nluApplied = false;
        return handleParkSelection(res, session, 0);
      }

      let reply = `🚌 *Available Options*\n📍 ${session.from} → ${session.to}\n📅 ${formatDate(session.date)}\n\n`;
      parkOptions.forEach((opt, i) => { reply += `*${i + 1}.* ${opt.label}\n`; });
      reply += `\nReply with a number.`;
      return twimlReply(res, reply);
    }

    /* ─── SELECT PARK ─── */
    if (session.step === "SELECT_PARK") {
      const index = parseInt(rawMsg) - 1;
      const opts  = session.parkOptions;
      if (isNaN(index) || index < 0 || index >= opts?.length) {
        return twimlReply(res,
          `⚠️ Please reply with a number between 1 and ${opts?.length || "?"}.`);
      }
      return handleParkSelection(res, session, index);
    }

    /* ─── SELECT TRIP ─── */
    if (session.step === "SELECT_TRIP") {
      const index = parseInt(rawMsg) - 1;
      const trip  = session.filteredTrips?.[index];

      if (!trip) {
        return twimlReply(res,
          `⚠️ Invalid choice. Reply with a number between 1 and ${session.filteredTrips?.length || "?"}.`);
      }

      const freshTrip = await prisma.trip.findUnique({
        where:   { id: trip.id },
        include: { bookings: true, branch: { include: { park: true } } },
      });

      const booked = freshTrip.bookings?.length || 0;
      if (booked >= freshTrip.totalSeats) {
        return twimlReply(res,
          `😔 That trip just filled up.\n\nReply with another number or type *menu* to search again.`);
      }

      session.selectedTrip = freshTrip;
      session.step         = "ASK_SEATS";

      const remaining  = freshTrip.totalSeats - booked;
      const isFlexible = freshTrip.tripType === "INSTANT" || freshTrip.tripType === "FLEXIBLE";

      return twimlReply(res,
`✅ *Trip Selected*
${isFlexible ? "🕐 Flexible — departs when full" : `⏰ ${formatTime(freshTrip.departureTime)}`}
💺 ${remaining} seat${remaining !== 1 ? "s" : ""} left

How many seats? _(max ${Math.min(remaining, 4)})_`);
    }

    /* ─── ASK SEATS ─── */
    if (session.step === "ASK_SEATS") {
      let seats = session.seats || parseInt(rawMsg);
      const trip = session.selectedTrip;

      const freshBookings = await prisma.booking.count({ where: { tripId: trip.id } });
      const remaining     = trip.totalSeats - freshBookings;

      if (!seats || seats < 1 || seats > remaining || seats > 4) {
        session.seats = null;
        return twimlReply(res,
          `⚠️ Enter a valid seat count.\nAvailable: ${remaining} | Max per booking: ${Math.min(remaining, 4)}`);
      }

      session.seats = seats;
      session.step  = "ASK_DETAILS";

      return twimlReply(res,
`📋 Please fill in the information below:

Name of traveler:
Phone no:
Next of kin:
Next of kin phone no:`);
    }

    /* ─── ASK DETAILS (single-step form) ─── */
    if (session.step === "ASK_DETAILS") {
      const details = parsePassengerDetails(rawMsg);

      if (!details) {
        return twimlReply(res,
`⚠️ Some details are missing or invalid.
Please fill in *all four* fields:

Name of traveler:
Phone no:
Next of kin:
Next of kin phone no:

_Example:_
Name of traveler: Emeka Okafor
Phone no: 08012345678
Next of kin: Ngozi Okafor
Next of kin phone no: 08087654321`);
      }

      session.passengerName  = details.name;
      session.passengerPhone = details.phone;
      session.nextOfKinName  = details.nokName;
      session.nextOfKinPhone = details.nokPhone;
      session.step           = "CONFIRM";

      const trip            = session.selectedTrip;
      const { totalAmount } = calculateAmounts(trip.price * session.seats);
      const isFlexible      = trip.tripType === "INSTANT" || trip.tripType === "FLEXIBLE";

      return twimlReply(res,
`📋 *Confirm Booking*

👤 ${session.passengerName}
📱 ${session.passengerPhone}
🆘 NOK: ${session.nextOfKinName} (${session.nextOfKinPhone})
🚌 ${trip.branch?.park?.name}
📍 ${session.from} → ${session.to}
📅 ${isFlexible ? "Flexible departure" : formatDate(trip.departureTime)}
⏰ ${isFlexible ? "Departs when full" : formatTime(trip.departureTime)}
💺 ${session.seats} seat${session.seats > 1 ? "s" : ""}
💰 ${formatCurrency(totalAmount)} _(incl. 3% fee)_

⏰ Payment must be made within *10 minutes* or seat will be released.

Reply *YES* to confirm or *NO* to cancel.`);
    }

    /* ─── CONFIRM ─── */
    if (session.step === "CONFIRM") {
      if (msg === "no" || msg === "cancel") {
        clearSession(phone);
        return twimlReply(res, `❌ Booking cancelled.\n\nType *menu* to start over.`);
      }
      if (msg !== "yes" && msg !== "y") {
        return twimlReply(res, `Reply *YES* to confirm or *NO* to cancel.`);
      }

      const trip          = session.selectedTrip;
      const freshBookings = await prisma.booking.count({ where: { tripId: trip.id } });

      if (freshBookings >= trip.totalSeats) {
        clearSession(phone);
        return twimlReply(res, `😔 Trip just filled up.\n\nType *menu* to search again.`);
      }

      const ticketTotal     = trip.price * session.seats;
      const { totalAmount } = calculateAmounts(ticketTotal);
      const primaryRef      = `GT-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

      const refs       = [];
      const bookingIds = [];

      try {
        await prisma.$transaction(async (tx) => {
          for (let i = 0; i < session.seats; i++) {
            const ref      = generateRef();
            const nextSeat = freshBookings + i + 1;
            refs.push(ref);

            await checkAndDeductWallet(tx, trip.branchId, ref);

            const created = await tx.booking.create({
              data: {
                passengerName:    session.passengerName,
                passengerPhone:   session.passengerPhone,
                seatNumber:       nextSeat,
                reference:        ref,
                bookingSource:    "WHATSAPP",
                tripId:           trip.id,
                branchId:         trip.branchId,
                paymentStatus:    "PENDING",
                status:           "PENDING",
                paymentMethod:    "ONLINE",
                totalAmount,
                paymentReference: primaryRef,
                nextOfKinName:    session.nextOfKinName,
                nextOfKinPhone:   session.nextOfKinPhone,
              },
            });

            bookingIds.push(created.id);

            await tx.payment.create({
              data: {
                bookingId: created.id,
                provider:  "MONNIFY",
                amount:    totalAmount,
                status:    "PENDING",
              },
            });
          }
        });

      } catch (txErr) {
        clearSession(phone);

        if (txErr.message?.includes("Insufficient wallet")) {
          console.warn(`[WhatsApp] Wallet exhausted for branch ${trip.branchId}`);
          return twimlReply(res,
`❌ *Booking Unavailable*

Sorry, this service is temporarily unavailable for this route.

Please contact the transport operator directly or try another park.

Type *menu* to search again.`);
        }

        console.error("[WhatsApp] Booking transaction failed:", txErr.message);
        return twimlReply(res,
          `⚠️ Something went wrong creating your booking. Type *hi* to start over.`);
      }

      // ── Fetch branch sub-account ──────────────────────────────────
      const tripWithBranch = await prisma.trip.findUnique({
        where:   { id: trip.id },
        include: { branch: true },
      });

      const subAccountCode = tripWithBranch?.branch?.monnifySubAccountCode || null;

      if (subAccountCode) {
        console.log(`[WhatsApp] Routing to sub-account: ${subAccountCode}`);
      } else {
        console.warn(`[WhatsApp] No sub-account for branch ${trip.branchId} — using main account`);
      }

      // ── Create or reuse Monnify virtual account ───────────────────
      // Monnify allows only one reserved account per customer email.
      // We derive the email from the passenger's phone number, so we
      // check if this passenger already has a virtual account from a
      // previous booking and reuse those details if so.
      let accountNumber, bankName;

      const previousBooking = await prisma.booking.findFirst({
        where: {
          passengerPhone: session.passengerPhone,
          accountNumber:  { not: null },
          bankName:       { not: null },
        },
        orderBy: { createdAt: "desc" },
        select:  { accountNumber: true, bankName: true },
      });

      if (previousBooking?.accountNumber && previousBooking?.bankName) {
        console.log(`[Monnify] Reusing existing virtual account for ${session.passengerPhone}`);
        accountNumber = previousBooking.accountNumber;
        bankName      = previousBooking.bankName;

        await prisma.booking.updateMany({
          where: { id: { in: bookingIds } },
          data:  { accountNumber, bankName, paymentReference: primaryRef },
        });

      } else {
        try {
          const result = await createVirtualAccount({
            reference:      primaryRef,
            passengerName:  session.passengerName,
            passengerPhone: session.passengerPhone,
            ticketPrice:    ticketTotal,
            description:    `GoTicket: ${session.from} → ${session.to} (${session.seats} seat${session.seats > 1 ? "s" : ""})`,
            subAccountCode,
          });

          accountNumber = result.accountNumber;
          bankName      = result.bankName;

          await prisma.booking.updateMany({
            where: { id: { in: bookingIds } },
            data:  { accountNumber, bankName, paymentReference: primaryRef },
          });

        } catch (monnifyErr) {
          console.error("[Monnify] Virtual account failed:", monnifyErr.message);
          clearSession(phone);

          const refList = refs.map((r, i) =>
            session.seats > 1
              ? `  Seat ${freshBookings + i + 1}: *${r}*`
              : `*${r}*`
          ).join("\n");

          return twimlReply(res,
`⚠️ *Booking Created — Payment Setup Delayed*

Your seat${session.seats > 1 ? "s have" : " has"} been reserved but we couldn't generate your payment account right now.

🎟️ Reference${refs.length > 1 ? "s" : ""}:
${refList}

Please contact support:
📞 +234 800 000 0000

Type *menu* to return.`);
        }
      }

      clearSession(phone);

      const isFlexible = trip.tripType === "INSTANT" || trip.tripType === "FLEXIBLE";

      const refList = refs.map((r, i) =>
        session.seats > 1
          ? `  Seat ${freshBookings + i + 1}: *${r}*`
          : `*${r}*`
      ).join("\n");

      return twimlReply(res,
`✅ *Booking Reserved!*

━━━━━━━━━━━━━━━━
🎟️ Ref: ${refList}
━━━━━━━━━━━━━━━━
👤 ${session.passengerName}
🚌 ${trip.branch?.park?.name}
📍 ${session.from} → ${session.to}
📅 ${isFlexible ? "Flexible departure" : formatDate(trip.departureTime)}
⏰ ${isFlexible ? "Departs when full" : formatTime(trip.departureTime)}
💺 ${session.seats} seat${session.seats > 1 ? "s" : ""}

💳 *Pay Now to Confirm Your Seat*
━━━━━━━━━━━━━━━━
🏦 Bank:    ${bankName}
🔢 Account: *${accountNumber}*
💰 Amount:  *${formatCurrency(totalAmount)}*
━━━━━━━━━━━━━━━━

⚠️ Transfer the *exact amount* shown.
⏰ Payment expires in *10 minutes*.
Your seat is confirmed automatically on receipt.

Type *menu* for a new booking.`);
    }

    // ── Fallback ──────────────────────────────────────────────────
    return twimlReply(res,
`I didn't understand that.

Type *menu* or say your route:
_"Lagos to Abuja tomorrow"_`);

  } catch (error) {
    console.error("[WhatsApp Bot Error]", error);
    clearSession(phone);
    return twimlReply(res, `⚠️ Something went wrong. Type *hi* to start over.`);
  }
});

/* ══════════════════════════════════════════════
   PARK SELECTION HANDLER
══════════════════════════════════════════════ */
async function handleParkSelection(res, session, optionIndex) {
  const chosen = session.parkOptions[optionIndex];

  const freshTrips = await Promise.all(
    chosen.trips.map(t =>
      prisma.trip.findUnique({
        where:   { id: t.id },
        include: { bookings: true, branch: { include: { park: true } } },
      })
    )
  );

  const stillAvailable = freshTrips.filter(
    t => (t.bookings?.length || 0) < t.totalSeats
  );

  if (!stillAvailable.length) {
    return twimlReply(res,
      `😔 All trips for *${chosen.park}* just filled up.\n\nType *menu* to search again.`);
  }

  // ── Single trip → skip time selection ───────────────────────────
  if (stillAvailable.length === 1) {
    const trip       = stillAvailable[0];
    const booked     = trip.bookings?.length || 0;
    const remaining  = trip.totalSeats - booked;
    const isFlexible = trip.tripType === "INSTANT" || trip.tripType === "FLEXIBLE";

    session.selectedTrip = trip;
    session.step         = "ASK_SEATS";

    return twimlReply(res,
`✅ *${chosen.park}*
💰 ${formatCurrency(chosen.price)}
${isFlexible ? "🕐 Flexible — departs when full" : `⏰ ${formatTime(trip.departureTime)}`}
💺 ${remaining} seat${remaining !== 1 ? "s" : ""} left

How many seats? _(max ${Math.min(remaining, 4)})_`);
  }

  // ── Multiple trips → let user pick time ─────────────────────────
  session.filteredTrips = stillAvailable;
  session.step          = "SELECT_TRIP";

  let reply = `🕐 *${chosen.park}* — ${formatCurrency(chosen.price)}\nChoose a departure time:\n\n`;

  stillAvailable.forEach((t, i) => {
    const remaining  = t.totalSeats - (t.bookings?.length || 0);
    const isFlexible = t.tripType === "INSTANT" || t.tripType === "FLEXIBLE";
    const timeLabel  = isFlexible ? "Flexible (departs when full)" : formatTime(t.departureTime);
    reply += `*${i + 1}.* ${timeLabel} — ${remaining} seat${remaining !== 1 ? "s" : ""} left\n`;
  });

  return twimlReply(res, reply);
}

module.exports = router;