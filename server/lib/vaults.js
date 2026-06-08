"use strict";

/**
 * In-memory vault store and related helpers.
 *
 * Vault shape:
 * {
 *   id:        string,
 *   createdAt: number,
 *   members:   Map<socketId, { name: string, joinedAt: number }>,
 *   files:     Map<fileId, FileEntry>,
 *   ttlTimer:  NodeJS.Timeout | null,
 * }
 *
 * FileEntry shape:
 * {
 *   id:         string,
 *   name:       string,
 *   size:       number,
 *   type:       string,
 *   hash:       string,   // SHA-256 hex — computed by uploader
 *   uploaderId: socketId,
 *   addedAt:    number,
 * }
 */

const { ROOM_TTL_MS } = require("../config");

/** @type {Map<string, object>} */
const vaults = new Map();

function vaultSummary(vault) {
  return {
    id:      vault.id,
    members: [...vault.members.entries()].map(([sid, m]) => ({ id: sid, name: m.name })),
    files:   [...vault.files.values()],
  };
}

/**
 * Dissolve a vault: notify all members, remove from store.
 * `io` is passed in so this module stays free of Socket.IO imports at the top level.
 * @param {string} vaultId
 * @param {import("socket.io").Server} io
 * @param {string} reason
 */
function dissolveVault(vaultId, io, reason = "empty") {
  const vault = vaults.get(vaultId);
  if (!vault) return;
  if (vault.ttlTimer) clearTimeout(vault.ttlTimer);
  io.to(vaultId).emit("vault:dissolved", { reason });
  io.in(vaultId).socketsLeave(vaultId);
  vaults.delete(vaultId);
  console.log(`[vault] ${vaultId} dissolved (${reason})`);
}

/**
 * (Re)arm the TTL timer on a vault.
 * @param {object} vault
 * @param {import("socket.io").Server} io
 */
function armTTL(vault, io) {
  if (vault.ttlTimer) clearTimeout(vault.ttlTimer);
  vault.ttlTimer = setTimeout(() => dissolveVault(vault.id, io, "ttl"), ROOM_TTL_MS);
}

/**
 * Start the periodic sweep that removes vaults whose TTL timer somehow didn't fire.
 * @param {import("socket.io").Server} io
 */
function startSweep(io) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, vault] of vaults) {
      if (now - vault.createdAt > ROOM_TTL_MS + 60_000) {
        dissolveVault(id, io, "sweep");
      }
    }
  }, 5 * 60 * 1000);
}

module.exports = { vaults, vaultSummary, dissolveVault, armTTL, startSweep };
