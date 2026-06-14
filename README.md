# Peerfy

Peer-to-peer file sharing in the browser. No accounts. End-to-end encrypted transfers over WebRTC.

## How it works

1. **Signaling server** — Express + Socket.IO manages vault membership, file manifests (metadata only), ECDH key relay, and WebRTC signaling.
2. **Data plane** — File bytes travel directly between peers over encrypted RTCDataChannels. Nothing passes through the server.

Each download opens a dedicated WebRTC connection between the downloader and uploader.

## Quick start (development)

```bash
npm install
npm run build
npm start
```

Open `http://localhost:8000`.

For hot reload during development, run in two terminals:

```bash
npm run dev:server   # port 8000
npm run dev:client   # port 5173, proxies /socket.io
```

## Environment variables

Copy `.env.example` to `.env` and configure:

| Variable | Where | Description |
|----------|-------|-------------|
| `PORT` | Server | HTTP port (default `8000`) |
| `NODE_ENV` | Server | Set to `production` for deploy |
| `ALLOWED_ORIGIN` | Server | **Required in production** — your site URL for Socket.IO CORS |
| `MAX_MEMBERS` | Server | Max peers per vault (default `10`) |
| `MAX_ROOMS` | Server | Max concurrent vaults (default `500`) |
| `ROOM_TTL_MS` | Server | Vault TTL in ms (default 4 hours) |
| `VITE_BACKEND_URL` | Client build | Socket.IO URL; leave blank when served from same origin |
| `VITE_TURN_*` | Client build | TURN credentials for NAT traversal |

## Production deploy

```bash
npm ci
npm run build
NODE_ENV=production ALLOWED_ORIGIN=https://your-domain.com npm start
```

### Docker

```bash
docker build -t peerfy .
docker run -p 8000:8000 -e NODE_ENV=production -e ALLOWED_ORIGIN=https://your-domain.com peerfy
```

Health check: `GET /health`

## Limits

- 50 MB per file (client-side)
- 10 members per vault
- Files are available only while the uploader remains connected with the file in memory
