/**
 * WebRTC configuration and transfer constants.
 *
 * ICE servers: STUN handles most NAT situations. TURN is required for
 * symmetric NAT (common on mobile carriers and some corporate networks).
 * Set VITE_TURN_URL / VITE_TURN_USER / VITE_TURN_CREDENTIAL in your
 * deployment environment to enable TURN fallback.
 */

const turnUrl  = import.meta.env.VITE_TURN_URL;
const turnUser = import.meta.env.VITE_TURN_USER;
const turnCred = import.meta.env.VITE_TURN_CREDENTIAL;

const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

if (turnUrl) {
  iceServers.push({
    urls:       turnUrl,
    username:   turnUser || "",
    credential: turnCred || "",
  });
}

export const ICE_CONFIG = { iceServers };

// 64 KB chunks - well within the 256 KB SCTP message limit and works across browsers
export const CHUNK_SIZE = 64 * 1024;

// Pause sending when the DataChannel send buffer exceeds this. Keeping it at
// 8 MB gives a good throughput/memory trade-off for large files.
export const BUFFER_THRESHOLD = 8 * 1024 * 1024;
