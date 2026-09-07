/**
 * The audible chimes for live restaurant screens.
 *
 * Synthesised with Web Audio rather than shipped as assets: short sine tones
 * need no file to bundle and no network fetch on a POS terminal. Two sounds,
 * deliberately distinct so staff can tell them apart across a room:
 *
 * - "New order" — a RISING two-note ding (A5→D6), the shape mainstream
 *   POS/KDS products use for "something arrived".
 * - "Food ready" (D105) — two taps on the SAME note (E6), the counter
 *   service-bell everyone already understands as "order up".
 *
 * Browsers block audio until the user has interacted with the page. On a
 * terminal that is being worked this is already satisfied; on a freshly
 * opened, untouched tab the chime is skipped rather than queued — a burst of
 * stale dings on the first tap would be worse than a missed one. Audio is
 * best-effort throughout: no failure here may ever break the screen using it.
 */

let ctx: AudioContext | null = null;

function play(sound: (c: AudioContext) => void): void {
  if (typeof window === 'undefined') return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // jsdom and old WebViews: no audio, no error
    ctx ??= new Ctor();
    const c = ctx;
    if (c.state === 'running') {
      sound(c);
    } else {
      // Suspended until a user gesture. Try once; if the browser still says
      // no, drop this chime instead of scheduling tones that would all fire
      // together whenever the context finally resumes.
      void c
        .resume()
        .then(() => {
          if (c.state === 'running') sound(c);
        })
        .catch(() => undefined);
    }
  } catch {
    // Best-effort by design (see header).
  }
}

export function playNewOrderChime(): void {
  play(ring);
}

/** D105 — the waiter's "order up" bell. */
export function playFoodReadyChime(): void {
  play(bell);
}

function note(c: AudioContext, freq: number, at: number): void {
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Exponential ramps, not linear — a linear cut clicks audibly at the end.
  gain.gain.setValueAtTime(0.0001, t0 + at);
  gain.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0 + at);
  osc.stop(t0 + at + 0.4);
}

/** Two ascending sine notes, ~0.55 s total — well inside the 8 s poll. */
function ring(c: AudioContext): void {
  note(c, 880, 0); // A5
  note(c, 1174.66, 0.18); // D6 — the rise is what reads as "incoming"
}

/** Two taps on one note, ~0.6 s — the flat repeat is what reads as a bell. */
function bell(c: AudioContext): void {
  note(c, 1318.51, 0); // E6
  note(c, 1318.51, 0.22);
}
