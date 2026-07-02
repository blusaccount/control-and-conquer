/**
 * Short, procedurally-synthesized sound effects — deliberately not audio
 * files, so there is nothing to source or license. OpenFront gives every
 * expand, alliance, and match-end a distinct audible cue; we approximate that
 * feedback with a handful of oscillator blips through the Web Audio API.
 *
 * Enabled by default; togglable from the settings gear (see `settings.ts`)
 * and persisted like every other preference there.
 */

let ctx: AudioContext | null = null;
let enabled = true;

/** Toggle whether `sfx.*` calls actually produce sound. */
export const setSoundEnabled = (value: boolean): void => {
  enabled = value;
};

/**
 * Lazily create the shared AudioContext. Browsers require a user gesture
 * before audio can play; every `sfx.*` call in this codebase happens inside a
 * click handler, so creating it on first use is always gesture-backed.
 */
const audioContext = (): AudioContext | null => {
  if (!enabled) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
};

/** One short tone: a sine blip with an exponential decay envelope. */
const tone = (freq: number, startDelay: number, duration: number, peakGain: number): void => {
  const audio = audioContext();
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t0 = audio.currentTime + startDelay;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
};

export const sfx = {
  /** A click that successfully commits an expand or build order. */
  click: (): void => tone(660, 0, 0.09, 0.12),
  /** An alliance offer accepted (either side). */
  allyAccepted: (): void => {
    tone(523.25, 0, 0.12, 0.1);
    tone(783.99, 0.06, 0.16, 0.1);
  },
  /** The run ended in victory. */
  victory: (): void => {
    tone(523.25, 0, 0.16, 0.14);
    tone(659.25, 0.12, 0.16, 0.14);
    tone(783.99, 0.24, 0.3, 0.14);
  },
  /** The run ended in defeat or elimination. */
  defeat: (): void => {
    tone(311.13, 0, 0.22, 0.12);
    tone(233.08, 0.16, 0.35, 0.12);
  },
  /** An Atom Bomb launch — a rising whoosh as the missile clears the silo. */
  nukeLaunch: (): void => {
    tone(180, 0, 0.05, 0.05);
    tone(420, 0.03, 0.12, 0.1);
  },
  /** An Atom Bomb detonation — a low, heavy boom. */
  nukeDetonate: (): void => {
    tone(55, 0, 0.5, 0.22);
    tone(90, 0, 0.35, 0.16);
  },
  /** A SAM Launcher shooting down an incoming warhead — a quick falling fizzle. */
  nukeIntercepted: (): void => {
    tone(900, 0, 0.08, 0.1);
    tone(500, 0.05, 0.14, 0.09);
  },
};
