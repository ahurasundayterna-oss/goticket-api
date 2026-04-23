/**
 * routes/webhook.js
 *
 * CHANGED in this version:
 *   - ASK_DATE:     after fetching trips, groups them by park + price and
 *                   advances to SELECT_PARK instead of SELECT_TRIP.
 *   - SELECT_PARK:  NEW step — user picks a park/price option; if that
 *                   selection has multiple departure times the user is sent
 *                   to SELECT_TRIP, otherwise auto-advances to ASK_SEATS.
 *   - SELECT_TRIP:  now shows departure-time options only for the already-
 *                   chosen park, so messages are short.
 *
 *   Everything from ASK_SEATS onward is byte-for-byte identical to the
 *   previous version.
 */

const router = require("express").Router();
const prisma  = require("../prismaClient");
const { parseIntent, resolveDate } = require("../services/nlp");
const { createVirtualAccount, calculateAmounts } = require("../services/monnify");

/* ══════════════════════════════════════════
   SESSION STORE  (in-memory; swap for Redis in prod)
══════════════════════════════════════════ */
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) sessions.set(phone, {});
  return sessions.get(phone);
}
function clearSession(phone) {
  sessions.delete(phone);
}

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */
function twimlReply(res, message) {
  res.type("text/xml");
  res.send(`<Response><Message>${message}</Message></Response>`);
}
function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString("en-NG", { hour:"2-digit", minute:"2-digit" });
}
function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-NG", {
    weekday:"long", day:"numeric", month:"long", year:"numeric",
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

/* ══════════════════════════════════════════
   NEW HELPER — build park/price option list
   ──────────────────────────────────────────
   Groups a flat trips array into unique
   (parkName, price) combinations.

   Returns an array of option objects:
   [
     {
       label:  "Benue Links — ₦30,000",
       park:   "Benue Links",
       price:  30000,
       trips:  [ ...trip objects with this park+price ]
     },
     ...
   ]
   Sorted by price ascending, then park name.
══════════════════════════════════════════ */
function buildParkOptions(trips) {
  const map = new Map();

  for (const trip of trips) {
    const parkName = trip.branch?.park?.name || "Unknown";
    const key      = `${parkName}::${trip.price}`;

    if (!map.has(key)) {
      map.set(key, {
        label: `${parkName} — ${formatCurrency(trip.price)}`,
        park:  parkName,
        price: trip.price,
        trips: [],
      });
    }
    map.get(key).trips.push(trip);
  }

  // Sort: price ascending, then park name alphabetically
  return Array.from(map.values()).sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return a.park.localeCompare(b.park);
  });
}

/* ══════════════════════════════════════════
   NLU PRE-PROCESSOR  (unchanged)
══════════════════════════════════════════ */
function applyNLU(rawMsg, session) {
  const parsed = parseIntent(rawMsg);
  if (parsed.intent === "MENU")   return false;
  if (parsed.intent === "CANCEL") return false;

  const nluEligibleSteps = [undefined, "MAIN_MENU", "ASK_ROUTE", "ASK_DATE", "SELECT_PARK", "SELECT_TRIP", "ASK_SEATS"];
  if (!nluEligibleSteps.includes(session.step)) return false;
  if (parsed.intent !== "BOOK" && !parsed.from && !parsed.to && !parsed.date) return false;

  let mutated = false;
  if (parsed.from  && !session.from)  { session.from  = parsed.from;  mutated = true; }
  if (parsed.to    && !session.to)    { session.to    = parsed.to;    mutated = true; }
  if (parsed.date  && !session.date)  { session.date  = parsed.date;  mutated = true; }
  if (parsed.seats && !session.seats) { session.seats = parsed.seats; mutated = true; }

  if (!mutated) return false;

  if (session.from && session.to && session.date) {
    session.step = "ASK_DATE";
  } else if (session.from && session.to) {
    session.step = "ASK_DATE";
  } else {
    session.step = "ASK_ROUTE";
  }

  session._nluApplied = true;
  return true;
}

/* ══════════════════════════════════════════
   MAIN WEBHOOK
══════════════════════════════════════════ */
router.post("/", async (req, res) => {
  const rawMsg = req.body.Body?.trim() || "";
  const phone  = req.body.From;
  const msg    = rawMsg.toLowerCase();

  console.log(`[WhatsApp] ${phone} → "${rawMsg}"`);

  const session  = getSession(phone);
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
_"Lagos to Abuja tomorrow"_`
      );
    }

    /* ─── MAIN MENU SELECTION ─── */
    if (session.step === "MAIN_MENU") {
      if (session._nluApplied && session.from && session.to) {
        session.step = "ASK_DATE";
        // fall through to ASK_DATE handler below
      } else if (msg === "1") {
        session.step = "ASK_ROUTE";
        return twimlReply(res,
`🗺️ *Route*

Enter your route:
*Lagos - Abuja*  or  *"Lagos to Abuja"*`
        );
      } else if (msg === "2") {
        session.step = "CHECK_BOOKING";
        return twimlReply(res, `🔍 Enter your booking reference:\nExample: *GT-A3K7RX*`);
      } else if (msg === "3") {
        clearSession(phone);
        return twimlReply(res,
`📞 *Support*
• Phone: +234 800 000 0000
• Email: support@goticket.ng
• Hours: Mon–Sat, 6am–10pm`
        );
      } else {
        return twimlReply(res, `Reply *1*, *2*, or *3*.\nOr say your route: *"Makurdi to Abuja tomorrow"*`);
      }
    }

    /* ─── CHECK BOOKING ─── */
    if (session.step === "CHECK_BOOKING") {
      const parsed = parseIntent(rawMsg);
      const ref    = (parsed.ref || rawMsg.trim()).toUpperCase();

      const booking = await prisma.booking.findFirst({
        where:   { reference: ref },
        include: { trip: { include: { branch: { include: { park: true } } } } }
      });
      clearSession(phone);

      if (!booking) {
        return twimlReply(res, `❌ No booking for *${ref}*.\nCheck the code and try again.\nType *menu* to go back.`);
      }

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

Show this at the terminal.
Type *menu* to go back.`
      );
    }

    /* ─── ASK ROUTE ─── */
    if (session.step === "ASK_ROUTE") {
      if (!session.from || !session.to) {
        const route = parseRoute(rawMsg);
        if (!route) {
          return twimlReply(res,
`⚠️ Couldn't read that route.
Try: *Lagos - Abuja* or *"Makurdi to Abuja"*`
          );
        }
        session.from = route.from;
        session.to   = route.to;
      }

      session.step = "ASK_DATE";

      if (session.date) {
        session._skipDatePrompt = true;
      } else {
        return twimlReply(res,
`📅 *Travel Date*

Route: *${session.from} → ${session.to}*

Format: *DD-MM-YYYY*
Or say *"today"* / *"tomorrow"*`
        );
      }
    }

    /* ─── ASK DATE ─────────────────────────────────────────────────────────
     * CHANGED: after fetching trips, builds park/price option groups and
     *          advances to SELECT_PARK instead of SELECT_TRIP.
     * ─────────────────────────────────────────────────────────────────────*/
    if (session.step === "ASK_DATE") {
      if (!session._skipDatePrompt) {
        const nlpDate = resolveDate(rawMsg);
        const date    = nlpDate || parseDate(rawMsg);
        if (!date) {
          return twimlReply(res,
`⚠️ Invalid date. Use *DD-MM-YYYY* or say *"today"* / *"tomorrow"*.`
          );
        }
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
        include: {
          bookings: true,
          branch:   { include: { park: true } },
        },
        orderBy: { departureTime: "asc" },
      });

      const available = trips.filter(t => (t.bookings?.length || 0) < t.totalSeats);

      if (!available.length) {
        clearSession(phone);
        return twimlReply(res,
`😔 No seats available for:
📍 ${session.from} → ${session.to}
📅 ${formatDate(date)}

Type *menu* to try another date.`
        );
      }

      // ── Build park/price groups ──────────────────────────────────────────
      const parkOptions = buildParkOptions(available);
      session.trips       = available;      // keep full list for later filtering
      session.parkOptions = parkOptions;    // grouped summary
      session.step        = "SELECT_PARK";

      // If NLU found only one option, auto-select it
      if (parkOptions.length === 1 && session._nluApplied) {
        session._nluApplied = false;
        return handleParkSelection(res, session, 0);
      }

      // Build the summary message — park name + price only, one line each
      let msg2 = `🚌 *Available Options*\n`;
      msg2    += `📍 ${session.from} → ${session.to}\n`;
      msg2    += `📅 ${formatDate(date)}\n\n`;

      parkOptions.forEach((opt, i) => {
        msg2 += `*${i + 1}.* ${opt.label}\n`;
      });

      msg2 += `\nReply with a number.`;
      return twimlReply(res, msg2);
    }

    /* ─── SELECT PARK  (NEW STEP) ───────────────────────────────────────────
     * User has picked a park+price option.
     * If that option has multiple trips (different times) → go to SELECT_TRIP.
     * If only one trip → skip straight to ASK_SEATS.
     * ─────────────────────────────────────────────────────────────────────*/
    if (session.step === "SELECT_PARK") {
      const index = parseInt(rawMsg) - 1;
      const opts  = session.parkOptions;

      if (isNaN(index) || index < 0 || index >= opts?.length) {
        return twimlReply(res,
`⚠️ Please reply with a number between 1 and ${opts?.length || "?"}.`
        );
      }

      return handleParkSelection(res, session, index);
    }

    /* ─── SELECT TRIP  (UPDATED) ────────────────────────────────────────────
     * Now only shows departure times — park and price are already known.
     * ─────────────────────────────────────────────────────────────────────*/
    if (session.step === "SELECT_TRIP") {
      const index = parseInt(rawMsg) - 1;
      const trip  = session.filteredTrips?.[index];

      if (!trip) {
        return twimlReply(res,
`⚠️ Invalid choice. Reply with a number between 1 and ${session.filteredTrips?.length || "?"}.`
        );
      }

      // Re-check availability (race condition guard)
      const freshTrip = await prisma.trip.findUnique({
        where:   { id: trip.id },
        include: { bookings: true, branch: { include: { park: true } } },
      });

      const booked = freshTrip.bookings?.length || 0;
      if (booked >= freshTrip.totalSeats) {
        return twimlReply(res,
`😔 That trip just filled up.

Reply with another number or type *menu* to search again.`
        );
      }

      session.selectedTrip = freshTrip;
      session.step         = "ASK_SEATS";

      const remaining = freshTrip.totalSeats - booked;
      return twimlReply(res,
`✅ *Trip Confirmed*
⏰ ${formatTime(freshTrip.departureTime)}
💺 ${remaining} seat${remaining !== 1 ? "s" : ""} left

How many seats? (max ${Math.min(remaining, 4)})`
      );
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
`⚠️ Enter a valid seat count.
Available: ${remaining} | Max per booking: ${Math.min(remaining, 4)}`
        );
      }

      session.seats = seats;
      session.step  = "ASK_NAME";
      return twimlReply(res,
`👤 *Passenger Name*

${seats > 1 ? `Booking ${seats} seats.\n\n` : ""}Enter the lead passenger's full name:`
      );
    }

    /* ─── ASK NAME ─── */
    if (session.step === "ASK_NAME") {
      const name = rawMsg.trim();
      if (name.length < 3 || !/^[a-zA-Z\s\-']+$/.test(name)) {
        return twimlReply(res, `⚠️ Enter a valid full name.\nExample: *Emeka Okafor*`);
      }
      session.passengerName = name;
      session.step          = "ASK_PHONE";
      return twimlReply(res, `📱 Enter the passenger's phone number:\nExample: *08012345678*`);
    }

    /* ─── ASK PHONE ─── */
    if (session.step === "ASK_PHONE") {
      const enteredPhone = rawMsg.trim();
      if (!isValidPhone(enteredPhone)) {
        return twimlReply(res, `⚠️ Invalid phone number.\nExample: *08012345678*`);
      }
      session.passengerPhone = enteredPhone;
      session.step           = "ASK_NOK_NAME";
      return twimlReply(res,
`🆘 *Next of Kin*

Enter the next of kin's full name:`
      );
    }

    /* ─── ASK NOK NAME ─── */
    if (session.step === "ASK_NOK_NAME") {
      const nokName = rawMsg.trim();
      if (nokName.length < 3 || !/^[a-zA-Z\s\-']+$/.test(nokName)) {
        return twimlReply(res, `⚠️ Enter a valid full name for next of kin.\nExample: *Ngozi Okafor*`);
      }
      session.nextOfKinName = nokName;
      session.step          = "ASK_NOK_PHONE";
      return twimlReply(res, `📱 Next of kin's phone number:\nExample: *08087654321*`);
    }

    /* ─── ASK NOK PHONE ─── */
    if (session.step === "ASK_NOK_PHONE") {
      const nokPhone = rawMsg.trim();
      if (!isValidPhone(nokPhone)) {
        return twimlReply(res, `⚠️ Invalid phone number.\nExample: *08087654321*`);
      }
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

Reply *YES* to confirm or *NO* to cancel.`
      );
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

      const ticketTotal = trip.price * session.seats;
      const { totalAmount } = calculateAmounts(ticketTotal);

      const refs      = [];
      const bookingIds = [];

      for (let i = 0; i < session.seats; i++) {
        const ref     = generateRef();
        const nextSeat = freshBookings + i + 1;
        refs.push(ref);

        const created = await prisma.booking.create({
          data: {
            passengerName:  session.passengerName,
            passengerPhone: session.passengerPhone,
            seatNumber:     nextSeat,
            reference:      ref,
            bookingSource:  "WHATSAPP",
            tripId:         trip.id,
            branchId:       trip.branchId,
            paymentStatus:  "PENDING",
            totalAmount,
            nextOfKinName:  session.nextOfKinName,
            nextOfKinPhone: session.nextOfKinPhone,
          }
        });
        bookingIds.push(created.id);
      }

      const primaryRef = refs[0];
      let accountNumber, bankName, paymentReference;

      try {
        const tripWithBranch = await prisma.trip.findUnique({
          where:   { id: trip.id },
          include: { branch: true },
        });

        const result = await createVirtualAccount({
          reference:            primaryRef,
          passengerName:        session.passengerName,
          passengerPhone:       session.passengerPhone,
          ticketPrice:          ticketTotal,
          branchSubAccountCode: tripWithBranch.branch.monnifySubAccountCode,
          description: `GoTicket: ${session.from} → ${session.to} (${session.seats} seat${session.seats > 1 ? "s" : ""})`,
        });

        accountNumber    = result.accountNumber;
        bankName         = result.bankName;
        paymentReference = result.paymentReference;

        await prisma.booking.updateMany({
          where: { id: { in: bookingIds } },
          data:  { accountNumber, bankName, paymentReference },
        });
      } catch (monnifyErr) {
        console.error("[Monnify] Failed:", monnifyErr.message);
        clearSession(phone);

        const refList = refs.map((r, i) =>
          session.seats > 1 ? `  Seat ${freshBookings + i + 1}: *${r}*` : `*${r}*`
        ).join("\n");

        return twimlReply(res,
`⚠️ *Booking Created — Payment Pending*

${refList}

Contact support to pay:
📞 +234 800 000 0000

Type *menu* to go back.`
        );
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

💳 *Pay to confirm your seat*
🏦 ${bankName}
🔢 *${accountNumber}*
💰 *${formatCurrency(totalAmount)}*
🔖 ${paymentReference}

Transfer the exact amount shown.
Seat confirmed automatically on receipt.

Type *menu* for a new booking.`
      );
    }

    // Fallback
    return twimlReply(res,
`I didn't understand that.

Type *menu* or say your route:
*"Lagos to Abuja tomorrow"*`
    );

  } catch (error) {
    console.error("[WhatsApp Bot Error]", error);
    clearSession(phone);
    return twimlReply(res, `⚠️ Something went wrong. Type *hi* to start over.`);
  }
});

/* ══════════════════════════════════════════
   PARK SELECTION HANDLER
   ──────────────────────────────────────────
   Extracted as a named function so both
   SELECT_PARK and the NLU auto-select path
   use identical logic with no duplication.
══════════════════════════════════════════ */
async function handleParkSelection(res, session, optionIndex) {
  const chosen = session.parkOptions[optionIndex];

  // Re-check seat availability for all trips in this group
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
`😔 All trips for *${chosen.park}* just filled up.

Type *menu* to search again.`
    );
  }

  // Only one trip at this park+price — skip the time-selection step
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

How many seats? (max ${Math.min(remaining, 4)})`
    );
  }

  // Multiple departure times — let user pick one
  session.filteredTrips = stillAvailable;
  session.step          = "SELECT_TRIP";

  let msg = `🕐 *${chosen.park}* — ${formatCurrency(chosen.price)}\n`;
  msg    += `Choose a departure time:\n\n`;

  stillAvailable.forEach((t, i) => {
    const booked    = t.bookings?.length || 0;
    const remaining = t.totalSeats - booked;
    msg += `*${i + 1}.* ${formatTime(t.departureTime)} — ${remaining} seat${remaining !== 1 ? "s" : ""} left\n`;
  });

  return twimlReply(res, msg);
}

module.exports = router;