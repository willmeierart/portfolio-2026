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
uniform sampler2D uTileFrom;
uniform sampler2D uTileTo;
uniform float uTileMix;
uniform vec2 uSphere;
varying vec2 vUv;

vec2 atlasMap(vec2 screenUv) {
  vec2 atlas = uGrid + uPad * 2.0;
  return (uPad + screenUv * uGrid) / atlas;
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

// Soften the sphere picture. It is magnified across the view, so a small gaussian
// in texture space keeps the blown-up edges from sparkling.
vec3 blurTile(sampler2D tex, vec2 uv) {
  vec2 s = vec2(2.4 / 256.0);
  vec3 c = texture2D(tex, uv).rgb * 0.250;
  c += texture2D(tex, uv + vec2(s.x, 0.0)).rgb * 0.125;
  c += texture2D(tex, uv - vec2(s.x, 0.0)).rgb * 0.125;
  c += texture2D(tex, uv + vec2(0.0, s.y)).rgb * 0.125;
  c += texture2D(tex, uv - vec2(0.0, s.y)).rgb * 0.125;
  c += texture2D(tex, uv + s).rgb * 0.0625;
  c += texture2D(tex, uv - s).rgb * 0.0625;
  c += texture2D(tex, uv + vec2(s.x, -s.y)).rgb * 0.0625;
  c += texture2D(tex, uv + vec2(-s.x, s.y)).rgb * 0.0625;
  return c;
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
  float cell = 1.0 / max(uGrid.x, uGrid.y);
  vec2 push = grad * (0.9 * uDistort) + vdir * (0.55 * cell * uDistort);
  push *= 0.25 + 0.75 * min(1.0, edge * 1.6 + ink);
  float pl = length(push);
  float maxPush = cell * 0.7;
  if (pl > maxPush) push *= maxPush / pl;
  vec2 pushAtlas = push * (uGrid / atlas);

  vec2 uvW = clamp(base - pushAtlas, lo, hi);
  vec3 col = sampleAtlas(uvW) * 0.4;
  col += sampleAtlas(clamp(uvW - pushAtlas * 0.5, lo, hi)) * 0.3;
  col += sampleAtlas(clamp(uvW - pushAtlas * 1.0, lo, hi)) * 0.2;
  col += sampleAtlas(clamp(uvW - pushAtlas * 1.6, lo, hi)) * 0.1;

  // crisp inside, dragged at the edge
  vec3 sharp = sampleAtlas(clamp(base, lo, hi));
  vec3 img = mix(sharp, col, clamp(edge * 1.2 + ink * 0.35, 0.0, 1.0));

  // Inside a sphere that covers the view. uSphere rolls it; the settled picture is on
  // the inside and eases into the next settled picture.
  vec3 background = vec3(1.0);
  if (uTile > 0.5) {
    vec2 ndc = vUv * 2.0 - 1.0;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec3 rd = normalize(vec3(ndc.x * aspect, ndc.y, -1.35));
    float yaw = uSphere.x;
    float pitch = uSphere.y;
    float cy = cos(yaw);
    float sy = sin(yaw);
    float cp = cos(pitch);
    float sp = sin(pitch);
    rd = vec3(cy * rd.x + sy * rd.z, rd.y, -sy * rd.x + cy * rd.z);
    rd = vec3(rd.x, cp * rd.y - sp * rd.z, sp * rd.y + cp * rd.z);
    float lon = atan(rd.x, -rd.z);
    float lat = asin(clamp(rd.y, -1.0, 1.0));
    vec2 local = vec2(lon * 1.65, lat * 2.4) + 0.5;
    background = mix(blurTile(uTileFrom, local), blurTile(uTileTo, local), uTileMix);
  }

  gl_FragColor = vec4(mix(img, background, 1.0 - mask), 1.0);
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
  vec2 s = (vUv * atlas - uPad) / uGrid - uFocusPan;

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
