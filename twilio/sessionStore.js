const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = {};
  }
  return sessions[phone];
}

function clearSession(phone) {
  delete sessions[phone];
}

module.exports = {
  getSession,
  clearSession
};