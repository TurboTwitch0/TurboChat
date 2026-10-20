const fs = require("node:fs");
const path = require("node:path");
const rate = 20000;
const output = path.join(__dirname, "..", "media");
const songs = [
  { file: "neon-postcards.wav", bpm: 112, roots: [45, 41, 48, 43], chords: [[0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 11], [0, 4, 7, 10]], notes: [12, 15, 19, 22, 19, 17, 15, 10], seed: 31 },
  { file: "midnight-arcade.wav", bpm: 118, roots: [38, 45, 41, 48], chords: [[0, 3, 7, 10], [0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 10]], notes: [12, 19, 22, 26, 24, 22, 19, 15], seed: 71 },
  { file: "dreamwave-radio.wav", bpm: 96, roots: [48, 43, 45, 41], chords: [[0, 4, 7, 11], [0, 4, 7, 11], [0, 3, 7, 10], [0, 4, 7, 11]], notes: [19, 22, 24, 22, 19, 15, 14, 12], seed: 113 },
  { file: "slow-orbit.wav", bpm: 82, roots: [41, 48, 43, 45], chords: [[0, 4, 7, 11], [0, 3, 7, 10], [0, 4, 7, 11], [0, 3, 7, 10]], notes: [12, 19, 22, 24, 19, 17, 15, 14], seed: 191 }
];
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
function writeStereo(file, left, right) {
  const pcm = Buffer.alloc(left.length * 4), wav = Buffer.alloc(44 + pcm.length);
  const shortDelay = Math.round(rate * 0.115), longDelay = Math.round(rate * 0.245);
  for (let i = 0; i < left.length; i++) {
    const fade = Math.min(1, i / (rate * 0.7), (left.length - i - 1) / (rate * 0.9));
    const echoL = (i > shortDelay ? right[i - shortDelay] * 0.13 : 0) + (i > longDelay ? left[i - longDelay] * 0.08 : 0);
    const echoR = (i > shortDelay ? left[i - shortDelay] * 0.13 : 0) + (i > longDelay ? right[i - longDelay] * 0.08 : 0);
    pcm.writeInt16LE(Math.round(Math.tanh((left[i] + echoL) * fade) * 30000), i * 4);
    pcm.writeInt16LE(Math.round(Math.tanh((right[i] + echoR) * fade) * 30000), i * 4 + 2);
  }
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44); fs.writeFileSync(path.join(output, file), wav);
}
function synth(song) {
  const beat = 60 / song.bpm, bar = beat * 4, bars = 16, size = Math.floor(bar * bars * rate);
  const left = new Float32Array(size), right = new Float32Array(size); let seed = song.seed;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const add = (start, length, voice, volume, pan = 0) => {
    const from = Math.max(0, Math.floor(start * rate)), to = Math.min(size, Math.ceil((start + length) * rate));
    const l = volume * Math.sqrt((1 - pan) / 2), r = volume * Math.sqrt((1 + pan) / 2);
    for (let i = from; i < to; i++) { const v = voice((i - from) / rate); left[i] += v * l; right[i] += v * r; }
  };
  const kick = t => Math.sin(2 * Math.PI * (48 + 95 * Math.exp(-t * 24)) * t) * Math.exp(-t * 13);
  for (let n = 0; n < bars; n++) {
    const root = song.roots[n % song.roots.length], start = n * bar, fullness = n < 2 ? 0.38 : n > 12 && n < 14 ? 0.62 : 1;
    const chord = song.chords[n % song.chords.length].map(step => root + step);
    for (let c = 0; c < chord.length; c++) {
      const f = hz(chord[c] + 12), pan = (c - 1.5) * 0.22;
      add(start, bar * 0.98, t => {
        const env = Math.min(1, t / 0.32) * (0.78 + 0.22 * Math.sin(Math.PI * t / bar));
        const drift = Math.sin(2 * Math.PI * 0.23 * t) * 0.002;
        return (0.72 * Math.sin(2 * Math.PI * f * t) + 0.26 * Math.sin(2 * Math.PI * f * 2.01 * t + drift) + 0.09 * Math.sin(2 * Math.PI * f * 3.98 * t)) * env;
      }, 0.052 * fullness, pan);
    }
    for (let beatNo = 0; beatNo < 4; beatNo++) {
      const t = start + beatNo * beat, bass = hz(root - 12 + (beatNo === 2 ? 7 : 0));
      add(t, beat * 0.82, x => (Math.sin(2 * Math.PI * bass * x) + 0.22 * Math.sin(2 * Math.PI * bass * 2 * x)) * Math.exp(-x * 2.6), 0.16 * fullness, -0.12);
      if (n >= 2 && !(n >= 12 && n < 14)) {
        add(t, 0.32, kick, beatNo % 2 ? 0.22 : 0.34, 0);
        if (beatNo === 1 || beatNo === 3) add(t, 0.24, x => (random() * 0.82 + Math.sin(2 * Math.PI * 190 * x) * 0.18) * Math.exp(-x * 13), 0.22, 0.08);
      }
    }
    for (let step = 0; step < 8; step++) {
      const t = start + step * beat / 2, f = hz(root + song.notes[(step + n) % song.notes.length]);
      add(t, beat * 0.34, x => { const env = (1 - Math.exp(-x * 38)) * Math.exp(-x * 4.3); const vibrato = Math.sin(2 * Math.PI * 5.2 * x) * 0.006; return (Math.sin(2 * Math.PI * f * (1 + vibrato) * x) + 0.32 * Math.sin(2 * Math.PI * f * 2.01 * x) + 0.1 * Math.sin(2 * Math.PI * f * 3 * x)) * env; }, 0.13 * fullness, step % 2 ? 0.3 : -0.3);
      if (n >= 2 && !(n >= 12 && n < 14)) {
        add(t, 0.055, x => random() * Math.exp(-x * 95), step % 2 ? 0.052 : 0.026, step % 2 ? 0.55 : -0.55);
        if (step % 2 === 1) add(t + beat * 0.125, beat * 0.22, x => Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 7), 0.036 * fullness, step % 4 ? 0.45 : -0.45);
      }
    }
    if (n >= 4 && n % 4 === 3) {
      const f = hz(song.notes[(n + 2) % song.notes.length] + 12), t = start + bar - beat * 0.45;
      add(t, beat * 0.4, x => Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 4), 0.08, 0.2);
    }
  }
  writeStereo(song.file, left, right);
}
fs.mkdirSync(output, { recursive: true }); songs.forEach(synth); console.log(`Generated ${songs.length} original stereo pop loops in ${output}`);
