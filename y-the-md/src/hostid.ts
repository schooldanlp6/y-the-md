/**
 * Resolving a Music Together host id.
 *
 * There is no autojoin and there cannot be one from disk: the id is generated
 * per session by PeerJS and never persisted — pear-desktop's config holds only
 * `{"enabled": true}`. It has to arrive out of band.
 *
 * The plugin does put it on the clipboard when you host, which is the closest
 * thing to automatic available: `YTMD_MT_HOST_ID=clipboard`.
 */

/** PeerJS ids from pear-desktop are UUIDs; used to sanity-check clipboard text. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLIPBOARD_COMMANDS = [
  ['wl-paste', '--no-newline'],
  ['xclip', '-selection', 'clipboard', '-o'],
  ['xsel', '--clipboard', '--output'],
];

async function readClipboard(): Promise<string | undefined> {
  for (const [cmd, ...args] of CLIPBOARD_COMMANDS) {
    try {
      const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'ignore' });
      const text = (await new Response(proc.stdout).text()).trim();
      if (await proc.exited) continue;
      if (text) return text;
    } catch {
      // Tool not installed; try the next one.
    }
  }
  return undefined;
}

/**
 * Resolve the host id from config.
 *
 * `clipboard` reads it from the system clipboard, which is where pear-desktop
 * puts it when a session is hosted. Anything else is used verbatim.
 */
export async function resolveHostId(raw: string | undefined): Promise<string | undefined> {
  if (!raw) return undefined;
  if (raw !== 'clipboard') return raw;

  const text = await readClipboard();
  if (!text) {
    throw new Error(
      'YTMD_MT_HOST_ID=clipboard but no clipboard tool is available. ' +
        'Install one (`sudo apt install wl-clipboard` on Wayland) or pass the id directly.',
    );
  }

  if (!UUID.test(text)) {
    // Better to say what we found than to fail an opaque connection attempt.
    throw new Error(
      `clipboard does not look like a Music Together host id: ${JSON.stringify(
        text.slice(0, 60),
      )}. Host a session in pear-desktop and copy the id first.`,
    );
  }

  return text;
}
