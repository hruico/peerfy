"use strict";

const { vaults } = require("../lib/vaults");

// Relay WebRTC signaling between peers. Only relays between members of the same vault.
function registerSignalingHandlers(socket, io) {
  function sameVault(targetId) {
    const vaultId = socket.vaultId;
    if (!vaultId) return false;
    const vault = vaults.get(vaultId);
    if (!vault) return false;
    return vault.members.has(targetId);
  }

  socket.on("signal:offer", ({ to, offer, fileId }) => {
    if (typeof to !== "string" || !to) return;
    if (!sameVault(to)) return;
    socket.to(to).emit("signal:offer", { from: socket.id, offer, fileId });
  });

  socket.on("signal:answer", ({ to, answer, fileId }) => {
    if (typeof to !== "string" || !to) return;
    if (!sameVault(to)) return;
    socket.to(to).emit("signal:answer", { from: socket.id, answer, fileId });
  });

  socket.on("signal:ice", ({ to, candidate, fileId }) => {
    if (typeof to !== "string" || !to) return;
    if (!sameVault(to)) return;
    socket.to(to).emit("signal:ice", { from: socket.id, candidate, fileId });
  });
}

module.exports = { registerSignalingHandlers };
