import { useEffect, useRef } from "react";
import { io } from "socket.io-client";

const EVENTS = [
  "vault:joined", "vault:updated", "vault:error", "vault:dissolved",
  "signal:offer", "signal:answer", "signal:ice",
];

// Module-level singleton — survives React 18 Strict Mode double-mount
let _socket = null;

function getSocket() {
  if (!_socket || _socket.disconnected) {
    _socket = io();
  }
  return _socket;
}

export function useSocket(handlers) {
  const socketRef   = useRef(null);
  const handlersRef = useRef(handlers);
  // Always keep the latest handlers accessible without re-registering listeners
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = getSocket();
    socketRef.current = socket;

    // Register one stable listener per event that delegates to the latest handler ref.
    // Using named functions so we can safely remove exactly these listeners on cleanup.
    const listeners = {};
    EVENTS.forEach((ev) => {
      // Remove any previously registered listener for this event on this socket
      if (socket._peerfyListeners?.[ev]) {
        socket.off(ev, socket._peerfyListeners[ev]);
      }
      const fn = (data) => handlersRef.current[ev]?.(data);
      listeners[ev] = fn;
      socket.on(ev, fn);
    });
    // Store refs so the next mount can cleanly replace them
    socket._peerfyListeners = listeners;

    return () => {
      // On Strict Mode cleanup we intentionally do NOT disconnect the socket
      // and do NOT remove the listeners — the re-mount will replace them above.
      // This prevents ICE / signaling messages from being dropped mid-negotiation.
    };
  }, []);

  return socketRef;
}
