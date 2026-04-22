const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const client = new Client({
  authStrategy: new LocalAuth()
});

const sessions = {};

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Abibot is ready 🚌");
});

client.on("message", async (message) => {
  const text = message.body.trim().toLowerCase();
  const user = message.from;

  // START / RESET
  if (text === "hi" || text === "hello" || text === "menu") {
    sessions[user] = { step: "menu" };

    return message.reply(
`Welcome to Abibot 🚌

1. Book a Trip
2. Customer Support`
    );
  }

  // MENU OPTION
  if (text === "1" && sessions[user]?.step === "menu") {
    sessions[user].step = "route";

    return message.reply(
`Enter your route

Example:
Makurdi to Abuja`
    );
  }

  // ROUTE INPUT
  if (sessions[user]?.step === "route") {
    sessions[user].route = message.body;
    sessions[user].step = "date";

    return message.reply(
`Route: ${message.body}

Enter travel date
Example:
25 April`
    );
  }

  // DATE INPUT
  if (sessions[user]?.step === "date") {
    sessions[user].date = message.body;
    sessions[user].step = "confirm";

    return message.reply(
`Booking Summary 🚌

Route: ${sessions[user].route}
Date: ${sessions[user].date}

Reply YES to confirm`
    );
  }

  // CONFIRMATION
  if (text === "yes" && sessions[user]?.step === "confirm") {
    sessions[user].step = "done";

    return message.reply(
`✅ Booking received!

Our agent will contact you shortly.
Thank you for choosing Abibot 🚌`
    );
  }

  // SUPPORT
  if (text === "2") {
    return message.reply(
`Customer Support

Call: 08012345678
WhatsApp: 08012345678`
    );
  }
});

client.initialize();