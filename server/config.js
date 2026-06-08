"use strict";

const NODE_ENV = process.env.NODE_ENV || "development";

module.exports = {
  PORT:        process.env.PORT       || 8000,
  NODE_ENV,
  isProd:      NODE_ENV === "production",
  MAX_MEMBERS: parseInt(process.env.MAX_MEMBERS || "10",  10),
  MAX_ROOMS:   parseInt(process.env.MAX_ROOMS   || "500", 10),
  ROOM_TTL_MS: parseInt(process.env.ROOM_TTL_MS || String(4 * 60 * 60 * 1000), 10), // 4 h
};
