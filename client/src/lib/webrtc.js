export const ICE_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export const CHUNK_SIZE       = 64 * 1024;       // 64 KB per chunk
export const BUFFER_THRESHOLD = 4 * 1024 * 1024; // pause sending if DC buffer > 4 MB
