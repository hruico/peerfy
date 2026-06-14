"use strict";

const { MAX_MEMBERS, MAX_ROOMS } = require("../config");
const { vaults, vaultSummary, dissolveVault, armTTL } = require("../lib/vaults");
const { makeId, makeVaultId } = require("../lib/utils");

/**
 * Register all vault-related socket event handlers.
 * @param {import("socket.io").Socket} socket
 * @param {import("socket.io").Server} io
 */
function registerVaultHandlers(socket, io) {
  // ── vault:create ────────────────────────────────────────────────────────────
  socket.on("vault:create", ({ name = "Anonymous" } = {}) => {
    if (vaults.size >= MAX_ROOMS) {
      socket.emit("vault:error", { code: "SERVER_FULL", message: "Server is at capacity. Try again later." });
      return;
    }

    const vaultId = makeVaultId(vaults);
    const vault = {
      id:        vaultId,
      createdAt: Date.now(),
      members:   new Map([[socket.id, { name: String(name).slice(0, 32), joinedAt: Date.now(), pubkey: null }]]),
      files:     new Map(),
      ttlTimer:  null,
    };

    vaults.set(vaultId, vault);
    armTTL(vault, io);

    socket.join(vaultId);
    socket.vaultId = vaultId;

    socket.emit("vault:joined", vaultSummary(vault));
    console.log(`[vault] ${vaultId} created by ${socket.id} (${name})`);
  });

  // ── vault:join ──────────────────────────────────────────────────────────────
  socket.on("vault:join", ({ vaultId, name = "Anonymous" } = {}) => {
    const vault = vaults.get(String(vaultId).toUpperCase());

    if (!vault) {
      socket.emit("vault:error", { code: "NOT_FOUND", message: "Vault not found." });
      return;
    }
    if (vault.members.size >= MAX_MEMBERS) {
      socket.emit("vault:error", { code: "FULL", message: "Vault is full." });
      return;
    }

    vault.members.set(socket.id, { name: String(name).slice(0, 32), joinedAt: Date.now(), pubkey: null });
    socket.join(vault.id);
    socket.vaultId = vault.id;
    armTTL(vault, io);

    socket.emit("vault:joined", vaultSummary(vault));
    socket.to(vault.id).emit("vault:updated", vaultSummary(vault));

    console.log(`[vault] ${vault.id} joined by ${socket.id} (${name}), members: ${vault.members.size}`);
  });

  // ── vault:pubkey ─────────────────────────────────────────────────────────────
  // Each peer broadcasts their ECDH public key after joining.
  // The server stores it and sends the full pubkey map to everyone in the vault
  // so each peer can derive a shared secret with every other peer.
  socket.on("vault:pubkey", ({ pubkey } = {}) => {
    const vault = vaults.get(socket.vaultId);
    if (!vault) return;
    if (typeof pubkey !== "string" || pubkey.length > 256) return; // basic validation

    const member = vault.members.get(socket.id);
    if (member) member.pubkey = pubkey;

    // Broadcast the full pubkey map to everyone in the vault
    const pubkeys = {};
    for (const [sid, m] of vault.members) {
      if (m.pubkey) pubkeys[sid] = m.pubkey;
    }
    io.to(vault.id).emit("vault:pubkeys", pubkeys);
  });

  // ── vault:file:add ──────────────────────────────────────────────────────────
  // Uploader registers a file in the vault manifest. File data travels P2P over
  // WebRTC when a receiver clicks download — it never passes through this server.
  socket.on("vault:file:add", ({ name, size, type, hash } = {}) => {
    const vault = vaults.get(socket.vaultId);
    if (!vault) {
      socket.emit("vault:error", { code: "NO_VAULT", message: "Not in a vault." });
      return;
    }

    const fileId = makeId(10);
    const entry = {
      id:         fileId,
      name:       String(name || "unnamed").slice(0, 255),
      size:       Number(size || 0),
      type:       String(type || "application/octet-stream").slice(0, 128),
      hash:       String(hash || "").slice(0, 64),
      uploaderId: socket.id,
      addedAt:    Date.now(),
    };

    vault.files.set(fileId, entry);
    armTTL(vault, io);
    io.to(vault.id).emit("vault:updated", vaultSummary(vault));
    console.log(`[vault] ${vault.id} file added: ${entry.name} (${entry.size}B) by ${socket.id}`);
  });

  // ── vault:file:remove ───────────────────────────────────────────────────────
  socket.on("vault:file:remove", ({ fileId } = {}) => {
    const vault = vaults.get(socket.vaultId);
    if (!vault) return;

    const file = vault.files.get(fileId);
    if (!file) return;

    if (file.uploaderId !== socket.id) {
      socket.emit("vault:error", { code: "FORBIDDEN", message: "Cannot remove another user's file." });
      return;
    }

    vault.files.delete(fileId);
    io.to(vault.id).emit("vault:updated", vaultSummary(vault));
  });

  // ── disconnect ──────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[socket] disconnect ${socket.id} (${reason})`);
    const vaultId = socket.vaultId;
    if (!vaultId) return;

    const vault = vaults.get(vaultId);
    if (!vault) return;

    vault.members.delete(socket.id);

    // Files only exist while the uploader is online with the File in memory.
    for (const [fileId, file] of vault.files) {
      if (file.uploaderId === socket.id) vault.files.delete(fileId);
    }

    if (vault.members.size === 0) {
      dissolveVault(vaultId, io, "empty");
    } else {
      io.to(vaultId).emit("vault:updated", vaultSummary(vault));
    }
  });
}

module.exports = { registerVaultHandlers };
