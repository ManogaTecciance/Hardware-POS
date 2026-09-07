/**
 * The kitchen board's new-ticket chime — a RISING two-note ding (A5→D6),
 * the shape mainstream KDS products use for "something arrived".
 *
 * D111 (PO): the KITCHEN is the only screen that makes sound. The orders
 * queue's arrival chime and the D105/D107 food-ready bell were removed —
 * those screens inform visually (badges, tabs, counts). This module stays
 * the single home for POS audio should any of it be invited back.
 *
 * Synthesised with Web Audio rather than shipped as an asset: short sine
 * tones need no file to bundle and no network fetch on a POS terminal.
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

/** Two ascending sine notes, ~0.55 s total — well inside the 5 s poll. */
function ring(c: AudioContext): void {
  note(c, 880, 0); // A5
  note(c, 1174.66, 0.18); // D6 — the rise is what reads as "incoming"
}
