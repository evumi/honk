// "Turn to dust": what a view draws breaks into small particles that sweep
// away left to right, drift up, grey out and fade (as a cancelled voice
// message does in some chat apps). Used when a message or a bot is deleted.
import type { AnimatedValue, JSX } from "nsh";
import { createAnimatedValue, shadersAvailable, ShaderEffect, View } from "nsh";

/** How far particles fly beyond the view, in points. */
const REACH = 110;

// nsh.progress goes 0 → 1. The view is cut into CELL-point grains, dealt
// at random into LAYERS groups. A sweep crosses the view left to right; each
// group follows it with its own delay and flies its own way (up, and left or
// right), so neighbouring grains part. Within a group the motion depends on x
// only and smoothly, so the shader can walk back from each output point to
// the grain that lands there (a few fixed-point steps) and needs no particle
// buffer. Grains shrink, grey and fade as they go.
const WGSL = /* wgsl */ `
const CELL: f32 = 2.5;
const LAYERS: i32 = 6;

fn hash(p: vec2f, k: f32) -> f32 {
  return fract(sin(dot(p, vec2f(127.1 + k, 311.7 - k))) * 43758.5453);
}

fn layer_of(c: vec2f) -> i32 {
  return i32(floor(hash(c, 7.0) * f32(LAYERS)));
}

fn velocity(j: i32) -> vec2f {
  let k = vec2f(f32(j), 3.0);
  return vec2f((hash(k, 1.0) - 0.35) * 90.0, -(35.0 + hash(k, 2.0) * 65.0));
}

// How far grain group j at x has gone, 0 → 1.
fn local_t(x: f32, j: i32, size: vec2f, prog: f32) -> f32 {
  let start = x / max(size.x, 260.0) * 0.5 + hash(vec2f(f32(j), 9.0), 3.0) * 0.25;
  return clamp((prog - start) / 0.5, 0.0, 1.0);
}

fn ease(t: f32) -> f32 {
  return 1.0 - (1.0 - t) * (1.0 - t);
}

fn shade(uv: vec2f) -> vec4f {
  let size = nsh.size;
  let prog = nsh.progress;
  if (prog <= 0.0) {
    return sample_content(uv);
  }
  let p = uv * size;
  for (var j = 0; j < LAYERS; j = j + 1) {
    let v = velocity(j);
    // Find where a grain of this group that lands on p started.
    var s = p;
    for (var i = 0; i < 6; i = i + 1) {
      s = p - v * ease(local_t(s.x, j, size, prog));
    }
    let c = floor(s / CELL);
    if (layer_of(c) != j || s.x < 0.0 || s.y < 0.0 || s.x >= size.x || s.y >= size.y) {
      continue;
    }
    let home = (c + 0.5) * CELL;
    let t = local_t(home.x, j, size, prog);
    if (t <= 0.0) {
      continue;
    }
    let landed = home + v * ease(t);
    let radius = CELL * 0.5 * (1.0 - 0.45 * t);
    if (max(abs(p.x - landed.x), abs(p.y - landed.y)) > radius) {
      continue;
    }
    let src = sample_content(home / size);
    if (src.a <= 0.01) {
      continue;
    }
    let grey = dot(src.rgb, vec3f(0.299, 0.587, 0.114));
    let rgb = mix(src.rgb, vec3f(mix(grey, 0.5, 0.6)), min(t * 2.0, 1.0));
    return vec4f(rgb, src.a * (1.0 - t * t));
  }
  // Not a flying grain: the view itself where its grain has not left yet.
  let c = floor(p / CELL);
  if (local_t((c.x + 0.5) * CELL, layer_of(c), size, prog) <= 0.0) {
    return sample_content(uv);
  }
  return vec4f(0.0);
}
`;

/** A progress value to pass to `Dissolve`, a function that plays it once and one that rewinds it. */
export function createDissolve(): { progress: AnimatedValue; play: () => Promise<void>; reset: () => void } {
  const progress = createAnimatedValue(0);
  return {
    progress,
    play: async () => {
      await progress.timing(1, { duration: shadersAvailable() ? 950 : 280 });
    },
    reset: () => void progress.timing(0, { duration: 0 }),
  };
}

/**
 * Draws its children normally until `active`, then through the dust shader
 * as `progress` runs 0 → 1. Without shaders it fades and shrinks instead.
 * Rows stay plain Views until then, so a long list pays nothing for it.
 */
export function Dissolve(props: { active: boolean; progress: AnimatedValue; children: JSX.Element; style?: Record<string, unknown> }) {
  const style = props.style ?? {};
  if (!shadersAvailable()) {
    const opacity = props.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
    const scale = props.progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.92] });
    return <View style={{ ...style, opacity: opacity as never, scale: scale as never } as never}>{props.children}</View>;
  }
  return (
    <If when={props.active} else={<View style={style as never}>{props.children}</View>}>
      <ShaderEffect source={WGSL} progress={props.progress} maxSampleOffset={REACH} style={style as never}>
        {props.children}
      </ShaderEffect>
    </If>
  );
}
