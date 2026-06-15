"use strict";

const { randomBytes } = require("crypto");

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)

function makeId(len = 6) {
  const buf = randomBytes(len);
  return Array.from(buf, (b) => CHARS[b % CHARS.length]).join("");
}

function makeVaultId(vaults) {
  let id;
  do { id = makeId(6); } while (vaults.has(id));
  return id;
}

module.exports = { makeId, makeVaultId };
