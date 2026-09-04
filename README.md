# Retro Flyer

A browser flight simulator with an honest flight model and a deliberately crude
world. Polygon-era visuals; a real 6DOF aerodynamic model underneath.

**Status: Day 1 of 4 complete.** The flight model exists and is validated. There is
nothing to look at yet — no renderer, no terrain, no HUD. Those are Days 2 through 4.

---

## The idea

Crude on purpose everywhere except the flight model. Terrain and lighting will be
low-poly and flat-shaded by choice. The aerodynamics are not: they come from the
open academic F-16 dataset published by NASA, with a validation suite that holds
them to it.

The developer has no flying experience. That is the constraint the whole project is
built around — "does it feel right" is not an available signal, so the test suite has
to be the ground truth instead. Everything in `packages/physics` exists to make that
suite worth trusting.

Full specification: [`REQUIREMENTS.md`](REQUIREMENTS.md).

---

## What Day 1 shipped

A headless 6DOF flight model in TypeScript with no runtime dependencies.

- **Aerodynamics** — 852 coefficients across 12 tables, ported from the reference
  implementation, plus the engine model, ISA atmosphere, and the source's own
  simplified atmosphere the tables are referenced to.
- **Rigid body dynamics** — quaternion attitude, RK4 at a fixed 120 Hz decoupled
  from rendering.
- **Trim solver** — Nelder-Mead over the equilibrium residuals; level, climbing, and
  coordinated-turn conditions.
- **Linearization and modal analysis** — finite-difference Jacobian and a QR
  eigensolver, both written out rather than pulled in as dependencies.
- **197 tests** across two tiers, plus the break-check protocol that verifies the
  tests can actually fail.

```bash
npm install
npm test          # headless, no browser
```

---

## Two tiers of test, and why

The spec's validation suite (§4.2) checks trim, modal characteristics, and energy
conservation, all at 5–10% tolerances. Those tolerances are right for physics — and
they make the suite structurally blind to the most likely defect in the project.

852 hand-entered coefficients. Mistype one by 10% and every physics test still
passes: trim converges, the modes stay in range, energy still decreases. The model is
permanently wrong and nothing says so.

So there are two tiers:

**Tier A — port fidelity.** A Python script drives the reference implementation over
~6,700 randomized operating points and dumps the results to JSON. The TypeScript port
must reproduce them to **1e-12**. Fixtures are committed, so `npm test` needs only
Node.

**Tier B — physics validity.** The spec's suite, at the spec's tolerances. Checks that
the thing being ported is an F-16 rather than merely that the port is faithful.

The break-check confirms neither is redundant. Changing one coefficient by 10% is
caught by Tier A and by **no** Tier B test. Swapping the integrator or moving the CG
is caught by Tier B and by no Tier A test. See
[`docs/BREAK_CHECK.md`](docs/BREAK_CHECK.md).

---

## Things the model does that are worth knowing

**It is longitudinally unstable, and that is correct.** At the reference CG of
0.35 c̄ the short-period mode has split into two real roots, one divergent, with a
time to double of about 2.7 seconds. This is the F-16's relaxed static stability —
the source wind tunnel study is titled for it — and it is why the real aircraft flies
by wire. Moving the CG forward restores conventional stability; the neutral point
sits between 0.33 and 0.35 c̄. The modal tests pin all of this.

The practical consequence for Day 2: the assist layer is not a nicety. Without pitch
augmentation this aircraft genuinely is not flyable by a human for long.

**Trim reproduces the reference solutions to 0.00%**, against a 5% allowance. The
low-speed end shows the back side of the drag curve — flying slower needs more
power — which falls out of the model rather than being put into it.

**It has a data envelope, and outside it there is no model.** The tables cover
α from −10° to +45° and β to ±30°. Beyond that the reference extrapolates without
limit; held full-deflection controls reach α > 100° and diverge to NaN in about six
seconds. The model stays bit-exact by default so Tier A keeps its meaning, while the
integrator clamps onto the data boundary — so departing the aircraft stays departure
rather than becoming a dead simulation.

**Altitude above ~40,000 ft is approximate.** The thrust tables stop at 50,000 ft and
Mach 1 and extrapolate to negative thrust above ~65,000 ft; the model's atmosphere
runs up to 10% too dense above 35,000 ft. Both are measured and pinned in tests
rather than assumed away.

---

## Sources

Every number in the model traces to a citation in
[`docs/SOURCES.md`](docs/SOURCES.md). The primary reference is NASA/TM-2003-212145,
*A Collection of Nonlinear Aircraft Simulations in MATLAB* (Garza & Morelli, NASA
Langley), whose Table 1 supplies the mass properties. The aerodynamic tables and the
executable reference for the golden vectors come from Stanley Bak's
[AeroBenchVVPython](https://github.com/stanleybak/AeroBenchVVPython), itself derived
from Stevens & Lewis, *Aircraft Control and Simulation*.

The `REQUIREMENTS.md` provenance labels are real: `[S]` sourced, `[A]` our own choice.
Source verification was the first task of Day 1, done before any number entered code.
Every recalled value in §2.1 turned out correct; three other claims in the spec did
not, and were corrected against the sources.

---

## Repository layout

```
packages/physics/          the flight model — no rendering dependency
  src/tables/              aero coefficient data and the lookup scheme
  src/aero/                coefficient build-up and the engine model
  src/                     dynamics, state, integrator, trim, linearization
  test/                    Tier A and Tier B
  fixtures/                committed golden vectors
  tools/                   fixture generation and the break-check (dev only)
docs/SOURCES.md            provenance for every number
docs/BREAK_CHECK.md        proof the tests can fail
```

Regenerating the fixtures or the table data needs Python 3 with numpy and scipy:

```bash
cd packages/physics
python3 tools/gen_golden.py --vendor   # downloads the reference, then generates
python3 tools/gen_tables.py            # re-extracts the coefficient tables
node tools/break_check.mjs             # the §4.3 protocol
```

None of that is needed to run the tests.

---

## Roadmap

- **Day 1 — Physics, headless.** Done.
- **Day 2 — Flight.** Renderer, authored heightmap, cameras, input conditioning and
  the assist layer, speed sensation.
- **Day 3 — Full cycle.** Ground reaction, takeoff and landing, slew mode, situation
  save/restore, a timed waypoint course.
- **Day 4 — HUD and ship.** Fighter HUD with a flight path marker, GitHub Pages
  deploy.

---

## License

MIT.
