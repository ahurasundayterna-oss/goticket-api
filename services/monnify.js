/**
 * services/monnify.js
 *
 * Handles all Monnify API communication:
 *   - Cached auth token (re-fetches when expired)
 *   - Dynamic virtual account creation per WhatsApp booking
 *   - Payment verification for webhook validation
 *
 * Required env vars (see .env.example):
 *   MONNIFY_BASE_URL, MONNIFY_API_KEY, MONNIFY_SECRET_KEY,
 *   MONNIFY_CONTRACT_CODE, MONNIFY_GOTICKET_SUBACCOUNT_CODE
 */

const axios = require("axios");
const crypto = require("crypto");

const BASE_URL       = process.env.MONNIFY_BASE_URL       || "https://sandbox.monnify.com";
const API_KEY        = process.env.MONNIFY_API_KEY;
const SECRET_KEY     = process.env.MONNIFY_SECRET_KEY;
const CONTRACT_CODE  = process.env.MONNIFY_CONTRACT_CODE;

// GoTicket's own sub-account code (receives the 3% commission)
const GOTICKET_SUBACCOUNT = process.env.MONNIFY_GOTICKET_SUBACCOUNT_CODE;

// Commission rate applied on top of ticket price — passenger pays this
const COMMISSION_RATE = 0.03; // 3%

/* ─── Auth token cache ───────────────────────────────────────────────────── */
let _cachedToken    = null;
let _tokenExpiresAt = 0;

/**
 * Returns a valid Monnify bearer token, fetching a new one when expired.
 * Monnify tokens last 1 hour; we refresh 60 s early to be safe.
 */
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
  // expiresIn is in seconds; cache for (expiresIn - 60) seconds
  _tokenExpiresAt = now + (data.responseBody.expiresIn - 60) * 1000;

  return _cachedToken;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Compute totalAmount = ticketPrice + 3%
 * Returns object with both values rounded to 2 dp.
 */
function calculateAmounts(ticketPrice) {
  const commission  = Math.round(ticketPrice * COMMISSION_RATE * 100) / 100;
  const totalAmount = Math.round((ticketPrice + commission) * 100) / 100;
  return { ticketPrice, commission, totalAmount };
}

/**
 * Verify Monnify webhook signature.
 * Monnify sends: monnify-signature header = HMAC-SHA512(payload, secretKey)
 */
function verifyWebhookSignature(rawBody, signature) {
  const expected = crypto
    .createHmac("sha512", SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

/* ─── Core API calls ─────────────────────────────────────────────────────── */

/**
 * Create a dynamic virtual account for a WhatsApp booking.
 *
 * Split settlement:
 *   - branch sub-account receives ticketPrice
 *   - GoTicket sub-account receives commission (3%)
 *   - passenger pays totalAmount (covers both)
 *
 * @param {object} params
 * @param {string} params.reference       - GoTicket booking reference (e.g. GT-A3K7RX)
 * @param {string} params.passengerName   - Lead passenger full name
 * @param {string} params.passengerPhone  - Passenger phone number
 * @param {number} params.ticketPrice     - Base ticket price (per seat × seats)
 * @param {string} params.branchSubAccountCode - Branch's Monnify sub-account code
 * @param {string} params.description     - Human-readable description for the transaction
 *
 * @returns {{ accountNumber, bankName, totalAmount, commission, paymentReference }}
 */
async function createVirtualAccount({
  reference,
  passengerName,
  passengerPhone,
  ticketPrice,
  branchSubAccountCode,
  description,
}) {
  if (!branchSubAccountCode) {
    throw new Error("Branch has no Monnify sub-account code configured.");
  }

  const token = await getAuthToken();
  const { totalAmount, commission } = calculateAmounts(ticketPrice);

  const payload = {
    amount:          totalAmount,
    customerName:    passengerName,
    customerEmail:   `${passengerPhone.replace(/\D/g, "")}@goticket.ng`, // Monnify requires email
    paymentReference: reference,
    paymentDescription: description,
    currencyCode:    "NGN",
    contractCode:    CONTRACT_CODE,
    incomeSplitConfig: [
      {
        // Branch receives the base ticket price
        subAccountCode:     branchSubAccountCode,
        feePercentage:      0,
        splitAmount:        ticketPrice,     // exact naira amount
        feeBearer:          false,
      },
      {
        // GoTicket receives the 3% commission
        subAccountCode:     GOTICKET_SUBACCOUNT,
        feePercentage:      0,
        splitAmount:        commission,
        feeBearer:          false,
      },
    ],
  };

  const { data } = await axios.post(
    `${BASE_URL}/api/v1/merchant/virtual-account/dynamic`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify virtual account creation failed: ${data.responseMessage}`);
  }

  const body = data.responseBody;

  // Monnify returns an array of accounts (one per bank); pick the first one.
  // In production you may want to present multiple bank options to the user.
  const account = Array.isArray(body.accounts) ? body.accounts[0] : body;

  return {
    accountNumber:    account.accountNumber,
    bankName:         account.bankName,
    totalAmount,
    commission,
    paymentReference: body.paymentReference || reference,
  };
}

/**
 * Verify a completed payment by its Monnify transaction reference.
 * Called inside the Monnify webhook handler to double-confirm before
 * marking a booking as PAID.
 *
 * @param {string} transactionReference - Monnify's own transaction ref
 * @returns {object} Monnify transaction body
 */
async function verifyTransaction(transactionReference) {
  const token    = await getAuthToken();
  const encoded  = encodeURIComponent(transactionReference);

  const { data } = await axios.get(
    `${BASE_URL}/api/v2/transactions/${encoded}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!data.requestSuccessful) {
    throw new Error(`Monnify transaction verification failed: ${data.responseMessage}`);
  }

  return data.responseBody;
}

module.exports = {
  createVirtualAccount,
  verifyTransaction,
  verifyWebhookSignature,
  calculateAmounts,
};