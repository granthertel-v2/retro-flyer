#!/usr/bin/env python3
"""
Generate Tier A golden vectors from the reference F-16 implementation.

Why this exists
---------------
The aero model is roughly a thousand hand-entered table numbers. Every physics test
in REQUIREMENTS §4.2 carries a 5-10% tolerance, and a single mistyped coefficient
moves results by far less than that. So the physics suite can be fully green while
the model is quietly wrong, permanently. This script closes that hole: it drives the
reference implementation over thousands of randomized operating points and records
exactly what it produces, so the TypeScript port can be held to 1e-12 rather than 5%.

This is a DEV-ONLY tool. The fixtures it writes are committed, so `npm test` needs
nothing but Node. You only need to run this if you are changing the aero tables, and
if you are changing the aero tables you should read REQUIREMENTS §4.4 first.

Usage
-----
    python3 tools/gen_golden.py [--vendor] [--points N]

    --vendor   Download the reference implementation into tools/vendor/ first.
               Requires network. The vendor directory is gitignored.
    --points   Number of randomized sample points per fixture (default 2000).

Determinism
-----------
The RNG is seeded with a fixed constant, so re-running reproduces byte-identical
fixtures. If a regenerated fixture differs, something in the reference changed, and
that is worth knowing rather than silently absorbing.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor"
FIXTURES = HERE.parent / "fixtures"

RAW_BASE = (
    "https://raw.githubusercontent.com/stanleybak/AeroBenchVVPython/master/code/aerobench"
)

LOWLEVEL_MODULES = [
    "adc", "tgear", "pdot", "rtau", "thrust",
    "cx", "cy", "cz", "cl", "cm", "cn",
    "dampp", "dlda", "dldr", "dnda", "dndr",
    "morellif16", "subf16_model",
]

SEED = 20260903

# Sampling ranges. Deliberately a little WIDER than the documented validity range
# (alpha -10..45, beta -30..30) so that the port's out-of-range clamping behavior is
# pinned too. The reference clamps rather than extrapolating, and getting that edge
# behavior wrong is exactly the kind of bug that hides until someone departs the
# aircraft. See docs/SOURCES.md.
ALPHA_DEG = (-20.0, 55.0)
BETA_DEG = (-40.0, 40.0)
ELEV_DEG = (-25.0, 25.0)
AIL_DEG = (-21.5, 21.5)
RDR_DEG = (-30.0, 30.0)
RATE_RAD_S = (-2.0, 2.0)
VT_FPS = (200.0, 1200.0)
ALT_FT = (0.0, 60000.0)
POWER_PCT = (0.0, 100.0)


def vendor_reference() -> None:
    """Download the reference implementation. Network required.

    Uses curl rather than urllib deliberately: a stock python.org install on macOS
    ships without a configured SSL trust store, so urllib fails with
    CERTIFICATE_VERIFY_FAILED on a machine where curl works fine. Shelling out
    sidesteps a setup step that has nothing to do with flight dynamics.
    """
    (VENDOR / "aerobench" / "lowlevel").mkdir(parents=True, exist_ok=True)
    (VENDOR / "aerobench" / "__init__.py").touch()
    (VENDOR / "aerobench" / "lowlevel" / "__init__.py").touch()

    targets = [("util.py", VENDOR / "aerobench" / "util.py")]
    targets += [
        (f"lowlevel/{m}.py", VENDOR / "aerobench" / "lowlevel" / f"{m}.py")
        for m in LOWLEVEL_MODULES
    ]

    for remote, local in targets:
        url = f"{RAW_BASE}/{remote}"
        print(f"  fetching {remote}")
        result = subprocess.run(
            ["curl", "-sfL", "--max-time", "60", "-o", str(local), url],
            capture_output=True,
        )
        if result.returncode != 0 or local.stat().st_size == 0:
            sys.exit(f"failed to fetch {url} (curl exit {result.returncode})")

    print(f"vendored reference implementation into {VENDOR}")


def require_reference():
    """Import the reference implementation, explaining clearly if it is absent."""
    if not (VENDOR / "aerobench").is_dir():
        sys.exit(
            "Reference implementation not vendored.\n"
            "Run:  python3 tools/gen_golden.py --vendor\n"
            "(needs network; tools/vendor/ is gitignored)"
        )
    sys.path.insert(0, str(VENDOR))
    try:
        import numpy  # noqa: F401
    except ImportError:
        sys.exit("numpy required:  pip3 install numpy scipy")


def round_trip(value):
    """Force a value through the exact float64 that JSON will carry.

    Guards against a subtle failure: if Python serializes more precision than JSON
    round-trips, the TS side compares against a number Python never actually
    produced, and a 1e-12 tolerance turns into noise.
    """
    return json.loads(json.dumps(value))


def gen_coefficients(n: int) -> dict:
    """Static and dynamic aerodynamic coefficients over randomized states.

    These are pure functions of (alpha, beta, controls) plus the damping tables --
    no attitude, no integration, no atmosphere. That isolation is the point: a
    failure here is a table transcription error and nothing else.
    """
    import random

    from aerobench.lowlevel.cx import cx
    from aerobench.lowlevel.cy import cy
    from aerobench.lowlevel.cz import cz
    from aerobench.lowlevel.cl import cl
    from aerobench.lowlevel.cm import cm
    from aerobench.lowlevel.cn import cn
    from aerobench.lowlevel.dampp import dampp
    from aerobench.lowlevel.dlda import dlda
    from aerobench.lowlevel.dldr import dldr
    from aerobench.lowlevel.dnda import dnda
    from aerobench.lowlevel.dndr import dndr

    rng = random.Random(SEED)
    cases = []

    # Exact table nodes first. Interpolation schemes are most likely to be wrong
    # exactly ON a node (off-by-one in the index, wrong tie-breaking on the sign
    # test), and random sampling almost never lands on one.
    node_alphas = [-10.0 + 5.0 * i for i in range(12)]
    node_elevs = [-24.0, -12.0, 0.0, 12.0, 24.0]
    node_betas = [-30.0 + 5.0 * i for i in range(13)]

    grid = [
        (a, b, e)
        for a in node_alphas
        for b in node_betas[::3]
        for e in node_elevs
    ]

    # Then randomized points, including out-of-range, to pin clamping.
    randomized = [
        (
            rng.uniform(*ALPHA_DEG),
            rng.uniform(*BETA_DEG),
            rng.uniform(*ELEV_DEG),
        )
        for _ in range(n)
    ]

    for alpha, beta, el in grid + randomized:
        ail = rng.uniform(*AIL_DEG)
        rdr = rng.uniform(*RDR_DEG)
        d = dampp(alpha)

        cases.append(
            {
                "in": round_trip(
                    {"alpha": alpha, "beta": beta, "el": el, "ail": ail, "rdr": rdr}
                ),
                "out": round_trip(
                    {
                        "cx": cx(alpha, el),
                        "cy": cy(beta, ail, rdr),
                        "cz": cz(alpha, beta, el),
                        "cl": cl(alpha, beta),
                        "cm": cm(alpha, el),
                        "cn": cn(alpha, beta),
                        "dlda": dlda(alpha, beta),
                        "dldr": dldr(alpha, beta),
                        "dnda": dnda(alpha, beta),
                        "dndr": dndr(alpha, beta),
                        "dampp": [float(v) for v in d],
                    }
                ),
            }
        )

    return {
        "description": "Static + dynamic aero coefficients from the reference "
                       "implementation. Tier A, tolerance 1e-12.",
        "source": "AeroBenchVVPython code/aerobench/lowlevel/",
        "seed": SEED,
        "cases": cases,
    }


def gen_engine(n: int) -> dict:
    """Thrust, throttle gearing, power-level lag, and the atmosphere function."""
    import random

    from aerobench.lowlevel.adc import adc
    from aerobench.lowlevel.tgear import tgear
    from aerobench.lowlevel.pdot import pdot
    from aerobench.lowlevel.rtau import rtau
    from aerobench.lowlevel.thrust import thrust

    rng = random.Random(SEED + 1)

    # Table nodes: altitude every 10k to 50k, Mach every 0.2 to 1.0.
    node_alts = [0.0, 10000.0, 20000.0, 30000.0, 40000.0, 50000.0]
    node_machs = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
    node_powers = [0.0, 25.0, 50.0, 75.0, 100.0]

    thrust_cases = []
    for alt in node_alts:
        for mach in node_machs:
            for power in node_powers:
                thrust_cases.append(
                    {
                        "in": round_trip({"power": power, "alt": alt, "mach": mach}),
                        "out": round_trip({"thrust": thrust(power, alt, mach)}),
                    }
                )

    # Randomized, including beyond the 50k/M1.0 table edge to pin clamping.
    for _ in range(n):
        power = rng.uniform(*POWER_PCT)
        alt = rng.uniform(0.0, 70000.0)
        mach = rng.uniform(0.0, 1.4)
        thrust_cases.append(
            {
                "in": round_trip({"power": power, "alt": alt, "mach": mach}),
                "out": round_trip({"thrust": thrust(power, alt, mach)}),
            }
        )

    gear_cases = [
        {"in": round_trip({"thtl": t}), "out": round_trip({"tgear": tgear(t)})}
        for t in [i / 200.0 for i in range(201)]
    ]

    lag_cases = []
    for _ in range(n // 4):
        p3 = rng.uniform(0.0, 100.0)
        p1 = rng.uniform(0.0, 100.0)
        lag_cases.append(
            {
                "in": round_trip({"p3": p3, "p1": p1}),
                "out": round_trip({"pdot": pdot(p3, p1), "rtau": rtau(p1 - p3)}),
            }
        )

    adc_cases = []
    for _ in range(n // 4):
        vt = rng.uniform(*VT_FPS)
        alt = rng.uniform(*ALT_FT)
        amach, qbar = adc(vt, alt)
        adc_cases.append(
            {
                "in": round_trip({"vt": vt, "alt": alt}),
                "out": round_trip({"mach": amach, "qbar": qbar}),
            }
        )
    # Straddle the 35,000 ft temperature discontinuity explicitly.
    for alt in [34999.0, 35000.0, 35001.0]:
        amach, qbar = adc(600.0, alt)
        adc_cases.append(
            {
                "in": round_trip({"vt": 600.0, "alt": alt}),
                "out": round_trip({"mach": amach, "qbar": qbar}),
            }
        )

    return {
        "description": "Engine model and atmosphere. Tier A, tolerance 1e-12.",
        "source": "AeroBenchVVPython code/aerobench/lowlevel/",
        "seed": SEED + 1,
        "thrust": thrust_cases,
        "tgear": gear_cases,
        "powerLag": lag_cases,
        "adc": adc_cases,
    }


def gen_derivatives(n: int) -> dict:
    """Full 13-state derivative from the reference model.

    This validates the assembled model -- coefficient buildup, force and moment
    equations, rotational coupling -- rather than the tables in isolation. Our
    quaternion state is converted to Euler at the boundary to compare.
    """
    import random

    import numpy as np
    from aerobench.lowlevel.subf16_model import subf16_model

    rng = random.Random(SEED + 2)
    cases = []

    for _ in range(n):
        # Sampled inside the documented validity range here. Out-of-range behavior
        # is already pinned by the coefficient fixture; mixing the two would make a
        # failure ambiguous between "bad table" and "bad assembly".
        x = [
            rng.uniform(300.0, 900.0),                       # vt, ft/s
            np.radians(rng.uniform(-8.0, 40.0)),             # alpha, rad
            np.radians(rng.uniform(-25.0, 25.0)),            # beta, rad
            rng.uniform(-np.pi, np.pi),                      # phi, rad
            rng.uniform(-1.2, 1.2),                          # theta, rad
            rng.uniform(-np.pi, np.pi),                      # psi, rad
            rng.uniform(*RATE_RAD_S),                        # P, rad/s
            rng.uniform(*RATE_RAD_S),                        # Q, rad/s
            rng.uniform(*RATE_RAD_S),                        # R, rad/s
            rng.uniform(-5000.0, 5000.0),                    # pn, ft
            rng.uniform(-5000.0, 5000.0),                    # pe, ft
            rng.uniform(1000.0, 40000.0),                    # alt, ft
            rng.uniform(0.0, 100.0),                         # power, pct
        ]
        u = [
            rng.uniform(0.0, 1.0),      # throttle
            rng.uniform(*ELEV_DEG),     # elevator, deg
            rng.uniform(*AIL_DEG),      # aileron, deg
            rng.uniform(*RDR_DEG),      # rudder, deg
        ]

        xd, nz, ny, az, ay = subf16_model(np.array(x), np.array(u), "stevens")

        cases.append(
            {
                "x": round_trip([float(v) for v in x]),
                "u": round_trip([float(v) for v in u]),
                "xd": round_trip([float(v) for v in np.asarray(xd).ravel()]),
                "accel": round_trip(
                    {"nz": float(nz), "ny": float(ny), "az": float(az), "ay": float(ay)}
                ),
            }
        )

    return {
        "description": "Full 13-state derivative. Tier A, tolerance 1e-12. State "
                       "order: [vt, alpha, beta, phi, theta, psi, P, Q, R, pn, pe, "
                       "alt, power]. Controls: [throttle, elev_deg, ail_deg, "
                       "rdr_deg]. Note alpha/beta/rates in RADIANS, control "
                       "deflections in DEGREES -- that mix is in the source model.",
        "source": "AeroBenchVVPython code/aerobench/lowlevel/subf16_model.py",
        "seed": SEED + 2,
        "cases": cases,
    }


def gen_trim() -> dict:
    """Reference trim solutions for steady level flight (REQUIREMENTS §4.2).

    Solved here rather than recalled, so the numbers in docs/SOURCES.md are
    reproducible on demand instead of being one more thing taken on trust.
    """
    import numpy as np
    from scipy.optimize import minimize

    from aerobench.lowlevel.subf16_model import subf16_model
    from aerobench.lowlevel.tgear import tgear

    def solve(vt: float, alt: float):
        # Level flight: gamma = 0, so theta = alpha. Free: alpha, elevator, throttle.
        # Residual weights alpha_dot and q_dot up because they are numerically
        # small next to vt_dot and would otherwise be ignored by the optimizer.
        def cost(z):
            alpha, el, thtl = z
            x = np.array(
                [vt, alpha, 0.0, 0.0, alpha, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, alt,
                 tgear(thtl)]
            )
            u = np.array([thtl, el, 0.0, 0.0])
            xd = subf16_model(x, u, "stevens")[0]
            return xd[0] ** 2 + (100 * xd[1]) ** 2 + (10 * xd[7]) ** 2

        best = None
        for a0 in (0.02, 0.05, 0.10, 0.20):
            r = minimize(
                cost,
                [a0, -2.0, 0.3],
                method="Nelder-Mead",
                options=dict(maxiter=20000, maxfev=20000, xatol=1e-12, fatol=1e-14),
            )
            if best is None or r.fun < best.fun:
                best = r
        return best

    conditions = [
        (0.0, 500.0), (10000.0, 500.0), (20000.0, 600.0),
        (30000.0, 700.0), (10000.0, 300.0), (10000.0, 900.0),
    ]

    cases = []
    for alt, vt in conditions:
        r = solve(vt, alt)
        alpha, el, thtl = r.x
        cases.append(
            {
                "in": round_trip({"alt": alt, "vt": vt}),
                "out": round_trip(
                    {
                        "alphaRad": float(alpha),
                        "alphaDeg": float(np.degrees(alpha)),
                        "elevatorDeg": float(el),
                        "throttle": float(thtl),
                        "residual": float(r.fun),
                    }
                ),
            }
        )

    # Airspeed sweep for the trim-continuity test (REQUIREMENTS §4.2 test 2).
    sweep = []
    for vt in range(300, 951, 25):
        r = solve(float(vt), 10000.0)
        alpha, el, thtl = r.x
        sweep.append(
            round_trip(
                {
                    "vt": float(vt),
                    "alphaDeg": float(np.degrees(alpha)),
                    "elevatorDeg": float(el),
                    "throttle": float(thtl),
                    "residual": float(r.fun),
                }
            )
        )

    return {
        "description": "Reference trim solutions, steady level flight, CG 0.35 cbar. "
                       "Tier B targets, tolerance 5% per REQUIREMENTS §4.2.",
        "source": "Solved against AeroBenchVVPython via Nelder-Mead",
        "cases": cases,
        "sweep": {"alt": 10000.0, "points": sweep},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vendor", action="store_true",
                    help="download the reference implementation first")
    ap.add_argument("--points", type=int, default=2000,
                    help="randomized sample points per fixture")
    args = ap.parse_args()

    if args.vendor:
        vendor_reference()

    require_reference()
    FIXTURES.mkdir(parents=True, exist_ok=True)

    outputs = {
        "golden-coefficients.json": lambda: gen_coefficients(args.points),
        "golden-engine.json": lambda: gen_engine(args.points),
        "golden-derivatives.json": lambda: gen_derivatives(args.points),
        "golden-trim.json": gen_trim,
    }

    for name, fn in outputs.items():
        print(f"generating {name} ...")
        data = fn()
        path = FIXTURES / name
        with path.open("w") as f:
            json.dump(data, f, indent=1)
            f.write("\n")
        size_kb = path.stat().st_size / 1024
        print(f"  wrote {path.name} ({size_kb:.0f} KB)")

    print("\ndone. fixtures are committed; `npm test` needs only Node.")


if __name__ == "__main__":
    main()
