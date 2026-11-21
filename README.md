# csv-reader-speed-20261121

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/ehsanef/csv-reader-speed-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/ehsanef/csv-reader-speed-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0: reads broken CSV files and answers exactly as csv-reader does on every case, much faster.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

## How it is fast

The reference walks one character at a time and builds every field a character at a time. This reader slices fields out of the text with short, bounded `indexOf` scans, takes a whole-line fast path for records with no quote and no stray CR (one slice plus `split(',')` per record), and slices quoted fields between quotes — with a slow path only for doubled quotes, embedded line breaks, stray CRs and quote junk, the rare cases. Every scan is bounded to the field or line it decides.

Measured locally on the kit's practice set (6 cases, ~10.5 MB of CSV): solve time ~0.13 s against csv-reader 1.0.0's ~0.6 s, with byte-identical answers on all 6 cases, plus 240 generated cases and 50 hand-made edge cases (unterminated quotes, quote junk, stray CRs, ragged rows, blank lines, CRLF, BOM) all matching the reference exactly.

## Layout

- `solve.js` — the fast reader: `run({text, header})` returns `{columns, rows, errors}`
- `main.ts` — the harness driver (the kit's driver, unchanged)

---

<sub>Entered on [make.fun](https://make.fun/?ref=qzcjfqr9&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
