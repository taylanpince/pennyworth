#!/usr/bin/env python3
"""Exercise backup coverage and restore guards with isolated fixture state."""
import gzip
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for d in ['config', 'data/board', 'data/ops-mcp', 'runner', 'whatsapp', 'bin', 'secrets', 'data/paperclip/instances/default/secrets', 'data/paperclip/instances/default/data/backups']:
            (self.root/d).mkdir(parents=True, exist_ok=True)
        for f in ['data/board/board.sqlite', 'data/ops-mcp/state.sqlite', 'runner/state.sqlite', 'whatsapp/messages.sqlite']:
            db = sqlite3.connect(self.root/f)
            db.execute('create table fixture(value text)'); db.execute("insert into fixture values('retained')"); db.commit(); db.close()
        (self.root/'config/household.md').write_text('Personal prompt')
        (self.root/'config/system.yaml').write_text('timezone: Europe/Madrid\n')
        (self.root/'data/paperclip/instances/default/secrets/master.key').write_text('fixture-master-key')
        (self.root/'whatsapp/session').mkdir(); (self.root/'whatsapp/session/creds.json').write_text('MUST-NOT-BACK-UP')
        (self.root/'secrets/password').write_text('MUST-NOT-BACK-UP')
        with gzip.open(self.root/'data/paperclip/instances/default/data/backups/paperclip-fixture.sql.gz','wb') as f:
            f.write(b'BEGIN;\nCOMMIT;\n')
        self.values = {'PENNYWORTH_DATA_DIR': str(self.root/'data'), 'PENNYWORTH_CONFIG_DIR': str(self.root/'config'), 'PENNYWORTH_RUNNER_STATE_DIR': str(self.root/'runner'), 'PENNYWORTH_SECRETS_DIR': str(self.root/'secrets'), 'PENNYWORTH_WHATSAPP_STATE_DIR': str(self.root/'whatsapp'), 'PENNYWORTH_RUNNER_SERVICE': 'fixture-runner', 'PENNYWORTH_BACKUP_NAME': 'fixture'}
        self.envfile = self.root/'env'; self.save_env()
        for command, content in {'docker': '#!/bin/sh\nexit 0\n', 'systemctl': '#!/bin/sh\n[ "$*" = "--user is-active -q fixture-runner" ]\n'}.items():
            p=self.root/'bin'/command; p.write_text(content); p.chmod(0o755)
        self.env = dict(os.environ, PENNYWORTH_ENV_FILE=str(self.envfile), PATH=str(self.root/'bin')+':'+os.environ['PATH'])
    def save_env(self):
        self.envfile.write_text(''.join(k+'='+shlex.quote(v)+'\n' for k,v in self.values.items()))
    def test_archive_preserves_state_without_sessions(self):
        subprocess.run(['bash',str(ROOT/'scripts/backup.sh'),str(self.root/'out')],env=self.env,check=True,capture_output=True)
        with tarfile.open(next((self.root/'out').glob('*.tar.gz'))) as tar:
            names=set(n.removeprefix('./') for n in tar.getnames())
            for n in ['config/household.md','runner/state.sqlite','whatsapp/messages.sqlite','paperclip/instance/secrets/master.key']:
                self.assertIn(n,names)
            self.assertFalse(any('creds.json' in n or n.endswith('/password') for n in names))
            p=self.root/'restored.sqlite'; p.write_bytes(tar.extractfile('./whatsapp/messages.sqlite').read())
            with sqlite3.connect(p) as db:
                self.assertEqual(db.execute('pragma integrity_check').fetchone()[0],'ok')
                self.assertEqual(db.execute('select value from fixture').fetchone()[0],'retained')
    def test_missing_configured_whatsapp_fails(self):
        (self.root/'whatsapp/messages.sqlite').unlink()
        r=subprocess.run(['bash',str(ROOT/'scripts/backup.sh'),str(self.root/'out')],env=self.env,capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0); self.assertIn('configured WhatsApp database is missing',r.stderr)
    def test_restore_refuses_instance_runner(self):
        r=subprocess.run(['bash',str(ROOT/'scripts/restore.sh'),'unused.tar.gz'],env=self.env,capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0); self.assertIn('stop fixture-runner',r.stderr)

if __name__ == '__main__': unittest.main()
