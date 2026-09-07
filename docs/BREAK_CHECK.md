# Break-check results

> **A passing suite proves nothing until each test is confirmed able to fail.**
> — `REQUIREMENTS.md` §4.3

Run date: 2026-09-07, Day 4 QA. Physics suite at time of run: **275 tests,
14 files, all green.** Reproduce with `node tools/break_check.mjs` from
`packages/physics` (add `--json` for machine-readable output).

**Result: 25 of 25 mutations detected. Nothing went unnoticed.**

> **Correction.** This document claimed the same result on 2026-09-04 and it was
> not true at the time. The run it described stopped at mutation 14 of 25 on a
> stale anchor, so eleven mutations never executed and the 25/25 was a count of
> what was listed rather than of what ran. The Day 4 QA pass found it; the cause
> and the fix are in [The anchor that went stale](#the-anchor-that-went-stale)
> below. The figures above are from a complete run.

Day 4 added a second, much smaller pass over the HUD geometry — `11 of 11
detected`, run with `node tools/hud_break_check.mjs` from `packages/app`. It has
its own section at the end.

Two mutations went undetected on the first run of this pass and both are described
below. Both are now caught. That is the protocol working, and it is the reason §4.3
exists — a suite that has never been shown to fail is a suite nobody has tested.

---

## Method

Each mutation is one surgical edit to a source file: apply it, run the entire physics
suite, record which test files go red, revert. The working tree is restored before
and after, and the script refuses to start on a dirty tree so that a crash mid-run
cannot leave a corrupted model behind.

The tool also **refuses to run a mutation whose anchor text no longer exists**. This
matters more than it sounds: a mutation that silently fails to apply reports a clean
bill of health for a test that was never challenged. It fired for real during this
pass, when the Day 3 integrator rewrite moved the RK4 stage lines out from under the
`euler-integrator` mutation.

Since Day 4 the tool **validates every anchor before running anything**, rather than
discovering a stale one partway through. That ordering is not a detail: throwing at
mutation 14 leaves mutations 15 to 25 unrun, and a tool that reports "stopped early"
in the same breath as a list of twenty-five mutation names is one glance away from
being read as a pass. Checking up front costs nothing and reports every stale anchor
at once.

Each mutation carries an `expect` list — a claim about which suites *should* notice.
Where reality disagreed with the claim, the finding is recorded below rather than the
claim being quietly edited to match.

---

## Results

| Mutation | What it breaks | Caught by |
|---|---|---|
| `invert-lift` | Lift acts downward | bodyAxis, boundary, energy, goldenCoefficients, goldenDerivatives, modes, quaternion, trim |
| `zero-pitching-moment` | All pitch stiffness removed | bodyAxis, goldenCoefficients, goldenDerivatives, modes, quaternion, trim |
| `offset-cg` | Reference CG moved 0.05 chord | massProperties, modes |
| `kill-pitch-damping` | Cmq zeroed | bodyAxis, energy, goldenDerivatives, modes, quaternion |
| `kill-yaw-damping` | Cnr and Cnp zeroed | bodyAxis, goldenDerivatives, modes |
| `swap-damping-indices` | Pitch and yaw damping indices swapped | bodyAxis, energy, goldenDerivatives, modes, quaternion |
| `perturb-one-coefficient` | One axial-force table entry off by 10% | goldenCoefficients, goldenDerivatives |
| `break-alpha-index` | Off-by-one in the alpha table index | bodyAxis, boundary, energy, gear, goldenCoefficients, goldenDerivatives, modes, quaternion, trim |
| `wrong-gravity` | 32.17 → 9.81, feet mistaken for metres | bodyAxis, energy, gear, goldenDerivatives, modes, quaternion, trim |
| `euler-integrator` | RK4 replaced with forward Euler | bodyAxis, quaternion |
| `skip-quaternion-normalize` | Quaternion drift left uncorrected | quaternion |
| `disable-envelope-guard` | Envelope guard made a no-op | bodyAxis, boundary |
| `swap-body-accelerations` | Lateral and normal accelerations swapped in the body-axis tail | bodyAxis, boundary, energy, gear, quaternion |
| `integrated-alpha` | `atan2` → `atan`, losing the quadrant | bodyAxis |
| `external-loads-inert` | External force dropped from the force equations | bodyAxis, gear |
| `strut-pulls-down` | Strut allowed to pull the aircraft down on rebound | gear |
| `friction-sign-law` | Tyre friction ramp replaced with `sign()` | gear |
| `no-static-friction` | Static-to-dynamic friction falloff removed | gear |
| `no-bottoming-stop` | Bottomed strut keeps its linear rate | gear |
| `no-damping-fade` | Full strut damping applied at first contact | gear |
| `symmetric-strut-damping` | Extension damped as softly as compression | gear |
| `gear-without-moments` | Gear produces forces but no moments | gear |
| `contact-ignores-rotation` | Contact velocity drops the omega × r term | gear |
| `level-resting-attitude` | Parked aircraft assumed level | gear |
| `supersonic-thrust-clamped` | Thrust interpolation weight clamped at the table edge | goldenEngine, supersonicThrust |

---

## The two that survived, and what they mean

Both were in the gear model, and both had the same shape: the behaviour *was* tested,
but only from the **app** package, by the landing tests in `takeoff.test.ts`. The
break-check runs the physics suite alone, so `gear.ts` — where the code lives — could
have been changed without anything in its own package objecting.

That is a real gap and not a bookkeeping detail. A cross-package test is the right
place to check that a landing feels like a landing; it is the wrong place to be the
*only* check on a spring-damper's constitutive law.

### `no-damping-fade`

Damping is `c × closing speed`, and without the fade the damper is at full strength
the instant the wheel touches, while the spring is still at zero. Measured before the
fix: **173,871 lb in a single tick** on a 27 ft/s arrival — 8.5 times the aircraft's
weight, from a strut that had not yet moved.

Now caught by `the damper > does not answer first contact with a step force`, which
asserts the force at 0.004 ft of squash is under a tenth of the undamped `c × v`, and
that it still ramps up deeper in the stroke.

### `symmetric-strut-damping`

A strut that returns the energy it stored throws the aircraft off the runway it has
just landed on. Measured: airborne again 0.25 s after touchdown, climbing at 1,100
fpm.

Now caught by `the damper > resists extension harder than compression`. Writing that
test surfaced a second trap worth recording: at the obvious test rate of 6 ft/s the
damper alone exceeds the spring force, the strut releases completely, and `N` clamps
at zero — so the asymmetry saturates and reads as *0.68*, the wrong way round. The
test measures at 1 ft/s, inside the regime where the strut is still pushing, and says
so in a comment.

---

## The anchor that went stale

`strut-pulls-down` anchored on this, in `src/gear.ts`:

```
if (N <= 0) {
  compression.push(squash)
  normal.push(0)
  continue
}
```

Day 3's airframe-contact work replaced that push-based accumulation with indexed
assignment — `if (N <= 0) continue`, with `compression[gearIndex] = squash` moved
above it — **in the same commit that refreshed this document**. So the mutation
stopped applying at the moment the results here were written down, and the tool did
what it is built to do: it refused to run a mutation it could not apply, and threw.

It threw at number 14 of 25. The eleven behind it — every gear and contact mutation
except the first two, plus the supersonic thrust case — did not run again until Day 4.
Nothing was actually wrong with them; a complete run detects all eleven. But for two
days this file asserted a result nobody had measured.

The lesson is not "update your anchors". It is that a guard which fires *during* a
run only protects the part of the run that has already happened, and that a tool
whose job is to catch silent failure is exactly the tool that must not fail
silently itself. Hence the pre-flight check described above, in both break-checks.

## Where an expectation was wrong rather than a test

`swap-body-accelerations` was expected to be caught by `trim` and `modes`. It is
caught by neither, and both are correct:

- **`modes` cannot see it.** Modal analysis linearises the 13-element Euler state
  through `derivative()`, which the body-axis tail does not touch. This is by design —
  `dynamics.ts` keeps the reference's wind-axis form precisely so the Tier A vectors
  and the modal analysis validate the reference model rather than our replacement.
- **`trim` is too loose to see it.** It holds a level condition where beta is zero
  and both swapped accelerations are near zero, so the mutation is very nearly a
  no-op — against bounds deliberately widened because trim is neutrally stable in the
  phugoid.

The `expect` list in the tool was corrected to the measured truth, with the reasoning
recorded next to it. Editing the expectation is only honest when the expectation was
the thing that was wrong; here it was.

---

## What this does not cover

- **The control package.** `@retro-flyer/control` is tunable by §4.4 and has no
  ground truth to mutate against.
- **The renderer, except its geometry.** Four separate Day 2 and Day 3 defects were
  invisible to a fully green suite and were found by flying the aircraft in a browser
  — no landing gear drawn at all, wheels sitting 0.6 m under the runway surface, and
  the default spawn flying with its gear down. Six more came out of Day 4's HUD the
  same way. Mutation testing would not have found any of the ten, because there was
  no test to challenge. Flying it remains the only check on whether the picture is
  right; the section below covers only whether the *numbers behind* the picture are.

---

# HUD geometry — Day 4

Run date: 2026-09-07. `packages/app` at time of run: **171 tests, 11 files, green**,
32 of them in `test/hud.test.ts`.
Reproduce with `node tools/hud_break_check.mjs` from `packages/app`.

**Result: 11 of 11 mutations detected.** One went undetected on the first run and is
described below.

## Why this one part of the app gets the protocol

Most of the renderer cannot be mutation-tested, because there is no assertion to
break: nothing in the suite claims the sky is the right blue. `hud/symbology.ts` is
different. It is pure geometry with exact right answers, and it is the part of the
renderer whose defects are least visible — a pitch ladder at the wrong scale, or a
flight path marker reflected through the centre of the screen, looks entirely
plausible. Since the developer has no flying experience, "looks plausible" is the
whole failure mode this project is built to survive.

| Mutation | What it breaks | Suite |
|---|---|---|
| `flip-screen-y` | Screen Y measured upward instead of downward | hud |
| `ignore-behind` | Directions behind the camera projected anyway | hud |
| `flat-ladder` | Cosine of pitch dropped from the ladder direction | hud |
| `quat-conjugate` | One sign flipped in the quaternion rotation | hud |
| `ticks-off-grid` | Tape graduations start at the current value | hud |
| `no-min-clamp` | Negative airspeeds emitted on the tape | hud |
| `no-wrap` | Heading strip stops wrapping at north | hud |
| `no-short-way` | Steering cue takes the long way round the compass | hud |
| `bearing-swap` | Bearing arguments to `atan2` exchanged | hud |
| `never-caged` | A clamped flight path marker stops saying it is clamped | hud |
| `ladder-eats-horizon` | The zero rung drawn as an ordinary rung | hud |

## The one that got through

`quat-conjugate` flips the sign of a single term in `applyQuat`, and the first run of
the suite did not notice. The reason is a coverage hole rather than a weak assertion:
every quaternion in the tests was a *pure pitch rotation*, and for a pure pitch
rotation acting on the nose vector the mutated term is identically zero. Half the
rotation formula could have been deleted with the suite still green — and the
consequence in flight would have been a boresight drawn in the wrong place on any
heading but north, which is precisely the kind of wrong that survives a look at the
screen.

Two tests closed it: a 90-degree yaw, the smallest rotation that gives the term
weight, and a general attitude with no zero component checked against an
independently written rotation matrix.

## A claim that was removed rather than tested

A twelfth mutation was tried and is not in the list. `tapeTicks` carried a guard
against floating-point drift in the tick values, with a comment about accumulation
producing `250.00000000000003` and dropping a labelled graduation at random. Removing
the guard broke nothing, so the guard was suspected of being dead code — and a sweep
over every step size across the whole altitude and airspeed envelope found the worst
deviation from an integer to be exactly zero. `first` comes out of `Math.ceil`, so it
is exact, and adding an integer step to it stays exact at these magnitudes.

The guard and the test that pretended to cover it were both deleted. A test that
cannot fail is not a test, and a comment describing a hazard that does not exist is
worse than no comment: the next person budgets around it.
