"""Package a public local distribution; installation data and dependencies are excluded."""
from pathlib import Path
import re
import zipfile

root = Path(__file__).resolve().parent.parent
files = set()
for name in ['server', 'src', 'config', 'tools', 'dist', 'docs', 'examples', 'desktop-channel-mvp/shared']:
    files.update(p for p in (root / name).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
files.update(root / name for name in ['package.json', 'pnpm-lock.yaml', 'index.html', 'vite.config.js', 'README.md', 'LICENSE', 'NOTICE'])
queue = list(files)
imports = re.compile(r'''(?:from\s*|import\s*\(|require\s*\(|new URL\s*\()\s*["'](\.[^"']+)["']''')
while queue:
    file = queue.pop()
    if file.suffix not in ['.js', '.jsx', '.mjs', '.cjs']:
        continue
    for relative in imports.findall(file.read_text()):
        base = (file.parent / relative).resolve()
        base.relative_to(root)
        for candidate in [base, Path(str(base) + '.js'), Path(str(base) + '.mjs'), base / 'index.js']:
            if candidate.is_file():
                if candidate not in files:
                    files.add(candidate)
                    queue.append(candidate)
                break
output = root / 'publication-assets' / 'e-manager-center-local.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(files):
        name = file.relative_to(root).as_posix()
        if name.startswith(('data/', '.git/')) or '/node_modules/' in name or name.startswith('src/assets/digital-employee-characters/'):
            raise ValueError('private asset or installation data in archive')
        archive.write(file, name)
    archive.writestr('pnpm-workspace.yaml', 'packages:\n  - .\n')
print(output)
