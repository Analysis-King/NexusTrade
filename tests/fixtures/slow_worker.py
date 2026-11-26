"""Test icin sahte worker: her istegi sirayla isler, 'sleep' komutunda bekler."""
import json
import sys
import time

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    if req.get('cmd') == 'sleep':
        time.sleep(float(req.get('ms', 0)) / 1000.0)
    sys.stdout.write(json.dumps({'id': req.get('id'), 'ok': True, 'data': {'cmd': req.get('cmd')}}) + '\n')
    sys.stdout.flush()
