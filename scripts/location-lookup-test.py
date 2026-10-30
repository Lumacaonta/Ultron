#!/usr/bin/env python3
"""Exercise ULTRON's foreground location lookup without a network request."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


class FakeResponse:
    def __init__(self, payload: bytes) -> None:
        self.payload = payload

    def read(self, _size: int = -1) -> bytes:
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> bool:
        return False


def _expect_http_error(status_code: int, callback) -> None:
    try:
        callback()
    except HTTPException as error:
        assert error.status_code == status_code
    else:
        raise AssertionError(f"Expected HTTP {status_code}")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ultron-location-test-") as temp_dir:
        os.environ["ULTRON_AUTH_DATA_DIR"] = str(Path(temp_dir) / "auth")
        sys.path.insert(0, str(BACKEND))
        import main as backend  # noqa: PLC0415

        original_provider = backend.LOCATION_PROVIDER_URL
        original_last_request = backend._location_lookup_last_request_at
        backend._location_lookup_cache.clear()
        backend._location_lookup_last_request_at = 0.0
        backend.LOCATION_PROVIDER_URL = "https://nominatim.openstreetmap.org/search"

        fixture = json.dumps(
            [
                {
                    "lat": "44.493820",
                    "lon": "11.343960",
                    "display_name": "Piazza Maggiore, Bologna, Emilia-Romagna, Italia",
                    "name": "Piazza Maggiore",
                    "addresstype": "square",
                    "address": {"city": "Bologna"},
                }
            ]
        ).encode("utf-8")
        requests: list[tuple[str, int]] = []

        def fake_urlopen(request, timeout: int):
            requests.append((request.full_url, timeout))
            return FakeResponse(fixture)

        try:
            with patch.object(backend, "urlopen", fake_urlopen):
                first = backend.resolve_location(
                    backend.LocationLookupRequest(query="Piazza Maggiore Bologna")
                )
                second = backend.resolve_location(
                    backend.LocationLookupRequest(query="piazza maggiore bologna")
                )

            assert len(requests) == 1
            assert "format=jsonv2" in requests[0][0]
            assert requests[0][1] == 8
            assert first == second
            assert first["provider"] == "OpenStreetMap Nominatim"
            assert first["attribution"] == "© OpenStreetMap contributors"
            assert first["results"][0]["lat"] == 44.49382
            assert first["results"][0]["lon"] == 11.34396

            backend._location_lookup_cache.clear()
            backend._location_lookup_last_request_at = time.monotonic()
            _expect_http_error(
                429,
                lambda: backend.resolve_location(
                    backend.LocationLookupRequest(query="Bologna Italia")
                ),
            )

            backend._location_lookup_last_request_at = 0.0
            backend.LOCATION_PROVIDER_URL = "http://invalid-provider.test/search"
            _expect_http_error(
                503,
                lambda: backend.resolve_location(
                    backend.LocationLookupRequest(query="Roma Italia")
                ),
            )

            _expect_http_error(
                422,
                lambda: backend.resolve_location(
                    backend.LocationLookupRequest(query="  ")
                ),
            )
        finally:
            backend.LOCATION_PROVIDER_URL = original_provider
            backend._location_lookup_last_request_at = original_last_request
            backend._location_lookup_cache.clear()

    print("Ultron AI location lookup test passed")


if __name__ == "__main__":
    main()
