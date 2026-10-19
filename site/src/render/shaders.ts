export const displayVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

/**
 * White page. The archive only exists inside a fluid boundary:
 *   reveal = halo disc  +  ink the pointer leaves behind (real Stable Fluids density)
 * The boundary is an ink edge (thresholded density), and the photograph itself
 * is carried by the flow there: refracted by the density gradient and dragged
 * along the velocity, so the image smears into the white like pigment.
 * No overlay, no chroma, no tint.
 */
export const displayFrag = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform sampler2D uBlend;
uniform sampler2D uFadeFlag;
uniform float uMix;
uniform sampler2D uFluid;
uniform sampler2D uVelocity;
uniform float uTime;
uniform vec2 uGrid;
uniform vec2 uView;
uniform vec2 uPad;
uniform vec2 uFocusPan;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform vec2 uPointer;
uniform float uLensRadius;
uniform float uEnabled;
uniform float uDistort;
uniform float uInk;
uniform float uSoft;
uniform float uFloor;
uniform float uTile;
uniform float uStage;
uniform float uBlendMode;
uniform float uCustom;
uniform float uDiscCover;
uniform float uFocus;
uniform float uNameOn;
uniform sampler2D uNamePlate;
uniform vec3 uNameAvg;
uniform vec3 uNamePop;
uniform vec2 uNameSpan;
uniform sampler2D uKlein;
varying vec2 vUv;

vec3 applyBlend(vec3 base, vec3 src) {
  // Custom: the bottle photo stays the picture. Lighten only brightens it on the
  // white page; exclusion is a thin tint on the black page.
  if (uCustom > 0.5) {
    if (uStage > 0.5) {
      vec3 excl = src + base - 2.0 * src * base;
      return mix(src, excl, 0.22);
    }
    return mix(src, max(src, base), 0.35);
  }
  if (uBlendMode < 0.5) return max(base, src);
  if (uBlendMode < 1.5) return abs(base - src);
  if (uBlendMode < 2.5) return vec3(1.0) - (vec3(1.0) - base) * (vec3(1.0) - src);
  if (uBlendMode < 3.5) return base * src;
  return base + src - 2.0 * base * src;
}

// uGrid is whole atlas cells; uView is how many square cells the screen spans
// (fractional). The view is centred, so partial cells sit evenly at both edges.
vec2 atlasMap(vec2 screenUv) {
  vec2 atlas = uGrid + uPad * 2.0;
  return (uPad + (uGrid - uView) * 0.5 + screenUv * uView) / atlas;
}

// The atlas only changes under the white (hidden-cell swaps) or through one slow,
// eased cross-fade that runs after the pointer settles. Only the cells flagged in
// uFadeFlag blend toward uBlend; every other cell is read straight from uAtlas.
vec3 sampleAtlas(vec2 uv) {
  vec3 a = texture2D(uAtlas, uv).rgb;
  if (uMix > 0.0) {
    vec2 atlas = uGrid + uPad * 2.0;
    float f = texture2D(uFadeFlag, (floor(uv * atlas) + 0.5) / atlas).r;
    if (f > 0.5) a = mix(a, texture2D(uBlend, uv).rgb, uMix);
  }
  return a;
}

void main() {
  vec2 atlas = uGrid + uPad * 2.0;
  vec2 base = atlasMap(vUv + uFocusPan);

  // stay inside painted pad cells
  vec2 lo = (uPad * 0.2) / atlas;
  vec2 hi = 1.0 - lo;

  if (uEnabled < 0.5) {
    gl_FragColor = vec4(sampleAtlas(clamp(base, lo, hi)), 1.0);
    return;
  }

  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 q = (vUv - uPointer) * vec2(aspect, 1.0);
  float dist = length(q);
  float lens = uLensRadius;

  // ---- fluid field -------------------------------------------------
  // Wide two-ring blur: nearby blobs merge with rounded necks (gooey),
  // and thin low-density filaments survive (wispy).
  float d0 = texture2D(uFluid, vUv).b;
  float acc = d0 * 0.16;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    vec2 dir = vec2(cos(a), sin(a));
    acc += texture2D(uFluid, vUv + dir * uTexel * 2.5).b * 0.06;
    acc += texture2D(uFluid, vUv + dir * uTexel * 6.0).b * 0.045;
  }
  // Thin end-of-life ink is dropped sooner: dense parts of the wake keep their full
  // lifetime, wisps bleed away faster. (Gradients below still use the raw density.)
  float dens = max(acc - uFloor, 0.0);
  float dL = texture2D(uFluid, vUv - vec2(uTexel.x * 3.0, 0.0)).b;
  float dR = texture2D(uFluid, vUv + vec2(uTexel.x * 3.0, 0.0)).b;
  float dD = texture2D(uFluid, vUv - vec2(0.0, uTexel.y * 3.0)).b;
  float dU = texture2D(uFluid, vUv + vec2(0.0, uTexel.y * 3.0)).b;
  vec2 grad = vec2(dR - dL, dU - dD);
  vec2 vel = texture2D(uVelocity, vUv).xy;
  vec2 vdir = vel / (24.0 + length(vel)); // soft-limited, |.| < 1

  // ---- reveal: halo + ink, thresholded into a liquid edge ---------
  float halo = 1.0 - smoothstep(0.62 * lens, 1.0 * lens, dist);
  float ink = 1.0 - exp(-dens * uInk);
  float field = halo + ink * 0.95;
  // Edge softness. The halo keeps its crisp rim and the dense core of the wake keeps its
  // body (upper bound barely moves), but wherever the edge is made of *ink* the lower
  // bound slides far out, so thin wisps fade into the white through a translucent skirt
  // instead of shrinking into hard-edged slivers that pop out of existence.
  float inkShare = clamp(ink * 0.95 / max(field, 0.001), 0.0, 1.0);
  float soft = inkShare * inkShare;
  float mask = smoothstep(0.44 - uSoft * 0.23 * soft, 0.58 + uSoft * 0.04 * soft, field);
  float edge = 4.0 * mask * (1.0 - mask);

  // ---- carry the picture with the flow (strongest at the boundary) ---
  float cell = 1.0 / max(uView.x, uView.y);
  vec2 push = grad * (0.9 * uDistort) + vdir * (0.55 * cell * uDistort);
  push *= 0.25 + 0.75 * min(1.0, edge * 1.6 + ink);
  float pl = length(push);
  float maxPush = cell * 0.7;
  if (pl > maxPush) push *= maxPush / pl;
  vec2 pushAtlas = push * (uView / atlas);

  vec2 uvW = clamp(base - pushAtlas, lo, hi);
  vec3 col = sampleAtlas(uvW) * 0.4;
  col += sampleAtlas(clamp(uvW - pushAtlas * 0.5, lo, hi)) * 0.3;
  col += sampleAtlas(clamp(uvW - pushAtlas * 1.0, lo, hi)) * 0.2;
  col += sampleAtlas(clamp(uvW - pushAtlas * 1.6, lo, hi)) * 0.1;

  // crisp inside, dragged at the edge
  vec3 sharp = sampleAtlas(clamp(base, lo, hi));
  vec3 img = mix(sharp, col, clamp(edge * 1.2 + ink * 0.35, 0.0, 1.0));

  // uStage 1: the grid stays up, and the bottle blends over it.
  // uStage 0: the page is white, and that composite lives only inside the cursor.
  // The orb itself stays one cell wide. While the pointer is moving, a soft halo
  // around it also hides the bottle overlay; uFocus grows that halo with speed.
  // The long tails stay blended. Once settled, uDiscCover eases back to 1 and the
  // overlay covers the orb again.
  vec3 revealed = img;
  vec3 outside = vec3(1.0);
  if (uTile > 0.5) {
    vec3 mixed = applyBlend(img, texture2D(uKlein, vUv).rgb);
    float disc = 1.0 - smoothstep(0.42 * lens, 1.08 * lens, dist);
    float reach = lens * (1.15 + uFocus * 2.6);
    float haloBleed = 1.0 - smoothstep(0.7 * lens, reach, dist);
    float pierce = max(disc, haloBleed * smoothstep(0.08, 0.55, uFocus)) * (1.0 - uDiscCover);
    revealed = mix(mixed, img, pierce);
    outside = uStage > 0.5 ? mixed : vec3(1.0);
  }
  vec3 color = mix(revealed, outside, 1.0 - mask);

  // The name runs upward from the photo's average to its most saturated color.
  // A thin ring just outside the strokes is a clear window onto the photograph.
  if (uNameOn > 0.5) {
    float glyph = texture2D(uNamePlate, vUv).r;
    float fill = smoothstep(0.2, 0.8, glyph);
    vec2 px = 1.6 / uResolution;
    float neigh = glyph;
    neigh = max(neigh, texture2D(uNamePlate, vUv + vec2(px.x, 0.0)).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv - vec2(px.x, 0.0)).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv + vec2(0.0, px.y)).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv - vec2(0.0, px.y)).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv + px).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv - px).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv + vec2(px.x, -px.y)).r);
    neigh = max(neigh, texture2D(uNamePlate, vUv + vec2(-px.x, px.y)).r);
    float outline = smoothstep(0.2, 0.8, neigh) * (1.0 - fill);
    float covered = smoothstep(0.18, 0.5, mask);
    float t = clamp((vUv.y - uNameSpan.x) / max(uNameSpan.y - uNameSpan.x, 1e-4), 0.0, 1.0);
    vec3 inkColor = mix(uNameAvg, uNamePop, t);
    color = mix(inkColor, color, max(1.0 - fill, covered));
    color = mix(color, sharp, outline);
  }
  gl_FragColor = vec4(color, 1.0);
}
`

/**
 * Visibility pass (tiny render target, read back on the CPU).
 * One output pixel group per atlas cell: "how much of this cell can currently be
 * seen through the halo or the ink tail?" Same field as the display shader's
 * reveal, evaluated where each atlas cell sits on screen (including focus pan).
 * Cells that are off-screen read 0.
 */
export const visibilityFrag = /* glsl */ `
precision highp float;
uniform sampler2D uFluid;
uniform vec2 uGrid;
uniform vec2 uView;
uniform vec2 uPad;
uniform vec2 uFocusPan;
uniform vec2 uResolution;
uniform vec2 uTexel;
uniform vec2 uPointer;
uniform float uLensRadius;
uniform float uInk;
uniform float uFloor;
varying vec2 vUv;

void main() {
  vec2 atlas = uGrid + uPad * 2.0;
  // screen position of this atlas sample (inverse of the display shader's atlasMap)
  vec2 s = (vUv * atlas - uPad - (uGrid - uView) * 0.5) / uView - uFocusPan;

  float onScreen = step(0.0, s.x) * step(s.x, 1.0) * step(0.0, s.y) * step(s.y, 1.0);

  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 q = (s - uPointer) * vec2(aspect, 1.0);
  float halo = 1.0 - smoothstep(0.62 * uLensRadius, 1.0 * uLensRadius, length(q));

  vec2 c = clamp(s, 0.0, 1.0);
  float dens = texture2D(uFluid, c).b;
  dens = max(dens, texture2D(uFluid, c + vec2(uTexel.x * 6.0, 0.0)).b);
  dens = max(dens, texture2D(uFluid, c - vec2(uTexel.x * 6.0, 0.0)).b);
  dens = max(dens, texture2D(uFluid, c + vec2(0.0, uTexel.y * 6.0)).b);
  dens = max(dens, texture2D(uFluid, c - vec2(0.0, uTexel.y * 6.0)).b);
  dens = max(dens - uFloor, 0.0);
  float ink = 1.0 - exp(-dens * uInk);

  float field = clamp(halo + ink * 0.95, 0.0, 1.0) * onScreen;
  gl_FragColor = vec4(field, 0.0, 0.0, 1.0);
}
`

export const transitionVert = displayVert
export const atmosphereVert = displayVert
export const transitionFrag = displayFrag
export const atmosphereFrag = displayFrag
