"use strict";

const { Server }  = require("socket.io");
const { isProd }  = require("../config");
const { startSweep } = require("../lib/vaults");
const { registerVaultHandlers } = require("./vaultHandlers");
const { registerSignalingHandlers } = require("./signalingHandlers");

function createSocketServer(httpServer) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigin || (isProd ? false : "*"),
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 64 * 1024,   // signaling only, never file data
    pingTimeout:  20_000,
    pingInterval: 25_000,
    transports: ["websocket", "polling"],
  });

  startSweep(io);

  io.on("connection", (socket) => {
    console.log(`[socket] connect    ${socket.id}`);
    registerVaultHandlers(socket, io);
    registerSignalingHandlers(socket, io);
  });

  return io;
}

module.exports = { createSocketServer };
