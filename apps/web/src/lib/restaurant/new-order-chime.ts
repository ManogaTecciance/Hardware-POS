/**
 * The audible "new order" chime for live queue screens.
 *
 * Synthesised with Web Audio rather than shipped as an asset: two short sine
 * tones need no file to bundle and no network fetch on a POS terminal. The
 * sound is a rising two-note ding — the shape mainstream POS/KDS products use
 * for "something arrived", so staff who have worked other tills recognise it
 * without being told.
 *
 * Browsers block audio until the user has interacted with the page. On a
 * terminal that is being worked this is already satisfied; on a freshly
 * opened, untouched tab the chime is skipped rather than queued — a burst of
 * stale dings on the first tap would be worse than a missed one. Audio is
 * best-effort throughout: no failure here may ever break the queue.
 */

let ctx: AudioContext | null = null;

export function playNewOrderChime(): void {
  if (typeof window === 'undefined') return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // jsdom and old WebViews: no audio, no error
    ctx ??= new Ctor();
    const c = ctx;
    if (c.state === 'running') {
      ring(c);
    } else {
      // Suspended until a user gesture. Try once; if the browser still says
      // no, drop this chime instead of scheduling tones that would all fire
      // together whenever the context finally resumes.
      void c
        .resume()
        .then(() => {
          if (c.state === 'running') ring(c);
        })
        .catch(() => undefined);
    }
  } catch {
    // Best-effort by design (see header).
  }
}

/** Two ascending sine notes, ~0.55 s total — well inside the 8 s poll. */
function ring(c: AudioContext): void {
  const t0 = c.currentTime;
  const note = (freq: number, at: number) => {
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
  };
  note(880, 0); // A5
  note(1174.66, 0.18); // D6 — the rise is what reads as "incoming"
}
