# Peerfy

Browser-based peer-to-peer file sharing. No accounts. End-to-end encrypted.

---

## What it does

Users create or join a **vault** (6-character code), upload files, and share them with others in the same vault. File bytes go directly between browsers over WebRTC — the server only handles signaling and metadata.

---

## Architecture

**Signaling server** (`server/`)
- Express + Socket.IO
- Vault membership, file manifests, ECDH pubkey relay, WebRTC signaling
- Serves the built React app in production

**Client** (`client/`)
- React + Vite
- WebRTC data channels for transfers
- ECDH (P-256) + AES-GCM-256 encryption between peers

```
Browser A  ←—— encrypted WebRTC ——→  Browser B
     \                                  /
      —— Socket.IO signaling (server) ——
```

---

## Project structure

```
peerfy/
├── client/          React frontend (Vite)
├── server/          Express + Socket.IO signaling
├── package.json     Root scripts (build, start, dev)
└── .env.example     Environment variable reference
```

---

## Run locally

```bash
npm install
npm run build
npm start
```

Open **http://localhost:8000**

**Dev mode** (two terminals):

```bash
npm run dev:server   # backend on :8000
npm run dev:client   # frontend on :5173, proxies /socket.io
```

Copy `.env.example` to `.env` for optional config. See that file for all variables.

Health check: `GET /health`

---

## Security

- File data never passes through the server
- Per-peer encryption via ECDH + AES-GCM
- Signaling scoped per vault (cross-vault relay blocked)
- Helmet headers, HTTP rate limiting, input validation on socket events
- `ALLOWED_ORIGIN` required in production for WebSocket CORS

---

## Limits

- 50 MB per file
- 10 members per vault
- Files exist only while the uploader stays online
- Vaults expire after 4 hours of inactivity (configurable)
