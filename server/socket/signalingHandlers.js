"use strict";

const { vaults } = require("../lib/vaults");

/**
 * WebRTC signaling relay.
 * All messages are targeted at a specific peer socket ID — never broadcast.
 *
 * Security: we verify that both the sender and the target are members of the
 * same vault before relaying, preventing cross-vault signal injection.
 *
 * @param {import("socket.io").Socket} socket
 * @param {import("socket.io").Server} io
 */
function registerSignalingHandlers(socket, io) {
  function sameVault(targetId) {
    const vaultId = socket.vaultId;
    if (!vaultId) return false;
    const vault = vaults.get(vaultId);
    if (!vault) return false;
    return vault.members.has(targetId);
  }

  socket.on("signal:offer", ({ to, offer, fileId }) => {
    if (!sameVault(to)) return; // silently drop — not in same vault
    socket.to(to).emit("signal:offer", { from: socket.id, offer, fileId });
  });

  socket.on("signal:answer", ({ to, answer, fileId }) => {
    if (!sameVault(to)) return;
    socket.to(to).emit("signal:answer", { from: socket.id, answer, fileId });
  });

  socket.on("signal:ice", ({ to, candidate, fileId }) => {
    if (!sameVault(to)) return;
    socket.to(to).emit("signal:ice", { from: socket.id, candidate, fileId });
  });
}

module.exports = { registerSignalingHandlers };
