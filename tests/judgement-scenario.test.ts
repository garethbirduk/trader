import { describe, it, expect } from "vitest";
import { createRNG } from "../src/engine/core/rng.js";
import { computeEstimate } from "../src/engine/perception/estimate.js";

/**
 * Snapshot of the new judgement engine's behaviour across the
 * (expertise, j) grid. Drift in these numbers means the perception
 * pipeline has shifted — intentional or otherwise. The doc commits
 * to the four-case shape (confidently-wrong / confidently-right /
 * haphazardly-wrong / hesitantly-right); the snapshot pins the
 * specific statistical fingerprint that produces those four cases.
 *
 * Anchor 80, truth 1000 — large gap so cluelessness shows up clearly
 * as a centre near 80, not near 1000.
 */

const TRUTH = 1000;
const ANCHOR = 80;
const TRIALS = 4000;

const EXPERTISE_VALUES = [0.1, 0.3, 0.5, 0.8, 0.95];
const J_VALUES = [0.1, 0.3, 0.5, 0.8, 0.95];

function summarise(samples: readonly number[]): {
  mean: number;
  sd: number;
  p10: number;
  p50: number;
  p90: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const variance =
    samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
  const sd = Math.sqrt(variance);
  const at = (q: number) => sorted[Math.floor(samples.length * q)] ?? 0;
  return { mean, sd, p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

function pad(label: string, width: number): string {
  return label.length >= width
    ? label
    : label + " ".repeat(width - label.length);
}

function rightPad(num: number, width: number): string {
  const s = Math.round(num).toString();
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function buildSnapshot(): string {
  const lines: string[] = [];
  lines.push(`Judgement engine — sample distribution`);
  lines.push(`  truth=${TRUTH}, anchor=${ANCHOR}, trials/cell=${TRIALS}`);
  lines.push("");
  lines.push(
    `  ${pad("exp", 5)}${pad("j", 5)}${pad("mean", 8)}${pad("sd", 8)}${pad("p10", 8)}${pad("p50", 8)}${pad("p90", 8)}`,
  );
  lines.push(`  ${"-".repeat(5 + 5 + 8 * 5)}`);
  for (const expertise of EXPERTISE_VALUES) {
    for (const j of J_VALUES) {
      const rng = createRNG(`scenario-exp${expertise}-j${j}`);
      const samples: number[] = [];
      for (let i = 0; i < TRIALS; i += 1) {
        const r = computeEstimate({
          arm: "price",
          truth: TRUTH,
          anchor: ANCHOR,
          expertise,
          j,
          rng,
        });
        samples.push(r.sample);
      }
      const s = summarise(samples);
      lines.push(
        `  ${pad(expertise.toFixed(2), 5)}${pad(j.toFixed(2), 5)}` +
          `${rightPad(s.mean, 7)} ${rightPad(s.sd, 7)} ${rightPad(s.p10, 7)} ${rightPad(s.p50, 7)} ${rightPad(s.p90, 7)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

describe("judgement engine — scenario snapshot", () => {
  it("distribution fingerprint across (expertise × j) is stable", () => {
    expect(buildSnapshot()).toMatchInlineSnapshot(`
      "Judgement engine — sample distribution
        truth=1000, anchor=80, trials/cell=4000

        exp  j    mean    sd      p10     p50     p90     
        --------------------------------------------------
        0.10 0.10     170      85      50     172     292
        0.10 0.30     173      59      85     173     261
        0.10 0.50     172      35     120     172     221
        0.10 0.80     172       9     169     172     175
        0.10 0.95     172       2     171     172     173

        0.30 0.10     352     174     106     352     602
        0.30 0.30     354     121     171     356     528
        0.30 0.50     357      73     249     357     461
        0.30 0.80     356      19     349     356     363
        0.30 0.95     356       4     354     356     358

        0.50 0.10     539     265     166     533     916
        0.50 0.30     543     185     274     541     820
        0.50 0.50     538     110     375     540     695
        0.50 0.80     540      28     530     540     551
        0.50 0.95     540       6     537     540     543

        0.80 0.10     811     400     239     808    1382
        0.80 0.30     812     278     400     816    1217
        0.80 0.50     814     170     557     815    1063
        0.80 0.80     817      43     800     817     832
        0.80 0.95     816       9     811     816     821

        0.95 0.10     952     470     289     958    1615
        0.95 0.30     949     323     469     951    1424
        0.95 0.50     950     192     662     954    1230
        0.95 0.80     955      50     936     955     972
        0.95 0.95     954      10     948     954     960
      "
    `);
  });
});
