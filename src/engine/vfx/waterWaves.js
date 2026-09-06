import { float } from 'three/tsl';

export const WATER_WAVE_DEFAULTS = Object.freeze({waveHeight:.15,waveLength:4,waveDirection:0,waveSpeed:2,choppiness:.35,rippleStrength:.25});
// ── THE SPECTRUM ────────────────────────────────────────────────────────────
//
// Eight bands, not five. Complexity in a wave field is INTERFERENCE, and
// interference needs components close enough in scale and spread enough in
// direction to beat against each other; five widely-separated bands read as
// three obvious waves crossing. The angles fan across the full circle, the
// wavelengths fall by roughly a third each step, and the speeds are
// incommensurate so no pattern ever recurs.
//
// Amplitudes hold steepness roughly constant across scales (a/λ ~ 0.2-0.45),
// which is what a real wind sea does, and sum to the same 1.1 the five-band
// table did — so `waveHeight` still means what it meant. Anything the grid
// cannot carry is faded out by `bandGain` rather than aliased.
//
// [direction, wavelength fraction, amplitude, speed fraction, phase]
const BANDS = [
  [0,1,.45,1,0], [.71,.613,.195,1.173,1.9], [2.6,.78,.14,1.07,3.3],
  [-1.45,.42,.11,1.41,5.2], [-.94,.287,.08,1.731,4.1], [.35,.19,.062,2.05,1.4],
  [1.83,.113,.047,2.417,.7], [-2.16,.057,.025,3.139,2.6],
];
const clamp01=v=>Math.min(1,Math.max(0,v));
/** Octaves of detail noise the ladder runs. A ceiling: the grid's Nyquist
 *  fade silences whatever it cannot carry. */
export const MAX_OCTAVES=8;
/** How many bands are live, faded at the last one so the count is not a step. */
const octaveGain=(op,i,p)=>op.clamp01(op.add(p.waveOctaves??4,-i));
const scalar={add:(a,b)=>a+b,mul:(a,b)=>a*b,div:(a,b)=>a/b,sin:Math.sin,floor:Math.floor,max:(a,b)=>Math.max(a,b),clamp01};
const shader={add:(a,b)=>float(a).add(b),mul:(a,b)=>float(a).mul(b),div:(a,b)=>float(a).div(b),sin:a=>float(a).sin(),floor:a=>float(a).floor(),
  max:(a,b)=>float(a).max(b),clamp01:v=>float(v).clamp(0,1)};
function valueNoise(x,z,op) {
  const {add,mul,div,floor}=op;
  const mod289=v=>add(v,mul(floor(div(v,289)),-289));
  // Integer-valued polynomial hashing stays below f32's exact integer range;
  // CPU buoyancy and WGSL cannot disagree through a chaotic sin/fract hash.
  const permute=v=>mod289(mul(add(mul(v,34),1),v));
  const ix=floor(x),iz=floor(z),fx=add(x,mul(ix,-1)),fz=add(z,mul(iz,-1));
  const ux=mul(mul(fx,fx),add(3,mul(fx,-2))),uz=mul(mul(fz,fz),add(3,mul(fz,-2)));
  const hash=(a,b)=>div(permute(mod289(add(permute(mod289(a)),b))),289);
  const lerp=(a,b,t)=>add(a,mul(add(b,mul(a,-1)),t));
  return lerp(lerp(hash(ix,iz),hash(add(ix,1),iz),ux),lerp(hash(ix,add(iz,1)),hash(add(ix,1),add(iz,1)),ux),uz);
}
/**
 * ⛔ A BAND FINER THAN THE GRID IS NOISE, NOT DETAIL.
 *
 * The last two bands are wind ripples at 0.113 and 0.057 of the base
 * wavelength, so on a 40 m pool authored with a 10 m swell they are 1.1 m and
 * 0.57 m — and the solver's cells are 0.6 m wide. The heightfield cannot carry
 * either: they come back as per-vertex jitter, which is a garbage NORMAL, and a
 * garbage normal is a scrambled reflection, a caustic lens made of noise, and a
 * surface that reads as boiling however well the solver behaves. The Nyquist
 * clamp on `waveLength` protected the BASE wavelength and said nothing about
 * the bands built from it.
 *
 * A band fades out as its own wavelength approaches the cutoff (three cells)
 * rather than being cut off, so changing resolution moves detail in and out
 * smoothly instead of popping it. `cutoff = 0` disables the whole test, which
 * is what the CPU parity fixtures and the buoyancy query use when they have no
 * grid to speak of.
 */
// ⛔ AND THE FADE MUST REACH ONE **AT** THE CUTOFF, NOT ZERO.
//
// `gridSimulation`'s tick clamps `waveLength` up to three cells so a pool is
// never asked for waves its grid cannot carry — and publishes that same three
// cells as the cutoff. With a plain `λ/cutoff − 1` the base band then lands
// EXACTLY on the zero of the fade, so any water authored below the clamp lost
// every band and went dead flat: "the water surface is still wrong, it looks
// grey and transparent, it lost color and reflectiveness" (user, 2026-09-05,
// with `waveLength` 0.1 on a 40 m pool). Doubling the ratio moves the fade to
// [1.5, 3] cells: a band at the clamp floor is kept whole, and only bands
// genuinely finer than the grid are removed.
const bandGain=(op,length,p)=>op.clamp01(op.add(op.mul(op.div(op.mul(p.waveLength,length),op.max(p.waveCutoff??0,1e-6)),2),-1));

function evaluate(x,z,time,p,op) {
  const {add,mul,div,sin}=op;
  let result=0;
  for(let i=0;i<BANDS.length;i++) {
    const [angle,length,amplitude,speed,phase]=BANDS[i],c=Math.cos(angle),s=Math.sin(angle);
    const cx=add(mul(p.waveCos,c),mul(p.waveSin,-s)),cz=add(mul(p.waveSin,c),mul(p.waveCos,s));
    const along=add(mul(x,cx),mul(z,cz)),across=add(mul(x,cz),mul(z,mul(cx,-1)));
    const k=div(Math.PI*2,mul(p.waveLength,length));
    const warp=mul(sin(add(mul(across,div(.31,p.waveLength)),mul(time,.071+speed*.013))),.28);
    const theta=add(add(add(mul(along,k),mul(time,mul(p.speed,-speed))),phase),warp);
    const height=add(sin(theta),mul(sin(mul(theta,2)),mul(p.choppiness,.16)));
    // `rippleStrength` scales the WIND RIPPLES — the bands short enough to be
    // ripples rather than swell — which is a property of the band and not of
    // its position in a list that has now been reordered twice.
    //
    // ⛔ AND ZERO MEANS ZERO. A floor was added here so that `rippleStrength: 0`
    // still left some fine structure — reasoning that a control should not be
    // able to make water look dead. That is not the control's decision to make:
    // it silently overrode a setting the author had chosen deliberately, and
    // the water "started rippling too much even with ripple and choppiness
    // being 0" (user, 2026-09-06). If the default is bad, change the DEFAULT.
    const ripple=length<.3?p.rippleStrength:1;
    result=add(result,mul(mul(height,bandGain(op,length,p)),mul(amplitude,ripple)));
  }
  // ── REAL WAVES ARE NOT SINUSOIDS ─────────────────────────────────────────
  //
  // A gravity wave has SHARP CRESTS AND FLAT, BROAD TROUGHS, and a sum of sines
  // has neither — it is symmetric by construction, which is most of why a
  // heightfield ocean reads as corrugated cardboard however many octaves go
  // into it. The Stokes expansion's second-order term is exactly that
  // asymmetry: adding `h²` lifts a crest and lifts a trough too, so the crest
  // grows and the hollow shallows, in the one direction real water goes.
  //
  // Polynomial, so it is safe for any amplitude (a `u^p` reshaping needs a
  // clamped [0,1] base and clips the very tallest crests — the opposite of the
  // point). Subtracting the mean square keeps the mean water level put, which
  // matters because buoyancy floats bodies on this. `choppiness` drives it,
  // which is what that control already meant.
  result=add(result,mul(mul(p.choppiness,.5),add(mul(result,result),-.25)));
  // == THE OCTAVE LADDER =====================================================
  //
  // Each octave doubles the frequency and takes `waveGain` of the previous
  // amplitude, so every one draws detail half the size of the last. This is
  // where "config on octaves" belongs, and why reshuffling the DIRECTIONAL
  // bands changed so little: the fine detail has always lived in this loop,
  // which was hard-wired at three octaves contributing 18 % of the height.
  //
  // WARNING: EVERY OCTAVE IS NYQUIST-FADED, exactly like the bands. The eighth
  // is a hundred-and-twenty-eighth of the base wavelength; on any real grid
  // that is far below the cell size, and letting it through is aliased jitter,
  // which is a garbage NORMAL, which is the whole surface. The count is a
  // ceiling on detail, not a promise of it.
  //
  // Normalized by the live weight, so adding octaves adds STRUCTURE and never
  // height. `waveHeight` stays the one control that says how big the water is.
  let noise=0,weight=0,amplitude=1,frequency=1;
  const nx=add(div(add(mul(x,p.waveCos),mul(z,p.waveSin)),p.waveLength),mul(time,mul(p.speed,.031)));
  const nz=add(div(add(mul(z,p.waveCos),mul(x,mul(p.waveSin,-1))),p.waveLength),mul(time,mul(p.speed,-.023)));
  for(let octave=0;octave<MAX_OCTAVES;octave++) {
    const share=mul(amplitude,mul(octaveGain(op,octave,p),bandGain(op,1/frequency,p)));
    noise=add(noise,mul(valueNoise(add(mul(nx,frequency),octave*17.13),add(mul(nz,frequency),octave*11.71),op),share));
    weight=add(weight,share);
    amplitude=mul(amplitude,p.waveGain);
    frequency*=2;
  }
  const centered=add(div(noise,op.max(weight,.02)),-.5);
  // The detail both MODULATES the directional swell (crests stop being equal)
  // and ADDS to it (the surface has structure between the crests).
  return mul(add(mul(result,add(1,mul(centered,.35))),mul(centered,.95)),p.waveHeight);
}
const bounded=(value,fallback,min,max)=>Math.min(max,Math.max(min,Number.isFinite(Number(value))?Number(value):fallback));
export function waterWaveParameters(props={}) {
  const angle=bounded(props.waveDirection,0,-180,180)*Math.PI/180;
  return {waveHeight:bounded(props.waveHeight,.15,0,5),waveLength:bounded(props.waveLength,4,.1,100),
    waveCutoff:bounded(props.waveCutoff,0,0,1000),
    waveOctaves:bounded(props.waveOctaves,4,1,MAX_OCTAVES),
    waveGain:bounded(props.waveGain,.5,.2,.9),
    waveCos:Math.cos(angle),waveSin:Math.sin(angle),speed:bounded(props.waveSpeed,2,0,100),
    choppiness:bounded(props.choppiness,.35,0,1),rippleStrength:bounded(props.rippleStrength,.25,0,2)};
}
/** Continuous surface only; separately simulated initial/wake ripples are not included. */
export function waterWaveHeight(x,z,time,props={}) {return evaluate(x,z,time,waterWaveParameters(props),scalar);}
export function waterWaveHeightNode(x,z,time,uniforms) {return evaluate(x,z,time,uniforms,shader);}
export function waterWaveNormal(x,z,time,props={}) {
  const epsilon=Math.max(.0001,waterWaveParameters(props).waveLength*.0002);
  const dx=(waterWaveHeight(x+epsilon,z,time,props)-waterWaveHeight(x-epsilon,z,time,props))/(2*epsilon);
  const dz=(waterWaveHeight(x,z+epsilon,time,props)-waterWaveHeight(x,z-epsilon,time,props))/(2*epsilon);
  const length=Math.hypot(dx,1,dz);return [-dx/length,1/length,-dz/length];
}

/**
 * ══ THE FIELD'S OWN RMS STEEPNESS, IN WORLD UNITS ══════════════════════════
 *
 * Foam is "steeper than the water around you", so it needs to know what the
 * water around you actually is. `2πH/L` — the base band's steepness — is the
 * obvious guess and it is wrong by about half: `waveHeight` is the total, split
 * across eight bands of different wavelengths, so the field's real RMS
 * steepness on the reported lake is 0.083 where that formula says 0.126. A
 * threshold set against the guess never fires; one set against a fixed world
 * constant fires everywhere. This sums the bands that are actually alive,
 * including the grid's Nyquist fade and the ripple control, and is exact.
 */
export function waterFieldSteepness(props = {}, cutoff = 0) {
  const p = waterWaveParameters({ ...props, waveCutoff: cutoff });
  const fade = (wavelength) => (cutoff > 0 ? Math.min(1, Math.max(0, 2 * wavelength / cutoff - 1)) : 1);
  let sum = 0;
  for (const [, length, amplitude] of BANDS) {
    const wavelength = p.waveLength * length;
    const ripple = length < .3 ? p.rippleStrength : 1;
    const steep = 2 * Math.PI * (amplitude * ripple * fade(wavelength) * p.waveHeight) / Math.max(1e-4, wavelength);
    sum += steep * steep;
  }
  // ...and the octave ladder, which after normalization carries 0.95 of the
  // height spread over however many octaves are alive.
  let weight = 0, amplitude = 1, frequency = 1;
  const shares = [];
  for (let o = 0; o < MAX_OCTAVES; o++) {
    const wavelength = p.waveLength / frequency;
    const share = amplitude * clamp01(p.waveOctaves - o) * fade(wavelength);
    shares.push([share, wavelength]);
    weight += share; amplitude *= p.waveGain; frequency *= 2;
  }
  for (const [share, wavelength] of shares) {
    const steep = 2 * Math.PI * (.95 * share / Math.max(.02, weight) * p.waveHeight) / Math.max(1e-4, wavelength);
    sum += steep * steep;
  }
  return Math.sqrt(sum);
}
