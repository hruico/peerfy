import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const EVENTS = [
  "vault:joined", "vault:updated", "vault:error", "vault:dissolved",
  "vault:pubkeys",
  "signal:offer", "signal:answer", "signal:ice",
];

// Module-level singleton — survives React 18 Strict Mode double-mount.
let _socket = null;

function getSocket() {
  if (!_socket || _socket.disconnected) {
    const url = import.meta.env.VITE_BACKEND_URL;
    _socket = io(url || undefined, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ["websocket", "polling"],
    });
  }
  return _socket;
}

export function useSocket(handlers) {
  const socketRef   = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(() => getSocket().connected);

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;
    setConnected(socket.connected);

    const onConnect = () => {
      setConnected(true);
      handlersRef.current.onConnect?.();
    };
    const onDisconnect = (reason) => {
      setConnected(false);
      handlersRef.current.onDisconnect?.(reason);
    };
    const onConnectError = (err) => {
      handlersRef.current.onConnectError?.(err);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    const listeners = {};
    EVENTS.forEach((ev) => {
      const fn = (data) => handlersRef.current[ev]?.(data);
      listeners[ev] = fn;
      socket.on(ev, fn);
    });

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      EVENTS.forEach((ev) => socket.off(ev, listeners[ev]));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { socketRef, connected };
}
