import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("setup.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def package(self, root):
        source = root / "source"
        source.mkdir()
        (source / "package.json").write_text(json.dumps({"name": "marifold-personal-bridge"}))
        (source / "dist").mkdir()
        (source / "dist/serve.js").write_text("// fixture")
        (source / "vendor").mkdir()
        (source / ".env").write_text("UNRELATED_SECRET=do-not-copy")
        return source

    def test_dedicated_install_is_private_persistent_and_exclusive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.package(root)
            target = root / "install"
            installer.prepare(source, target, None, "bridge.example.com")
            config = json.loads((target / "compose.json").read_text())
            self.assertEqual(config["services"]["bridge"]["restart"], "unless-stopped")
            self.assertEqual(config["services"]["redis"]["network_mode"], "host")
            self.assertIn("redis-data:/data", config["services"]["redis"]["volumes"])
            self.assertIn("bind 127.0.0.1", (target / "redis.conf").read_text())
            self.assertIn("appendonly yes", (target / "redis.conf").read_text())
            self.assertIn("maxmemory-policy noeviction", (target / "redis.conf").read_text())
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertEqual((target / "bridge.env").stat().st_mode & 0o777, 0o600)
            token = (target / "registration-token").read_text().strip()
            self.assertEqual(len(token), 64)
            self.assertIn(token, (target / "bridge.env").read_text())
            self.assertFalse((target / "package/.env").exists())
            with self.assertRaises(FileExistsError):
                installer.prepare(source, target, None, None)
            self.assertEqual((target / "registration-token").read_text().strip(), token)

    def test_existing_redis_and_ingress_do_not_create_replacements(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.package(root)
            target = root / "install"
            url = "redis://marifold:abc%24def@127.0.0.1:6379/1"
            installer.prepare(source, target, installer.validate_redis(url), None)
            config = json.loads((target / "compose.json").read_text())
            self.assertEqual(list(config["services"]), ["bridge"])
            self.assertEqual(config["volumes"], {})
            self.assertIn(url, (target / "bridge.env").read_text())
            self.assertFalse((target / "redis.conf").exists())
            self.assertFalse((target / "Caddyfile").exists())

    def test_invalid_inputs_rejected(self):
        for url in ["https://example.com", "redis://example.com/0", "redis://localhost/0\nINJECT=yes", "redis://localhost/not-a-db", "rediss://example.com:bad/0", "redis://a:'x@localhost/0"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                installer.validate_redis(url)
        for domain in ["https://example.com", "example.com/path", "foo\nbar.com", "*.example.com", "bad..example.com"]:
            with self.subTest(domain=domain), self.assertRaises(ValueError):
                installer.validate_domain(domain)

    def test_symlinked_payload_rejected_before_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.package(root)
            (source / "dist/leak").symlink_to(source / ".env")
            target = root / "install"
            with self.assertRaises(ValueError):
                installer.prepare(source, target, None, None)
            self.assertFalse(target.exists())

    def test_start_waits_for_health_and_never_prints_token(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            (target / "installation.json").write_text(json.dumps({"domain": None}))
            with patch.object(installer, "run", return_value="") as command, contextlib.redirect_stdout(io.StringIO()) as output:
                installer.start(target)
            calls = [call.args[0] for call in command.call_args_list]
            self.assertTrue(any("--wait" in args for args in calls))
            self.assertEqual(calls[-1][-4:], ["-T", "bridge", "node", "health.cjs"])
            self.assertIn("registration-token", output.getvalue())

    def update_fixture(self, root):
        source = self.package(root)
        target = root / "install"
        installer.prepare(source, target, None, None)
        dockerfile = target / "package/Dockerfile"
        dockerfile.write_text(dockerfile.read_text().replace("node:24-bookworm-slim", "mirror.example.com/node:24-bookworm-slim"))
        return source, target

    def docker(self, args, cwd=None):
        if args[-3:] == ["ps", "--quiet", "bridge"]:
            return "a" * 64
        if args[:2] == ["docker", "inspect"]:
            return "sha256:" + "b" * 64
        return ""

    def test_update_preserves_configuration_mirror_and_other_services(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = self.update_fixture(Path(temporary))
            retained = {name: (target / name).read_bytes() for name in ("bridge.env", "registration-token", "redis.conf", "installation.json")}
            before = json.loads((target / "compose.json").read_text())
            (source / "dist/serve.js").write_text("// updated bridge")
            with patch.object(installer, "run", side_effect=self.docker) as command, contextlib.redirect_stdout(io.StringIO()):
                installer.update(source, target)
            after = json.loads((target / "compose.json").read_text())
            package = Path(after["services"]["bridge"]["build"]["context"])
            self.assertEqual((package / "dist/serve.js").read_text(), "// updated bridge")
            self.assertIn("mirror.example.com", (package / "Dockerfile").read_text())
            self.assertFalse((package / ".env").exists())
            self.assertEqual(after["services"]["redis"], before["services"]["redis"])
            self.assertEqual(after["volumes"], before["volumes"])
            for name, contents in retained.items():
                self.assertEqual((target / name).read_bytes(), contents)
            calls = [call.args[0] for call in command.call_args_list]
            deploy = next(args for args in calls if "up" in args)
            self.assertIn("--no-deps", deploy)
            self.assertIn("--no-build", deploy)
            self.assertEqual(deploy[-1], "bridge")
            self.assertTrue(list(target.glob("release-*-rollback.json")))

    def test_failed_update_restores_previous_image_and_build_failure_leaves_config_intact(self):
        for fail_at in ("build", "up", "health.cjs"):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as temporary:
                source, target = self.update_fixture(Path(temporary))
                original = (target / "compose.json").read_bytes()
                failed = False
                def docker(args, cwd=None):
                    nonlocal failed
                    if fail_at in args and not failed:
                        failed = True
                        raise RuntimeError("fixture failure")
                    return self.docker(args, cwd)
                with patch.object(installer, "run", side_effect=docker) as command, contextlib.redirect_stdout(io.StringIO()), self.assertRaises(RuntimeError):
                    installer.update(source, target)
                if fail_at == "build":
                    self.assertEqual((target / "compose.json").read_bytes(), original)
                    self.assertFalse(any("up" in call.args[0] for call in command.call_args_list))
                else:
                    restored = json.loads((target / "compose.json").read_text())
                    self.assertTrue(restored["services"]["bridge"]["image"].endswith("-previous"))
                    self.assertEqual(restored["services"]["bridge"]["build"]["context"], "./package")
                    self.assertEqual(sum("up" in call.args[0] for call in command.call_args_list), 2)

    def test_external_failure_output_is_not_leaked(self):
        failure = subprocess.CompletedProcess(["docker"], 1, "secret-url", "secret-password")
        with patch.object(installer.subprocess, "run", return_value=failure):
            with self.assertRaises(RuntimeError) as error:
                installer.run(["docker", "compose"])
        self.assertNotIn("secret", str(error.exception))


if __name__ == "__main__":
    unittest.main()
