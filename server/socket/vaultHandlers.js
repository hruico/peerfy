"use strict";

const { MAX_MEMBERS, MAX_ROOMS } = require("../config");
const {
  vaults, vaultSummary, dissolveVault, armTTL,
  isValidVaultId, removeMemberFromVault,
} = require("../lib/vaults");
const { makeId, makeVaultId } = require("../lib/utils");

const MAX_FILE_BYTES = 50 * 1024 * 1024;

function registerVaultHandlers(socket, io) {
  socket.on("vault:create", ({ name = "Anonymous" } = {}) => {
    removeMemberFromVault(socket, io);

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

  socket.on("vault:join", ({ vaultId, name = "Anonymous" } = {}) => {
    const id = String(vaultId || "").toUpperCase();
    if (!isValidVaultId(id)) {
      socket.emit("vault:error", { code: "INVALID", message: "Invalid vault code." });
      return;
    }

    const vault = vaults.get(id);
    if (!vault) {
      socket.emit("vault:error", { code: "NOT_FOUND", message: "Vault not found." });
      return;
    }
    if (vault.members.size >= MAX_MEMBERS && !vault.members.has(socket.id)) {
      socket.emit("vault:error", { code: "FULL", message: "Vault is full." });
      return;
    }

    if (socket.vaultId && socket.vaultId !== vault.id) {
      removeMemberFromVault(socket, io);
    }

    vault.members.set(socket.id, { name: String(name).slice(0, 32), joinedAt: Date.now(), pubkey: null });
    socket.join(vault.id);
    socket.vaultId = vault.id;
    armTTL(vault, io);

    socket.emit("vault:joined", vaultSummary(vault));
    socket.to(vault.id).emit("vault:updated", vaultSummary(vault));

    console.log(`[vault] ${vault.id} joined by ${socket.id} (${name}), members: ${vault.members.size}`);
  });

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

  socket.on("vault:file:add", ({ name, size, type, hash } = {}) => {
    const vault = vaults.get(socket.vaultId);
    if (!vault) {
      socket.emit("vault:error", { code: "NO_VAULT", message: "Not in a vault." });
      return;
    }

    const fileSize = Number(size);
    if (!Number.isFinite(fileSize) || fileSize < 0 || fileSize > MAX_FILE_BYTES) {
      socket.emit("vault:error", { code: "FILE_TOO_LARGE", message: "File exceeds the 50 MB limit." });
      return;
    }

    const fileId = makeId(10);
    const entry = {
      id:         fileId,
      name:       String(name || "unnamed").slice(0, 255),
      size:       fileSize,
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

  socket.on("disconnect", (reason) => {
    console.log(`[socket] disconnect ${socket.id} (${reason})`);
    removeMemberFromVault(socket, io);
  });
}

module.exports = { registerVaultHandlers };
