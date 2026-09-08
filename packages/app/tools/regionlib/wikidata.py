"""
Heights for buildings OpenStreetMap does not have heights for.

## Why this exists

Ninety of the 392 named buildings in Chicago's Loop carry no `height` and no
`building:levels`, and **Willis Tower is one of them**. So is Trump International,
and so is the Chrysler Building in New York. These are not obscure: they are the
tallest things in their cities, and a skyline without them is wrong in the one way a
person would notice immediately.

A height cannot be invented — `SOURCES.md` is explicit that nothing enters the world
without a traceable source, and a plausible 440 is exactly the kind of number that
would never be questioned again. But the buildings already carry a `wikidata` tag,
and Wikidata publishes height as property P2048 with references. That is a citable
source, it is machine-readable, and it is the same identifier OpenStreetMap already
chose to point at.

So: ask it. One SPARQL query for hundreds of entities, cached like everything else.

## The multiple-values problem

A skyscraper has several heights — roof, architectural top, tip — and Wikidata
records them all. The Chrysler Building returns 252.3, 282 and 318.9 metres, which
are the roof, the observation level and the spire. The **largest** is taken, because
that is the figure the building is known by and the one that matches how OSM tags
`height` for buildings that do have it.

Wikidata is CC0, so this adds no licence obligation, but it is credited in the region
manifest anyway on the same principle as everything else: a region should carry a
record of where its numbers came from.
"""

from __future__ import annotations

import json
import urllib.parse

from .fetch import fetch

ENDPOINT = "https://query.wikidata.org/sparql"

ATTRIBUTION = "Some building heights: Wikidata (CC0), property P2048."

#: Tallest height accepted, metres. `[A]` Comfortably above anything in North
#: America and far below the point where a bad statement stops being obvious.
MAX_PLAUSIBLE_M = 700.0

#: Entities per query. The endpoint takes long URLs but not unlimited ones, and a
#: failed batch costs the whole region rather than one building.
CHUNK = 150


def heights_for(qids: list[str]) -> dict[str, float]:
    """Metres for each entity that publishes a height. Missing entities are absent."""
    out: dict[str, float] = {}
    rejected: list[tuple[str, float]] = []
    unique = sorted({q for q in qids if q.startswith("Q") and q[1:].isdigit()})

    for start in range(0, len(unique), CHUNK):
        batch = unique[start : start + CHUNK]
        values = " ".join(f"wd:{q}" for q in batch)
        # The **normalised** value, not `wdt:`. Wikidata stores heights in whatever
        # unit the source used, and returns the bare number: the Empire State
        # Building has both 453 (metres) and 1500 (feet) on it, and taking the larger
        # raw figure made it a 1,500 m building. `psn:` is the SI-normalised
        # statement value, so feet arrive as metres and the comparison below is
        # comparing like with like.
        sparql = (
            f"SELECT ?item ?h WHERE {{ VALUES ?item {{ {values} }} "
            f"?item p:P2048/psn:P2048/wikibase:quantityAmount ?h. }}"
        )
        url = f"{ENDPOINT}?format=json&query={urllib.parse.quote(sparql)}"

        try:
            data = json.loads(
                fetch(url, label=f"wikidata heights {start // CHUNK + 1}", timeout=120)
            )
        except Exception as exc:  # noqa: BLE001
            # A region is still perfectly usable without these; it just loses a few
            # towers. Failing the whole build over an optional embellishment would be
            # the wrong trade.
            print(f"    wikidata unavailable ({type(exc).__name__}); skipping heights")
            continue

        for row in data.get("results", {}).get("bindings", []):
            qid = row["item"]["value"].rsplit("/", 1)[1]
            try:
                metres = float(row["h"]["value"])
            except (KeyError, ValueError):
                continue
            # Roof, observation deck and spire all appear; the tallest is the figure
            # the building is known by.
            #
            # The ceiling is a backstop, not a belief about architecture: it is there
            # so that a mis-typed statement or an entity that turns out to be a radio
            # mast cannot put a kilometre-high box in the middle of a city. Anything
            # rejected is reported rather than dropped quietly.
            if metres <= 0 or metres > MAX_PLAUSIBLE_M:
                if metres > MAX_PLAUSIBLE_M:
                    rejected.append((qid, metres))
                continue
            if metres > out.get(qid, 0.0):
                out[qid] = metres

    if rejected:
        print(
            f"    rejected {len(rejected)} implausible heights: "
            + ", ".join(f"{q} {h:.0f} m" for q, h in rejected[:4])
        )

    return out
