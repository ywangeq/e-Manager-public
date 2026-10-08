"""Check the exact candidate tree and release archives; never print matched values."""
from pathlib import Path
import argparse
import json
import re
import subprocess
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--archive', action='append', default=[])
parser.add_argument('--secret-env', action='append', default=[])
parser.add_argument('--tree')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
patterns = [
    re.compile(rb'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{15,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,})'),
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{40,}'),
    re.compile(rb'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'),
]
secret_values = set()
for file in args.secret_env:
    for line in Path(file).read_text().splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*?)\s*$', line)
        if match and re.search(r'SECRET|TOKEN|PASSWORD|(?:API|ENCRYPTION|DIGEST)_KEY', match[1]):
            value = match[2].strip('"\'')
            if len(value) >= 8:
                secret_values.add(value.encode())
# The current installation is never part of the distribution.
for file in (root / 'data/local').glob('*.json'):
    if file.name in ['runtime-secrets.json', 'local-account.json']:
        for value in json.loads(file.read_text()).values():
            if isinstance(value, str) and len(value) >= 20:
                secret_values.add(value.encode())
password = root / 'data/local/first-login.txt'
if password.exists():
    for line in password.read_text().splitlines():
        if line.startswith('密码：'):
            secret_values.add(line.split('：', 1)[1].strip().encode())
findings = []

def check(name, content):
    parts = Path(name).parts
    desktop_dependency = '.app/Contents/Resources/app.asar.unpacked/node_modules/' in name
    if any(p in ['.git', 'target', '.DS_Store'] for p in parts) or name.startswith(('data/', 'node_modules/')) or ('node_modules' in parts and not desktop_dependency) or any(p.startswith('.env') for p in parts) or 'digital-employee-characters' in parts:
        findings.append((name, 'excluded_path'))
    if any(p.search(content) for p in patterns):
        findings.append((name, 'credential_signature'))
    if any(value and value in content for value in secret_values):
        findings.append((name, 'local_secret_match'))

if args.tree:
    files = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '-z', args.tree], cwd=root).decode().split('\0')
else:
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
for name in filter(None, files):
    content = subprocess.check_output(['git', 'show', f'{args.tree}:{name}'], cwd=root) if args.tree else (root / name).read_bytes()
    check(name, content)
for archive in args.archive:
    with zipfile.ZipFile(root / archive) as z:
        for name in z.namelist():
            if not name.endswith('/'):
                check(name, z.read(name))
if findings:
    print(json.dumps({'passed': False, 'findings': sorted(set(findings))}))
    raise SystemExit(1)
print(json.dumps({'passed': True, 'files': len(list(filter(None, files))), 'archives': len(args.archive), 'knownSecretsChecked': len(secret_values)}))
