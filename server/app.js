"use strict";

const path      = require("path");
const express   = require("express");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");
const { isProd } = require("./config");

const app = express();

// Render, Railway, etc. sit behind a reverse proxy — needed for rate limiting and logs.
app.set("trust proxy", 1);

// ── Security headers ───────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      // 'self' covers same-origin Socket.IO WS upgrade.
      // wss:/ws: covers Socket.IO polling fallback and any cross-origin WS.
      // TURN/STUN traffic is handled by the browser's WebRTC stack natively
      // and is NOT subject to CSP connectSrc, so no TURN domain needed here.
      connectSrc:     ["'self'", "wss:", "ws:", "https://fonts.googleapis.com"],
      mediaSrc:       ["'none'"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── Logging ────────────────────────────────────────────────────────────────────
app.use(morgan(isProd ? "combined" : "dev"));

// ── Rate limiting ──────────────────────────────────────────────────────────────
// Only applies to HTTP requests (health, static assets, SPA fallback).
// WebSocket traffic is handled by Socket.IO and is not subject to this limiter.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max:      300,              // generous for static asset fetches + reconnects
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests — please slow down." },
  skip: (req) => req.path === "/health", // don't penalise health-check probes
}));

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── Static frontend ────────────────────────────────────────────────────────────
const clientDist = path.join(__dirname, "../client/dist");
app.use(express.static(clientDist, { maxAge: isProd ? "7d" : 0 }));

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));

module.exports = app;
