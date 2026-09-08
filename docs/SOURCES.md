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

---

# Region data

Everything above concerns the flight model. This section covers the *world* — the
real-terrain regions built by `packages/app/tools/build_region.py` and committed
under `packages/app/public/regions/`.

The same rule applies, with one addition. Values that describe reality are `[V]` and
must be traceable to a source. Values that are *choices about presentation* are `[A]`
and are listed here so that changing one is a decision rather than a discovery.

## Primary sources

**[3DEP] USGS 3D Elevation Program**, bare-earth digital elevation model, served as a
dynamic image service.
<https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer>

A work of the US government and therefore public domain. Bare earth matters: the
model is the ground with buildings and vegetation removed, which is what a terrain
mesh wants, because the buildings arrive separately from OpenStreetMap and would
otherwise be counted twice.

**[OSM] OpenStreetMap**, via the Overpass API. <https://www.openstreetmap.org/>

Licensed **ODbL**. This is an obligation, not a courtesy, and it travels with derived
data — which is why the attribution strings live inside each region's manifest rather
than in a README that a copied file would leave behind.

**[WIKIDATA] Wikidata**, property P2048 (height). <https://www.wikidata.org/>

CC0. Used for one thing: the heights of notable buildings OpenStreetMap has none for.
Ninety of the 392 named buildings in Chicago's Loop carry neither `height` nor
`building:levels`, and **Willis Tower is one of them** — the tallest thing in the
city, absent from the skyline because a tag was never filled in. The buildings
already carry a `wikidata` tag, so this is following an identifier OSM chose, not
guessing.

It also supplies heights for landmarks that are structures rather than buildings —
a statue, an obelisk, a lighthouse — which have no height anywhere in OpenStreetMap.
Those are drawn as a plain tapered column of the right height in the right place, and
nothing more: there is no model of the Statue of Liberty here, and modelling one
would be the hand-work that stops landmarks generalising to a second city.

Note what the figure means. The Statue of Liberty comes back as **46.9 m**, which is
the statue; the 93 m people quote includes the pedestal it stands on. The sourced
number is what gets drawn, and the difference is recorded here rather than quietly
corrected — adding forty metres to make the picture look right is exactly the kind of
unsourced value this document exists to prevent.

Read **SI-normalised** (`psn:`), not raw. Wikidata stores a height in whatever unit
its source used and returns the bare number: the Empire State Building carries both
453 (metres) and 1500 (feet), and taking the larger raw figure made it a 1,500 m
building and put a 749 m box on the New York skyline. Where an entity gives several
heights — roof, observation deck, spire — the largest is taken, which is the figure
the building is known by.

**[FAA] FAA Aeronautical Information Services**, `Runways` and `US_Airport` layers.
<https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services>

Public domain. The authority for every runway number in a region manifest.

## Verification performed

- **The projection was proved, not reviewed.** The builder needs the inverse
  projection in Python and the runtime needs the forward one in TypeScript. Rather
  than trust the port, `tools/gen_projection_fixture.py` emits pairs that
  `test/geo.test.ts` recomputes through `GeoFrame`, requiring agreement to 0.1 mm
  across four origins and both hemispheres. A 1 mm divergence fails the suite.
- **The GeoTIFF decoder was checked against an independent service.** Elevations read
  out of the raster agree with the USGS point-query service — a different endpoint
  and a different code path — to 0.2 m at the raster maximum, and to under a metre on
  flat ground. Larger differences appear only on 30% slopes, where an 8 m cell cannot
  match a 1 m point query.
- **The raster's coordinate convention is read from the file, not assumed.** The
  reader refuses anything that is not geographic WGS 84 with `RasterPixelIsArea`. A
  Web Mercator raster, which decodes as perfectly valid floats and would be sampled
  as though metres were degrees, is rejected.
- **Runway dimensions cross-check between independent sources.** The FAA publishes
  LaGuardia 13/31 as 7,002 ft; its own runway polygon measures 2,134.3 m against a
  published 2,134.2 m, and OpenStreetMap, mapped by different people, says 2,135 m.
- **Bridges are filtered by the region's own water raster.** OpenStreetMap's longest
  named "bridges" are elevated railway viaducts — four kilometres of the BMT Jamaica
  Line in New York, the L in Chicago — so length cannot be the test. A bridge is a
  thing with water under it, and the surface grid already knows where the water is,
  which means the filter agrees with the coastline by construction and needs no
  extra query. All eleven crossings anyone could name in New York survive it.
- **The builder was tested on a second region, and that is what found the worst
  bug.** New York is bounded by `natural=coastline`; Chicago has none at all, because
  the tag is for the sea and the Great Lakes are ordinary water polygons. Building
  Chicago exercised the fallback path and immediately reported the region as 2.9%
  water: a multipolygon's outer boundary is not one member but an arbitrary number of
  open fragments in arbitrary directions, and Lake Michigan's relation has 743 outer
  members of which **none is closed**. Treating each as its own ring turned the lake
  into slivers. Small multipolygons hide this completely — a park with one hole
  usually is one closed way per ring — so no amount of further work on New York would
  have found it.
- **The coastline was checked against elevation.** OpenStreetMap decides what is
  water and USGS decides how high the ground is. Water cells in the New York region
  have a median elevation of 0.0 m and a 90th percentile of 0.5 m, while forest sits
  at 92 m. The two datasets were assembled independently, so their agreement is
  evidence rather than restatement.

  Chicago makes the same check sharper. Its water is Lake Michigan, whose surface the
  region reproduces at **176.0 m** with a 10th-to-90th-percentile spread of 0.8 m.
  Nothing in the builder knows that figure: OpenStreetMap decided which cells are
  lake and USGS decided how high they are. Two sources agreeing on a number neither
  was given is the strongest evidence available that the coastline and the elevation
  describe the same place.

## A disagreement worth recording

**The elevation model and the FAA disagree about airports, and the FAA wins.**

USGS puts LaGuardia's 13/31 midpoint at 1.96 m, its 04/22 midpoint at 4.38 m and the
terminal apron at **−1.62 m**. The FAA publishes the field at 20.7 ft, or 6.31 m. Both
USGS figures were confirmed through the point-query service, so this is the data and
not a decoding error — the airport is landfill in Flushing Bay and the bare-earth
model over it is poor. Kennedy shows the same effect more mildly.

Shipping that unaltered means a runway laid across eight metres of slope, which is a
hill you land on. So the builder flattens each tier to the published field elevation
across the runway and a pad around it, then ramps out — the same thing `authored.ts`
does, for the same reason, and what the flat pad in `source.ts` already promises the
physics. Verified: every one of the 22 runways in the New York region sits on ground
flat to 0.00 m of spread across its pad.

## Design choices `[A]`

These are not measurements. Each is a judgement, and each is recorded because the
`[A]` marking is the difference between a decision and an accident.

| Choice | Value | Why |
|---|---|---|
| Storey height, when only a floor count is tagged | 3.05 m | Ten feet, which is how most of the American building stock this will ever see was laid out. Moves a twenty-storey tower by one storey. |
| Height for a building with no usable height tag | 12 m | Nearly unreachable — such buildings fail the height filter — but a building drawn at zero height is a visible flat plate. |
| Buildings shipped per region | 50,000, tallest first | A **count budget**, not a height. See below. |
| Flat pad beyond a runway | 150 m | What `source.ts` already states and the 12 cm runway lift ramps out inside. |
| Ramp from pad back to real terrain | 350 m | Turns the worst case, eight metres at LaGuardia, into a 2.3% slope well outside the landing roll. |
| Tall buildings per 3×3 cell before ground counts as dense city | 3 | About 13 hectares, three or four Manhattan blocks. Counting per single cell left downtown speckled. |
| Finest elevation cell | 60 m | Exactly the innermost LOD ring in `mesh.ts`. Finer cannot be drawn, only stored. |
| Surface-class cell | 120 m | Land cover is flat colour and survives being coarser than the heightfield. A crisper coastline is worth more than a crisper park boundary. |
| Landmark notability filter | a Wikipedia article | 506 of New York's 969 "landmarks" are plaques on walls. Requiring a Wikidata entity, and preferring a Wikipedia article, keeps the ones a person would name — somebody wrote an article about them, which beats any tag as a test of fame. |
| Landmark ordering, after that | distance from the tall buildings | 71 of Chicago's 81 artworks have an article, so notability alone cannot order them. Famous things cluster downtown, and downtown is already known as the centre of mass of the skyline. |
| Shortest bridge drawn | 60 m | Keeps the Chicago River bascules, which are the character of that riverfront. |
| Water a bridge must span | 100 m continuous | Not "mostly over water": the Brooklyn Bridge's longest way is 2,165 m of which only the main span crosses the river, and a fraction test threw it away while keeping viaducts running along a shoreline. |
| Bridge clearance at mid-span | length x 0.055, capped at 60 m | The Verrazzano gives 69 m and a bascule about five; span length is the only signal that separates them. |
| Shortest landmark drawn as a marker | 15 m | Below that it is a plinth, invisible from an aeroplane. |
| Region bundle budget | ~3.7-4.0 MB, ~1.6 MB gzipped | New York 3.65 MB, Chicago 3.98 MB. About 700,000 triangles a frame, of which the buildings are roughly 450-500,000. |

## Why the buildings are budgeted rather than thresholded

A fixed height threshold cannot serve two cities, and the reason is tagging rather
than architecture. At 20 m it returns **30,466 buildings in New York and 291 in
Chicago** — but the regions hold almost exactly the same number of mapped footprints,
1,081,496 against 1,015,768.

The difference is which tag they were imported with:

| | New York | Chicago |
|---|---|---|
| footprints mapped | 1,081,496 | 1,015,768 |
| with `height` in metres | **897,927 (83%)** | **433 (0.04%)** |
| with `building:levels` | 17,180 | **320,682 (32%)** |

New York received a bulk import of measured heights; Chicago received floor counts.
Judged on the metric both actually carry, the cities are close — 1,246 buildings of
ten storeys or more in Chicago against 1,715 in New York, which is about the real
ratio.

So the fixed, reasoned-about number is the **budget**, and the height threshold is
searched per region by binary search over cheap count queries until it fills. That is
one rule applied to two datasets, not two rules: New York settles at 18 m and Chicago
at 9 m, and the difference between those numbers is exactly the difference between
the two imports. Chicago went from 2,044 buildings to 42,312.

Two things this exposed:

- **The query and the filter rounded differently.** The Overpass query admitted
  `building:levels >= 6` while the filter demanded 20 m, and six floors at 3.05 m is
  18.3 — so every six-storey building was fetched and thrown away. In a city whose
  heights are almost entirely floor counts that is a whole storey band lost. Both use
  `ceil` now.
- **Chicago's heights are quantised by storey.** Three floors gives 42,358 buildings
  and four gives 6,477, with nothing in between. A 40,000 budget fell the wrong side
  of that cliff and cost the city six sevenths of its fabric to save 6% of the
  budget; 50,000 clears it.

## A known limitation

A small number of inland cells are missed by the coastline fill and remain water:
0.4% of New York and 0.8% of Chicago, isolated and away from any mapped water. At
120 m they are single stray cells rather than anything a pilot would notice, and
`test/regions.test.ts` bounds the figure so a regression that scatters the map cannot
pass as normal. It has not been tracked to a cause.

## Why the land-cover classes exist

`mesh.ts` originally coloured land by altitude — olive below 520 m, then green, rock,
snow. Manhattan's highest natural ground is about 60 m and the Palisades reach 113 m,
so every land triangle in the region falls in the bottom eighth of the lowest band
and the whole map renders as one uniform olive plain: correct elevation, correct
coastline, unreadable. Real ground is therefore coloured by what it *is*, which is
why `Surface` gained `Forest`, `Grass`, `Sand` and `Suburb`. They mean nothing to the
physics — `groundSource.ts` maps everything that is not runway or water to soft
ground — and that is deliberate.
