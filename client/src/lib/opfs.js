/**
 * OPFS writer - streams chunks directly to disk (Origin Private File System).
 * Falls back to in-memory accumulation if OPFS is unavailable.
 *
 * Supports resume: pass resumeFromByte > 0 to seek the write cursor forward,
 * preserving already-written data on disk.
 */

const OPFS_AVAILABLE =
  typeof window !== "undefined" &&
  "storage" in navigator &&
  typeof navigator.storage?.getDirectory === "function";

export async function createOPFSWriter(filename, resumeFromByte = 0) {
  if (!OPFS_AVAILABLE) return createMemWriter(resumeFromByte);

  try {
    const root = await navigator.storage.getDirectory();

    if (resumeFromByte === 0) {
      // Fresh start - delete any stale file with this name
      try { await root.removeEntry(filename); } catch (_) {}
    }

    const handle = await root.getFileHandle(filename, { create: true });
    const writer = await handle.createWritable({
      keepExistingData: resumeFromByte > 0,
    });

    if (resumeFromByte > 0) {
      await writer.seek(resumeFromByte);
    }

    return {
      write: async (chunk) => writer.write(chunk),
      finish: async () => {
        await writer.close();
        return handle.getFile();
      },
      cleanup: async () => {
        try { await writer.abort(); } catch (_) {}
        try {
          const r = await navigator.storage.getDirectory();
          await r.removeEntry(filename);
        } catch (_) {}
      },
    };
  } catch (_) {
    return createMemWriter(resumeFromByte);
  }
}

function createMemWriter() {
  const chunks = [];
  return {
    write: async (chunk) => {
      chunks.push(chunk instanceof ArrayBuffer ? chunk : chunk.buffer);
    },
    finish: async () => {
      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      const out   = new Uint8Array(total);
      let off     = 0;
      for (const c of chunks) { out.set(new Uint8Array(c), off); off += c.byteLength; }
      return new Blob([out]);
    },
    cleanup: async () => { chunks.length = 0; },
  };
}

export { OPFS_AVAILABLE };
