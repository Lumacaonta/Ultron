#!/usr/bin/env python3
"""Exercise ULTRON's local fabrication boundaries without touching a real printer.

The test uses a fresh temporary account store, fabricated model files, a fake
macOS application bundle, and mocked local telemetry.  It never opens a serial
port, scans a LAN, starts a slicer, accesses a keychain, or reads an operator's
existing ULTRON profile.
"""

from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"


def expect_http(status_code: int, callback) -> None:
    try:
        callback()
    except HTTPException as error:
        assert error.status_code == status_code, (error.status_code, error.detail)
    else:
        raise AssertionError(f"Expected HTTP {status_code}")


def assert_private(path: Path) -> None:
    if os.name == "nt":
        return
    assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, (
        f"{path} has insecure permissions {oct(stat.S_IMODE(path.stat().st_mode))}"
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="ultron-fabrication-test-") as temporary:
        root = Path(temporary)
        os.environ.update(
            {
                "ULTRON_AUTH_DATA_DIR": str(root / "accounts"),
                "ULTRON_AUTH_SECRET": "fabrication-test-secret-" + ("f" * 64),
                "ULTRON_AUTH_REQUIRE_EMAIL_VERIFICATION": "false",
                "ULTRON_DESKTOP_PICKER_SECRET": "fabrication-picker-secret-" + ("p" * 64),
            }
        )
        sys.path.insert(0, str(BACKEND))

        import external_apps  # noqa: PLC0415
        import main as backend  # noqa: PLC0415
        import printer_service as printer  # noqa: PLC0415

        account_a = {"id": "a" * 32, "display_name": "Fabrication A"}
        account_b = {"id": "b" * 32, "display_name": "Fabrication B"}
        active = {"user": account_a}

        backend.get_current_user = lambda: active["user"]
        external_apps.get_current_user = lambda: active["user"]
        printer.get_current_user = lambda: active["user"]

        try:
            route_paths = {
                getattr(route, "path", "")
                for route in backend.app.routes
                if getattr(route, "path", None)
            }
            for included in backend.app.routes:
                nested_router = getattr(included, "original_router", None)
                if nested_router is not None:
                    route_paths.update(
                        getattr(route, "path", "")
                        for route in nested_router.routes
                        if getattr(route, "path", None)
                    )
            # Native file/application registration requires a secret that only
            # Electron main receives. The renderer never receives this token.
            picker_secret = os.environ["ULTRON_DESKTOP_PICKER_SECRET"]
            expect_http(403, lambda: backend._require_desktop_picker(SimpleNamespace(headers={})))
            backend._require_desktop_picker(
                SimpleNamespace(headers={"X-Ultron-Desktop-Picker": picker_secret})
            )
            expect_http(403, lambda: external_apps._require_native_desktop_picker(None))
            external_apps._require_native_desktop_picker(picker_secret)

            for expected in (
                "/api/printer/profiles",
                "/api/printer/ports",
                "/api/printer/config",
                "/api/printer/test-connection",
                "/api/printer/connect",
                "/api/models/apps",
                "/api/models/register",
                "/api/models/apps/register",
                "/api/models/open-external",
                "/api/models/apps/{app_id}/launch",
            ):
                assert expected in route_paths, f"Missing router path {expected}"

            # The model deck must retain every selected regular file, even when
            # only a native CAD/slicer can display it.
            binary_stl = root / "fixture.stl"
            binary_stl.write_bytes(b"ULTRON fixture".ljust(80, b"\0") + (0).to_bytes(4, "little"))
            step_file = root / "fixture.step"
            step_file.write_text("ISO-10303-21; END-ISO-10303-21;", encoding="utf-8")
            unknown_file = root / "fixture.vendor-format"
            unknown_file.write_text("private fixture only", encoding="utf-8")
            unselected_file = root / "unselected.stl"
            unselected_file.write_bytes(binary_stl.read_bytes())

            backend._remember_selected_model(binary_stl.resolve())
            backend._remember_selected_model(step_file.resolve())
            backend._remember_selected_model(unknown_file.resolve())

            stl_metadata = backend._model_metadata(binary_stl.resolve())
            step_metadata = backend._model_metadata(step_file.resolve())
            unknown_metadata = backend._model_metadata(unknown_file.resolve())
            assert stl_metadata["preview"]["supported"] is True
            assert step_metadata["preview"]["supported"] is False
            assert step_metadata["format"] == "STEP CAD"
            assert unknown_metadata["format"] == "External fabrication asset"
            assert backend._resolve_model_file(str(binary_stl)) == binary_stl.resolve()
            expect_http(403, lambda: backend._resolve_model_file(str(unselected_file)))

            # A selected path is account scoped, so one local account cannot use
            # another account's model through the loopback API.
            active["user"] = account_b
            expect_http(403, lambda: backend._resolve_model_file(str(binary_stl)))
            assert printer._read_config(account_b["id"])["profileId"] is None
            assert external_apps._read_config(account_b["id"]) == []
            active["user"] = account_a

            # LAN profiles only accept a literal local endpoint and strip
            # everything that could carry credentials or cross a public network.
            lan_request = printer.PrinterConfigRequest(
                profileId="octoprint-local",
                baseUrl="http://127.0.0.1:5000/",
                monitoring=True,
            )
            lan_config = printer._merge_connection_config(
                printer._default_config(),
                lan_request,
                require_profile=True,
                validate_usb_port=True,
            )
            assert lan_config["baseUrl"] == "http://127.0.0.1:5000"
            expect_http(422, lambda: printer._normalize_lan_base_url("http://8.8.8.8:80"))
            expect_http(422, lambda: printer._normalize_lan_base_url("http://key@127.0.0.1:5000"))

            # USB handling accepts an explicit detected port only. This test
            # never calls the serial opener.
            fake_port = {
                "device": "/dev/cu.ultron-fixture",
                "description": "ULTRON fixture port",
                "manufacturer": "Fixture",
                "product": "Marlin",
                "vid": "1a2b",
                "pid": "3c4d",
                "score": 10,
                "recommended": True,
            }
            with patch.object(printer, "_serial_port_records", return_value=[fake_port]):
                usb_request = printer.PrinterConfigRequest(
                    profileId="marlin-usb",
                    usbPort=fake_port["device"],
                    baudRate=115200,
                    monitoring=False,
                )
                usb_config = printer._merge_connection_config(
                    printer._default_config(),
                    usb_request,
                    require_profile=True,
                    validate_usb_port=True,
                )
                assert usb_config["usbPort"] == fake_port["device"]
                expect_http(409, lambda: printer._assert_selected_usb_port("/dev/cu.missing"))

            # Credentials are deliberately excluded from the persisted JSON.
            with patch.object(printer, "_can_use_macos_keychain", return_value=False):
                storage = printer._save_credential(account_a["id"], "octoprint-local", "fixture-secret-token")
                assert storage == "session"
                printer._write_config(account_a["id"], lan_config)
                printer_config_path = printer._config_path(account_a["id"])
                printer_payload = printer_config_path.read_text(encoding="utf-8")
                assert "fixture-secret-token" not in printer_payload
                assert_private(printer_config_path)
                public_config = printer._safe_config_view(account_a["id"], lan_config)
                assert public_config["hasCredential"] is True
                assert "credential" not in public_config
                assert printer._request_headers("octoprint-local", "fixture-secret-token") == {
                    "X-Api-Key": "fixture-secret-token"
                }
                assert printer._request_headers("klipper-moonraker-local", "fixture-token") == {
                    "Authorization": "Bearer fixture-token"
                }

            octoprint_calls: list[tuple[str, dict[str, str]]] = []

            def fake_octoprint_get(url: str, headers: dict[str, str]) -> dict:
                octoprint_calls.append((url, dict(headers)))
                if url.endswith("/api/printer"):
                    return {"state": {"flags": {"operational": True}}}
                return {
                    "progress": {"completion": 42.4},
                    "job": {"file": {"name": "fixture.gcode"}},
                }

            with patch.object(printer, "_local_json_get", side_effect=fake_octoprint_get):
                status = printer._network_status(lan_config, "fixture-secret-token")
            assert status["connected"] is True and status["progress"] == 42.4
            assert len(octoprint_calls) == 2
            assert all(headers == {"X-Api-Key": "fixture-secret-token"} for _, headers in octoprint_calls)

            # A manually linked app must be a real bundle and its private path
            # is never sent back in the public response.
            fake_app = root / "Fixture Slicer.app"
            (fake_app / "Contents").mkdir(parents=True)
            (fake_app / "Contents" / "Info.plist").write_text("<plist/>", encoding="utf-8")
            # The fixture is a macOS bundle even when this isolated test runs
            # on a Linux CI worker. Keep the test focused on the account
            # boundary rather than pretending that Linux accepts .app bundles.
            with patch.object(external_apps.platform, "system", return_value="Darwin"):
                linked = external_apps._remember_custom_app(account_a["id"], str(fake_app), "Fixture slicer")
                assert linked["configured"] is True
                assert linked["available"] is True
                assert "path" not in linked
                apps_path = external_apps._config_path(account_a["id"])
                assert_private(apps_path)
                app, public_app = external_apps._resolve_linked_app(account_a["id"], linked["id"])
                assert app == fake_app.resolve()
                assert public_app["name"] == "Fixture slicer"
                expect_http(422, lambda: external_apps._resolve_linked_app(account_a["id"], "../bad-app"))

            # Starting a linked application for its own printer setup uses the
            # stored account-scoped bundle, never a renderer-provided command
            # or path. Mock the native opener so no application is launched.
            with (
                patch.object(external_apps.platform, "system", return_value="Darwin"),
                patch.object(external_apps.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as open_app,
            ):
                launched = external_apps.launch_external_app(linked["id"])
            assert launched == {"ok": True, "application": "Fixture slicer"}
            assert open_app.call_args.args[0] == ["open", "-a", str(fake_app.resolve())]

            # Windows hands an already-validated .exe a selected model without
            # using a shell. This stays mocked and never starts a process.
            fake_windows_app = root / "Fixture Slicer.exe"
            fake_windows_app.write_bytes(b"fixture executable")
            with (
                patch.object(external_apps.platform, "system", return_value="Windows"),
                patch.object(external_apps.subprocess, "Popen") as open_windows_app,
            ):
                resolved_windows_app = external_apps._resolve_application(fake_windows_app)
                assert resolved_windows_app == fake_windows_app.resolve()
                external_apps._launch_application(resolved_windows_app, binary_stl)
            windows_command = open_windows_app.call_args.args[0]
            assert Path(windows_command[0]).resolve() == fake_windows_app.resolve()
            assert Path(windows_command[1]).resolve() == binary_stl.resolve()
            assert open_windows_app.call_args.kwargs["shell"] is False

            # No status call can create a connection by itself.
            printer.close_all_printer_connections()
            offline = printer._offline_status(printer._read_config(account_a["id"]))
            assert offline["connected"] is False
            assert printer._runtime_connections == {}
        finally:
            printer.close_all_printer_connections()
            backend._selected_model_paths.clear()
            printer._ephemeral_credentials.clear()

    print("ULTRON fabrication integration test passed")


if __name__ == "__main__":
    main()
