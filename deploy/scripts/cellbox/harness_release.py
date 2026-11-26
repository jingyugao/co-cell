"""Pack pinned Linux/amd64 harnesses, or install a local/S3 release into a Box shared mount."""
import argparse
import base64
import errno
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
from urllib.parse import urlsplit

PRODUCT = Path(__file__).resolve().parents[2] / "box-wrap"
MAX_SIZE = 2 * 1024**3


def file_hash(path, algorithm="sha256"):
    with path.open("rb") as source:
        return hashlib.file_digest(source, algorithm)


def copy_members(archive, destination, prefix="", only=None):
    total = count = 0
    for entry in archive:
        if not entry.name.startswith(prefix):
            continue
        name = entry.name[len(prefix):]
        if not name or (only is not None and name not in only):
            continue
        parts = PurePosixPath(name)
        if parts.is_absolute() or ".." in parts.parts or not parts.parts:
            raise ValueError("Invalid path in release archive")
        target = destination / parts
        count += 1
        if count > 4096:
            raise ValueError("Too many release archive entries")
        if entry.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        total += entry.size
        if not entry.isfile() or total > MAX_SIZE:
            raise ValueError("Unsupported release archive entry")
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(entry) as src, target.open("xb") as out:
            shutil.copyfileobj(src, out)
        target.chmod(0o755 if entry.mode & 0o111 else 0o644)


def script(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nset -eu\n" + contents + "\n")
    path.chmod(0o755)


def product_assets(root, assets):
    # Keep source-relative imports intact, including the tool dispatcher's policy modules.
    for name in ("tool-client.mjs", "protected-tool.mjs", "oss-archive-restore.mjs"):
        dest = root / "product/cocell" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PRODUCT / name, dest)
    for name in ("tool-working-directory.mjs", "tool-runtime-identity.mjs", "dynamic-tool-config.mjs"):
        dest = root / "util" / name
        dest.parent.mkdir(exist_ok=True)
        shutil.copyfile(PRODUCT.parents[1] / "util" / name, dest)
    (root / "product/cocell/proxy-tool-ids.json").write_text('["cocell_tool"]')
    dispatch = 'root=${0%/*}/..\nexec "$root/bin/node" "$root/product/cocell/tool-client.mjs" --dynamic "$@"'
    script(root / "bin/cocell", dispatch)
    # Preserve the relative layout used by the same dispatcher in prepared images.
    proxy = root / "cellbox/tools/cocell-proxy.mjs"
    proxy.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(PRODUCT / "tools/cocell-proxy", proxy)
    for name, target in (("cocell-proxy", "cellbox/tools/cocell-proxy.mjs"), ("cocell-archive-restore", "product/cocell/oss-archive-restore.mjs")):
        script(root / "protected" / name, 'root=${0%/*}/..\nexec "$root/bin/node" "$root/' + target + '" "$@"')
    if assets is None:
        return
    if not assets.is_dir():
        raise ValueError("Expected an assets directory with AGENTS.md, skills/, docs/ or cli/")
    for name in ("AGENTS.md", "docs", "skills", "cli"):
        src = assets / name
        if not src.exists() and not src.is_symlink():
            continue
        entries = [src, *sorted(src.rglob("*"))]
        for item in entries:
            if item.is_symlink() or not (item.is_file() or item.is_dir()):
                raise ValueError(f"Unsupported product asset: {item}")
            if item == src and (name == "AGENTS.md") != item.is_file():
                raise ValueError(f"Unexpected product asset type: {item}")
            if item.is_file():
                target = root / "assets" / item.relative_to(assets)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(item, target)
        if name == "skills":
            for skill in src.iterdir():
                if not skill.is_dir() or not (skill / "SKILL.md").is_file():
                    raise ValueError(f"Expected skills/<name>/SKILL.md: {skill}")
        if name == "cli":
            for cli in src.iterdir():
                if cli.is_dir():
                    continue  # directories may contain libraries for a CLI
                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]*\.(mjs|js)", cli.name):
                    raise ValueError(f"Invalid CLI filename: {cli.name}")
                entry = root / "bin" / cli.stem
                if entry.exists() or cli.stem in {"codex", "claude", "claude-agent-acp", "rg"}:
                    raise ValueError(f"Reserved or duplicate CLI name: {cli.stem}")
                script(entry, 'root=${0%/*}/..\nexec "$root/bin/node" "$root/assets/cli/' + cli.name + '" "$@"')


def pack(artifacts, node, output, assets=None):
    pins = json.loads((PRODUCT / "runtime-packages.json").read_text())
    if subprocess.check_output([node, "-p", "process.platform+'-'+process.arch"], text=True).strip() != "linux-x64":
        raise ValueError("This release requires Linux x86-64 Node")
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        (root / "bin").mkdir()
        shutil.copy2(node, root / "bin/node")
        for key, folder, prefix, only in [
            ("codexLinuxX64","codex","package/vendor/x86_64-unknown-linux-musl/",None),
            ("claudeAcp","claude","",{"claude-agent-acp","claude"}),
        ]:
            pin = pins[key]
            source = artifacts / pin["file"]
            if key == "codexLinuxX64":
                valid = "sha512-" + base64.b64encode(file_hash(source, "sha512").digest()).decode() == pin["integrity"]
            else:
                valid = file_hash(source).hexdigest() == pin["sha256"]
            if not valid:
                raise ValueError(f"Incorrect vendor artifact digest for {key}")
            with tarfile.open(source, "r|gz") as archive:
                copy_members(archive, root / folder, prefix, only)
        product_assets(root, assets)
        for name in ("launcher.mjs", "harness-entry.mjs", "release-skills.mjs", "release-shell.mjs", "acp/host.mjs", "acp/server.mjs", "acp/questions.mjs"):
            (root / name).parent.mkdir(exist_ok=True)
            shutil.copyfile(PRODUCT / name, root / name)
        (root / "launch").write_text('#!/bin/sh\nset -eu\nroot=${0%/*}\nexport COCELL_HARNESS_BIN="$root/bin"\nexport PATH="$root/bin:$root/codex/bin:$root/codex/codex-path:$root/claude:$PATH"\nexec "$root/bin/node" "$root/harness-entry.mjs"\n')
        (root / "launch").chmod(0o755)
        # Stable content IDs also make publishing an unchanged release idempotent.
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as out:
            staged = Path(out.name)
        try:
            with staged.open("wb") as stream, gzip.GzipFile(filename="", fileobj=stream, mode="wb", mtime=0, compresslevel=1) as gz, tarfile.open(fileobj=gz, mode="w|") as archive:
                total = 0
                files = sorted(path for path in root.rglob("*") if path.is_file())
                if len(files) > 4096:
                    raise ValueError("Too many release archive entries")
                for path in files:
                    entry = tarfile.TarInfo(path.relative_to(root).as_posix())
                    entry.size = path.stat().st_size
                    total += entry.size
                    if total > MAX_SIZE:
                        raise ValueError("Release exceeds the unpacked size limit")
                    entry.mode = 0o755 if path.stat().st_mode & stat.S_IXUSR else 0o644
                    with path.open("rb") as f:
                        archive.addfile(entry, f)
            os.replace(staged, output)
        finally:
            staged.unlink(missing_ok=True)
    print(file_hash(output).hexdigest())


def prepare_protected_release(shared, dest):
    if os.geteuid() != 0:
        raise ValueError("Publish protected tools as root so Guest can verify their ownership")
    root = shared / "harness"
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    for path in (root, root / "versions"):
        fd = os.open(path, flags)
        try:
            os.fchown(fd, 0, 0)
            os.fchmod(fd, 0o755)
        finally:
            os.close(fd)
    # CoCell writes Box selections. The runtime directory is created by that same service.
    pins = root / "boxes"
    try:
        pins.mkdir(mode=0o755)
    except FileExistsError:
        if pins.is_symlink() or not pins.is_dir():
            raise ValueError("Unexpected Harness Box selection directory")
    else:
        owner = (shared / "runtime").stat() if (shared / "runtime").is_dir() else shared.stat()
        os.chown(pins, owner.st_uid, owner.st_gid, follow_symlinks=False)
    # A cached directory may predate root-owned releases. Never elevate its contents.
    if dest.exists():
        for path in (dest, *dest.rglob("*")):
            info = path.lstat()
            if info.st_uid or info.st_mode & 0o022 or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError(f"Untrusted cached release entry: {path}")


def publish(source, digest, shared):
    if not re.fullmatch("[a-f0-9]{64}", digest):
        raise ValueError("Expected a SHA-256 digest")
    root = shared / "harness"
    versions = root / "versions"
    versions.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root, prefix=".publish-") as temp:
        temp = Path(temp)
        dest = versions / digest
        if dest.is_symlink() or (dest.exists() and not dest.is_dir()):
            raise ValueError("Unexpected release version directory")
        if not dest.exists():
            # Verify a private copy before unpacking, including for mounted OSS directories.
            bundle = temp / "bundle"
            if source.startswith("s3://"):
                import boto3
                url = urlsplit(source)
                if not url.netloc or not url.path.lstrip("/") or url.query or url.fragment:
                    raise ValueError("Invalid S3 object")
                boto3.client("s3", endpoint_url=os.environ.get("OSS_ENDPOINT")).download_file(url.netloc, url.path[1:], str(bundle))
            else:
                shutil.copyfile(source, bundle)
            if file_hash(bundle).hexdigest() != digest:
                raise ValueError("Harness bundle checksum mismatch")
            stage = temp / "release"
            stage.mkdir(mode=0o755)
            with tarfile.open(bundle, "r|gz") as archive:
                copy_members(archive, stage)
            if not (stage / "launch").is_file() or not os.access(stage / "launch", os.X_OK):
                raise ValueError("Release has no executable launch entry")
            if (stage / "protected").is_dir():
                prepare_protected_release(shared, dest)
            try:
                stage.rename(dest)
            except OSError as error:
                if error.errno not in (errno.EEXIST, errno.ENOTEMPTY) or not dest.is_dir():
                    raise
        elif (dest / "protected").is_dir():
            prepare_protected_release(shared, dest)
        pointer = temp / "current"
        pointer.write_text(digest + "\n")
        pointer.chmod(0o644)
        pointer.replace(root / "current")
    print(digest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("pack")
    build.add_argument("--artifacts", type=Path, default=PRODUCT / "artifacts")
    build.add_argument("--node", type=Path, default=shutil.which("node"))
    build.add_argument("--assets", type=Path, default=os.environ.get("COCELL_HARNESS_ASSETS"), help="Directory containing release AGENTS.md, docs/, skills/<name>/SKILL.md and cli/*.js or *.mjs")
    build.add_argument("--output", type=Path, required=True)
    install = commands.add_parser("publish", help="Materialize a verified release and select it for new Boxes")
    install.add_argument("source", help="Path to a release .tar.gz or s3://bucket/key")
    install.add_argument("--sha256", required=True)
    install.add_argument("--shared-root", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o022)
    if args.command == "pack":
        pack(args.artifacts, args.node, args.output, args.assets)
    else:
        publish(args.source, args.sha256, args.shared_root)
