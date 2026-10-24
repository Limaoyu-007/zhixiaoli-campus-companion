'use strict';
class ChaoxingError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; Object.assign(this, details); }
}
module.exports = { ChaoxingError };
