"""Read an untrusted package as bounded inert bytes. Never extract or execute it."""
import base64
import json
import stat
import sys
import tarfile
import zipfile

MAX_BYTES = 32 * 1024 * 1024
MAX_FILES = 2000


def read_package(filename):
    result = {}
    total = 0
    archive = zipfile.ZipFile(filename) if zipfile.is_zipfile(filename) else tarfile.open(filename)
    with archive:
        entries = archive.infolist() if isinstance(archive, zipfile.ZipFile) else archive.getmembers()
        if len(entries) > MAX_FILES:
            raise ValueError()
        for item in entries:
            zipped = isinstance(archive, zipfile.ZipFile)
            name = item.filename if zipped else item.name
            while name.startswith("./"):
                name = name[2:]
            parts = name.rstrip("/").split("/")
            if not name or name.startswith("/") or "\\" in name or any(p in ("", ".", "..") for p in parts):
                raise ValueError()
            if any(ord(c) < 32 for c in name):
                raise ValueError()
            mode = item.external_attr >> 16 if zipped else 0
            if zipped and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError()
            if (item.is_dir() if zipped else item.isdir()):
                continue
            if not zipped and not item.isfile():
                raise ValueError()
            size = item.file_size if zipped else item.size
            total += size
            if name in result or size < 0 or total > MAX_BYTES:
                raise ValueError()
            with (archive.open(item) if zipped else archive.extractfile(item)) as source:
                content = source.read(size + 1)
            if len(content) != size:
                raise ValueError()
            result[name] = base64.b64encode(content).decode("ascii")
    return dict(sorted(result.items()))


try:
    print(json.dumps(read_package(sys.argv[1]), separators=(",", ":")))
except Exception:
    sys.stderr.write("skill_artifact_archive_rejected\n")
    sys.exit(1)
