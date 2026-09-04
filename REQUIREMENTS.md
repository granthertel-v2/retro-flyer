# Retro Flyer — Requirements

Target: a browser-based flight simulator with an honest flight model and a
deliberately crude world. Reference points: the polygon-world feeling of early
Microsoft Flight Simulator, calibrated to Ace Combat handling expectations.

## Design thesis

**Crude on purpose everywhere except the flight model.** Terrain, lighting, and
scenery are low-poly and flat-shaded by choice. The 6DOF aerodynamic model is
not. This mismatch is the point, not an inconsistency to resolve — if a decision
is ambiguous, resolve it toward "simpler visuals, honest physics."

## Provenance key

Every numeric input below is labeled. Do not promote a label without evidence.

- `[S]` **Sourced** — traced to a cited reference
- `[V]` **To verify** — stated from memory, must be checked against the primary
  source before it lands in code
- `[A]` **Assumption / design choice** — chosen by us, not derived from anything

---

## 1. Scope

**In:** single aircraft, single authored map, free flight, takeoff and landing,
timed waypoint course, HUD, assist layer, situation save/restore, slew mode.

**Out for MVP:** weapons, damage, AI traffic, multiplayer, real-world elevation
data, weather beyond steady wind and turbulence, systems failures (electrical,
hydraulic, icing), ATC, multiple aircraft.

**Deferred but architecturally reserved:** weapons and stores. See §8.4.

---

## 2. Aircraft

**F-16A**, modeled on the open academic dataset from Stevens & Lewis,
*Aircraft Control and Simulation*, whose aerodynamic tables derive from
NASA Technical Report 1538 (1979), *Simulator Study of Stall/Post-Stall
Characteristics of a Fighter Airplane with Relaxed Longitudinal Stability*. `[S]`

Why this airframe: it is the most thoroughly documented open 6DOF dataset
available, with published trim solutions and open reference implementations in
MATLAB and Python built explicitly as a verification benchmark. It gives us
falsifiable targets, which matters disproportionately here because the developer
has no real flying experience to check the model against.

The published **table** range covers angle of attack from −10° to +45° and
sideslip from −30° to +30°. `[S]` Use the low-fidelity mode for MVP; high-fidelity
mode (leading-edge flap, polynomial fit) is a later swap behind the same interface.

> **Corrected 2026-09-03.** This previously read −20° to +90°. That is the range of
> the *wind tunnel test campaign* behind NASA TR-1538, not the range of the tabulated
> data in either fidelity mode. NASA/TM-2003-212145 p.29 states the F-16 static aero
> data is tabulated over −10° ≤ α ≤ 45° and −30° ≤ β ≤ 30°, and the reference
> Morelli implementation clamps to the same range. The corrected bounds are what
> §4.2 test 5 probes and what the §5 AoA limiter must sit below.

### 2.1 Geometry and mass — VERIFIED

All values below were verified against primary sources on 2026-09-03, before any
were written into code. Every recalled value proved correct. Full provenance,
including the independent cross-check, is in `docs/SOURCES.md`.

| Parameter | Value | Source | Label |
|---|---|---|---|
| Wing area S | 300 ft² | AeroBench `subf16_model.py` | `[S]` |
| Wingspan b | 30 ft | AeroBench `subf16_model.py` | `[S]` |
| Mean aerodynamic chord c̄ | 11.32 ft | AeroBench `subf16_model.py` | `[S]` |
| Reference weight | 20,500 lb | NASA/TM-2003-212145 Table 1 | `[S]` |
| Ixx | 9,496 slug·ft² | NASA/TM-2003-212145 Table 1 | `[S]` |
| Iyy | 55,814 slug·ft² | NASA/TM-2003-212145 Table 1 | `[S]` |
| Izz | 63,100 slug·ft² | NASA/TM-2003-212145 Table 1 | `[S]` |
| Ixz | 982 slug·ft² | NASA/TM-2003-212145 Table 1 | `[S]` |
| CG reference | 0.35 c̄ | NASA/TM-2003-212145 p.29; AeroBench `xcgr` | `[S]` |

**Independent cross-check.** The reference code carries precomputed moment
constants `c1…c9` rather than a raw inertia tensor. Inverting Stevens' definitions
(`c7 = 1/Jy`, `c6 = Jxz/Jy`, `c5 = (Jz−Jx)/Jy`, `c3 = Jz/Γ`, `c9 = Jx/Γ`, where
`Γ = JxJz − Jxz²`) recovers Jx = 9,489, Jy = 55,804, Jz = 63,083, Jxz = 982 —
agreeing with NASA Table 1 to 0.1%, with the `c` round trip closing to <0.05%. Two
independent sources concur. This is enforced as a test, not just recorded here.

### 2.1.1 Control deflection limits

| Surface | Limit | Source | Label |
|---|---|---|---|
| Throttle δth | 0 … 1 | NASA/TM-2003-212145 p.29 | `[S]` |
| Elevator δe | ±25° | NASA/TM-2003-212145 p.29 | `[S]` |
| Aileron δa | ±21.5° | NASA/TM-2003-212145 p.29 | `[S]` |
| Rudder δr | ±30° | NASA/TM-2003-212145 p.29 | `[S]` |

For cross-checking against real-aircraft figures, an F-16A Block 10 reference
gives wing area 27.87 m², wingspan 9.45 m, length 15.03 m, sweep 40°, normal
takeoff weight 11,467 kg. `[S]` The model is what the tests validate against, not
the airframe — but the comparison came out closer than this section expected:

- **Wing area matches exactly.** 27.87 m² = 299.99 ft². The model's 300 ft² is the
  real wing area, not an approximation of it.
- **Span differs by 3%.** 9.45 m = 31.0 ft against the model's 30 ft.
- **Weight differs substantially, by design.** 11,467 kg = 25,280 lb against the
  model's 20,500 lb reference. The model sits at a combat weight (roughly empty
  plus partial fuel), not a normal takeoff weight. Mass is computed from a loadout
  per §8.4, so this is a starting condition rather than a constant.

### 2.2 Propulsion

Thrust from the model's lookup table across idle / military / afterburner
settings as a function of Mach and altitude. `[S]` — verified: three 6×6 tables on
(altitude, Mach), plus first-order power-level lag and a throttle gearing curve.
Sea-level static values are 1,060 lb idle, 12,680 lb military, 20,000 lb maximum.
Throttle maps 0–1 to idle→mil, with afterburner engaged above a detent. `[A]`

### 2.3 Atmosphere

ISA standard atmosphere, sea level to 60,000 ft. Density, pressure, temperature,
speed of sound. No non-standard days for MVP. `[A]`

**The thrust table does not cover that range.** Engine data is tabulated only over
0 ft ≤ h ≤ 50,000 ft and 0 ≤ M ≤ 1 (NASA/TM-2003-212145 p.29). `[S]` Above 50,000 ft
or beyond Mach 1 we are outside the data.

What the reference model does there, verified by reading it rather than assumed: it
clamps the table *index* but lets the interpolation weight run past 1, so it
**linearly extrapolates**. Past roughly 65,000 ft that yields negative thrust at high
power settings. We keep that behavior — it is the model, and Tier A pins it — but the
engine exposes a `thrustOutsideTable()` predicate so flying up there is a decision
rather than an accident.

**A second, related limit.** The model's own atmosphere keeps applying the
troposphere density law into the stratosphere, so above 35,000 ft it runs
progressively too dense: +3.5% at 40,000 ft, ~+10% at 50,000 and 60,000 ft (measured
in `test/atmosphere.test.ts`). Taken together, altitudes above ~40,000 ft are
approximate in both thrust and air density. Fine for MVP; worth knowing before anyone
builds a high-altitude objective.

---

## 3. Flight model

Six-degree-of-freedom rigid body. Quaternion attitude representation — not Euler
angles, to avoid gimbal lock at the high pitch attitudes this airframe will
routinely see. `[A]`

- Forces and moments from table lookup on (α, β, control deflections), with
  cubic or linear interpolation between table nodes
- Integrator: RK4 at a fixed 120 Hz physics tick, decoupled from render frame
  rate `[A]`
- Control surfaces: elevator/stabilator, aileron, rudder. Deflection limits are
  sourced (§2.1.1). Actuator **rate** limits are not published with this dataset and
  are ours to choose `[A]` — which places them on the assist side of the §4.4 tuning
  boundary, free to tune for feel.
- Landing gear as spring-damper ground reaction with per-strut compression,
  static and dynamic friction, and wheel brakes `[A]`
- Steady wind vector plus turbulence, both runtime-adjustable `[A]`

**No stability augmentation in the physics layer.** The real F-16 is
longitudinally unstable and flies via fly-by-wire. Our equivalent lives in the
assist layer (§5), where it can be toggled and where changing it cannot
invalidate the physics tests.

---

## 4. Validation harness

This section is load-bearing. It is the only ground truth available.

### 4.1 Trim solver

Numerically solve for the control and throttle settings producing steady flight
at a specified altitude, airspeed, and flight condition (level, climbing,
coordinated turn). This is the single most likely piece to overrun on Day 1 —
budget for it.

### 4.2 Tests

Extract reference trim solutions from the source text or a reference
implementation and assert our model reproduces them. `[S]` — generated by running
the AeroBench reference implementation, not recalled. Steady level flight, CG at
0.35 c̄:

| altitude (ft) | Vt (ft/s) | α (deg) | elevator (deg) | throttle |
|---|---|---|---|---|
| 0 | 500 | 2.150 | −0.756 | 0.1375 |
| 10,000 | 500 | 3.417 | −0.652 | 0.1570 |
| 20,000 | 600 | 3.231 | −0.667 | 0.2268 |
| 30,000 | 700 | 3.445 | −0.650 | 0.2891 |
| 10,000 | 300 | 11.778 | −0.031 | 0.2266 |
| 10,000 | 900 | 0.047 | −0.927 | 0.4255 |

These are regenerable — `packages/physics/tools/gen_golden.py` reproduces them from
the reference model, so they are checkable rather than merely asserted.

### 4.2.1 Two tiers of test

§4.2 as originally written cannot catch a transcription error. The aero model is
roughly a thousand hand-entered table numbers; a single mistyped coefficient moves
results by far less than the 5% tolerance below, so the suite stays green while the
model is quietly wrong. On Day 1 that is the likeliest defect of all. So:

- **Tier A — port fidelity.** Golden vectors generated from the reference
  implementation over thousands of randomized `(α, β, p, q, r, δe, δa, δr, alt, M)`
  points. Our port must reproduce coefficients and thrust to **1e-12**. Pure
  functions, no attitude, no integration. This is the only thing that catches a
  mistyped table entry.
- **Tier B — physics validity.** The suite below, at the stated tolerances.
  Validates that the model *is* an F-16, not merely that the port is faithful.

Tier A fixtures are committed, so the suite runs on Node alone; Python is needed
only to regenerate them.

Minimum suite (Tier B):

1. **Steady level trim** at 2–3 altitude/airspeed pairs, matching published α,
   elevator, and throttle within tolerance
2. **Trim continuity** — trim solutions vary smoothly across an airspeed sweep,
   no discontinuities that would indicate a table interpolation error
3. **Short-period mode** — perturb pitch from trim, measure damping ratio and
   natural frequency against published linearized values
4. **Dutch roll mode** — same, laterally
5. **Table boundary behavior** — model does not produce NaN or unbounded forces
   at the α and β table edges
6. **Energy sanity** — in an unpowered glide from trim, total energy decreases
   monotonically

Tolerance: 5% on trim values, 10% on modal characteristics. `[A]` Tighten once
the model is stable.

### 4.3 The break-check protocol

**A passing suite proves nothing until each test is confirmed able to fail.**
Before trusting the harness, deliberately corrupt the model — invert a lift
coefficient sign, zero the pitching moment table, offset the CG — and confirm
the specific tests you expect to go red actually do. A test aimed at the wrong
state variable reports clean forever.

Run this once at the end of Milestone 1 and record the results in the repo.

### 4.4 The tuning boundary

When the aircraft feels wrong, **tune the control layer, never the aerodynamic
coefficients.** Smoothing, rate limits, deadband, and assist gains are fair game.
Table values are not. If a change improves feel and turns a validation test red,
the change is wrong. The tests exist to enforce this boundary, and it is the
main thing standing between this project and an arcade flyer with extra steps.

---

## 5. Control and assist layer

Sits between raw input and the physics model. This is where Ace Combat feel is
manufactured, and it is entirely separable from the model beneath it.

**Input conditioning** (always on, keyboard is the primary device):

- Rate-limited inputs with exponential smoothing and a self-centering deadband
- Bang-bang keyboard input must never reach the model directly

**Assists** (individually toggleable, all on by default):

| Assist | Behavior |
|---|---|
| Auto-coordination | Rudder commanded to hold β ≈ 0 during rolls and turns |
| Pitch rate command | Stick maps to commanded pitch rate, not surface deflection |
| AoA limiter | Soft ceiling below departure onset |
| G limiter | Caps commanded normal acceleration |
| Roll rate amplification | Scales roll authority above baseline |

Ace Combat is, mechanically, maximum assists over a loose model. All assists on
should approximate that. All assists off should be genuinely difficult and
departure-prone. Both are correct behavior.

Gamepad support via the Gamepad API is welcome but must never be required. `[A]`

---

## 6. Renderer and speed sensation

Three.js, WebGL. Flat-shaded low-poly, no textures for MVP. Cameras: chase
(default), cockpit, external orbit.

**Speed sensation is authored, not emergent, and belongs in Milestone 2 rather
than polish.** It is a large fraction of what "feels right" means here:

- FOV widening with airspeed
- Ground detail density and near-field visual reference so low-altitude speed reads
- Camera lag and settle under hard maneuvering
- Optional subtle motion blur or speed lines at high Mach

---

## 7. Terrain

Authored fictional heightmap, designed rather than random: a coastline and bay,
a ridge line worth flying through, a river, a city grid for visual reference, and
three to four airfields 20–60 nm apart. `[A]`

Real elevation data is explicitly out of MVP scope and is a later swap behind the
terrain-source interface (§8.2). Real DEM buys accurate topography and nothing
else — no coastlines, cities, roads, or airports — so an authored map serves the
"world in polygons" goal better at this stage.

---

## 8. Interface contracts

Spend the architecture budget on exactly these four seams and nowhere else. No
entity-component system, no plugin layer, no abstracted input manager. There is
one aircraft and one world.

### 8.1 Input → Aero
The assist layer consumes raw device state and emits normalized control surface
commands and throttle. The physics model knows nothing about keyboards, assists,
or smoothing.

### 8.2 Terrain source → Renderer
The renderer requests height and surface type at world coordinates. It does not
know whether the answer came from an authored heightmap or a DEM tile. This is
what makes real terrain a later swap rather than a rewrite.

### 8.3 Aero → Renderer
The renderer consumes aircraft state (position, quaternion, velocity, surface
deflections, gear position). It never writes to the model. Physics runs at fixed
tick; rendering interpolates.

### 8.4 Mass properties → Aero
Mass, CG, and inertia tensor are **computed from a loadout description**, not
stored as constants — even though the loadout is empty and fuel is the only
variable for MVP. This is ~20 lines now and is what makes adding stores later a
change rather than a rewrite of the mass model.

---

## 9. Milestones

Four-day build, Friday through Monday. Each milestone ships independently.

**Day 1 — Physics, headless.** Source parameter verification, 6DOF integrator,
aero table loading and interpolation, trim solver, validation suite, break-check
protocol. No graphics at all.
*Acceptance:* suite green, and break-check documented showing each test can fail.

**Day 2 — Flight.** Renderer, authored heightmap, cameras, input conditioning
and assist layer, speed sensation.
*Acceptance:* you can take off from altitude, fly the map, and it reads as fast.

**Day 3 — Full cycle and objectives.** Ground reaction, brakes, takeoff and
landing from a runway, slew mode, situation save/restore, timed waypoint course.
*Acceptance:* complete a runway-to-runway flight through the course.

**Day 4 — HUD and ship.** HUD, GitHub Pages deploy, README.
*Acceptance:* live link, someone else can fly it.

### 9.1 On the HUD

A fighter HUD is both easier to build than a six-gauge steam panel and better
targeted: airspeed and altitude tapes, heading strip, pitch ladder, Mach and G
readout, and a **flight path marker** — which is the single most valuable
instrument for a non-pilot, because it shows where the aircraft is actually
going rather than where it is pointed. The gap between those two symbols is the
entire intuition this project is trying to build.

### 9.2 Post-MVP

Navaids and ILS approach. Real elevation data for one bounded region.
High-fidelity aero mode. Weapons — unscheduled, but the seam in §8.4 is reserved.

---

## 10. Repository

Public, MIT. TypeScript, Vite, three.js. Vitest for the validation suite.
GitHub Pages deploy on push to `main`. Physics package has no rendering
dependency and its tests run headless in CI.
