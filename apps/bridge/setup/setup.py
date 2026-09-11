#!/usr/bin/env python3
"""Interactive Linux installer for a prepared Marifold bridge package."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlsplit

PROJECT = "marifold-personal-bridge"
DEFAULT_TARGET = Path("/opt/marifold-bridge")


def run(args, cwd=None):
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
    if result.returncode:
        # Tool output can contain supplied connection strings. Keep it off the terminal.
        raise RuntimeError(f"{args[0]} failed (exit {result.returncode}). Configuration is retained; see HOSTING.md for troubleshooting.")
    return result.stdout.strip()


def validate_redis(value):
    if any(c.isspace() or c in "'\"\\" for c in value):
        raise ValueError("Redis URL must contain no whitespace or quotes; percent-encode password characters.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
        valid = parsed.scheme in ("redis", "rediss") and parsed.hostname and not parsed.query and not parsed.fragment
        valid = valid and re.fullmatch(r"/\d+|", parsed.path) and (port is None or 0 < port < 65536)
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Use a Redis TCP URL, optionally ending in /database_number.")
    if parsed.scheme == "redis" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Use rediss:// for Redis outside this server's loopback network.")
    return value


def validate_domain(value):
    value = value.lower().strip()
    labels = value.split(".")
    if len(value) > 253 or len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
    ):
        raise ValueError("Enter a DNS hostname such as bridge.example.com, without https:// or a path.")
    return value


def confirm(prompt):
    return input(prompt + " [y/N]: ").strip().lower() == "y"


def check_port(port):
    with socket.socket() as sock:
        try:
            sock.bind(("0.0.0.0", port))
        except OSError:
            raise ValueError(f"Port {port} is already in use. Choose existing HTTPS ingress or resolve the conflict first.") from None


def write(path, value, mode=0o600):
    with path.open("x") as output:
        output.write(value)
    path.chmod(mode)


def compose_config(dedicated, domain):
    bridge = {
        "build": {"context": "./package"},
        "network_mode": "host",
        "restart": "unless-stopped",
        "env_file": ["./bridge.env"],
        "user": "node",
        "read_only": True,
        "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"],
        "healthcheck": {
            "test": ["CMD", "node", "health.cjs"],
            "interval": "10s", "timeout": "8s", "retries": 12, "start_period": "10s",
        },
        "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}},
    }
    config = {"name": PROJECT, "services": {"bridge": bridge}, "volumes": {}}
    if dedicated:
        config["services"]["redis"] = {
            "image": "redis:8.8", "network_mode": "host", "restart": "unless-stopped",
            "command": ["redis-server", "/usr/local/etc/redis/redis.conf"],
            "volumes": ["./redis.conf:/usr/local/etc/redis/redis.conf:ro", "redis-data:/data"],
            "logging": bridge["logging"],
        }
        bridge["depends_on"] = ["redis"]
        config["volumes"]["redis-data"] = {}
    if domain:
        config["services"]["https"] = {
            "image": "caddy:2", "network_mode": "host", "restart": "unless-stopped",
            "volumes": ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"],
            "depends_on": {"bridge": {"condition": "service_healthy"}},
            "logging": bridge["logging"],
        }
        config["volumes"].update({"caddy-data": {}, "caddy-config": {}})
    return config


def prepare(source, target, redis_url, domain):
    # Only copy the compiled package inputs; never copy local environment/configuration.
    required = ["package.json", "dist", "vendor"]
    for name in required:
        item = source / name
        if not item.exists() or item.is_symlink():
            raise ValueError("Run setup from a complete prepared bridge package.")
        if item.is_dir() and any(p.is_symlink() for p in item.rglob("*")):
            raise ValueError("Prepared package inputs must not contain symlinks.")
    manifest = json.loads((source / "package.json").read_text())
    if manifest.get("name") != "marifold-personal-bridge":
        raise ValueError("Run marifold workspace bridge prepare first, then use that package's setup.sh.")
    target.mkdir(mode=0o700)  # Exclusive creation: never overwrite an existing installation.
    package = target / "package"
    package.mkdir(mode=0o755)
    for name in required:
        item = source / name
        if item.is_dir():
            shutil.copytree(item, package / name)
        else:
            shutil.copyfile(item, package / name)
    for item in package.rglob("*"):
        item.chmod(0o755 if item.is_dir() else 0o644)
    # Installer owns its dependency installation; user-selected local node_modules are excluded.
    write(package / "Dockerfile", "FROM node:24-bookworm-slim\nWORKDIR /app\nCOPY package.json ./\nCOPY vendor ./vendor\nRUN npm install --omit=dev --ignore-scripts\nCOPY dist ./dist\nCOPY health.cjs ./health.cjs\nUSER node\nCMD [\"node\", \"dist/serve.js\"]\n", 0o644)
    write(package / ".dockerignore", "*\n!package.json\n!vendor/\n!vendor/**\n!dist/\n!dist/**\n!health.cjs\n!Dockerfile\n", 0o644)
    write(package / "health.cjs", "const Redis = require('ioredis');\nconst client = new Redis(process.env.MARIFOLD_BRIDGE_REDIS_URL, {lazyConnect: true, retryStrategy: () => null, connectTimeout: 3000, maxRetriesPerRequest: 0});\nclient.on('error', () => {});\nconst timeout = setTimeout(() => process.exit(1), 6000);\n(async () => { try { await client.connect(); await client.ping(); const response = await fetch('http://127.0.0.1:32143/health'); if (!response.ok) throw new Error(); clearTimeout(timeout); client.disconnect(); } catch { process.exit(1); } })();\n", 0o644)
    token = secrets.token_hex(32)
    dedicated = redis_url is None
    if dedicated:
        password = secrets.token_hex(32)
        redis_url = f"redis://default:{password}@127.0.0.1:32144/0"
        write(target / "redis.conf", f"bind 127.0.0.1\nport 32144\nprotected-mode yes\nrequirepass {password}\ndir /data\nappendonly yes\nappendfsync everysec\nsave 900 1\nmaxmemory 128mb\nmaxmemory-policy noeviction\n", 0o644)
    write(target / "bridge.env", f"MARIFOLD_BRIDGE_REDIS_URL='{redis_url}'\nMARIFOLD_BRIDGE_REGISTRATION_TOKEN='{token}'\nHOST=127.0.0.1\nPORT=32143\n")
    write(target / "registration-token", token + "\n")
    if domain:
        write(target / "Caddyfile", f"{domain} {{\n    reverse_proxy 127.0.0.1:32143\n}}\n", 0o644)
    write(target / "compose.json", json.dumps(compose_config(dedicated, domain), indent=2) + "\n")
    write(target / "installation.json", json.dumps({"schema": 1, "domain": domain, "dedicatedRedis": dedicated}) + "\n")


def start(target):
    command = ["docker", "compose", "-f", str(target / "compose.json")]
    run(command + ["config", "--quiet"])
    print("Building and starting the bridge. The first image download may take several minutes.", flush=True)
    run(command + ["up", "--detach", "--build", "--wait", "--wait-timeout", "180"])
    run(command + ["exec", "-T", "bridge", "node", "health.cjs"])
    print("Bridge is running; Redis PING and local HTTP health passed.")
    print(f"Read your registration token locally: sudo cat {target}/registration-token")
    print(f"Service status: sudo docker compose -f {target}/compose.json ps")
    metadata = json.loads((target / "installation.json").read_text())
    if metadata["domain"]:
        print(f"Next verify https://{metadata['domain']}/health, then create your workspace with that HTTPS origin.")
        print("Public DNS, certificate issuance and the cloud firewall still need to permit HTTPS; local health does not verify them.")
    else:
        print("Next route your existing HTTPS proxy or Cloudflare Tunnel to http://127.0.0.1:32143.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", action="store_true", help="Start an existing installer-managed installation without replacing secrets/data")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("Run sudo bash setup.sh on the Linux ECS/EC2 server, not on your Mac.")
    for executable in ("docker", "systemctl"):
        if not shutil.which(executable):
            raise ValueError("Install Docker Engine with its Compose plugin first: https://docs.docker.com/engine/install/ . Existing Docker installations are never replaced by this script.")
    run(["docker", "compose", "version"])
    target = DEFAULT_TARGET
    if args.start:
        if target.is_symlink() or target.stat().st_uid != 0 or target.stat().st_mode & 0o077:
            raise ValueError("Installation directory must be root-owned, mode 0700, and not a symlink.")
        for name in ("installation.json", "compose.json", "bridge.env"):
            if (target / name).is_symlink() or not (target / name).is_file():
                raise ValueError("Incomplete installation; inspect retained files before recovery.")
        if json.loads((target / "installation.json").read_text()).get("schema") != 1:
            raise ValueError("Unrecognized installation metadata.")
        if confirm("Start the existing bridge and enable Docker at boot, preserving its configuration?"):
            run(["systemctl", "enable", "--now", "docker"])
            start(target)
        return
    if target.exists() or target.is_symlink():
        raise ValueError("/opt/marifold-bridge already exists. Use --start for a managed installation; setup will not overwrite it.")
    print("Marifold bridge setup: Docker Compose on Linux, persistent containers with reboot recovery.")
    print("No changes to an existing Redis configuration, firewall rules, DNS or other projects.")
    print("Redis: 1) Create a separate persistent Redis on loopback port 32144 (default). 2) Use an existing Redis URL.")
    choice = input("Redis choice [1/2, default 1]: ").strip() or "1"
    if choice not in ("1", "2"):
        raise ValueError("Choose 1 or 2.")
    redis_url = None
    if choice == "2":
        print("Existing Redis must allow PING and bridge commands, persistence and non-eviction. Setup only tests PING; it does not configure or scan that database.")
        redis_url = validate_redis(getpass.getpass("Redis URL (hidden): "))
    print("HTTPS: 1) Set up Caddy for a domain. 2) Use an existing proxy/Cloudflare Tunnel (default).")
    ingress = input("HTTPS choice [1/2, default 2]: ").strip() or "2"
    if ingress not in ("1", "2"):
        raise ValueError("Choose 1 or 2.")
    domain = validate_domain(input("Bridge domain: ")) if ingress == "1" else None
    ports = [32143] + ([32144] if redis_url is None else []) + ([80, 443] if domain else [])
    for port in ports:
        check_port(port)
    print(f"Install: {target}; Redis: {'separate container' if redis_url is None else 'existing endpoint (credentials hidden)'}; HTTPS: {domain or 'existing ingress'}.")
    print("Downloads Node/Redis/Caddy images as needed, generates a private token, enables Docker at boot and starts services. Container restarts preserve named data volumes.")
    if not confirm("Proceed with this installation and its selected Redis connection?"):
        print("Cancelled; no installation written.")
        return
    run(["systemctl", "enable", "--now", "docker"])
    if run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT}", "--format", "{{.ID}}"]):
        raise ValueError("A Compose project with this name already exists; refusing to reuse its resources.")
    if run(["docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={PROJECT}", "--format", "{{.Name}}"]):
        raise ValueError("Volumes from an earlier installation exist; refusing to reuse data with new credentials.")
    source = Path(__file__).resolve().parent.parent
    prepare(source, target, redis_url, domain)
    start(target)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (ValueError, RuntimeError, OSError, EOFError, KeyboardInterrupt) as error:
        if isinstance(error, OSError):
            print("Setup failed due to a filesystem or process error. Existing data was not deleted.", file=sys.stderr)
        else:
            print(f"Setup stopped: {error}", file=sys.stderr)
        sys.exit(1)
