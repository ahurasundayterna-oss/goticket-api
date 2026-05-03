"use strict";
const express = require("express");
const cors    = require("cors");
const app     = express();

// Route imports
const staffRoutes    = require("./routes/staff");
const paymentsRoutes = require("./routes/payments");

/* ══════════════════════════════════════════════
   WEBHOOKS — raw body MUST come before express.json()
══════════════════════════════════════════════ */

// Monnify booking webhook
app.use("/api/monnify/webhook", require("./routes/monnifyWebhook"));

// Wallet funding webhook — extract the handler directly from the router
// so express.raw() wraps it correctly on this exact path
const walletWebhookHandler = require("./routes/wallet/webhook");
app.post(
  "/api/wallet/webhook",
  express.raw({ type: "application/json" }),
  walletWebhookHandler
);

/* ══════════════════════════════════════════════
   NORMAL MIDDLEWARE
══════════════════════════════════════════════ */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ══════════════════════════════════════════════
   HEALTH CHECK
══════════════════════════════════════════════ */
app.get("/", (req, res) => res.send("GoTicket API Live"));

/* ══════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════ */
app.use("/api/auth",      require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/parks",     require("./routes/parks"));
app.use("/api/branches",  require("./routes/branches"));
app.use("/api/users",     require("./routes/users"));
app.use("/api/setup",     require("./routes/setup"));
app.use("/api/super",     require("./routes/super/index"));
app.use("/api/trips",     require("./routes/trips"));
app.use("/api/bookings",  require("./routes/bookings"));
app.use("/api/reports",   require("./routes/reports"));
app.use("/api/wallet",    require("./routes/wallet"));   // all wallet routes EXCEPT /webhook
app.use("/api/routes",    require("./routes/routes-mgmt"));
app.use("/api/staff",     staffRoutes);
app.use("/api/payments",  paymentsRoutes);
app.use("/api/webhook",   require("./twilio/webhook"));

/* ══════════════════════════════════════════════
   START SERVER
══════════════════════════════════════════════ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`GoTicket server running on port ${PORT}`);
  require("./jobs/expireBookings").startExpiryJob();
});