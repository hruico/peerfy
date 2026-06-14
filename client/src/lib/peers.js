/**
 * WebRTC peer connection helpers — ICE queuing and signaling route keys.
 *
 * Route key format: `${fileId}:${remoteSocketId}` — unique per file transfer
 * between two peers, so multiple downloaders of the same file don't collide.
 */

export function routeKey(fileId, remoteSocketId) {
  return `${fileId}:${remoteSocketId}`;
}

export function createManagedPeer({ iceConfig, onIceCandidate, onStateChange }) {
  const peer = new RTCPeerConnection(iceConfig);
  const pendingIce = [];
  let remoteReady = false;

  peer.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) onIceCandidate?.(ev.candidate);
  });

  peer.addEventListener("connectionstatechange", () => {
    onStateChange?.(peer.connectionState);
  });

  async function setRemoteDescription(desc) {
    await peer.setRemoteDescription(desc);
    remoteReady = true;
    await flushPendingIce();
  }

  async function addIceCandidate(candidate) {
    if (!candidate) return;
    if (remoteReady && peer.remoteDescription) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[ice] addCandidate failed:", err.message);
      }
    } else {
      pendingIce.push(candidate);
    }
  }

  async function flushPendingIce() {
    while (pendingIce.length) {
      const candidate = pendingIce.shift();
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[ice] flush failed:", err.message);
      }
    }
  }

  function close() {
    try { peer.close(); } catch (_) {}
  }

  return { peer, setRemoteDescription, addIceCandidate, close };
}

export async function waitForSharedKey(sharedKeysRef, peerId, timeoutMs = 10000) {
  const existing = sharedKeysRef.current[peerId];
  if (existing) return existing;

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Key exchange timed out — peer may have disconnected.")),
      timeoutMs,
    );
    const interval = setInterval(() => {
      const key = sharedKeysRef.current[peerId];
      if (key) {
        clearTimeout(deadline);
        clearInterval(interval);
        resolve(key);
      }
    }, 50);
  });
}
