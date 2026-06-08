"use strict";

const path      = require("path");
const express   = require("express");
const helmet    = require("helmet");
const morgan    = require("morgan");
const rateLimit = require("express-rate-limit");
const { isProd } = require("./config");

const app = express();

// ── Security headers ───────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["'self'", "https://fonts.gstatic.com"],
      connectSrc:     ["'self'", "wss:", "ws:"],
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
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests — please slow down." },
}));

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// ── Static frontend ────────────────────────────────────────────────────────────
const clientDist = path.join(__dirname, "../client/dist");
app.use(express.static(clientDist, { maxAge: isProd ? "7d" : 0 }));

// ── SPA fallback ───────────────────────────────────────────────────────────────
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));

module.exports = app;
