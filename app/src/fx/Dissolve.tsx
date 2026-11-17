// "Turn to dust": what a view draws breaks into small particles that sweep
// away left to right, drift up, grey out and fade (as a cancelled voice
// message does in some chat apps). Used when a message or a bot is deleted.
import type { AnimatedValue, JSX } from "nsh";
import { createAnimatedValue, shadersAvailable, ShaderEffect, View } from "nsh";

/** How far particles fly beyond the view, in points. */
const REACH = 90;

// nsh.progress goes 0 → 1. Each source cell of CELL points starts moving
// when the sweep reaches it (by its x, with some noise), then accelerates
// up and sideways, shrinks and fades. The shader draws each output point by
// walking back from it to the cell that would land there (a few fixed-point
// steps), so it needs no particle buffer.
const WGSL = /* wgsl */ `
const CELL: f32 = 2.5;

fn hash(p: vec2f, k: f32) -> f32 {
  return fract(sin(dot(p, vec2f(127.1 + k, 311.7 - k))) * 43758.5453);
}

fn start_of(c: vec2f, size: vec2f) -> f32 {
  let x = (c.x * CELL) / max(size.x, 1.0);
  return x * 0.55 + hash(c, 0.0) * 0.3;
}

fn local_t(c: vec2f, size: vec2f, prog: f32) -> f32 {
  return clamp((prog - start_of(c, size)) / 0.45, 0.0, 1.0);
}

fn offset(c: vec2f, t: f32) -> vec2f {
  let e = t * t;
  let dx = (hash(c, 1.0) - 0.25) * 70.0;
  let dy = -(25.0 + hash(c, 2.0) * 65.0);
  return vec2f(dx, dy) * e;
}

fn shade(uv: vec2f) -> vec4f {
  let size = nsh.size;
  let prog = nsh.progress;
  if (prog <= 0.0) {
    return sample_content(uv);
  }
  let p = uv * size;
  // Find the source cell whose particle lands on p.
  var s = p;
  var c = floor(s / CELL);
  var t = 0.0;
  for (var i = 0; i < 4; i = i + 1) {
    c = floor(s / CELL);
    t = local_t(c, size, prog);
    s = p - offset(c, t);
  }
  c = floor(s / CELL);
  t = local_t(c, size, prog);
  if (t <= 0.0) {
    return sample_content(uv);
  }
  let landed = (c + 0.5) * CELL + offset(c, t);
  let radius = CELL * 0.5 * (1.0 - 0.6 * t);
  if (max(abs(p.x - landed.x), abs(p.y - landed.y)) > radius) {
    return vec4f(0.0);
  }
  let src = sample_content(((c + 0.5) * CELL) / size);
  let grey = dot(src.rgb, vec3f(0.299, 0.587, 0.114));
  let rgb = mix(src.rgb, vec3f(mix(grey, 0.85, 0.5)), min(t * 1.6, 1.0));
  return vec4f(rgb, src.a * (1.0 - t));
}
`;

/** A progress value to pass to `Dissolve` and a function that plays it once. */
export function createDissolve(): { progress: AnimatedValue; play: () => Promise<void> } {
  const progress = createAnimatedValue(0);
  return {
    progress,
    play: async () => {
      await progress.timing(1, { duration: shadersAvailable() ? 950 : 280 });
    },
  };
}

/**
 * Draws its children normally until `active`, then through the dust shader
 * as `progress` runs 0 → 1. Without shaders it fades and shrinks instead.
 */
export function Dissolve(props: { active: boolean; progress: AnimatedValue; children: JSX.Element; style?: Record<string, unknown> }) {
  return (
    <If
      when={shadersAvailable()}
      else={
        <View
          style={{
            ...(props.style ?? {}),
            opacity: props.active ? (props.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) as never) : 1,
            scale: props.active ? (props.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] }) as never) : 1,
          } as never}
        >
          {props.children}
        </View>
      }
    >
      <ShaderEffect
        source={props.active ? WGSL : undefined}
        progress={props.progress}
        maxSampleOffset={REACH}
        style={(props.style ?? {}) as never}
      >
        {props.children}
      </ShaderEffect>
    </If>
  );
}
