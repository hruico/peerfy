import { useRef, useState, useCallback, useEffect } from "react";
import { useSocket }          from "./hooks/useSocket";
import { sha256hex, generateECDHKeypair, importECDHPublicKey, deriveSharedKey } from "./lib/crypto";
import { sendFile, receiveFile }                   from "./lib/transfer";
import { ICE_CONFIG }                              from "./lib/webrtc";
import { formatBytes, formatSpeed }                from "./lib/format";
import { routeKey, createManagedPeer, waitForSharedKey } from "./lib/peers";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:        "#000000",
  surface:   "#0a0a0a",
  surfaceHi: "#111111",
  border:    "#2a2a2a",
  borderHi:  "#3a3a3a",
  accent:    "#CCFF00",
  accentHi:  "#DFFF00",
  textPri:   "#f0f0f0",
  textSec:   "#888888",
  textDim:   "#444444",
  danger:    "#ff4444",
  dangerBg:  "#1a0000",
  dangerBdr: "#4a0000",
};

// ── State ─────────────────────────────────────────────────────────────────────
const INIT = {
  screen:     "home",
  vaultId:    null,
  inviteUrl:  null,
  members:    [],
  files:      [],
  homeError:  "",
  dissolved:  false,
  toasts:     [],
  peerStatus: {},
  showInviteModal: false,
};

let toastSeq = 0;

export default function App() {
  const [state, setState]       = useState(INIT);
  const [progress, setProgress] = useState({});
  const [myName]                = useState(
    () => `User-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  );

  const st = useCallback((patch) => setState((s) => ({ ...s, ...patch })), []);

  const socketRef_ = useRef(null);
  // ECDH keypair generated once per session on vault join/create
  const ecdhRef        = useRef(null);  // { privateKey, publicKey, exported }
  // Map of peerId → derived AES CryptoKey, populated when we receive their pubkey
  const sharedKeysRef  = useRef({});
  const vaultIdRef        = useRef(null);
  const myNameRef         = useRef(null);
  const peersRef          = useRef({});   // peerKey → managed peer entry
  const routesRef         = useRef({});   // routeKey(fileId, socketId) → peerKey
  const pendingUploadsRef = useRef(new Map());
  const vaultFilesRef     = useRef([]);
  const activeDownloadsRef = useRef(new Set());

  const toast = useCallback((msg, type = "info", ttl = 4000) => {
    const id = ++toastSeq;
    setState((s) => ({ ...s, toasts: [...s.toasts, { id, msg, type }] }));
    setTimeout(() => setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) })), ttl);
  }, []);

  useEffect(() => { vaultFilesRef.current = state.files; }, [state.files]);
  useEffect(() => { myNameRef.current = myName; }, [myName]);

  function removePeer(peerKey, routeKeys = []) {
    const entry = peersRef.current[peerKey];
    if (entry) {
      entry.close();
      delete peersRef.current[peerKey];
    }
    for (const rk of routeKeys) delete routesRef.current[rk];
  }

  function createPeerConn(peerKey, signalingTarget, fileId, remoteSocketId) {
    removePeer(peerKey, fileId && remoteSocketId ? [routeKey(fileId, remoteSocketId)] : []);

    const target = signalingTarget || peerKey;
    const managed = createManagedPeer({
      iceConfig: ICE_CONFIG,
      onIceCandidate: (candidate) => {
        socketRef_.current?.emit("signal:ice", { to: target, candidate, fileId });
      },
      onStateChange: (s) => {
        setState((prev) => ({ ...prev, peerStatus: { ...prev.peerStatus, [peerKey]: s } }));
      },
    });

    peersRef.current[peerKey] = managed;
    if (fileId && remoteSocketId) {
      routesRef.current[routeKey(fileId, remoteSocketId)] = peerKey;
    }
    return managed;
  }

  function resolvePeer(fileId, from) {
    if (!fileId || !from) return null;
    const peerKey = routesRef.current[routeKey(fileId, from)];
    return peerKey ? peersRef.current[peerKey] : null;
  }

  const downloadFile = useCallback((file) => {
    if (!file.uploaderId) return Promise.resolve();
    if (file.uploaderId === socketRef_.current?.id) return Promise.resolve();
    if (activeDownloadsRef.current.has(file.id)) return Promise.resolve();

    activeDownloadsRef.current.add(file.id);
    const rk = routeKey(file.id, file.uploaderId);

    return (async () => {
      try {
        const sharedKey = await waitForSharedKey(sharedKeysRef, file.uploaderId);

        const peerKey = `dl-${file.id}`;
        const managed = createPeerConn(peerKey, file.uploaderId, file.id, file.uploaderId);
        const { peer } = managed;
        const channel = peer.createDataChannel(`dl:${file.id}`);

        setState((s) => ({ ...s, peerStatus: { ...s.peerStatus, [peerKey]: "connecting" } }));

        function cleanup() {
          removePeer(peerKey, [rk]);
          activeDownloadsRef.current.delete(file.id);
          setState((s) => {
            const ps = { ...s.peerStatus };
            delete ps[peerKey];
            return { ...s, peerStatus: ps };
          });
        }

        const receivePromise = receiveFile(channel, sharedKey, (prog) => {
          setProgress((p) => ({ ...p, [file.id]: prog }));
        });

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socketRef_.current?.emit("signal:offer", { to: file.uploaderId, offer, fileId: file.id });

        const { blob, ok, name } = await receivePromise;
        setProgress((p) => { const n = { ...p }; delete n[file.id]; return n; });
        cleanup();

        if (!ok) {
          toast(`Hash mismatch - "${name}" may be corrupted.`, "error");
          return;
        }
        toast(`"${name}" downloaded.`, "success");
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement("a"), { href: url, download: name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (e) {
        toast(`Download failed: ${e.message || "Connection error"}`, "error");
        setProgress((p) => { const n = { ...p }; delete n[file.id]; return n; });
        removePeer(`dl-${file.id}`, [rk]);
        activeDownloadsRef.current.delete(file.id);
        throw e;
      }
    })();
  }, [toast]);

  const uploadFile = useCallback(async (file) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast(`"${file.name}" exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit.`, "error", 6000);
      return;
    }
    const buffer = await file.arrayBuffer();
    const hash   = await sha256hex(buffer);
    socketRef_.current?.emit("vault:file:add", {
      name: file.name, size: file.size,
      type: file.type || "application/octet-stream", hash,
    });
    pendingUploadsRef.current.set(hash, { file, hash });
    toast(`"${file.name}" added to vault.`, "success");
  }, [toast]);

  const handleIncomingOffer = useCallback(async ({ from, offer, fileId }) => {
    if (!fileId) return;

    const peerKey = `ul:${from}:${fileId}`;
    const rk = routeKey(fileId, from);
    const managed = createPeerConn(peerKey, from, fileId, from);
    const { peer, setRemoteDescription } = managed;

    peer.addEventListener("datachannel", (ev) => {
      const channel    = ev.channel;
      const chanFileId = channel.label.replace("dl:", "");
      const vFile      = vaultFilesRef.current.find((f) => f.id === chanFileId);
      if (!vFile) {
        toast(`Download request for unknown file.`, "error");
        return;
      }
      const upload = pendingUploadsRef.current.get(vFile.hash);
      if (!upload) {
        toast(`File "${vFile.name}" is no longer available - uploader may have refreshed.`, "error");
        return;
      }

      channel.addEventListener("open", async () => {
        try {
          const sharedKey = await waitForSharedKey(sharedKeysRef, from);
          await sendFile(channel, upload.file, sharedKey, (prog) => {
            setProgress((p) => ({ ...p, [`send:${chanFileId}`]: prog }));
          });
          setProgress((p) => { const n = { ...p }; delete n[`send:${chanFileId}`]; return n; });
        } catch (e) {
          toast(`Send failed: ${e.message}`, "error");
        } finally {
          removePeer(peerKey, [rk]);
        }
      });
    });

    await setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socketRef_.current?.emit("signal:answer", { to: from, answer, fileId });
  }, [toast]);

  const rejoinVault = useCallback(() => {
    const id = vaultIdRef.current;
    if (!id || !myNameRef.current) return;
    socketRef_.current?.emit("vault:join", { vaultId: id, name: myNameRef.current });
  }, []);

  // Read vault ID from URL query param once on mount - consumed when socket connects
  const pendingVaultRef = useRef(null);
  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const vaultId = params.get("vault");
    if (vaultId) pendingVaultRef.current = vaultId.trim().toUpperCase();
  }, []);

  const { socketRef, connected: socketConnected } = useSocket({
    onConnect: () => {
      if (vaultIdRef.current) rejoinVault();
    },
    onDisconnect: (reason) => {
      for (const key of Object.keys(peersRef.current)) removePeer(key);
      routesRef.current = {};
      activeDownloadsRef.current.clear();
      sharedKeysRef.current = {};
      if (vaultIdRef.current && reason !== "io client disconnect") {
        toast("Connection lost - reconnecting…", "info", 6000);
      }
    },
    onConnectError: () => {
      toast("Cannot reach server - retrying…", "error", 5000);
    },
    "vault:joined": async ({ id, members, files }) => {
      const isReconnect = vaultIdRef.current === id;
      vaultIdRef.current = id;
      if (!ecdhRef.current) {
        ecdhRef.current = await generateECDHKeypair();
      }
      socketRef_.current?.emit("vault:pubkey", { pubkey: ecdhRef.current.exported });
      st({
        screen: "vault", vaultId: id, members, files,
        homeError: "", showInviteModal: !isReconnect,
      });
      if (isReconnect) toast("Reconnected to vault.", "success", 3000);
    },
    "vault:updated": ({ members, files }) => {
      setState((s) => {
        // Only fire toasts after we're actually in a vault
        if (s.screen !== "vault") return { ...s, members, files };
        const prevIds = new Set(s.members.map((m) => m.id));
        const nextIds = new Set(members.map((m) => m.id));
        prevIds.forEach((id) => {
          if (!nextIds.has(id)) {
            const left = s.members.find((m) => m.id === id);
            if (left) toast(`${left.name} left the vault.`, "info");
          }
        });
        members.forEach((m) => {
          // Only toast for genuinely new arrivals - not ourselves, not pre-existing members
          if (!prevIds.has(m.id) && m.id !== socketRef_.current?.id) {
            toast(`${m.name} joined.`, "info");
          }
        });
        return { ...s, members, files };
      });
    },
    "vault:error": ({ message }) => {
      setState((s) => {
        if (s.screen === "vault") {
          toast(message, "error");
          return s;
        }
        return { ...s, homeError: message };
      });
    },
    "vault:dissolved": () => {
      toast("Vault dissolved - all members left.", "info", 8000);
      for (const key of Object.keys(peersRef.current)) removePeer(key);
      routesRef.current = {};
      pendingUploadsRef.current.clear();
      sharedKeysRef.current = {};
      ecdhRef.current = null;
      vaultIdRef.current = null;
      activeDownloadsRef.current.clear();
      st({ dissolved: true, screen: "home", showInviteModal: false, vaultId: null, inviteUrl: null, members: [], files: [] });
    },
    "vault:pubkeys": async (pubkeyMap) => {
      const ecdh = ecdhRef.current;
      if (!ecdh) return;
      const myId = socketRef_.current?.id;
      for (const [peerId, pubkeyB64] of Object.entries(pubkeyMap)) {
        if (peerId === myId) continue;
        if (sharedKeysRef.current[peerId]) continue;
        try {
          const theirPubKey = await importECDHPublicKey(pubkeyB64);
          const sharedKey   = await deriveSharedKey(ecdh.privateKey, theirPubKey);
          sharedKeysRef.current[peerId] = sharedKey;
        } catch (e) {
          console.warn("[ecdh] key derivation failed for", peerId, e);
        }
      }
    },
    "signal:offer":  ({ from, offer, fileId }) => handleIncomingOffer({ from, offer, fileId }),
    "signal:answer": async ({ from, answer, fileId }) => {
      const managed = resolvePeer(fileId, from);
      if (!managed) return;
      await managed.setRemoteDescription(new RTCSessionDescription(answer));
    },
    "signal:ice": async ({ from, candidate, fileId }) => {
      if (!candidate) return;
      const managed = resolvePeer(fileId, from);
      if (!managed) return;
      await managed.addIceCandidate(candidate);
    },
  });
  socketRef_.current = socketRef.current;

  const createVault = useCallback(async () => {
    st({ homeError: "" });
    ecdhRef.current = await generateECDHKeypair();
    socketRef_.current?.emit("vault:create", { name: myName });
  }, [myName, st]);

  const joinVault = useCallback((vaultId) => {
    if (!vaultId.trim()) return;
    st({ homeError: "" });
    socketRef_.current?.emit("vault:join", { vaultId: vaultId.trim().toUpperCase(), name: myName });
  }, [myName, st]);

  // Join vault from URL query param once connected. Handles both fast connections
  // (socket already connected when effect runs) and slow ones (waits for onConnect).
  useEffect(() => {
    if (!socketConnected) return;
    if (vaultIdRef.current) return; // already in a vault
    const id = pendingVaultRef.current;
    if (!id) return;
    pendingVaultRef.current = null;
    socketRef_.current?.emit("vault:join", { vaultId: id, name: myNameRef.current });
  }, [socketConnected]);

  useEffect(() => {
    if (state.vaultId && !state.inviteUrl) {
      const url = `${window.location.origin}/?vault=${state.vaultId}`;
      st({ inviteUrl: url });
    }
  }, [state.vaultId, state.inviteUrl, st]);

  const downloadAll = useCallback(() => {
    const otherFiles = vaultFilesRef.current.filter(
      (f) => f.uploaderId !== socketRef_.current?.id
    );
    const byUploader = new Map();
    for (const file of otherFiles) {
      if (!byUploader.has(file.uploaderId)) byUploader.set(file.uploaderId, []);
      byUploader.get(file.uploaderId).push(file);
    }
    for (const [, files] of byUploader) {
      (async () => {
        for (const file of files) {
          try {
            await downloadFile(file);
          } catch (e) {
            console.error("download all:", file.name, e);
          }
        }
      })();
    }
  }, [downloadFile]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    [...e.dataTransfer.files].forEach(uploadFile);
  }, [uploadFile]);

  const onFileInput = useCallback((e) => {
    [...e.target.files].forEach(uploadFile);
    e.target.value = "";
  }, [uploadFile]);

  return (
    <>
      <ToastStack toasts={state.toasts} />

      {state.screen === "home"
        ? <HomeScreen
            onCreateVault={createVault}
            onJoinVault={joinVault}
            error={state.homeError}
            dissolved={state.dissolved}
            joiningVaultId={pendingVaultRef.current}
            socketConnected={socketConnected}
          />
        : <>
            <VaultScreen
              vault={{ id: state.vaultId, members: state.members, files: state.files }}
              inviteUrl={state.inviteUrl}
              myId={socketRef_.current?.id}
              socketConnected={socketConnected}
              progress={progress}
              peerStatus={state.peerStatus}
              encrypted={!!ecdhRef.current}
              onDrop={onDrop}
              onFileInput={onFileInput}
              onDownload={downloadFile}
              onDownloadAll={downloadAll}
              onRemove={(fileId) => {
                const file = vaultFilesRef.current.find((f) => f.id === fileId);
                if (file?.hash) pendingUploadsRef.current.delete(file.hash);
                socketRef_.current?.emit("vault:file:remove", { fileId });
              }}
              onOpenInvite={() => st({ showInviteModal: true })}
            />
            {state.showInviteModal && state.inviteUrl && (
              <InviteModal
                vaultId={state.vaultId}
                inviteUrl={state.inviteUrl}
                onClose={() => st({ showInviteModal: false })}
              />
            )}
          </>
      }
    </>
  );
}

function InviteModal({ vaultId, inviteUrl, onClose }) {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  function copy(text, setCopied) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  // Close on backdrop click
  function onBackdrop(e) {
    if (e.target === e.currentTarget) onClose();
  }

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      onClick={onBackdrop}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
        backdropFilter: "blur(4px)",
      }}
    >
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 16, padding: 28, width: "100%", maxWidth: 460,
        animation: "fade-up 0.18s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.textPri, letterSpacing: "-0.3px" }}>
              Vault ready
            </div>
            <div style={{ fontSize: 13, color: C.textSec, marginTop: 2 }}>
              Share the code or link to invite others
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: `1px solid ${C.border}`,
              color: C.textSec, width: 32, height: 32, borderRadius: 8,
              cursor: "pointer", fontSize: 16, display: "flex",
              alignItems: "center", justifyContent: "center",
              transition: "border-color 0.15s, color 0.15s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.borderHi; e.currentTarget.style.color = C.textPri; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textSec; }}
          >
            <CloseIcon />
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em",
                        textTransform: "uppercase", marginBottom: 8 }}>
            Vault Code
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "12px 16px",
          }}>
            <span style={{
              flex: 1, fontFamily: "monospace", fontSize: 26, fontWeight: 700,
              letterSpacing: "0.3em", color: C.accent,
            }}>
              {vaultId}
            </span>
            <GhostBtn onClick={() => copy(vaultId, setCopiedCode)}>
              {copiedCode ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
            </GhostBtn>
          </div>
        </div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.textDim, letterSpacing: "0.08em",
                        textTransform: "uppercase", marginBottom: 8 }}>
            Invite Link
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            background: C.bg, border: `1px solid ${C.border}`,
            borderRadius: 10, padding: "10px 16px",
          }}>
            <span style={{
              flex: 1, fontSize: 12, color: C.textSec, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {inviteUrl}
            </span>
            <GhostBtn onClick={() => copy(inviteUrl, setCopiedLink)}>
              {copiedLink ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
            </GhostBtn>
          </div>
        </div>

        <KiwiBtn onClick={onClose} fullWidth size="lg">
          Done
        </KiwiBtn>
      </div>
    </div>
  );
}

function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  const style = {
    info:    { border: `1px solid ${C.border}`,   background: C.surface,   color: C.textSec },
    success: { border: "1px solid rgba(204,255,0,0.35)", background: "#0b1000", color: C.accent },
    error:   { border: `1px solid ${C.dangerBdr}`, background: C.dangerBg, color: "#ff8080" },
  };
  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 9000,
      display: "flex", flexDirection: "column", gap: 8,
      maxWidth: 340, pointerEvents: "none",
    }}>
      {toasts.map((t) => (
        <div key={t.id} style={{
          fontSize: 13, padding: "10px 14px", borderRadius: 10, lineHeight: 1.4,
          animation: "fade-up 0.2s ease",
          ...(style[t.type] || style.info),
        }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function HomeScreen({ onCreateVault, onJoinVault, error, dissolved, joiningVaultId, socketConnected }) {
  const [roomInput, setRoomInput] = useState("");

  // If opened via invite link, pre-fill the code and show waiting state
  const joining = joiningVaultId && !socketConnected;
  const waitingToJoin = joiningVaultId && socketConnected;

  return (
    <div style={{
      minHeight: "100vh", background: C.bg,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      padding: "0 20px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <PeerfyLogo size={44} />
        <span style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-1.5px", color: C.accent }}>
          Peerfy
        </span>
      </div>
      <p style={{ color: C.textDim, fontSize: 13, marginBottom: 40, letterSpacing: "0.01em" }}>
        Peer-to-peer file sharing. No accounts. End-to-end encrypted.
      </p>

      <div style={{
        width: "100%", maxWidth: 380,
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 16, padding: 24,
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        {dissolved && (
          <div style={{
            fontSize: 13, padding: "10px 14px", borderRadius: 8,
            background: "#0e0d00", border: "1px solid #3a3000", color: "#aaaa00",
          }}>
            Vault dissolved - all members disconnected.
          </div>
        )}

        {joining && (
          <div style={{
            fontSize: 13, padding: "10px 14px", borderRadius: 8,
            background: C.surface, border: `1px solid ${C.border}`, color: C.textSec,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#ffcc00",
                           animation: "kiwi-pulse 1s infinite", flexShrink: 0 }} />
            Connecting to server - this may take up to 30 seconds…
          </div>
        )}

        {waitingToJoin && (
          <div style={{
            fontSize: 13, padding: "10px 14px", borderRadius: 8,
            background: "#0b1000", border: "1px solid rgba(204,255,0,0.35)", color: C.accent,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.accent,
                           animation: "kiwi-pulse 1s infinite", flexShrink: 0 }} />
            Joining vault {joiningVaultId}…
          </div>
        )}

        <KiwiBtn onClick={onCreateVault} fullWidth size="lg">
          Create a Vault
        </KiwiBtn>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, height: 1, background: C.border }} />
          <span style={{ fontSize: 12, color: C.textDim }}>or join existing</span>
          <div style={{ flex: 1, height: 1, background: C.border }} />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && onJoinVault(roomInput)}
            maxLength={6}
            placeholder="Enter vault code"
            style={{
              flex: 1, background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 8, padding: "11px 14px", color: C.textPri,
              fontSize: 14, letterSpacing: "0.15em", outline: "none",
              fontFamily: "monospace", transition: "border-color 0.15s",
            }}
            onFocus={(e) => { e.target.style.borderColor = C.accent; }}
            onBlur={(e)  => { e.target.style.borderColor = C.border; }}
          />
          <KiwiBtn onClick={() => onJoinVault(roomInput)}>Join</KiwiBtn>
        </div>

        {error && (
          <div style={{
            fontSize: 13, padding: "10px 14px", borderRadius: 8,
            background: C.dangerBg, border: `1px solid ${C.dangerBdr}`, color: "#ff8080",
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function VaultScreen({
  vault, inviteUrl, myId, socketConnected, progress, peerStatus, encrypted,
  onDrop, onFileInput, onDownload, onDownloadAll, onRemove, onOpenInvite,
}) {
  const [dragging, setDragging] = useState(false);
  const [dlAll, setDlAll]       = useState(false);
  const inputRef = useRef(null);

  const activeStatuses = Object.values(peerStatus);
  const connStatus =
    activeStatuses.includes("connecting") ? "connecting" :
    activeStatuses.includes("connected")  ? "connected"  :
    activeStatuses.includes("failed")     ? "error"      : "idle";

  const connColor = { idle: C.textDim, connecting: "#ffcc00", connected: C.accent, error: C.danger }[connStatus];
  const connLabel = { idle: null, connecting: "Connecting", connected: "P2P active", error: "Connection error" }[connStatus];

  return (
    <div style={{ height: "100vh", background: C.bg, display: "flex", flexDirection: "column", overflow: "hidden" }}>

      <nav style={{
        flexShrink: 0, height: 52,
        borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center",
        padding: "0 20px", gap: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <PeerfyLogo size={24} />
          <span style={{ fontSize: 15, fontWeight: 800, color: C.accent, letterSpacing: "-0.4px" }}>
            Peerfy
          </span>
        </div>

        <div style={{ width: 1, height: 20, background: C.border, flexShrink: 0 }} />

        <div style={{
          flex: 1, maxWidth: 440,
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 8, height: 34,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
          padding: "0 14px",
        }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: C.textDim,
                         letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Vault
          </span>
          <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14,
                         letterSpacing: "0.25em", color: C.accent }}>
            {vault.id}
          </span>
          {encrypted && (
            <span style={{
              display: "flex", alignItems: "center", gap: 4,
              fontSize: 10, color: C.accent,
              background: "rgba(204,255,0,0.07)",
              border: "1px solid rgba(204,255,0,0.18)",
              borderRadius: 20, padding: "2px 8px",
              fontWeight: 600,
            }}>
              <LockIcon size={9} /> E2EE
            </span>
          )}
          {connLabel && (
            <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: connColor }}>
              <span style={{
                width: 5, height: 5, borderRadius: "50%", background: connColor,
                animation: connStatus === "connecting" ? "kiwi-pulse 1s infinite" : "none",
              }} />
              {connLabel}
            </span>
          )}
          <span style={{
            display: "flex", alignItems: "center", gap: 5,
            fontSize: 10, color: socketConnected ? C.accent : C.danger,
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: "50%",
              background: socketConnected ? C.accent : C.danger,
            }} />
            {socketConnected ? "Online" : "Offline"}
          </span>
        </div>

        <div style={{ flex: 1 }} />

        {/* Invite button */}
        <KiwiBtn onClick={onOpenInvite} size="sm">
          <LinkIcon size={13} />
          Invite
        </KiwiBtn>
      </nav>

      <div className="vault-layout">
        <aside className="vault-sidebar-left" style={{
          borderRight: `1px solid ${C.border}`,
          display: "flex", flexDirection: "column", gap: 10,
          padding: 14, overflowY: "auto",
        }}>
          <SectionLabel>Upload</SectionLabel>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e)    => { setDragging(false); onDrop(e); }}
            onClick={() => inputRef.current?.click()}
            style={{
              height: 136, flexShrink: 0,
              border: `1.5px dashed ${dragging ? C.accent : C.border}`,
              borderRadius: 10, cursor: "pointer",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: 8,
              background: dragging ? "rgba(204,255,0,0.03)" : "transparent",
              transition: "border-color 0.15s, background 0.15s",
              textAlign: "center", padding: 12,
            }}
          >
            <input ref={inputRef} type="file" multiple style={{ display: "none" }} onChange={onFileInput} />
            <UploadIcon size={28} color={dragging ? C.accent : C.textDim} />
            <span style={{ fontSize: 12, color: dragging ? C.accent : C.textDim, lineHeight: 1.5 }}>
              Drop files here<br />
              <span style={{ color: C.textDim, fontSize: 11 }}>or click to browse</span>
            </span>
          </div>

          <KiwiBtn onClick={() => inputRef.current?.click()} fullWidth size="sm">
            Add Files
          </KiwiBtn>

          <span style={{ fontSize: 10, color: C.textDim, textAlign: "center" }}>
            Max {formatBytes(MAX_UPLOAD_BYTES)} per file
          </span>

          {vault.files.some((f) => progress[`send:${f.id}`]) && (
            <>
              <div style={{ height: 1, background: C.border, margin: "4px 0" }} />
              <SectionLabel>Sending</SectionLabel>
              {vault.files.map((file) => {
                const send = progress[`send:${file.id}`];
                if (!send?.total) return null;
                const pct = Math.round((send.transferred / send.total) * 100);
                return (
                  <div key={file.id} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{
                        fontSize: 11, color: C.textSec,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        maxWidth: 120,
                      }}>
                        {file.name}
                      </span>
                      <span style={{ fontSize: 10, color: C.accent, fontVariantNumeric: "tabular-nums" }}>
                        {pct}%
                      </span>
                    </div>
                    <ProgressBar pct={pct} />
                  </div>
                );
              })}
            </>
          )}
        </aside>

        <main style={{ overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <SectionLabel>{vault.files.length} {vault.files.length === 1 ? "File" : "Files"}</SectionLabel>
            {(() => {
              const downloadableCount = vault.files.filter((f) => f.uploaderId !== myId).length;
              return downloadableCount > 1 ? (
                <KiwiBtn
                  onClick={() => { onDownloadAll(); setDlAll(true); setTimeout(() => setDlAll(false), 1000); }}
                  size="sm"
                >
                  <DownloadIcon size={12} />
                  {dlAll ? "Downloading…" : `Download All (${downloadableCount})`}
                </KiwiBtn>
              ) : null;
            })()}
          </div>

          {vault.files.length === 0 ? (
            <div style={{
              flex: 1, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: 10, paddingTop: 60, color: C.textDim,
            }}>
              <EmptyIcon />
              <span style={{ fontSize: 14, color: C.textDim }}>No files yet</span>
              <span style={{ fontSize: 12, color: "#2a2a2a" }}>Add files from the left panel</span>
            </div>
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))",
              gap: 10,
            }}>
              {vault.files.map((file) => (
                <FileTile
                  key={file.id}
                  file={file}
                  isOwn={file.uploaderId === myId}
                  dl={progress[file.id]}
                  onDownload={onDownload}
                  onRemove={onRemove}
                />
              ))}
            </div>
          )}
        </main>

        <aside className="vault-sidebar-right" style={{
          borderLeft: `1px solid ${C.border}`,
          display: "flex", flexDirection: "column", gap: 8,
          padding: 14, overflowY: "auto",
        }}>
          <SectionLabel>Members · {vault.members.length}</SectionLabel>

          {vault.members.map((m) => {
            const isMe = m.id === myId;
            return (
              <div key={m.id} style={{
                display: "flex", alignItems: "center", gap: 9,
                padding: "8px 10px", borderRadius: 8,
                background: isMe ? "rgba(204,255,0,0.05)" : C.surface,
                border: `1px solid ${isMe ? "rgba(204,255,0,0.2)" : C.border}`,
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
                  background: isMe ? C.accent : "#1e1e1e",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700,
                  color: isMe ? "#000" : C.textDim,
                  letterSpacing: "0.03em",
                }}>
                  {m.name.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600,
                    color: isMe ? C.accent : C.textPri,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {m.name}
                  </div>
                  <div style={{ fontSize: 10, color: isMe ? "rgba(204,255,0,0.45)" : C.textDim }}>
                    {isMe ? "you" : "online"}
                  </div>
                </div>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: C.accent, flexShrink: 0,
                }} />
              </div>
            );
          })}
        </aside>
      </div>
    </div>
  );
}

function FileTile({ file, isOwn, dl, onDownload, onRemove }) {
  const [hovered, setHovered] = useState(false);
  const pct = dl?.total ? Math.round((dl.transferred / dl.total) * 100) : 0;
  const downloading = !!dl;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? C.surfaceHi : C.surface,
        border: `1px solid ${hovered ? C.borderHi : C.border}`,
        borderRadius: 10, padding: "12px 10px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
        transition: "background 0.15s, border-color 0.15s",
        position: "relative", cursor: "default",
      }}
    >
      {/* Remove button */}
      {isOwn && hovered && !downloading && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(file.id); }}
          title="Remove from vault"
          style={{
            position: "absolute", top: 6, right: 6,
            width: 18, height: 18, borderRadius: 5,
            background: C.dangerBg, border: `1px solid ${C.dangerBdr}`,
            color: "#ff6666", fontSize: 9, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 0,
          }}
        >
          <CloseIcon size={8} />
        </button>
      )}

      {/* File icon */}
      <div style={{ color: C.textSec, marginTop: 2 }}>
        <FileTypeIcon type={file.type} size={32} />
      </div>

      {/* Name */}
      <div style={{
        fontSize: 11, color: C.textSec, textAlign: "center",
        lineHeight: 1.35, maxWidth: "100%",
        overflow: "hidden", display: "-webkit-box",
        WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        wordBreak: "break-all",
      }}>
        {file.name}
      </div>

      {/* Size */}
      <div style={{ fontSize: 10, color: C.textDim }}>
        {formatBytes(file.size)}
      </div>

      {/* Progress */}
      {downloading && dl.total > 0 && (
        <div style={{ width: "100%", marginTop: 2 }}>
          <ProgressBar pct={pct} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <span style={{ fontSize: 10, color: C.accent, fontVariantNumeric: "tabular-nums" }}>
              {pct}%
            </span>
            {dl.speed > 0 && (
              <span style={{ fontSize: 10, color: C.textDim, fontVariantNumeric: "tabular-nums" }}>
                {formatSpeed(dl.speed)}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Download button on hover */}
      {hovered && !downloading && !isOwn && (
        <button
          onClick={() => onDownload(file)}
          style={{
            marginTop: 2, width: "100%", padding: "5px 0",
            background: C.accent, border: "none", borderRadius: 6,
            color: "#000", fontSize: 11, fontWeight: 700, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = C.accentHi; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = C.accent; }}
        >
          <DownloadIcon size={11} />
          Download
        </button>
      )}
    </div>
  );
}

function KiwiBtn({ onClick, children, disabled, fullWidth, size = "md" }) {
  const [hov, setHov] = useState(false);
  const pad = { sm: "6px 12px", md: "9px 16px", lg: "13px 20px" }[size];
  const fz  = { sm: 12, md: 13, lg: 14 }[size];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: fullWidth ? "100%" : "auto",
        padding: pad, borderRadius: 8, border: "none",
        background: disabled ? "#1c1c1c" : hov ? C.accentHi : C.accent,
        color: disabled ? C.textDim : "#000",
        fontSize: fz, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        whiteSpace: "nowrap", letterSpacing: "0.01em",
      }}
    >
      {children}
    </button>
  );
}

function GhostBtn({ onClick, children }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        flexShrink: 0, padding: "6px 12px", borderRadius: 7,
        border: `1px solid ${hov ? C.borderHi : C.border}`,
        background: hov ? C.surfaceHi : "transparent",
        color: hov ? C.textPri : C.textSec,
        fontSize: 12, fontWeight: 600, cursor: "pointer",
        transition: "all 0.15s",
        display: "flex", alignItems: "center", gap: 5,
      }}
    >
      {children}
    </button>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, color: C.textDim,
      letterSpacing: "0.1em", textTransform: "uppercase",
    }}>
      {children}
    </div>
  );
}

function ProgressBar({ pct, color = C.accent }) {
  return (
    <div style={{ width: "100%", height: 2, background: C.border, borderRadius: 2, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${pct}%`, background: color,
        borderRadius: 2, transition: "width 0.15s",
      }} />
    </div>
  );
}

function PeerfyLogo({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#CCFF00" />
      <path d="M8 22V10h4.2c2.8 0 4.6 1.5 4.6 3.9 0 1.5-.7 2.6-1.9 3.2L18 22h-3.2l-2.3-4.4H11.2V22H8zm3.2-7.2h1c1.1 0 1.7-.5 1.7-1.3 0-.8-.6-1.3-1.7-1.3h-1v2.6zM20 22l5-12h3.4l-5 12H20z"
            fill="#000" />
    </svg>
  );
}


const iconProps = (size) => ({
  width: size, height: size, viewBox: "0 0 24 24",
  fill: "none", stroke: "currentColor",
  strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round",
});

function UploadIcon({ size = 20, color }) {
  return (
    <svg {...iconProps(size)} style={{ color }}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function DownloadIcon({ size = 16 }) {
  return (
    <svg {...iconProps(size)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function LinkIcon({ size = 16 }) {
  return (
    <svg {...iconProps(size)}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function LockIcon({ size = 14 }) {
  return (
    <svg {...iconProps(size)}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CloseIcon({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#222"
         strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileTypeIcon({ type = "", size = 28 }) {
  const s = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
               stroke: C.textDim, strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" };

  if (type.startsWith("image/")) return (
    <svg {...s}>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
  if (type.startsWith("video/")) return (
    <svg {...s}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
  if (type.startsWith("audio/")) return (
    <svg {...s}>
      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    </svg>
  );
  if (type.includes("pdf")) return (
    <svg {...s}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
  if (type.includes("zip") || type.includes("tar") || type.includes("gzip")) return (
    <svg {...s}>
      <path d="M21 10H3M21 6H3M21 14H3M21 18H3" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
  if (type.includes("text") || type.includes("javascript") || type.includes("json") || type.includes("xml")) return (
    <svg {...s}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="11" y2="17" />
    </svg>
  );
  // generic
  return (
    <svg {...s}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
