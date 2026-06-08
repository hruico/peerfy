"use strict";

/**
 * WebRTC signaling relay.
 * All messages are targeted at a specific peer socket ID — never broadcast.
 * @param {import("socket.io").Socket} socket
 */
function registerSignalingHandlers(socket) {
  socket.on("signal:offer",  ({ to, offer     }) => socket.to(to).emit("signal:offer",  { from: socket.id, offer     }));
  socket.on("signal:answer", ({ to, answer    }) => socket.to(to).emit("signal:answer", { from: socket.id, answer    }));
  socket.on("signal:ice",    ({ to, candidate }) => socket.to(to).emit("signal:ice",    { from: socket.id, candidate }));
}

module.exports = { registerSignalingHandlers };
