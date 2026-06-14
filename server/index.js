"use strict";

const http = require("http");
const app  = require("./app");
const { createSocketServer } = require("./socket");
const { vaults, dissolveVault } = require("./lib/vaults");
const { PORT, NODE_ENV }     = require("./config");

const httpServer = http.createServer(app);
const io         = createSocketServer(httpServer);

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down gracefully`);
  for (const vaultId of [...vaults.keys()]) {
    dissolveVault(vaultId, io, "server_shutdown");
  }

  httpServer.close(() => {
    console.log("[server] HTTP server closed");
    process.exit(0);
  });

  // Force-exit after 10 s if connections don't drain
  setTimeout(() => {
    console.error("[server] Forcing exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});

// ── Start ──────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[server] peerfy listening on :${PORT} (${NODE_ENV})`);
});
