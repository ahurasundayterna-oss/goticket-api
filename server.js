"use strict";

const express = require("express");
const cors = require("cors");

const app = express();

// Route imports
const staffRoutes = require("./routes/staff");
const paymentsRoutes = require("./routes/payments");

// ─────────────────────────────────────────
// MONNIFY WEBHOOK (MUST COME FIRST)
// Raw body route before express.json()
// ─────────────────────────────────────────
app.use("/api/monnify/webhook", require("./routes/monnifyWebhook"));

// ─────────────────────────────────────────
// NORMAL MIDDLEWARE
// ─────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("GoTicket API Live");
});

// ─────────────────────────────────────────
// EXISTING ROUTES
// ─────────────────────────────────────────
app.use("/api/auth", require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/parks", require("./routes/parks"));
app.use("/api/branches", require("./routes/branches"));
app.use("/api/users", require("./routes/users"));
app.use("/api/setup", require("./routes/setup"));
app.use("/api/super", require("./routes/super/index"));

// ─────────────────────────────────────────
// CORE ROUTES
// ─────────────────────────────────────────
app.use("/api/trips", require("./routes/trips"));
app.use("/api/bookings", require("./routes/bookings"));
app.use("/api/reports", require("./routes/reports"));

// ─────────────────────────────────────────
// NEW ROUTES
// ─────────────────────────────────────────
app.use("/api/routes", require("./routes/routes-mgmt"));
app.use("/api/staff", staffRoutes);
app.use("/api/payments", paymentsRoutes);

// ─────────────────────────────────────────
// TWILIO / WHATSAPP WEBHOOK
// ─────────────────────────────────────────
app.use("/api/webhook", require("./twilio/webhook"));

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`GoTicket server running on port ${PORT}`);

  // Start seat expiry background job
  require("./jobs/expireBookings").startExpiryJob();
});