const { v4: uuidv4 } = require("uuid");

module.exports = function generateRef() {
  return "ABI-" + uuidv4().split("-")[0].toUpperCase();
};