# Sources

Provenance for every number in the flight model. Verified 2026-09-03, before any of
it was written into code, per `REQUIREMENTS.md` §2.1.

The rule this document exists to enforce: **nothing enters the aerodynamic model
without a traceable source.** If a value is here, it came from a reference. If it is
a design choice, it is labeled as one and lives outside the aero tables — on the
assist side of the §4.4 tuning boundary, where it is free to change.

---

## Primary references

**[NASA-TM] NASA/TM-2003-212145** — Garza, F. R. and Morelli, E. A., *A Collection of
Nonlinear Aircraft Simulations in MATLAB*, NASA Langley Research Center, 2003.
<https://ntrs.nasa.gov/api/citations/20030013626/downloads/20030013626.pdf>

The NASA-published form of the F-16 model. Contains the mass properties table, the
aerodynamic model structure, control deflection limits, and the documented ranges of
the tabulated data. This is the strongest source available for this project because
it is a primary NASA technical memorandum rather than a third-party transcription.

**[AEROBENCH] AeroBenchVVPython** — Bak, S., F-16 simulation in Python, derived from
Stevens & Lewis Appendix A. <https://github.com/stanleybak/AeroBenchVVPython>
Specifically `code/aerobench/lowlevel/`. Source of the aero table data itself and of
the geometry constants, and the executable reference the Tier A golden vectors are
generated from.

**[SL] Stevens, B. L. and Lewis, F. L.**, *Aircraft Control and Simulation*, Wiley.
The originating textbook. Not consulted directly; both sources above derive from it,
and where they overlap they agree.

**[TR-1538] NASA TR-1538 (1979)** — Nguyen, L. T. et al., *Simulator Study of
Stall/Post-Stall Characteristics of a Fighter Airplane with Relaxed Longitudinal
Stability*. The wind tunnel campaign the aerodynamic data ultimately derives from.
Cited for lineage; the tabulated data we use comes via [NASA-TM] and [AEROBENCH].

---

## Mass properties

[NASA-TM] Table 1, "Mass Properties of the Simulated F-16":

| Parameter | Value | Units |
|---|---|---|
| Weight | 20,500 | lb |
| Iₓ | 9,496 | slug·ft² |
| I_y | 55,814 | slug·ft² |
| I_z | 63,100 | slug·ft² |
| I_xz | 982 | slug·ft² |

CG reference: 0.35 c̄ ([NASA-TM] p.29 — "Aerodynamic coefficients are referenced to a
center of gravity location at 0.35 c̄").

### Cross-check against the reference code

[AEROBENCH] `subf16_model.py` does not carry the inertia tensor. It carries nine
precomputed moment-equation constants:

```
c1 = -.770     c4 = 1.642e-6   c7 = 1.792e-5
c2 = .02755    c5 = .9604      c8 = -.7336
c3 = 1.055e-4  c6 = 1.759e-2   c9 = 1.587e-5
```

Under Stevens' definitions, with `Γ = JₓJ_z − J_xz²`:

```
c1 = ((J_y − J_z)J_z − J_xz²)/Γ     c6 = J_xz/J_y
c2 = (Jₓ − J_y + J_z)J_xz/Γ         c7 = 1/J_y
c3 = J_z/Γ                          c8 = (Jₓ(Jₓ − J_y) + J_xz²)/Γ
c4 = J_xz/Γ                         c9 = Jₓ/Γ
c5 = (J_z − Jₓ)/J_y
```

Inverting these recovers:

| | recovered from c-constants | [NASA-TM] Table 1 | difference |
|---|---|---|---|
| Jₓ | 9,489.4 | 9,496 | 0.07% |
| J_y | 55,803.6 | 55,814 | 0.02% |
| J_z | 63,083.1 | 63,100 | 0.03% |
| J_xz | 981.6 | 982 | 0.04% |

Round-tripping the recovered tensor back through the definitions reproduces every
published `c` to better than 0.05%. Two sources that never reference each other's
numbers agree, so the values are not a shared transcription error.

`packages/physics/test/massProperties.test.ts` asserts this. The residual difference
is rounding in the published `c` constants, not disagreement.

Also consistent: [AEROBENCH] carries `rm = 1.57e-3` (inverse mass), giving
636.94 slug, which at `g = 32.17 ft/s²` is 20,490 lb — Table 1's 20,500 lb to within
the precision of `rm`.

---

## Geometry

[AEROBENCH] `subf16_model.py`:

| Parameter | Value | Units |
|---|---|---|
| Wing area S | 300 | ft² |
| Wingspan b | 30 | ft |
| Mean aerodynamic chord c̄ | 11.32 | ft |
| xcgr (CG reference) | 0.35 | fraction of c̄ |
| he (engine angular momentum) | 160.0 | slug·ft²/s |
| g | 32.17 | ft/s² |

Against the real F-16A Block 10: the cited 27.87 m² wing area is **299.99 ft²** — the
model's 300 ft² is the actual wing area, not a round number. Span differs by 3%
(9.45 m = 31.0 ft vs. 30 ft). Reference weight differs substantially and
intentionally: 11,467 kg normal takeoff = 25,280 lb against the model's 20,500 lb
combat weight.

---

## Data ranges — the boundaries the model is valid within

[NASA-TM] p.29, verbatim: static aerodynamic data is tabulated "as a function of
angle of attack and sideslip over the ranges −10° ≤ α ≤ 45° and −30° ≤ β ≤ 30°."
Dynamic (damping) data is tabulated at zero sideslip over the same α range.

| Quantity | Valid range |
|---|---|
| Angle of attack α | −10° … +45° |
| Sideslip β | −30° … +30° |
| Altitude (thrust table) | 0 … 50,000 ft |
| Mach (thrust table) | 0 … 1.0 |

**This corrects `REQUIREMENTS.md` §2, which said α −20° to +90°.** That is the range
of the TR-1538 wind tunnel test campaign, not of the tabulated data in either
fidelity mode. [AEROBENCH]'s Morelli (high-fidelity polynomial) implementation
carries the same −10°/+45° clamp, so switching fidelity modes does not widen it.

Consequences, both real:

- §4.2 test 5 probes α = −10°/+45° and β = ±30°, not −20°/+90°.
- The §5 AoA limiter ceiling must sit below 45°, not below 90°. Departure behavior
  above 45° is *not* modeled by data we have; anything there is extrapolation.

The atmosphere model is ISA to 60,000 ft as specified, but thrust lookups clamp at
the 50,000 ft / Mach 1.0 table edge and report that they clamped, rather than
extrapolating silently.

---

## Control limits

[NASA-TM] p.29:

| Surface | Limit |
|---|---|
| Throttle δth | 0 … 1 |
| Elevator δe | ±25° |
| Aileron δa | ±21.5° |
| Rudder δr | ±30° |

Actuator **rate** limits are not published with this dataset. They are ours to
choose (`[A]`), which puts them on the assist side of the §4.4 tuning boundary.

---

## Propulsion

[AEROBENCH] `thrust.py` — three 6×6 tables on (altitude, Mach) for idle, military,
and maximum power. Sea-level static: idle 1,060 lb, military 12,680 lb, maximum
20,000 lb. Power-level lag and throttle gearing from `pdot.py`, `rtau.py`,
`tgear.py`. Engine gyroscopic term uses `he = 160.0 slug·ft²/s`.

---

## Reference trim solutions

Generated by `packages/physics/tools/gen_golden.py` driving [AEROBENCH] — not
recalled, and reproducible on demand. Steady level flight, CG 0.35 c̄:

| altitude (ft) | Vt (ft/s) | α (deg) | elevator (deg) | throttle |
|---|---|---|---|---|
| 0 | 500 | 2.150 | −0.756 | 0.1375 |
| 10,000 | 500 | 3.417 | −0.652 | 0.1570 |
| 20,000 | 600 | 3.231 | −0.667 | 0.2268 |
| 30,000 | 700 | 3.445 | −0.650 | 0.2891 |
| 10,000 | 300 | 11.778 | −0.031 | 0.2266 |
| 10,000 | 900 | 0.047 | −0.927 | 0.4255 |

Solved by Nelder-Mead on (α, δe, δth) against a weighted residual of (V̇t, α̇, q̇),
multi-start over α; residuals converge to ~1e-25.

Sanity, for a reader without flight background: α falls monotonically as speed rises
(less lift coefficient needed at higher dynamic pressure), and throttle rises with
both speed and altitude (more drag at speed, less thrust available up high). Both
behaviors are what the physics requires, which is weak but genuine evidence the
solver is not converging to nonsense.

---

## A note on the table lookup scheme

The [AEROBENCH] table functions (`cx.py`, `dampp.py`, et al.) do **not** use standard
bilinear interpolation. They use a `fix`/`sign` index scheme with `abs(da)` weighting
and specific out-of-range index clamping. It is ported literally rather than
"cleaned up," because the exact edge and clamping behavior is part of the model.
Tier A golden vectors at 1e-12 are what enforce that.
