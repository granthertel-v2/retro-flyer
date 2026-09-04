#!/usr/bin/env python3
"""
Extract the aerodynamic table data from the reference implementation into
TypeScript.

Why generate instead of transcribe
----------------------------------
There are roughly a thousand coefficients across fifteen files. Typing them by hand
has a nonzero error rate and no natural way to check itself. Parsing them out is
deterministic and repeatable.

This does NOT make the Tier A golden tests redundant. The fixtures are produced by
*running* the reference model; these tables are produced by *parsing its text*. If
this script mis-associated a row with a column -- right numbers, wrong layout -- the
lookup would return values that disagree with the fixtures immediately. So Tier A
still polices the thing most likely to go wrong, which is the layout and the
lookup algorithm, not the digits.

Usage
-----
    python3 tools/gen_tables.py

Requires tools/vendor/ (see gen_golden.py --vendor).
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "aerobench" / "lowlevel"
OUT = HERE.parent / "src" / "tables" / "data.ts"

# Each entry: (module, whether the literal is transposed with .T in the source)
#
# In the source, a 2-D literal is written as a list of rows and then transposed, so
# each inner list is one column of the final array and holds 12 alpha values. We
# keep that pre-transpose shape -- data[col][alphaIndex] -- because it maps directly
# onto how the lookup indexes: a[k-1, m-1] in the source becomes data[m-1][k-1].
TABLES = [
    "cx", "cz", "cl", "cm", "cn",
    "dampp", "dlda", "dldr", "dnda", "dndr",
]

# thrust.py holds three separate arrays rather than one.
THRUST_ARRAYS = ["a", "b", "c"]


def parse_arrays(path: Path) -> dict[str, list]:
    """Pull every `name = np.array([...])` literal out of a source file."""
    src = path.read_text()
    found: dict[str, list] = {}

    for match in re.finditer(r"(\w+)\s*=\s*np\.array\(", src):
        name = match.group(1)
        start = match.end() - 1  # position of the '(' after np.array

        # Walk forward to the matching close paren so nested brackets are handled.
        depth = 0
        i = start
        while i < len(src):
            if src[i] == "(":
                depth += 1
            elif src[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        else:
            sys.exit(f"unbalanced parentheses in {path.name} near {name}")

        inner = src[start + 1 : i]
        # Join line continuations FIRST -- a backslash can sit between the comma and
        # the `dtype` kwarg, and \s does not match a backslash, so stripping the
        # kwarg before joining silently fails to strip it.
        inner = inner.replace("\\\n", " ")
        inner = re.sub(r",\s*dtype\s*=\s*\w+\s*$", "", inner.strip())

        try:
            found[name] = ast.literal_eval(inner)
        except (ValueError, SyntaxError) as exc:
            sys.exit(f"could not parse array {name} in {path.name}: {exc}")

    return found


def fmt(value) -> str:
    """Format a number the way TypeScript should carry it.

    repr() on a Python float gives the shortest string that round-trips to the same
    float64, which is also what JavaScript parses back to the same double. So the
    emitted constants are bit-identical to what the reference used.
    """
    if isinstance(value, list):
        return "[" + ", ".join(fmt(v) for v in value) + "]"
    return repr(float(value))


def emit(name: str, data: list) -> str:
    if data and isinstance(data[0], list):
        rows = ",\n  ".join(fmt(row) for row in data)
        return f"export const {name} = [\n  {rows},\n] as const\n"
    return f"export const {name} = {fmt(data)} as const\n"


def main() -> None:
    if not VENDOR.is_dir():
        sys.exit(
            "Reference implementation not vendored.\n"
            "Run:  python3 tools/gen_golden.py --vendor"
        )

    parts = [
        "/**",
        " * Aerodynamic table data.",
        " *",
        " * GENERATED FILE -- do not edit by hand.",
        " * Regenerate with:  python3 tools/gen_tables.py",
        " *",
        " * Extracted verbatim from the reference implementation",
        " * ([AEROBENCH] code/aerobench/lowlevel/). Source and provenance for every",
        " * number here is documented in docs/SOURCES.md.",
        " *",
        " * Layout: 2-D tables are stored pre-transpose, as data[column][alphaIndex],",
        " * with 12 alpha nodes running -10 deg to +45 deg in 5 deg steps. That matches",
        " * the source's own indexing after its `.T`, so `a[k-1, m-1]` there is",
        " * `data[m - 1][k - 1]` here.",
        " *",
        " * These are aerodynamic coefficients. Per REQUIREMENTS §4.4 they are never",
        " * tuned for feel -- if the aircraft flies wrong, the fix belongs in the assist",
        " * layer, not in this file.",
        " */",
        "",
        "/* eslint-disable */",
        "",
    ]

    for mod in TABLES:
        path = VENDOR / f"{mod}.py"
        arrays = parse_arrays(path)
        if "a" not in arrays:
            sys.exit(f"no array named 'a' found in {path.name}")
        parts.append(f"// {mod}.py")
        parts.append(emit(f"{mod.upper()}_TABLE", arrays["a"]))

    thrust = parse_arrays(VENDOR / "thrust.py")
    names = {"a": "THRUST_IDLE_TABLE", "b": "THRUST_MIL_TABLE", "c": "THRUST_MAX_TABLE"}
    parts.append("// thrust.py -- idle, military, maximum power")
    for key in THRUST_ARRAYS:
        if key not in thrust:
            sys.exit(f"no array named '{key}' in thrust.py")
        parts.append(emit(names[key], thrust[key]))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(parts))

    total = 0
    for mod in TABLES:
        arrays = parse_arrays(VENDOR / f"{mod}.py")["a"]
        total += sum(len(r) for r in arrays) if isinstance(arrays[0], list) else len(arrays)
    for key in THRUST_ARRAYS:
        total += sum(len(r) for r in thrust[key])

    print(f"wrote {OUT.relative_to(HERE.parent)}  ({total} coefficients)")


if __name__ == "__main__":
    main()
