"""
HTTP, with a cache, because the builder is run over and over.

Building a region is an iterative business: change a tier resolution, rebuild, look
at it, change it again. Every one of those iterations wants the same forty megabytes
of elevation and the same Overpass answer. Re-downloading them is slow, and worse, it
is *rude* — Overpass is a volunteer-run service with a published etiquette, and a
tool that hammers it during development is the tool that gets the project blocked.

So every response is cached on disk under a hash of the request. The cache is
gitignored: it is a convenience, not an input. A clean checkout rebuilds a region
byte-identically, it just takes longer.

Two smaller things this centralises:

- **A real User-Agent.** Overpass asks for one that identifies the client, and
  answers anonymous requests last.
- **Certificates.** A stock python.org install on macOS ships without a usable CA
  bundle, so the standard SSL context fails on every HTTPS request with an error
  that reads like a network fault. `certifi` is used when it is importable.
"""

from __future__ import annotations

import hashlib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = (
    "retro-flyer-region-builder/1.0 "
    "(+https://github.com/granthertel-v2/retro-flyer; offline terrain ingest)"
)

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"


def _context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_CTX = _context()


class FetchError(RuntimeError):
    pass


def fetch(
    url: str,
    *,
    post: dict[str, str] | None = None,
    label: str = "",
    timeout: int = 300,
    attempts: int = 3,
    use_cache: bool = True,
) -> bytes:
    """
    GET, or POST a form. Cached by request, retried with a backoff.

    The retry exists because both upstreams fail transiently under load and neither
    failure means what it says: Overpass answers 429 or 504 when it is busy, and the
    USGS service occasionally returns a 500 that succeeds on the next try. A builder
    that gives up on the first one turns a slow afternoon into a broken pipeline.
    """
    key_material = url + "\x00" + urllib.parse.urlencode(sorted((post or {}).items()))
    key = hashlib.sha256(key_material.encode()).hexdigest()[:32]
    cached = CACHE_DIR / f"{key}.bin"

    if use_cache and cached.exists():
        return cached.read_bytes()

    data = urllib.parse.urlencode(post).encode() if post else None
    last: Exception | None = None

    for attempt in range(1, attempts + 1):
        try:
            if label:
                suffix = "" if attempt == 1 else f" (attempt {attempt})"
                print(f"  fetching {label}{suffix} ...", end=" ", flush=True)
            started = time.time()

            request = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=timeout, context=_CTX) as response:
                body = response.read()

            if label:
                print(f"{len(body) / 1e6:.1f} MB in {time.time() - started:.1f}s", flush=True)

            # An error page is a 200 with HTML in it often enough to be worth naming.
            if body[:1] == b"<" and b"html" in body[:400].lower():
                raise FetchError(f"{url}: server returned an HTML error page")

            if use_cache:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cached.write_bytes(body)
            return body

        except Exception as exc:  # noqa: BLE001 — retry anything that is not success
            last = exc
            if label:
                print(f"failed: {type(exc).__name__}", flush=True)
            if attempt < attempts:
                # Linear backoff. Overpass's etiquette is about not hammering it, and
                # a couple of extra seconds costs nothing next to a re-run.
                delay = 5 * attempt
                print(f"  retrying in {delay}s", file=sys.stderr, flush=True)
                time.sleep(delay)

    raise FetchError(f"{url}: giving up after {attempts} attempts: {last}")
