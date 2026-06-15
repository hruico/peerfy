/**
 * P2P file transfer over a single RTCDataChannel - with auto-resume.
 *
 * sendFile(channel, file, aesKey, onProgress)   → Promise<void>
 * receiveFile(channel, aesKey, onProgress)       → Promise<Result>
 *
 * Resume protocol:
 *   1. Sender opens channel, sends { type:"meta", name, size, hash, totalChunks }.
 *   2. Receiver checks sessionStorage for a saved checkpoint (keyed by hash).
 *      - If found, receiver replies { type:"resume", fromChunk: N }.
 *        Sender skips to chunk N and continues.
 *      - If not found, sender starts from chunk 0.
 *   3. Receiver checkpoints progress to sessionStorage every CHECKPOINT_EVERY chunks.
 *   4. On { type:"done" }, receiver re-hashes the full file and resolves.
 *   5. On success, sessionStorage checkpoint is cleared.
 *
 * Wire format per binary frame:
 *   [12 bytes IV][ciphertext]   - when aesKey provided
 *   [raw bytes]                 - otherwise
 */

import { sha256hex, encryptChunk, decryptChunk } from "./crypto";
import { CHUNK_SIZE, BUFFER_THRESHOLD }          from "./webrtc";
import { createOPFSWriter, OPFS_AVAILABLE }                      from "./opfs";

const CHECKPOINT_EVERY = 10;
const RESUME_KEY = (hash) => `peerfy_resume_${hash}`;

// ── Send ──────────────────────────────────────────────────────────────────────
export async function sendFile(channel, file, aesKey, onProgress) {
  const buffer      = await file.arrayBuffer();
  const hash        = await sha256hex(buffer);
  const total       = buffer.byteLength;
  const totalChunks = Math.ceil(total / CHUNK_SIZE);

  // Send meta - include whether this transfer is encrypted so the receiver
  // knows whether to decrypt regardless of its own key state.
  const encrypted = !!aesKey;
  channel.send(JSON.stringify({
    type: "meta",
    name: file.name,
    size: total,
    hash,
    totalChunks,
    encrypted,
    mime: file.type || "application/octet-stream",
  }));

  const startTime = Date.now();

  await new Promise((resolve, reject) => {
    channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD / 2;
    let startChunk = 0;
    let started    = false;

    // Wait for receiver to reply with resume/ready - never auto-start from 0,
    // which races with resume negotiation and corrupts partial transfers.
    const resumeTimer = setTimeout(() => {
      if (!started) reject(new Error("Receiver did not respond - transfer timed out."));
    }, 30_000);

    let sendDone = false;
    let ackTimeout = null;

    channel.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data);
      if (msg.type === "resume" && !started) {
        clearTimeout(resumeTimer);
        started    = true;
        startChunk = Math.max(0, Number(msg.fromChunk) || 0);
        sendFrom(startChunk);
      }
      if (msg.type === "ready" && !started) {
        clearTimeout(resumeTimer);
        started = true;
        sendFrom(0);
      }
      if (msg.type === "ack" && sendDone) {
        clearTimeout(ackTimeout);
        resolve();
      }
    });

    function sendFrom(fromChunk) {
      let offset     = fromChunk * CHUNK_SIZE;
      let chunkIndex = fromChunk;

      function sendNext() {
        try {
          if (aesKey) {
            // Encrypted - one chunk per microtask to preserve order
            if (offset >= total) { done(); return; }
            if (channel.readyState !== "open") { reject(new Error("Channel closed")); return; }
            if (channel.bufferedAmount > BUFFER_THRESHOLD) {
              channel.addEventListener("bufferedamountlow", sendNext, { once: true });
              return;
            }
            const slice = buffer.slice(offset, offset + CHUNK_SIZE);
            offset      += slice.byteLength;
            chunkIndex  += 1;
            encryptChunk(aesKey, slice).then(({ iv, ciphertext }) => {
              const packed = new Uint8Array(12 + ciphertext.byteLength);
              packed.set(iv, 0);
              packed.set(new Uint8Array(ciphertext), 12);
              channel.send(packed.buffer);
              report(offset);
              Promise.resolve().then(sendNext);
            }).catch(reject);
            return;
          }

          // Plaintext - tight loop with back-pressure
          while (offset < total) {
            if (channel.readyState !== "open") { reject(new Error("Channel closed")); return; }
            if (channel.bufferedAmount > BUFFER_THRESHOLD) {
              channel.addEventListener("bufferedamountlow", sendNext, { once: true });
              return;
            }
            const slice = buffer.slice(offset, offset + CHUNK_SIZE);
            channel.send(slice);
            offset     += slice.byteLength;
            chunkIndex += 1;
            report(offset);
          }
          done();
        } catch (e) { reject(e); }
      }

      function report(transferred) {
        const elapsed = (Date.now() - startTime) / 1000 || 0.001;
        onProgress?.({ transferred, total, speed: transferred / elapsed });
      }

      function done() {
        channel.send(JSON.stringify({ type: "done", hash }));
        report(total);
        sendDone = true;
        
        ackTimeout = setTimeout(() => {
          reject(new Error("Timeout waiting for receiver ACK"));
        }, 30000); // 30s for receiver to write OPFS, hash, and reply
      }

      sendNext();
    }
  });

  return hash;
}

// ── Receive ───────────────────────────────────────────────────────────────────
export function receiveFile(channel, aesKey, onProgress) {
  return new Promise((resolve, reject) => {
    let meta       = null;
    let writer     = null;
    let chunkCount = 0;   // chunks received this session
    let received   = 0;   // bytes received this session
    let resumedFrom = 0;  // chunks already on disk from a previous session
    let settled    = false; // true once resolve/reject has been called
    const startTime = Date.now();

    channel.binaryType = "arraybuffer";

    let writeQueue = Promise.resolve();

    channel.addEventListener("message", (ev) => {
      writeQueue = writeQueue.then(async () => {
        try {
          // ── Control messages ──
          if (typeof ev.data === "string") {
            const msg = JSON.parse(ev.data);

            if (msg.type === "meta") {
              meta = msg;
              let savedChunk = Number(sessionStorage.getItem(RESUME_KEY(msg.hash)) || 0);
              // Resume only works with OPFS - otherwise start fresh to avoid corruption
              if (savedChunk > 0 && !OPFS_AVAILABLE) {
                sessionStorage.removeItem(RESUME_KEY(msg.hash));
                savedChunk = 0;
              }
              const opfsName   = `peerfy_${msg.hash.slice(0, 16)}_${msg.name}`;
              const resumeByte = savedChunk * CHUNK_SIZE;

              resumedFrom = savedChunk;
              received    = resumeByte; // count bytes already on disk toward progress
              writer      = await createOPFSWriter(opfsName, resumeByte);

              if (savedChunk > 0 && savedChunk < msg.totalChunks) {
                // Tell sender to skip already-received chunks
                channel.send(JSON.stringify({ type: "resume", fromChunk: savedChunk }));
                onProgress?.({
                  transferred: resumeByte,
                  total:       msg.size,
                  speed:       0,
                  filename:    msg.name,
                  resuming:    true,
                });
              } else {
                // Fresh start
                channel.send(JSON.stringify({ type: "ready" }));
              }
            }

            if (msg.type === "done") {
              if (!meta || !writer) { settled = true; reject(new Error("done before meta")); return; }

              // Mark settled BEFORE async work so the close handler doesn't race
              settled = true;

              const fileOrBlob = await writer.finish();
              const buf        = await fileOrBlob.arrayBuffer();
              const recvHash   = await sha256hex(buf);
              const ok         = recvHash === msg.hash;

              // Clear checkpoint on success, keep it on failure so retry works
              if (ok) sessionStorage.removeItem(RESUME_KEY(msg.hash));

              try { channel.send(JSON.stringify({ type: "ack" })); } catch (_) {}

              resolve({
                blob:         new Blob([buf], { type: meta.mime || meta.type || "application/octet-stream" }),
                ok,
                name:         meta.name,
                size:         meta.size,
                hash:         recvHash,
                expectedHash: msg.hash,
              });
            }
            return;
          }

          // ── Binary chunk ──
          if (!writer) return;

          const raw = ev.data;
          let plaintext;

          if (meta?.encrypted && aesKey) {
            plaintext = await decryptChunk(
              aesKey,
              new Uint8Array(raw.slice(0, 12)),
              raw.slice(12)
            );
          } else if (meta?.encrypted && !aesKey) {
            // Sender encrypted but we have no key - can't decrypt
            if (!settled) {
              settled = true;
              writer?.cleanup?.();
              reject(new Error("Transfer is encrypted but no key is available. Wait for key exchange to complete."));
            }
            return;
          } else {
            plaintext = raw;
          }

          await writer.write(plaintext);
          chunkCount += 1;
          received   += plaintext.byteLength;

          // Checkpoint every N chunks
          if (chunkCount % CHECKPOINT_EVERY === 0 && meta) {
            sessionStorage.setItem(RESUME_KEY(meta.hash), resumedFrom + chunkCount);
          }

          const elapsed = (Date.now() - startTime) / 1000 || 0.001;
          onProgress?.({
            transferred: received,
            total:       meta?.size ?? 0,
            speed:       received / elapsed,
            filename:    meta?.name,
            resuming:    false,
          });
        } catch (e) {
          writer?.cleanup?.();
          if (!settled) { settled = true; reject(e); }
        }
      });
    });

    channel.addEventListener("error", (e) => {
      writer?.cleanup?.();
      if (!settled) {
        settled = true;
        const msg = e.error?.message || "DataChannel error";
        reject(new Error(msg));
      }
    });
    channel.addEventListener("close", () => {
      if (settled) return; // Transfer already completed successfully
      settled = true;
      if (!meta) {
        reject(new Error("Channel closed before transfer started"));
      } else {
        reject(new Error("Channel closed during transfer"));
      }
    });
  });
}
