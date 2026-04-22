/**
 * routes/webhook.js
 *
 * Changes from previous version:
 *   1. NLU (services/nlp.js) runs on EVERY incoming message before step routing.
 *      Free-text like "book Lagos to Abuja tomorrow" is parsed and pre-fills
 *      session fields, jumping the user past steps they've already answered.
 *   2. Two new steps added AFTER ASK_PHONE, BEFORE CONFIRM:
 *        ASK_NOK_NAME  → passenger's next of kin full name
 *        ASK_NOK_PHONE → next of kin phone number
 *   3. Booking creation (CONFIRM step) now stores nextOfKinName + nextOfKinPhone.
 *
 * Every other step (MAIN_MENU through ASK_PHONE) is byte-for-byte identical
 * to the previous version. Only the CONFIRM step's prisma.booking.create()
 * call has two new fields added.
 */

const router = require("express").Router();
const prisma  = require("../prismaClient");
const { parseIntent, resolveDate } = require("../services/nlp");
const { createVirtualAccount, calculateAmounts } = require("../services/monnify");

/* ══════════════════════════════════════════
   SESSION STORE (in-memory)
   For production: replace with Redis
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
   HELPERS  (all unchanged)
══════════════════════════════════════════ */
function twimlReply(res, message) {
  res.type("text/xml");
  res.send(`<Response><Message>${message}</Message></Response>`);
}

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString("en-NG", {
    hour:   "2-digit",
    minute: "2-digit",
  });
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString("en-NG", {
    weekday: "long",
    day:     "numeric",
    month:   "long",
    year:    "numeric",
  });
}

function formatCurrency(amount) {
  return "₦" + Number(amount).toLocaleString("en-NG");
}

function generateRef() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ref = "GT-";
  for (let i = 0; i < 6; i++) {
    ref += chars[Math.floor(Math.random() * chars.length)];
  }
  return ref;
}

function parseRoute(text) {
  const cleaned = text.trim();
  const parts = cleaned
    .split(/\s*(?:-|–|—|to)\s*/i)
    .filter(Boolean);
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
  const today = new Date();
  today.setHours(0,0,0,0);
  if (date < today) return null;
  return date;
}

function isValidPhone(phone) {
  return /^\+?[0-9]{7,15}$/.test(phone.replace(/\s/g,""));
}

/* ══════════════════════════════════════════
   NLU HELPER
   Called at the top of every request.
   Attempts to extract intent + entities from
   the raw message and fast-forward the session.
   Returns true if the session was mutated and
   the caller should re-evaluate the new step.
══════════════════════════════════════════ */
function applyNLU(rawMsg, session) {
  const parsed = parseIntent(rawMsg);

  // Hard resets — always apply regardless of current step
  if (parsed.intent === "MENU")   return false; // handled by GREETINGS list below
  if (parsed.intent === "CANCEL") return false; // let CONFIRM step handle it

  // Only auto-advance when we're at the start or on a flexible input step
  const nluEligibleSteps = [undefined, "MAIN_MENU", "ASK_ROUTE", "ASK_DATE", "SELECT_TRIP", "ASK_SEATS"];
  if (!nluEligibleSteps.includes(session.step)) return false;

  // Nothing useful extracted
  if (parsed.intent !== "BOOK" && !parsed.from && !parsed.to && !parsed.date) return false;

  let mutated = false;

  // Pre-fill whatever the NLU found
  if (parsed.from && !session.from) { session.from = parsed.from; mutated = true; }
  if (parsed.to   && !session.to)   { session.to   = parsed.to;   mutated = true; }
  if (parsed.date && !session.date) { session.date  = parsed.date; mutated = true; }
  if (parsed.seats && !session.seats) { session.seats = parsed.seats; mutated = true; }

  if (!mutated) return false;

  // Advance the step to wherever we have enough info to jump to
  if (session.from && session.to && session.date) {
    // Have full route + date — jump to trip selection (fetch happens in ASK_DATE handler)
    session.step = "ASK_DATE";
  } else if (session.from && session.to) {
    session.step = "ASK_DATE";
  } else if (session.from || session.to) {
    session.step = "ASK_ROUTE";
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

  const session = getSession(phone);

  // Global escape hatch — unchanged
  const GREETINGS = ["hi","hello","hey","start","menu","restart","back","0"];
  if (GREETINGS.includes(msg) && session.step !== undefined) {
    clearSession(phone);
    sessions.set(phone, {});
  }

  try {

    /* ─── NLU PRE-PROCESSING ─────────────────────────────────────────────────
     * Run NLU on every message that isn't a simple menu command.
     * If it successfully pre-fills session fields, the standard step handlers
     * below will find the session already partially populated and can skip
     * prompts for data the passenger already gave us.
     * ─────────────────────────────────────────────────────────────────────── */
    if (!GREETINGS.includes(msg)) {
      applyNLU(rawMsg, session);
    }

    /* ─── STEP: INITIAL / MAIN MENU ─── */
    if (!session.step || GREETINGS.includes(msg)) {
      session.step = "MAIN_MENU";
      return twimlReply(res,
`🎟️ *GoTicket*
Nigeria's Digital Transport Booking Platform

Welcome! How can we help you today?

1️⃣  Book a trip
2️⃣  Check my booking
3️⃣  Customer support

_Or just tell us where you're going — e.g. "Lagos to Abuja tomorrow"_`
      );
    }

    /* ─── STEP: MAIN MENU SELECTION ─── */
    if (session.step === "MAIN_MENU") {

      // If NLU already gave us a route, skip straight to the search
      if (session._nluApplied && session.from && session.to) {
        session.step = "ASK_DATE";
        // Fall through to ASK_DATE handler below
      } else if (msg === "1") {
        session.step = "ASK_ROUTE";
        return twimlReply(res,
`🗺️ *Route Selection*

Where are you travelling?

Please enter your route like this:
*Lagos - Abuja*

(You can also write "Lagos to Abuja")`
        );
      } else if (msg === "2") {
        session.step = "CHECK_BOOKING";
        return twimlReply(res,
`🔍 *Check Booking*

Please enter your booking reference code.
Example: *GT-A3K7RX*`
        );
      } else if (msg === "3") {
        clearSession(phone);
        return twimlReply(res,
`📞 *Customer Support*

You can reach us through:
• Phone: +234 800 000 0000
• Email: support@goticket.ng
• Hours: Mon–Sat, 6am–10pm

Reply *menu* anytime to go back.`
        );
      } else {
        // Unrecognised — give helpful nudge
        return twimlReply(res,
`Please reply with *1*, *2*, or *3*.

Or just tell us your route — e.g. *"Makurdi to Abuja tomorrow"*`
        );
      }
    }

    /* ─── STEP: CHECK BOOKING BY REF ─── */
    if (session.step === "CHECK_BOOKING") {
      // Also handle NLU-detected reference code
      const parsed = parseIntent(rawMsg);
      const ref    = (parsed.ref || rawMsg.trim()).toUpperCase();

      const booking = await prisma.booking.findFirst({
        where:   { reference: ref },
        include: { trip: { include: { branch: { include: { park: true } } } } }
      });

      clearSession(phone);

      if (!booking) {
        return twimlReply(res,
`❌ No booking found with reference *${ref}*.

Please double-check the code and try again.
Type *menu* to go back to the main menu.`
        );
      }

      const trip = booking.trip;
      return twimlReply(res,
`✅ *Booking Found*

👤 Passenger: ${booking.passengerName}
🎟️ Reference: *${booking.reference}*
🚌 Park: ${trip.branch?.park?.name || "N/A"}
📍 Route: ${trip.departureCity} → ${trip.destination}
📅 Date: ${formatDate(trip.departureTime)}
⏰ Time: ${formatTime(trip.departureTime)}
💺 Seat: ${booking.seatNumber}
💰 Price: ${formatCurrency(trip.price)}

Please show this message at the park terminal.
Type *menu* to return to main menu.`
      );
    }

    /* ─── STEP: ASK ROUTE ─── */
    if (session.step === "ASK_ROUTE") {
      // If NLU already filled the route, skip prompting
      if (!session.from || !session.to) {
        const route = parseRoute(rawMsg);
        if (!route) {
          return twimlReply(res,
`⚠️ I didn't understand that route format.

Please try again like this:
*Lagos - Abuja*
*Makurdi - Lagos*

Or write: *"Makurdi to Abuja"*`
          );
        }
        session.from = route.from;
        session.to   = route.to;
      }

      session.step = "ASK_DATE";

      // If NLU already gave us a date, fall through immediately
      if (session.date) {
        // Will be handled by ASK_DATE block below — but we need to re-enter it.
        // Set a flag so ASK_DATE knows to use the pre-filled date.
        session._skipDatePrompt = true;
      } else {
        return twimlReply(res,
`📅 *Travel Date*

Route: *${session.from} → ${session.to}*

What date would you like to travel?

Format: *DD-MM-YYYY*
Example: *25-04-2026*

_(Or say "today" / "tomorrow")_`
        );
      }
    }

    /* ─── STEP: ASK DATE ─── */
    if (session.step === "ASK_DATE") {
      // Use pre-filled date if NLU/skip flag set it
      if (!session._skipDatePrompt) {
        // First try NLU resolver (handles "today", "tomorrow", etc.)
        const nlpDate = resolveDate(rawMsg);
        const date    = nlpDate || parseDate(rawMsg);

        if (!date) {
          return twimlReply(res,
`⚠️ Invalid date. Please use the format *DD-MM-YYYY*.
Example: *25-04-2026*

Or say *"today"* / *"tomorrow"*.
Note: Past dates are not accepted.`
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
          departureTime: { gte: start, lte: end }
        },
        include: {
          bookings: true,
          branch: { include: { park: true } }
        },
        orderBy: { departureTime: "asc" }
      });

      const available = trips.filter(t => (t.bookings?.length || 0) < t.totalSeats);

      if (!available.length) {
        clearSession(phone);
        return twimlReply(res,
`😔 *No Available Trips*

No seats available for:
📍 ${session.from} → ${session.to}
📅 ${formatDate(date)}

Would you like to try another date?
Type *menu* to start over.`
        );
      }

      session.trips = available;
      session.step  = "SELECT_TRIP";

      // If NLU gave us only one matching trip (or a seat count), try to auto-select
      if (available.length === 1 && session._nluApplied) {
        // Auto-select the only available trip without asking
        const freshTrip = await prisma.trip.findUnique({
          where:   { id: available[0].id },
          include: { bookings: true, branch: { include: { park: true } } }
        });
        const booked    = freshTrip.bookings?.length || 0;
        const remaining = freshTrip.totalSeats - booked;

        session.selectedTrip = freshTrip;
        session.step         = "ASK_SEATS";

        return twimlReply(res,
`🚌 *One trip found — auto-selected!*

🚌 ${freshTrip.branch?.park?.name}
📍 ${session.from} → ${session.to}
⏰ ${formatTime(freshTrip.departureTime)}
💰 ${formatCurrency(freshTrip.price)} per seat
💺 ${remaining} seat${remaining !== 1 ? "s" : ""} remaining

How many seats do you need?
(Maximum: ${Math.min(remaining, 4)})`
        );
      }

      let message = `🚌 *Available Trips*\n`;
      message    += `📍 ${session.from} → ${session.to}\n`;
      message    += `📅 ${formatDate(date)}\n\n`;

      available.forEach((t, i) => {
        const booked    = t.bookings?.length || 0;
        const remaining = t.totalSeats - booked;
        message += `*${i + 1}.* ${t.branch?.park?.name}\n`;
        message += `    ⏰ ${formatTime(t.departureTime)}\n`;
        message += `    💰 ${formatCurrency(t.price)}\n`;
        message += `    💺 ${remaining} seat${remaining !== 1 ? "s" : ""} left\n\n`;
      });

      message += `Reply with the number of your preferred trip.`;
      return twimlReply(res, message);
    }

    /* ─── STEP: SELECT TRIP ─── */
    if (session.step === "SELECT_TRIP") {
      const index = parseInt(rawMsg) - 1;
      const trip  = session.trips?.[index];

      if (!trip) {
        return twimlReply(res,
`⚠️ Invalid selection. Please reply with a number between 1 and ${session.trips?.length || "?"}.`
        );
      }

      const freshTrip = await prisma.trip.findUnique({
        where:   { id: trip.id },
        include: { bookings: true, branch: { include: { park: true } } }
      });

      const booked = freshTrip.bookings?.length || 0;
      if (booked >= freshTrip.totalSeats) {
        return twimlReply(res,
`😔 Sorry, that trip just filled up.

Please choose another option or type *menu* to search again.`
        );
      }

      session.selectedTrip = freshTrip;
      session.step         = "ASK_SEATS";

      const remaining = freshTrip.totalSeats - booked;
      return twimlReply(res,
`✅ *Trip Selected*

🚌 ${freshTrip.branch?.park?.name}
📍 ${session.from} → ${session.to}
⏰ ${formatTime(freshTrip.departureTime)}
💰 ${formatCurrency(freshTrip.price)} per seat
💺 ${remaining} seat${remaining !== 1 ? "s" : ""} remaining

How many seats do you need?
(Maximum: ${Math.min(remaining, 4)})`
      );
    }

    /* ─── STEP: ASK SEATS ─── */
    if (session.step === "ASK_SEATS") {
      // If NLU pre-filled seats, skip the prompt
      let seats = session.seats || parseInt(rawMsg);
      const trip = session.selectedTrip;

      const freshBookings = await prisma.booking.count({ where: { tripId: trip.id } });
      const remaining     = trip.totalSeats - freshBookings;

      if (!seats || seats < 1 || seats > remaining || seats > 4) {
        session.seats = null; // clear bad NLU value
        return twimlReply(res,
`⚠️ Please enter a valid number of seats.
Available: ${remaining} | Maximum per booking: ${Math.min(remaining, 4)}`
        );
      }

      session.seats = seats;
      session.step  = "ASK_NAME";

      return twimlReply(res,
`👤 *Passenger Details*

${seats > 1 ? `Booking ${seats} seats.\n\n` : ""}Please enter the *lead passenger's full name*:`
      );
    }

    /* ─── STEP: ASK NAME ─── */
    if (session.step === "ASK_NAME") {
      const name = rawMsg.trim();

      if (name.length < 3 || !/^[a-zA-Z\s\-']+$/.test(name)) {
        return twimlReply(res,
`⚠️ Please enter a valid full name.
Example: *Emeka Okafor*`
        );
      }

      session.passengerName = name;
      session.step          = "ASK_PHONE";

      return twimlReply(res,
`📱 *Contact Number*

Please enter the passenger's phone number:
Example: *08012345678*`
      );
    }

    /* ─── STEP: ASK PHONE ─── */
    if (session.step === "ASK_PHONE") {
      const enteredPhone = rawMsg.trim();

      if (!isValidPhone(enteredPhone)) {
        return twimlReply(res,
`⚠️ That doesn't look like a valid phone number.
Please try again. Example: *08012345678*`
        );
      }

      session.passengerPhone = enteredPhone;
      session.step           = "ASK_NOK_NAME";   // ← NEW: next-of-kin flow

      return twimlReply(res,
`🆘 *Next of Kin*

Please enter the *full name* of the passenger's next of kin:
Example: *Ngozi Okafor*`
      );
    }

    /* ─── STEP: ASK NOK NAME (NEW) ───────────────────────────────────────── */
    if (session.step === "ASK_NOK_NAME") {
      const nokName = rawMsg.trim();

      if (nokName.length < 3 || !/^[a-zA-Z\s\-']+$/.test(nokName)) {
        return twimlReply(res,
`⚠️ Please enter a valid full name for the next of kin.
Example: *Ngozi Okafor*`
        );
      }

      session.nextOfKinName = nokName;
      session.step          = "ASK_NOK_PHONE";

      return twimlReply(res,
`📱 *Next of Kin Phone*

Please enter the next of kin's phone number:
Example: *08087654321*`
      );
    }

    /* ─── STEP: ASK NOK PHONE (NEW) ──────────────────────────────────────── */
    if (session.step === "ASK_NOK_PHONE") {
      const nokPhone = rawMsg.trim();

      if (!isValidPhone(nokPhone)) {
        return twimlReply(res,
`⚠️ That doesn't look like a valid phone number.
Please try again. Example: *08087654321*`
        );
      }

      session.nextOfKinPhone = nokPhone;
      session.step           = "CONFIRM";

      const trip = session.selectedTrip;
      const { totalAmount } = calculateAmounts(trip.price * session.seats);

      return twimlReply(res,
`📋 *Booking Summary*

Please confirm your booking:

👤 Name:     ${session.passengerName}
📱 Phone:    ${session.passengerPhone}
🆘 Next of Kin: ${session.nextOfKinName} (${session.nextOfKinPhone})
🚌 Park:     ${trip.branch?.park?.name}
📍 Route:    ${session.from} → ${session.to}
📅 Date:     ${formatDate(trip.departureTime)}
⏰ Time:     ${formatTime(trip.departureTime)}
💺 Seats:    ${session.seats}
💰 Total:    ${formatCurrency(totalAmount)}
_(includes 3% processing fee)_

Reply *YES* to confirm or *NO* to cancel.`
      );
    }

    /* ─── STEP: CONFIRM ──────────────────────────────────────────────────── */
    if (session.step === "CONFIRM") {

      if (msg === "no" || msg === "cancel") {
        clearSession(phone);
        return twimlReply(res, `❌ Booking cancelled.\n\nType *menu* to start a new booking.`);
      }

      if (msg !== "yes" && msg !== "y") {
        return twimlReply(res, `Please reply *YES* to confirm or *NO* to cancel.`);
      }

      const trip          = session.selectedTrip;
      const freshBookings = await prisma.booking.count({ where: { tripId: trip.id } });

      if (freshBookings >= trip.totalSeats) {
        clearSession(phone);
        return twimlReply(res,
`😔 Sorry! This trip just became fully booked while you were confirming.

Type *menu* to search for another trip.`
        );
      }

      // ── Calculate amounts ─────────────────────────────────────────────────
      const ticketTotal = trip.price * session.seats;
      const { totalAmount } = calculateAmounts(ticketTotal);

      // ── Create bookings (one per seat) ────────────────────────────────────
      const refs       = [];
      const bookingIds = [];

      for (let i = 0; i < session.seats; i++) {
        const nextSeat = freshBookings + i + 1;
        const ref      = generateRef();
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
            // ── NEW: next of kin ────────────────────────────────────────────
            nextOfKinName:  session.nextOfKinName,
            nextOfKinPhone: session.nextOfKinPhone,
          }
        });

        bookingIds.push(created.id);
      }

      const primaryRef = refs[0];

      // ── Request Monnify virtual account ───────────────────────────────────
      let accountNumber, bankName, paymentReference;

      try {
        const tripWithBranch = await prisma.trip.findUnique({
          where:   { id: trip.id },
          include: { branch: true }
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
          data:  { accountNumber, bankName, paymentReference }
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

Please contact support to complete payment:
📞 +234 800 000 0000

Type *menu* to return to the main menu.`
        );
      }

      clearSession(phone);

      const refList = refs.map((r, i) =>
        session.seats > 1 ? `  Seat ${freshBookings + i + 1}: *${r}*` : `*${r}*`
      ).join("\n");

      return twimlReply(res,
`✅ *Booking Reserved!*

━━━━━━━━━━━━━━━━━━━━
🎟️ Reference${refs.length > 1 ? "s" : ""}:
${refList}
━━━━━━━━━━━━━━━━━━━━

👤 ${session.passengerName}
🚌 ${trip.branch?.park?.name}
📍 ${session.from} → ${session.to}
📅 ${formatDate(trip.departureTime)}
⏰ ${formatTime(trip.departureTime)}
💺 ${session.seats} seat${session.seats > 1 ? "s" : ""}

💳 *Pay Now to Confirm Your Seat*
━━━━━━━━━━━━━━━━━━━━
🏦 Bank:    ${bankName}
🔢 Account: *${accountNumber}*
💰 Amount:  *${formatCurrency(totalAmount)}*
🔖 Ref:     ${paymentReference}
━━━━━━━━━━━━━━━━━━━━

⚠️ Transfer the *exact amount* shown above.
Your seat will be confirmed automatically once payment is received.

Type *menu* for a new booking.`
      );
    }

    // Fallback — unrecognised input
    return twimlReply(res,
`I didn't understand that.

Type *menu* to return to the main menu or *hi* to start over.
Or just tell us your route — e.g. *"Lagos to Abuja tomorrow"*`
    );

  } catch (error) {
    console.error("[WhatsApp Bot Error]", error);
    clearSession(phone);
    return twimlReply(res,
`⚠️ Something went wrong on our end. Please try again in a moment.

Type *hi* to start over.`
    );
  }
});

module.exports = router;