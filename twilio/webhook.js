/**
 * twilio/webhook.js
 *
 * CHANGED from previous version:
 *   - CONFIRM step: bookings now store expiresAt (10-minute seat lock)
 *   - CONFIRM step: creates Payment record alongside each booking
 *   - createVirtualAccount no longer requires branchSubAccountCode
 *     (removed split settlement — simplified for now)
 *   - Error fallback message improved
 *
 * All other steps (MAIN_MENU through ASK_NOK_PHONE) are unchanged.
 */

const router = require("express").Router();
const prisma  = require("../prismaClient");
const { parseIntent, resolveDate } = require("../services/nlp");
const { createVirtualAccount, calculateAmounts } = require("../services/monnify");

const sessions = new Map();
function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, {});
  return sessions.get(phone);
}
function clearSession(phone) { sessions.delete(phone); }

function twimlReply(res, message) {
  res.type("text/xml");
  res.send(`<Response><Message>${message}</Message></Response>`);
}
function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString("en-NG", {
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
  });
}
function formatDate(dateStr) {
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
function parseRoute(text) {
  const parts = text.trim().split(/\s*(?:-|–|—|to)\s*/i).filter(Boolean);
  if (parts.length < 2) return null;
  return { from: parts[0].trim(), to: parts[1].trim() };
}
function parseDate(text) {
  const cleaned = text.trim().replace(/\//g, "-");
  const parts   = cleaned.split("-");
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  const date = new Date(`${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`);
  if (isNaN(date.getTime())) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  if (date < today) return null;
  return date;
}
function isValidPhone(phone) {
  return /^\+?[0-9]{7,15}$/.test(phone.replace(/\s/g,""));
}

function buildParkOptions(trips) {
  const map = new Map();
  for (const trip of trips) {
    const parkName = trip.branch?.park?.name || "Unknown";
    const key      = `${parkName}::${trip.price}`;
    if (!map.has(key)) {
      map.set(key, {
        label: `${parkName} — ${formatCurrency(trip.price)}`,
        park: parkName, price: trip.price, trips: [],
      });
    }
    map.get(key).trips.push(trip);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return a.park.localeCompare(b.park);
  });
}

function applyNLU(rawMsg, session) {
  const parsed = parseIntent(rawMsg);
  if (parsed.intent === "MENU" || parsed.intent === "CANCEL") return false;
  const nluEligibleSteps = [undefined, "MAIN_MENU", "ASK_ROUTE", "ASK_DATE", "SELECT_PARK", "SELECT_TRIP", "ASK_SEATS"];
  if (!nluEligibleSteps.includes(session.step)) return false;
  if (parsed.intent !== "BOOK" && !parsed.from && !parsed.to && !parsed.date) return false;
  let mutated = false;
  if (parsed.from  && !session.from)  { session.from  = parsed.from;  mutated = true; }
  if (parsed.to    && !session.to)    { session.to    = parsed.to;    mutated = true; }
  if (parsed.date  && !session.date)  { session.date  = parsed.date;  mutated = true; }
  if (parsed.seats && !session.seats) { session.seats = parsed.seats; mutated = true; }
  if (!mutated) return false;
  session.step = (session.from && session.to) ? "ASK_DATE" : "ASK_ROUTE";
  session._nluApplied = true;
  return true;
}

router.post("/", async (req, res) => {
  const rawMsg = req.body.Body?.trim() || "";
  const phone  = req.body.From;
  const msg    = rawMsg.toLowerCase();
  console.log(`[WhatsApp] ${phone} → "${rawMsg}"`);

  const session   = getSession(phone);
  const GREETINGS = ["hi","hello","hey","start","menu","restart","back","0"];

  if (GREETINGS.includes(msg) && session.step !== undefined) {
    clearSession(phone); sessions.set(phone, {});
  }

  try {
    if (!GREETINGS.includes(msg)) applyNLU(rawMsg, session);

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

    if (session.step === "MAIN_MENU") {
      if (session._nluApplied && session.from && session.to) {
        session.step = "ASK_DATE";
      } else if (msg === "1") {
        session.step = "ASK_ROUTE";
        return twimlReply(res, `🗺️ *Route*\n\nEnter your route:\n*Lagos - Abuja*  or  *"Lagos to Abuja"*`);
      } else if (msg === "2") {
        session.step = "CHECK_BOOKING";
        return twimlReply(res, `🔍 Enter your booking reference:\nExample: *GT-A3K7RX*`);
      } else if (msg === "3") {
        clearSession(phone);
        return twimlReply(res, `📞 *Support*\n• Phone: +234 800 000 0000\n• Email: support@goticket.ng\n• Hours: Mon–Sat, 6am–10pm`);
      } else {
        return twimlReply(res, `Reply *1*, *2*, or *3*.\nOr say your route: *"Makurdi to Abuja tomorrow"*`);
      }
    }

    if (session.step === "CHECK_BOOKING") {
      const parsed = parseIntent(rawMsg);
      const ref    = (parsed.ref || rawMsg.trim()).toUpperCase();
      const booking = await prisma.booking.findFirst({
        where:   { reference: ref },
        include: { trip: { include: { branch: { include: { park: true } } } } }
      });
      clearSession(phone);
      if (!booking) return twimlReply(res, `❌ No booking for *${ref}*.\nCheck the code and try again.\nType *menu* to go back.`);
      const trip = booking.trip;
      return twimlReply(res,
`✅ *Booking Found*

👤 ${booking.passengerName}
🎟️ Ref: *${booking.reference}*
🚌 ${trip.branch?.park?.name || "N/A"}
📍 ${trip.departureCity} → ${trip.destination}
📅 ${formatDate(trip.departureTime)}
⏰ ${formatTime(trip.departureTime)}
💺 Seat ${booking.seatNumber}
💰 ${formatCurrency(trip.price)}
💳 Payment: ${booking.paymentStatus === "PAID" ? "✅ PAID" : "⏳ Pending"}

Show this at the terminal.
Type *menu* to go back.`);
    }

    if (session.step === "ASK_ROUTE") {
      if (!session.from || !session.to) {
        const route = parseRoute(rawMsg);
        if (!route) return twimlReply(res, `⚠️ Couldn't read that route.\nTry: *Lagos - Abuja* or *"Makurdi to Abuja"*`);
        session.from = route.from; session.to = route.to;
      }
      session.step = "ASK_DATE";
      if (session.date) { session._skipDatePrompt = true; }
      else return twimlReply(res, `📅 *Travel Date*\n\nRoute: *${session.from} → ${session.to}*\n\nFormat: *DD-MM-YYYY*\nOr say *"today"* / *"tomorrow"*`);
    }

    if (session.step === "ASK_DATE") {
      if (!session._skipDatePrompt) {
        const date = resolveDate(rawMsg) || parseDate(rawMsg);
        if (!date) return twimlReply(res, `⚠️ Invalid date. Use *DD-MM-YYYY* or say *"today"* / *"tomorrow"*.`);
        session.date = date;
      }
      session._skipDatePrompt = false;

      const date  = session.date;
      const start = new Date(date); start.setHours(0,0,0,0);
      const end   = new Date(date); end.setHours(23,59,59,999);

      const trips = await prisma.trip.findMany({
        where: {
          departureCity: { equals: session.from, mode: "insensitive" },
          destination:   { equals: session.to,   mode: "insensitive" },
          departureTime: { gte: start, lte: end },
        },
        include: { bookings: true, branch: { include: { park: true } } },
        orderBy: { departureTime: "asc" },
      });

      const available = trips.filter(t => (t.bookings?.length || 0) < t.totalSeats);
      if (!available.length) {
        clearSession(phone);
        return twimlReply(res, `😔 No seats available for:\n📍 ${session.from} → ${session.to}\n📅 ${formatDate(date)}\n\nType *menu* to try another date.`);
      }

      const parkOptions = buildParkOptions(available);
      session.trips       = available;
      session.parkOptions = parkOptions;
      session.step        = "SELECT_PARK";

      if (parkOptions.length === 1 && session._nluApplied) {
        session._nluApplied = false;
        return handleParkSelection(res, session, 0);
      }

      let msg2 = `🚌 *Available Options*\n📍 ${session.from} → ${session.to}\n📅 ${formatDate(date)}\n\n`;
      parkOptions.forEach((opt, i) => { msg2 += `*${i + 1}.* ${opt.label}\n`; });
      msg2 += `\nReply with a number.`;
      return twimlReply(res, msg2);
    }

    if (session.step === "SELECT_PARK") {
      const index = parseInt(rawMsg) - 1;
      const opts  = session.parkOptions;
      if (isNaN(index) || index < 0 || index >= opts?.length) {
        return twimlReply(res, `⚠️ Please reply with a number between 1 and ${opts?.length || "?"}.`);
      }
      return handleParkSelection(res, session, index);
    }

    if (session.step === "SELECT_TRIP") {
      const index = parseInt(rawMsg) - 1;
      const trip  = session.filteredTrips?.[index];
      if (!trip) return twimlReply(res, `⚠️ Invalid choice. Reply with a number between 1 and ${session.filteredTrips?.length || "?"}.`);

      const freshTrip = await prisma.trip.findUnique({
        where: { id: trip.id }, include: { bookings: true, branch: { include: { park: true } } },
      });
      const booked = freshTrip.bookings?.length || 0;
      if (booked >= freshTrip.totalSeats) return twimlReply(res, `😔 That trip just filled up.\n\nReply with another number or type *menu* to search again.`);

      session.selectedTrip = freshTrip;
      session.step         = "ASK_SEATS";
      const remaining = freshTrip.totalSeats - booked;
      return twimlReply(res, `✅ *Trip Confirmed*\n⏰ ${formatTime(freshTrip.departureTime)}\n💺 ${remaining} seat${remaining !== 1 ? "s" : ""} left\n\nHow many seats? (max ${Math.min(remaining, 4)})`);
    }

    if (session.step === "ASK_SEATS") {
      let seats = session.seats || parseInt(rawMsg);
      const trip = session.selectedTrip;
      const freshBookings = await prisma.booking.count({ where: { tripId: trip.id } });
      const remaining     = trip.totalSeats - freshBookings;
      if (!seats || seats < 1 || seats > remaining || seats > 4) {
        session.seats = null;
        return twimlReply(res, `⚠️ Enter a valid seat count.\nAvailable: ${remaining} | Max per booking: ${Math.min(remaining, 4)}`);
      }
      session.seats = seats;
      session.step  = "ASK_NAME";
      return twimlReply(res, `👤 *Passenger Name*\n\n${seats > 1 ? `Booking ${seats} seats.\n\n` : ""}Enter the lead passenger's full name:`);
    }

    if (session.step === "ASK_NAME") {
      const name = rawMsg.trim();
      if (name.length < 3 || !/^[a-zA-Z\s\-']+$/.test(name)) return twimlReply(res, `⚠️ Enter a valid full name.\nExample: *Emeka Okafor*`);
      session.passengerName = name;
      session.step          = "ASK_PHONE";
      return twimlReply(res, `📱 Enter the passenger's phone number:\nExample: *08012345678*`);
    }

    if (session.step === "ASK_PHONE") {
      const enteredPhone = rawMsg.trim();
      if (!isValidPhone(enteredPhone)) return twimlReply(res, `⚠️ Invalid phone number.\nExample: *08012345678*`);
      session.passengerPhone = enteredPhone;
      session.step           = "ASK_NOK_NAME";
      return twimlReply(res, `🆘 *Next of Kin*\n\nEnter the next of kin's full name:`);
    }

    if (session.step === "ASK_NOK_NAME") {
      const nokName = rawMsg.trim();
      if (nokName.length < 3 || !/^[a-zA-Z\s\-']+$/.test(nokName)) return twimlReply(res, `⚠️ Enter a valid full name for next of kin.\nExample: *Ngozi Okafor*`);
      session.nextOfKinName = nokName;
      session.step          = "ASK_NOK_PHONE";
      return twimlReply(res, `📱 Next of kin's phone number:\nExample: *08087654321*`);
    }

    if (session.step === "ASK_NOK_PHONE") {
      const nokPhone = rawMsg.trim();
      if (!isValidPhone(nokPhone)) return twimlReply(res, `⚠️ Invalid phone number.\nExample: *08087654321*`);
      session.nextOfKinPhone = nokPhone;
      session.step           = "CONFIRM";

      const trip = session.selectedTrip;
      const { totalAmount } = calculateAmounts(trip.price * session.seats);

      return twimlReply(res,
`📋 *Confirm Booking*

👤 ${session.passengerName}
📱 ${session.passengerPhone}
🆘 NOK: ${session.nextOfKinName} (${session.nextOfKinPhone})
🚌 ${trip.branch?.park?.name}
📍 ${session.from} → ${session.to}
📅 ${formatDate(trip.departureTime)}
⏰ ${formatTime(trip.departureTime)}
💺 ${session.seats} seat${session.seats > 1 ? "s" : ""}
💰 ${formatCurrency(totalAmount)} _(incl. 3% fee)_

⏰ Payment must be made within *10 minutes* or seat will be released.

Reply *YES* to confirm or *NO* to cancel.`);
    }

    /* ─── CONFIRM ──────────────────────────────────────────────────────────
     * CHANGED:
     *   - bookings now store expiresAt (10 min from now)
     *   - Payment record created alongside each booking
     *   - createVirtualAccount no longer needs branchSubAccountCode
     * ─────────────────────────────────────────────────────────────────────*/
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

      const ticketTotal = trip.price * session.seats;
      const { totalAmount } = calculateAmounts(ticketTotal);

      // Seat lock expiry — 10 minutes from now
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const refs       = [];
      const bookingIds = [];
      const primaryRef = `GT-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

      for (let i = 0; i < session.seats; i++) {
        const ref      = generateRef();
        const nextSeat = freshBookings + i + 1;
        refs.push(ref);

        const created = await prisma.booking.create({
  data: {
    passengerName: session.passengerName,
    passengerPhone: session.passengerPhone,
    seatNumber: nextSeat,
    reference: ref,
    bookingSource: "WHATSAPP",
    tripId: trip.id,
    branchId: trip.branchId,
    paymentStatus: "PENDING",
    status: "PENDING",
    paymentMethod: "ONLINE",
    totalAmount,
    paymentReference: primaryRef,
    nextOfKinName: session.nextOfKinName,
    nextOfKinPhone: session.nextOfKinPhone,
  }
});

bookingIds.push(created.id);
        // ── Create Payment record ──────────────────────────────────────────
        await prisma.payment.create({
          data: {
            bookingId:  created.id,
            provider:   "MONNIFY",
            amount:     totalAmount,
            status:     "PENDING",
          }
        });
      }

      // ── Request Monnify virtual account ───────────────────────────────────
      let accountNumber, bankName, paymentReference;

      try {
        const result = await createVirtualAccount({
          reference:     primaryRef,
          passengerName: session.passengerName,
          passengerPhone:session.passengerPhone,
          ticketPrice:   ticketTotal,
          description:   `GoTicket: ${session.from} → ${session.to} (${session.seats} seat${session.seats > 1 ? "s" : ""})`,
        });

        accountNumber    = result.accountNumber;
        bankName         = result.bankName;
        paymentReference = result.paymentReference;

        // Save account details to all bookings in this group
        await prisma.booking.updateMany({
          where: { id: { in: bookingIds } },
          data:  { accountNumber, bankName, paymentReference },
        });

      } catch (monnifyErr) {
        console.error("[Monnify] Virtual account creation failed:", monnifyErr.message);
        clearSession(phone);

        const refList = refs.map((r, i) =>
          session.seats > 1 ? `  Seat ${freshBookings + i + 1}: *${r}*` : `*${r}*`
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

      clearSession(phone);

      const refList = refs.map((r, i) =>
        session.seats > 1 ? `  Seat ${freshBookings + i + 1}: *${r}*` : `*${r}*`
      ).join("\n");

      return twimlReply(res,
`✅ *Booking Reserved!*

━━━━━━━━━━━━━━━━
🎟️ Ref: ${refList}
━━━━━━━━━━━━━━━━
👤 ${session.passengerName}
🚌 ${trip.branch?.park?.name}
📍 ${session.from} → ${session.to}
📅 ${formatDate(trip.departureTime)}
⏰ ${formatTime(trip.departureTime)}
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

    return twimlReply(res, `I didn't understand that.\n\nType *menu* or say your route:\n*"Lagos to Abuja tomorrow"*`);

  } catch (error) {
    console.error("[WhatsApp Bot Error]", error);
    clearSession(phone);
    return twimlReply(res, `⚠️ Something went wrong. Type *hi* to start over.`);
  }
});

/* ── Park selection handler (unchanged) ─────────────────────────────────── */
async function handleParkSelection(res, session, optionIndex) {
  const chosen = session.parkOptions[optionIndex];
  const freshTrips = await Promise.all(
    chosen.trips.map(t => prisma.trip.findUnique({
      where: { id: t.id }, include: { bookings: true, branch: { include: { park: true } } },
    }))
  );
  const stillAvailable = freshTrips.filter(t => (t.bookings?.length || 0) < t.totalSeats);

  if (!stillAvailable.length) {
    return twimlReply(res, `😔 All trips for *${chosen.park}* just filled up.\n\nType *menu* to search again.`);
  }

  if (stillAvailable.length === 1) {
    const trip      = stillAvailable[0];
    const booked    = trip.bookings?.length || 0;
    const remaining = trip.totalSeats - booked;
    session.selectedTrip = trip;
    session.step         = "ASK_SEATS";
    return twimlReply(res,
`✅ *${chosen.park}*
💰 ${formatCurrency(chosen.price)}
⏰ ${formatTime(trip.departureTime)}
💺 ${remaining} seat${remaining !== 1 ? "s" : ""} left

How many seats? (max ${Math.min(remaining, 4)})`);
  }

  session.filteredTrips = stillAvailable;
  session.step          = "SELECT_TRIP";

  let msg = `🕐 *${chosen.park}* — ${formatCurrency(chosen.price)}\nChoose a departure time:\n\n`;
  stillAvailable.forEach((t, i) => {
    const remaining = t.totalSeats - (t.bookings?.length || 0);
    msg += `*${i + 1}.* ${formatTime(t.departureTime)} — ${remaining} seat${remaining !== 1 ? "s" : ""} left\n`;
  });
  return twimlReply(res, msg);
}

module.exports = router;