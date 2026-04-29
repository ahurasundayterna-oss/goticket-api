"use strict";

const axios  = require("axios");
const crypto = require("crypto");

const BASE_URL      = process.env.MONNIFY_BASE_URL      || "https://sandbox.monnify.com";
const API_KEY       = process.env.MONNIFY_API_KEY;
const SECRET_KEY    = process.env.MONNIFY_SECRET_KEY;
const CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

const COMMISSION_RATE = 0.03; // 3% GoTicket fee

/* ── Auth token cache ─────────────────────────────────────────── */
let _cachedToken    = null;
let _tokenExpiresAt = 0;

async function getAuthToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt) return _cachedToken;

  const credentials = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString("base64");

  const { data } = await axios.post(
    `${BASE_URL}/api/v1/auth/login`,
    {},
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify auth failed: ${data.responseMessage}`);
  }

  _cachedToken    = data.responseBody.accessToken;
  _tokenExpiresAt = now + (data.responseBody.expiresIn - 60) * 1000;

  return _cachedToken;
}

/* ── Amount helper ────────────────────────────────────────────── */
function calculateAmounts(ticketPrice) {
  const commission  = Math.round(ticketPrice * COMMISSION_RATE * 100) / 100;
  const totalAmount = Math.round((ticketPrice + commission) * 100) / 100;
  return { ticketPrice, commission, totalAmount };
}

/* ── Webhook signature verification ──────────────────────────── */
function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

/* ── Create reserved virtual account ─────────────────────────── */
async function createVirtualAccount({
  reference,
  passengerName,
  passengerPhone,
  ticketPrice,
  description,
}) {
  const token = await getAuthToken();
  const { totalAmount } = calculateAmounts(ticketPrice);

  // Sanitise phone → valid email placeholder
  const safePhone = passengerPhone.replace(/\D/g, "");

  const payload = {
    accountReference:    reference,
    accountName:         passengerName,
    customerEmail:       `${safePhone}@goticket.ng`,
    customerName:        passengerName,
    currencyCode:        "NGN",
    contractCode:        CONTRACT_CODE,
    getAllAvailableBanks: true,  // get all available banks in sandbox
    description:         description || `GoTicket booking — ${reference}`,
  };

  console.log("[Monnify] Creating virtual account:", payload);

  const { data } = await axios.post(
    `${BASE_URL}/api/v2/bank-transfer/reserved-accounts`,
    payload,
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );

  console.log("[Monnify] Virtual account response:", JSON.stringify(data, null, 2));

  if (!data.requestSuccessful) {
    throw new Error(`Monnify virtual account failed: ${data.responseMessage}`);
  }

  const body    = data.responseBody;
  // Pick first available account
  const account = Array.isArray(body.accounts) && body.accounts.length
    ? body.accounts[0]
    : body;

  return {
    accountNumber:    account.accountNumber,
    bankName:         account.bankName,
    totalAmount,
    paymentReference: reference,
  };
}

/* ── Verify transaction ───────────────────────────────────────── */
async function verifyTransaction(transactionReference) {
  const token   = await getAuthToken();
  const encoded = encodeURIComponent(transactionReference);

  const { data } = await axios.get(
    `${BASE_URL}/api/v2/transactions/${encoded}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify verify failed: ${data.responseMessage}`);
  }

  return data.responseBody;
}

/* ── Send WhatsApp payment confirmation ───────────────────────── */
async function sendPaymentConfirmation(booking) {
  try {
    const twilio = require("twilio")(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const trip = booking.trip;

    const formatDate = (d) => new Date(d).toLocaleDateString("en-NG", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      timeZone: "Africa/Lagos",
    });
    const formatTime = (d) => new Date(d).toLocaleTimeString("en-NG", {
      hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lagos",
    });
    const formatCurrency = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");

    const message =
`✅ *Payment Confirmed!*

Your seat is now CONFIRMED. Show this at the terminal.

━━━━━━━━━━━━━━━━━━━━
🎟️ *GoTicket Receipt*
━━━━━━━━━━━━━━━━━━━━
👤 ${booking.passengerName}
🎫 Ref: *${booking.reference}*
🚌 ${trip?.branch?.park?.name || "GoTicket"}
📍 ${trip?.departureCity} → ${trip?.destination}
📅 ${trip?.departureTime ? formatDate(trip.departureTime) : "—"}
⏰ ${trip?.departureTime ? formatTime(trip.departureTime) : "—"}
💺 Seat ${booking.seatNumber}
💰 ${formatCurrency(booking.totalAmount)} — PAID ✓
━━━━━━━━━━━━━━━━━━━━

Safe travels! 🙏
Type *menu* for a new booking.`;

    let to = booking.passengerPhone.replace(/\s/g, "");
    if (!to.startsWith("+")) to = "+234" + to.replace(/^0/, "");

    await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to:   `whatsapp:${to}`,
      body: message,
    });

    console.log(`[Monnify] WhatsApp confirmation sent to ${to}`);
  } catch (err) {
    console.error("[Monnify] WhatsApp send failed:", err.message);
  }
}

module.exports = {
  getAuthToken,
  createVirtualAccount,
  verifyTransaction,
  verifyWebhookSignature,
  calculateAmounts,
  sendPaymentConfirmation,
};