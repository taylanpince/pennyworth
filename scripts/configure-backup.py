#!/usr/bin/env python3
"""Interactive B2 setup with masked feedback; existing encryption passwords are preserved."""
import getpass
import inspect
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import json


def read_values(path):
    values = {}
    if not path.exists(): return values
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k, v = line.split('=', 1)
            try: values[k.strip()] = shlex.split(v)[0]
            except (ValueError, IndexError): pass
    return values


def masked(prompt, *, trim=False):
    # Python 3.14 supplies terminal editing and masking without exposing pasted secrets.
    if 'echo_char' not in inspect.signature(getpass.getpass).parameters:
        raise SystemExit('Masked input requires Python 3.14 or newer. No files changed.')
    value = getpass.getpass(prompt, echo_char='*')
    if trim: value = value.strip()
    print(f'  Received {len(value)} characters.')
    return value


def encryption_password():
    print('Create and SAVE a random password of at least 24 characters in your password manager.')
    while True:
        password = masked('Saved backup encryption password: ')
        if len(password) < 24 or any(ord(c) < 32 or ord(c) == 127 for c in password):
            print('Use at least 24 characters without control characters. Try again.'); continue
        confirm = masked('Repeat backup encryption password: ')
        if password == confirm: return password
        print('Passwords did not match. Nothing saved; paste the same password into both prompts again.')


def main():
    if not sys.stdin.isatty():
        sys.exit('Run this interactively over SSH; credentials must not be supplied as command arguments.')
    if sys.argv[1:] not in ([], ['--replace-key']):
        sys.exit('Usage: configure-backup.py [--replace-key]')
    root = Path(__file__).resolve().parent.parent
    values = read_values(root / '.env')
    secrets = Path(os.path.expanduser(values.get('PENNYWORTH_SECRETS_DIR', '~/.config/pennyworth')))
    folder = secrets / 'backup'
    os.umask(0o077)
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(folder, 0o700)
    config_file = folder / 'restic.env'
    current = read_values(config_file)
    replace = '--replace-key' in sys.argv
    if config_file.exists() and not replace:
        sys.exit('Configuration already saved. To correct B2 credentials, rerun with --replace-key. The repository and encryption password will be preserved.')
    if replace and (not current.get('RESTIC_REPOSITORY') or not (folder / 'password').exists()):
        sys.exit('No complete existing configuration to update. Run without --replace-key.')
    backup_name = values.get('PENNYWORTH_BACKUP_NAME', 'pennyworth')
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', backup_name): sys.exit('Invalid backup name.')
    if replace:
        repository = current['RESTIC_REPOSITORY']
        print('Updating B2 credentials only; keeping the repository and encryption password.')
    else:
        defaults = json.loads((folder / 'setup.json').read_text()) if (folder / 'setup.json').exists() else {}
        bucket = input(f"B2 bucket name [{defaults.get('bucket', '')}]: ").strip() or defaults.get('bucket', '')
        endpoint = (input(f"B2 S3 endpoint [{defaults.get('endpoint', '')}]: ").strip() or defaults.get('endpoint', '')).removeprefix('https://').rstrip('/')
        if not re.fullmatch(r'[A-Za-z0-9-]{6,63}', bucket) or not re.fullmatch(r's3\.[a-z0-9-]+\.backblazeb2\.com', endpoint):
            sys.exit('Invalid bucket name or B2 S3 endpoint. Nothing saved.')
        repository = f's3:https://{endpoint}/{bucket}/{backup_name}'
    print('Secrets display as *. Backspace edits the input; Ctrl-C cancels. Paste one field at a time.')
    # The key ID is an identifier, so showing it makes clipboard mistakes easier to spot.
    key_id = input('B2 keyID (visible): ').strip()
    while True:
        key = masked('B2 applicationKey: ', trim=True)
        if key and not any(c.isspace() or ord(c) < 32 for c in key): break
        print('The application key must be nonempty and contain no whitespace. Try again.')
    if not key_id or any(c.isspace() for c in key_id): sys.exit('Invalid keyID. Nothing saved.')
    password_file = folder / 'password'
    password = encryption_password() if not password_file.exists() else None
    if password is not None:
        with password_file.open('x') as f: f.write(password+'\n')
    config = {'RESTIC_REPOSITORY': repository, 'AWS_ACCESS_KEY_ID': key_id, 'AWS_SECRET_ACCESS_KEY': key}
    fd, name = tempfile.mkstemp(prefix='.restic-', dir=folder)
    try:
        with os.fdopen(fd, 'w') as f:
            for k,v in config.items(): f.write(k+'='+shlex.quote(v)+'\n')
        os.replace(name, config_file)
    finally:
        if os.path.exists(name): os.unlink(name)
    print('Backup credentials saved privately on this machine. Tell the assistant setup is complete.')


if __name__ == '__main__':
    try: main()
    except (KeyboardInterrupt, EOFError): sys.exit('\nCancelled. Existing credentials were not changed.')
