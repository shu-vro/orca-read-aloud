/**
 * The Sec-MS-GEC token the speech WebSocket requires, scheme v2 ("<16 hex>-<64 hex>").
 *
 * Ported from rany2/edge-tts src/edge_tts/drm.py (7.3.1). The service started refusing the v1
 * token (a plain SHA-256) in October 2026; edge-tts-universal still generates v1. The digest is
 * SHA-256 resumed from a fixed mid-state with altered constants, followed by a CS64 checksum.
 * Constants are copied verbatim; their meaning is not documented anywhere.
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH = 11644473600;

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const K_BLOCK = K.map((k, i) => (i === 14 ? SHA256_ADJUSTMENT : k));
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
const rol16 = (x: number) => ((x << 16) | (x >>> 16)) >>> 0;
const mul = (a: number, b: number) => Math.imul(a, b) >>> 0;
const sigma0 = (x: number) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sigma1 = (x: number) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;

function expand(w: number[], from = 16) {
  for (let i = from; i < 64; i++) w[i] = (sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) >>> 0;
}

function rounds(state: number[], w: number[], first = 0): number[] {
  const k = first === 14 ? K_BLOCK : K;
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b)));
    [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
  }
  return [a, b, c, d, e, f, g, h];
}

const add = (x: number[], y: number[]) => x.map((v, i) => (v + y[i]) >>> 0);

/** The mid-state after a fixed first block that ends with the first seven bytes of data. */
function init(data: Uint8Array): number[] {
  const w: number[] = Array(14).fill(0);
  w.push((data[0] << 16) | (data[1] << 8) | data[2]);
  w.push(new DataView(data.buffer, data.byteOffset + 3, 4).getUint32(0));
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value += i === 16 ? (sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT) >>> 0 : sigma1(w[i - 2]);
    if (i - 7 >= 14) value += w[i - 7];
    if (i - 15 >= 14) value += i === 29 ? (sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT) >>> 0 : sigma0(w[i - 15]);
    w.push(value >>> 0);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]) >>> 0);
  expand(w, 31);
  return add(SHA256_INITIAL, rounds(SHA256_STATE, w, 14));
}

function sha256(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const tail = data.length - 7 + 1 + ((((55 - length) % 64) + 64) % 64);
  const padded = new Uint8Array(tail + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(tail, BigInt(length * 8));
  let state = init(data);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4));
    expand(w);
    state = add(state, rounds(state, w));
  }
  const out = new Uint8Array(32);
  state.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
}

function cs64(data: Uint8Array, digest: Uint8Array): [number, number] {
  const dv = new DataView(digest.buffer);
  const keyA = (dv.getUint32(0, true) | 1) >>> 0;
  const keyB = (dv.getUint32(4, true) | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([c], i) => mul(c, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, o]) => o);

  // Little-endian words of a zero byte plus data, zero-padded to an even count.
  const count = Math.ceil((data.length + 1) / 8) * 2;
  const bytes = new Uint8Array(count * 4);
  bytes.set(data, 1);
  const words = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) {
    const word = words.getUint32(i * 4, true);
    let term = mul(word, i % 2 ? keyB : keyA);
    let offset = mul(rol16(word), i % 2 ? 0xc31713db : 0xef0569fb);
    if (i === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let q = mul(rol16((offsets[i] + x) >>> 0), 0x76f50f34);
    swapAcc += (mul(rol16(q), 0xc3efea97) + q) >>> 0;
    q = mul(rol16((offsets[i + 1] + y) >>> 0), 0x1881ce3c);
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul(state, keyA) + x) >>> 0;
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc += state;
    let t = (mul(state, keyB) + y) >>> 0;
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/** The token for the five-minute window containing `nowMs`. */
export function secMsGec(nowMs = Date.now()): string {
  let ticks = nowMs / 1000 + WIN_EPOCH;
  ticks -= ticks % 300;
  const data = new TextEncoder().encode(`${(ticks * 1e7).toFixed(0)}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256(data);
  const check = new Uint8Array(8);
  const [lo, hi] = cs64(data, digest);
  new DataView(check.buffer).setUint32(0, lo, true);
  new DataView(check.buffer).setUint32(4, hi, true);
  return `${hex(check)}-${hex(digest)}`;
}
