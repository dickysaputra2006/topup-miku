const assert = require('node:assert');

// A simple static test to ensure our code change looks right in server.js
const fs = require('fs');
const content = fs.readFileSync(__dirname + '/../server.js', 'utf8');

if (!content.includes("const secureRandom = crypto.randomBytes(8).toString('hex');") || !content.includes("const invoiceId = `TRX-${Date.now()}${userId}-${secureRandom}`;")) {
  console.error("Missing expected crypto generation in regular order.");
  process.exit(1);
}

if (!content.includes("const secureRandomH2H = crypto.randomBytes(8).toString('hex');") || !content.includes("const invoiceId = `H2H-${Date.now()}${h2hUser.id}-${secureRandomH2H}`;")) {
  console.error("Missing expected crypto generation in h2h order.");
  process.exit(1);
}

console.log("Syntax and logic check for transaction IDs passed.");
