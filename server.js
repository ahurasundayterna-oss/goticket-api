const express = require("express");
const app     = express();
const cors    = require("cors");
const staffRoutes = require("./routes/staff");

/*
 ─────────────────────────────────────────
 MONNIFY WEBHOOK (MUST COME FIRST)
 ─────────────────────────────────────────
*/
app.use("/api/monnify/webhook", require("./routes/monnifywebhook"));

/*
 ─────────────────────────────────────────
 NORMAL MIDDLEWARE
 ─────────────────────────────────────────
*/
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Existing routes ────────────────────────────────────────────
app.use("/api/auth",      require("./routes/auth"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/parks",     require("./routes/parks"));
app.use("/api/branches",  require("./routes/branches"));
app.use("/api/users",     require("./routes/users"));
app.use("/api/setup",     require("./routes/setup"));
app.use("/api/super", require("./routes/super"));


// ── Updated routes ─────────────────────────────────────────────
app.use("/api/trips",     require("./routes/trips"));
app.use("/api/bookings",  require("./routes/bookings"));

// ── New routes ─────────────────────────────────────────────────
app.use("/api/routes",    require("./routes/routes-mgmt"));
app.use("/api/staff", require("./routes/staff"));

// ── WhatsApp webhook ───────────────────────────────────────────
app.use("/api/webhook",   require("./twilio/webhook"));

const PORT = process.env.PORT || 5000;

app.listen(PORT, () =>
  console.log(`GoTicket server running on port ${PORT}`)
);