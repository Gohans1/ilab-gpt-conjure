#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION_SOURCE = ROOT / "codex_image" / "version.py"
PYPROJECT = ROOT / "pyproject.toml"
CARGO_MANIFEST = ROOT / "launcher" / "Cargo.toml"
CARGO_LOCK = ROOT / "launcher" / "Cargo.lock"
REQUIREMENTS_LOCK = ROOT / "requirements-webui.txt"
EXPECTED_LICENSE = "AGPL-3.0-only"
VERSION_PATTERN = re.compile(r'^APP_VERSION = "([^"]+)"$', re.MULTILINE)
PIN_PATTERN = re.compile(
    r"^(?P<name>[A-Za-z0-9_.-]+)(?:\[[A-Za-z0-9_.-]+\])?==(?P<version>[^\s;\\]+)"
)


def _canonical_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _application_version(problems: list[str]) -> str:
    matches = VERSION_PATTERN.findall(VERSION_SOURCE.read_text(encoding="utf-8"))
    if len(matches) != 1:
        problems.append("codex_image/version.py must define exactly one literal APP_VERSION")
        return ""
    return matches[0]


def _locked_versions(requirements_text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in requirements_text.splitlines():
        match = PIN_PATTERN.match(line.strip())
        if match is not None:
            result[_canonical_package_name(match.group("name"))] = match.group("version")
    return result


def check_contracts(*, release_tag: str = "") -> list[str]:
    problems: list[str] = []
    app_version = _application_version(problems)
    pyproject = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    cargo = tomllib.loads(CARGO_MANIFEST.read_text(encoding="utf-8"))
    cargo_lock = tomllib.loads(CARGO_LOCK.read_text(encoding="utf-8"))
    requirements_text = REQUIREMENTS_LOCK.read_text(encoding="utf-8")

    project = pyproject.get("project", {})
    build_requires = pyproject.get("build-system", {}).get("requires", [])
    if len(build_requires) != 1 or PIN_PATTERN.fullmatch(str(build_requires[0])) is None:
        problems.append("Python build backend must be exactly pinned")
    dynamic = project.get("dynamic", [])
    version_dynamic = (
        pyproject.get("tool", {})
        .get("setuptools", {})
        .get("dynamic", {})
        .get("version", {})
        .get("attr")
    )
    if "version" not in dynamic or version_dynamic != "codex_image.version.APP_VERSION":
        problems.append("pyproject version must derive from codex_image.version.APP_VERSION")
    if "version" in project:
        problems.append("pyproject must not duplicate a static project.version")

    cargo_package = cargo.get("package", {})
    if cargo_package.get("version") != app_version:
        problems.append("Cargo package version does not match application version")
    cargo_lock_packages = cargo_lock.get("package", [])
    locked_launcher = next(
        (
            package
            for package in cargo_lock_packages
            if package.get("name") == cargo_package.get("name")
        ),
        {},
    )
    if locked_launcher.get("version") != app_version:
        problems.append("Cargo.lock launcher version does not match application version")

    if project.get("license") != EXPECTED_LICENSE:
        problems.append(f"Python license must be {EXPECTED_LICENSE}")
    if cargo_package.get("license") != EXPECTED_LICENSE:
        problems.append(f"Rust license must be {EXPECTED_LICENSE}")

    if "--require-hashes" not in requirements_text:
        problems.append("requirements-webui.txt must enable --require-hashes")
    locked_versions = _locked_versions(requirements_text)
    for dependency in project.get("dependencies", []):
        match = PIN_PATTERN.match(str(dependency))
        if match is None:
            problems.append(f"runtime dependency is not exactly pinned: {dependency}")
            continue
        name = _canonical_package_name(match.group("name"))
        expected = match.group("version")
        if locked_versions.get(name) != expected:
            problems.append(f"dependency lock for {name} does not match pyproject")

    if release_tag:
        expected_tag = f"v{app_version}"
        if release_tag != expected_tag:
            problems.append(
                f"release tag {release_tag} does not match application version {expected_tag}"
            )

    return problems


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate release metadata and dependency locks.")
    parser.add_argument("--release-tag", default="")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        problems = check_contracts(release_tag=args.release_tag.strip())
    except (OSError, tomllib.TOMLDecodeError) as exc:
        print(f"Unable to validate release contracts: {exc}", file=sys.stderr)
        return 1
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    print("Release contracts verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
