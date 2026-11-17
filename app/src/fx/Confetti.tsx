// A burst of confetti from the two bottom corners, for a moment of success
// (a bot was created). It draws over the page, takes no presses and goes
// away by itself after about three seconds.
//
// Each piece is a small View moved by the native animation graph: one clock
// value runs 0 → DURATION, and every piece's position, turn and fade are
// interpolations of it, sampled from the closed-form throw below. Nothing
// runs in JS per frame.
import { cleanup, createAnimatedValue, reduceMotion, signal, View } from "nsh";

const COLORS = ["#ff5a36", "#0a6ed1", "#1a9e6e", "#ffb02e", "#6741d9", "#c2255c"];
const DURATION = 3.2; // s
const GRAVITY = 1100; // points / s²
const K = 1.6; // air drag, 1/s
const PER_CORNER = 60;
const SAMPLES = 24; // keyframes per path

interface Piece {
  side: number; // -1 the left corner, 1 the right
  vx: number;
  vy: number;
  turn0: number; // degrees
  spin: number; // degrees / s
  w: number;
  h: number;
  color: string;
}

function pieces(): Piece[] {
  const out: Piece[] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < PER_CORNER; i++) {
      out.push({
        side,
        // Up and inwards: the left corner shoots right, the right one left.
        vx: -side * (180 + Math.random() * 620),
        vy: -(1100 + Math.random() * 900),
        turn0: Math.random() * 360,
        spin: (Math.random() - 0.5) * 800,
        w: 6 + Math.random() * 6,
        h: 9 + Math.random() * 8,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
  }
  return out;
}

/**
 * How far a piece is from its corner `t` seconds after launch: a throw with
 * linear air drag (dv/dt = g − K·v, y pointing down), whose velocity tends to
 * the terminal g/K: y = (g/K)·t + (v₀ − g/K)·(1 − e^(−K·t))/K.
 */
export function offset(p: { vx: number; vy: number }, t: number) {
  const decay = (1 - Math.exp(-K * t)) / K;
  const terminal = GRAVITY / K;
  return { x: p.vx * decay, y: terminal * t + (p.vy - terminal) * decay };
}

/** Fires once when mounted. With reduced motion it shows nothing. */
export function Confetti() {
  if (reduceMotion()) return <View />;
  const clock = createAnimatedValue(0);
  const done = signal(false);
  // Start once the pieces are on screen and bound to the clock (an animation
  // started before that would jump to its end), and remove them after.
  const raf = requestAnimationFrame(() => void clock.timing(DURATION, { duration: DURATION * 1000, easing: "linear" }));
  const timer = setTimeout(() => done.set(true), DURATION * 1000 + 100);
  cleanup(() => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
  });

  const times = Array.from({ length: SAMPLES + 1 }, (_, i) => (DURATION * i) / SAMPLES);
  const fade = clock.interpolate({ inputRange: [0, DURATION - 0.7, DURATION], outputRange: [1, 1, 0] });

  return (
    <If when={!done()}>
      <View testID="confetti" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        {pieces().map((p) => {
          const path = times.map((t) => offset(p, t));
          const x = clock.interpolate({ inputRange: times, outputRange: path.map((q) => q.x - p.w / 2) });
          const y = clock.interpolate({ inputRange: times, outputRange: path.map((q) => q.y - p.h / 2) });
          const turn = clock.interpolate({ inputRange: [0, DURATION], outputRange: [`${p.turn0}deg`, `${p.turn0 + p.spin * DURATION}deg`] });
          return (
            <View
              style={{
                // Anchored at its corner of the page; the throw is relative to it.
                position: "absolute", left: p.side < 0 ? 0 : "100%", top: "100%", width: p.w, height: p.h, borderRadius: 1.5,
                backgroundColor: p.color, translate: [x, y], rotate: turn, opacity: fade,
              }}
            />
          );
        })}
      </View>
    </If>
  );
}
