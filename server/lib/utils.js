"use strict";

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars (0/O, 1/I)

function makeId(len = 6) {
  return Array.from({ length: len }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
}

/**
 * Generate a unique vault ID that isn't already in the provided Map.
 * @param {Map} vaults
 */
function makeVaultId(vaults) {
  let id;
  do { id = makeId(6); } while (vaults.has(id));
  return id;
}

module.exports = { makeId, makeVaultId };
