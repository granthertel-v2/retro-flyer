# Break-check results

> **A passing suite proves nothing until each test is confirmed able to fail.**
> — `REQUIREMENTS.md` §4.3

Run date: 2026-09-03. Suite at time of run: 197 tests, 10 files, all green.
Reproduce with `node tools/break_check.mjs` from `packages/physics`.

**Result: 12 of 12 mutations detected. No mutation went unnoticed.**

The first run was more useful than that headline suggests — it found two tests
that stayed green through mutations they were specifically written to catch. Both
are described below and both are fixed. That is the protocol working, and it is the
reason §4.3 exists.

---

## Method

Each mutation is one surgical edit to a source file: apply, run the entire suite,
record which test files fail, revert. The tool refuses to start on a dirty working
tree and restores the tree on any crash path — a corrupted model must never be able
to survive the run.

Each mutation also carries an `expect` list naming the suites that *should* catch
it. A mutation being caught by something is weak evidence; a mutation being caught
by the test written to catch it is the actual claim.

---

## Results

`Tier A` is port fidelity against the reference implementation at 1e-12
(`goldenCoefficients`, `goldenEngine`, `goldenDerivatives`). `Tier B` is the
physics validation of `REQUIREMENTS` §4.2.

| Mutation | Tier A | Tier B | Caught by |
|---|---|---|---|
| Invert the lift coefficient sign | 2 | 5 | boundary, energy, goldenCoefficients, goldenDerivatives, modes, quaternion, trim |
| Zero the pitching-moment table | 2 | 3 | goldenCoefficients, goldenDerivatives, modes, quaternion, trim |
| Offset the reference CG by 0.05 c̄ | 0 | 2 | massProperties, modes |
| Zero pitch damping (Cmq) | 1 | 3 | energy, goldenDerivatives, modes, quaternion |
| Zero yaw damping (Cnr, Cnp) | 1 | 1 | goldenDerivatives, modes |
| Swap the pitch/yaw damping indices | 1 | 3 | energy, goldenDerivatives, modes, quaternion |
| **Change one coefficient by 10%** | **2** | **0** | **goldenCoefficients, goldenDerivatives** |
| Off-by-one in the alpha table index | 2 | 5 | boundary, energy, goldenCoefficients, goldenDerivatives, modes, quaternion, trim |
| Gravity 32.17 → 9.81 | 1 | 4 | energy, goldenDerivatives, modes, quaternion, trim |
| RK4 → forward Euler | 0 | 1 | quaternion |
| Skip quaternion renormalization | 0 | 1 | quaternion |
| Disable the envelope guard | 0 | 2 | boundary, quaternion |

---

## The row that justifies the whole design

**Change one coefficient by 10%: Tier A catches it. Tier B does not — not one test
out of seven files.**

This is the transcription error that `REQUIREMENTS` §4.2 as originally written could
not have detected. One number out of 852, altered by an amount well below every 5%
and 10% tolerance in the spec. Trim still converges. The modes are still in range.
Energy still decreases monotonically. Every physics test passes, and the aircraft is
permanently, invisibly wrong.

852 hand-entered coefficients against percentage-tolerance tests is a system where
the most likely defect is also the least detectable one. Tier A exists for exactly
this row, and this row is the evidence it was worth building.

The converse also holds and is worth stating: **Tier A alone would be equally
insufficient.** The CG offset, the integrator swap, the missing renormalization, and
the envelope guard are all invisible to Tier A — they are not port errors, so a
faithful port test has nothing to say about them. Neither tier subsumes the other.

---

## Two holes the first run found

Both were tests that passed through mutations they were written to catch. Neither
would have been discovered by any amount of staring at green output.

### 1. A tautological assertion in `massProperties.test.ts`

The `offset-cg` mutation changes `XCG_REF` from 0.35 to 0.40. The mass-properties
suite did not notice, because every assertion in it compared computed values against
`XCG_REF` itself:

```ts
expect(mp.xcg).toBeCloseTo(XCG_REF, 12)   // both sides move together
```

Changing the constant changes both sides of the comparison. The test passes for any
value whatsoever. This is precisely the failure mode §4.3 describes: *"a test aimed
at the wrong state variable reports clean forever."*

**Fixed** by adding assertions against literals traced to the source — `XCG_REF`
must equal `0.35`, the inertia constants must equal NASA Table 1's figures — so that
editing a sourced constant has to be a deliberate act that trips a test naming the
source.

### 2. A damping band too loose to test damping

The `kill-yaw-damping` mutation zeroes Cnr and Cnp. The dutch roll damping ratio
roughly halves as a result:

| Condition | Intact | Yaw damping zeroed |
|---|---|---|
| 10,000 ft / 500 ft/s | 0.124 | 0.065 |
| 10,000 ft / 900 ft/s | 0.112 | 0.030 |
| 30,000 ft / 700 ft/s | 0.091 | 0.050 |

The test asserted `zeta > 0.02`, which 0.065 satisfies comfortably. A model with no
yaw damping at all passed the yaw damping test.

**Fixed** two ways. The physical band was tightened to `zeta > 0.08`, still justified
independently — that is the low end for this class of aircraft. And per-condition
regression pins were added at the 10% tolerance §4.2 specifies, labelled honestly as
regression pins rather than validation: they cannot show the model is right, but they
ensure any change to a damping ratio has to be deliberate and visible.

---

## A bug in the break-check tool itself

The first two runs reported inflated detection — `perturb-one-coefficient` appeared
to be caught by all ten suites, including `atmosphere` and `massProperties`, which
have no path to an axial-force coefficient.

Cause: the tool ran vitest with `--reporter=json --outputFile=/dev/stdout`, so the
JSON report interleaved with vitest's console output and sometimes failed to parse.
The fallback for an unparseable report marks every suite as failed, on the reasoning
that a compile error should not read as "undetected".

That fallback is right, but combined with a flaky parse it inflates detection and
**hides suite holes** — a mutation looks broadly caught when the run never produced
readable results at all. It is a false negative for exactly the thing the tool
exists to find, which makes it the one error this tool must not make.

Fixed by writing the report to a real temp file, and by tagging any run that still
fails to produce a report as `BUILD FAILED` in the output rather than silently
folding it into the detection count.

Worth recording plainly: for a while, this tool was reporting a cleaner bill of
health than the suite deserved. The verification harness needs verifying too.

---

## What this does not establish

Stating the limits, since the point of the exercise is honesty about what is proven:

- **Twelve mutations is not exhaustive.** Real mutation testing enumerates thousands.
  These twelve were chosen to cover the failure classes that matter here — sign
  errors, zeroed terms, index errors, transcription errors, units errors, integration
  errors — but a mutation not on the list is a mutation not tested.
- **Detection is not localization.** Seven suites failing on inverted lift shows the
  suite is sensitive, not that it would point a maintainer at the right line.
- **Tier B validates against the model, not against a real F-16.** The strongest
  external evidence available is the relaxed-stability behavior in `modes.test.ts`,
  which reproduces a documented characteristic of the actual aircraft
  (`REQUIREMENTS` §3) rather than merely of the reference implementation. Everything
  else is internal consistency.
- **The dutch roll regression pins are pins.** They come from our own converged
  model, not from a published source, because no published modal values for this
  model were located. They provide sensitivity, not validation, and are labelled that
  way in the test file.

---

## Re-running

```bash
cd packages/physics
node tools/break_check.mjs          # human-readable summary
node tools/break_check.mjs --json   # full detail
```

Exit code is 0 if every mutation was detected, 2 if any went unnoticed.

Re-run after any change to the aero tables, the lookup scheme, the integrator, or
the tolerances in the test suite. A tolerance loosened for convenience is the most
likely way for a hole to reappear, and this is the only thing that would notice.
