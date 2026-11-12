#!/usr/bin/env python3
"""Interactive B2 setup: never echo credentials or overwrite an existing repository password."""
import getpass
import os
from pathlib import Path
import re
import shlex
import sys

if not sys.stdin.isatty():
    sys.exit('Run this interactively over SSH; credentials must not be supplied as command arguments.')
root = Path(__file__).resolve().parent.parent
values = {}
for line in (root / '.env').read_text().splitlines():
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.split('=', 1)
        try: values[k.strip()] = shlex.split(v)[0]
        except (ValueError, IndexError): pass
secrets = Path(os.path.expanduser(values.get('PENNYWORTH_SECRETS_DIR', '~/.config/pennyworth')))
folder = secrets / 'backup'
folder.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(folder, 0o700)
if (folder / 'restic.env').exists():
    sys.exit('Backup configuration already exists. Keep it intact; edit it deliberately if changing destinations.')
bucket = input('B2 bucket name: ').strip()
endpoint = input('B2 S3 endpoint (hostname only): ').strip().removeprefix('https://').rstrip('/')
if not re.fullmatch(r'[A-Za-z0-9-]{6,63}', bucket) or not re.fullmatch(r's3\.[a-z0-9-]+\.backblazeb2\.com', endpoint):
    sys.exit('Invalid bucket name or B2 S3 endpoint.')
key_id = getpass.getpass('B2 keyID (hidden): ').strip()
key = getpass.getpass('B2 applicationKey (hidden): ').strip()
if not key_id or not key: sys.exit('Both B2 credentials are required.')
password_file = folder / 'password'
password = None
if not password_file.exists():
    print('Create and SAVE a long random backup password in your password manager before continuing.')
    password = getpass.getpass('Saved backup encryption password (hidden): ')
    confirm = getpass.getpass('Repeat backup encryption password (hidden): ')
    if password != confirm or len(password) < 24 or '\n' in password:
        sys.exit('Passwords must match and contain at least 24 characters without newlines. Nothing saved.')
os.umask(0o077)
if password is not None:
    with password_file.open('x') as f: f.write(password+'\n')
backup_name = values.get('PENNYWORTH_BACKUP_NAME', 'pennyworth')
if not re.fullmatch(r'[a-zA-Z0-9_-]+', backup_name): sys.exit('Invalid backup name.')
config = {'RESTIC_REPOSITORY': f's3:https://{endpoint}/{bucket}/{backup_name}', 'AWS_ACCESS_KEY_ID': key_id, 'AWS_SECRET_ACCESS_KEY': key}
with (folder / 'restic.env').open('x') as f:
    for k,v in config.items(): f.write(k+'='+shlex.quote(v)+'\n')
print('Backup credentials saved privately on this machine. Tell the assistant setup is complete.')
