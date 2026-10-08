"""Validate syntax/import availability without importing or running package code."""
import ast
import importlib.metadata
import importlib.util
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / "runtime-harness.json").read_text())
minimum = tuple(int(p) for p in manifest.get("pythonMinVersion", "3.9").split("."))
assert sys.version_info >= minimum
dependencies = manifest.get("dependencies", {})
assert isinstance(dependencies, dict)
for name, version in dependencies.items():
    assert isinstance(version, str) and importlib.metadata.version(name) == version
local = {p.stem for p in root.rglob("*.py")} | {p.name for p in root.rglob("*") if p.is_dir()}
for filename in root.rglob("*.py"):
    tree = ast.parse(filename.read_bytes(), filename="<harness>")
    for node in ast.walk(tree):
        names = [n.name for n in node.names] if isinstance(node, ast.Import) else (
            [node.module] if isinstance(node, ast.ImportFrom) and node.module and not node.level else [])
        for name in names:
            module = name.split(".")[0]
            if module not in local:
                assert importlib.util.find_spec(module) is not None
