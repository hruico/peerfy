# Peerfy

Peer-to-peer file sharing in the browser. No accounts, no cloud storage, no file size limits beyond what your RAM or disk can handle.

Files travel directly between browsers over encrypted WebRTC data channels. The server only handles the initial connection handshake - it never sees, stores, or touches your files.

**Live demo:** https://peerfy.onrender.com

> The demo runs on Render's free tier. If it takes ~30 seconds to load, the server is waking up from inactivity.

---

## How it works

1. One user creates a **vault** and gets a 6-character room code + invite link
2. Other users join using the code or link
3. Any member can drop files into the vault, they appear for everyone instantly
4. Each member downloads directly from the uploader's browser over a P2P connection
5. The vault dissolves when everyone leaves

The signaling server (Node.js + Socket.IO on Render) only relays WebRTC offers, answers, and ICE candidates. File bytes never touch it.

---

## Features

### Core
- Drag-and-drop upload with 50 MB per-file limit
- Unique vault code + shareable invite link
- Direct P2P transfer over WebRTC data channels
- SHA-256 hash verification - every file is re-hashed on arrival and compared to the sender's hash
- Real-time progress bar, transfer speed (MB/s), and connection status per peer
- Graceful disconnect - vault updates when someone leaves, no crashes
- Download when transfer completes

### Advanced
- **Multi-peer mesh** - up to 10 members per vault, each downloading directly from the uploader in parallel
- **Large file support** - incoming chunks are written directly to the [Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) when available, bypassing RAM limits entirely. Falls back to in-memory accumulation on unsupported browsers
- **End-to-end encryption** - ECDH P-256 key exchange on join, AES-GCM-256 encryption per chunk. The signaling server only sees public keys. No key material is ever transmitted in plaintext
- **Auto-resume on disconnect** - transfer state is checkpointed to `sessionStorage` every 10 chunks. If the connection drops mid-transfer, it resumes from the last checkpoint rather than restarting

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS v4 |
| P2P | WebRTC (native browser API) |
| Encryption | Web Crypto API - ECDH P-256 + AES-GCM-256 |
| Signaling backend | Node.js, Express, Socket.IO |
| Hosting | Render (single service - backend serves built frontend) |

---

## Project structure

```
peerfy/
├── client/                  # React frontend (Vite)
│   └── src/
│       ├── App.jsx          # Main UI - home screen, vault screen, all components
│       ├── hooks/
│       │   └── useSocket.js # Socket.IO singleton + reconnect logic
│       └── lib/
│           ├── crypto.js    # ECDH key exchange, AES-GCM encrypt/decrypt
│           ├── transfer.js  # sendFile / receiveFile with resume protocol
│           ├── opfs.js      # OPFS writer with in-memory fallback
│           ├── peers.js     # RTCPeerConnection management, ICE queuing
│           ├── webrtc.js    # ICE config, chunk size constants
│           └── format.js    # formatBytes, formatSpeed
└── server/                  # Express + Socket.IO signaling server
    ├── app.js               # Express setup, CSP headers, static file serving
    ├── config.js            # Environment config
    ├── index.js             # HTTP server, graceful shutdown
    ├── socket/
    │   ├── index.js         # Socket.IO setup, CORS
    │   ├── vaultHandlers.js # vault:create, vault:join, vault:file:add/remove
    │   └── signalingHandlers.js  # signal:offer, signal:answer, signal:ice
    └── lib/
        ├── vaults.js        # In-memory vault store, TTL, sweep
        └── utils.js         # Cryptographically secure random ID generation
```

---

## Local setup

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/hruico/peerfy
cd peerfy
npm install        # installs deps for both client and server via postinstall
```

Create `server/.env` (or use the root `.env`):
```env
NODE_ENV=development
PORT=8000
ALLOWED_ORIGIN=*
```

Create `client/.env`:
```env
VITE_TURN_URL=turn:openrelay.metered.ca:80
VITE_TURN_USER=openrelay
VITE_TURN_CREDENTIAL=openrelay
```

Run in two terminals:
```bash
npm run dev:server   # starts Express on :8000
npm run dev:client   # starts Vite on :5173 (proxies /socket.io → :8000)
```

---

## Deployment (Render)

The project deploys as a single Render web service. The Express server builds and serves the React app.

**Build command:** `npm install && npm run build`  
**Start command:** `npm start`

Set these environment variables in the Render dashboard:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `ALLOWED_ORIGIN` | `https://peerfy.onrender.com` |
| `VITE_TURN_URL` | `turn:openrelay.metered.ca:80` |
| `VITE_TURN_USER` | `openrelay` |
| `VITE_TURN_CREDENTIAL` | `openrelay` |

---

## Security model

- **No file data on the server** - the signaling server only relays SDP offers/answers and ICE candidates
- **ECDH key exchange** - each peer generates a fresh P-256 keypair on join. The server broadcasts public keys; each pair of peers independently derives the same shared AES key without transmitting it
- **AES-GCM-256 per chunk** - every 64 KB chunk gets a fresh 12-byte random IV. Tampering with any chunk causes decryption to fail
- **SHA-256 integrity check** - the full file is re-hashed on arrival and compared to the sender's hash. Mismatches are shown as errors
- **Cross-vault signal injection prevented** - the server verifies sender and target are in the same vault before relaying any signal

---

## Known limitations

- Vault state is in-memory - a server restart clears all active vaults
- 50 MB per-file limit (server-side validation matches client-side)
- Free tier cold start adds ~30s on first request after inactivity
- Open Relay TURN credentials are shared/public - fine for demos, not production
