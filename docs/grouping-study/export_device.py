#!/usr/bin/env python3
"""Export a device database's present photos for the node replay harness
(m0.9 phase 10): one JSON line per present, dated photo with a device
vector — {id, uri, ts, kind, vec (base64 float32, L2-normalised), hash}.
Usage: venv/bin/python export_device.py <afterglow.db> <out.jsonl>
"""
import sys, json, sqlite3, base64
DB, OUT = sys.argv[1], sys.argv[2]
con = sqlite3.connect(DB)
hashes = dict(con.execute('SELECT asset_id, hash FROM photo_hashes'))
vecs = dict(con.execute('SELECT asset_id, vec FROM photo_embeddings'))
n = 0
with open(OUT, 'w') as f:
    for asset_id, uri, ts, kind in con.execute(
        "SELECT asset_id, uri, taken_at, kind FROM photos WHERE is_present = 1 AND day IS NOT NULL ORDER BY taken_at"):
        if asset_id not in vecs:
            continue
        f.write(json.dumps({'id': asset_id, 'uri': uri, 'ts': ts, 'kind': kind,
                            'vec': base64.b64encode(vecs[asset_id]).decode(),
                            'hash': hashes.get(asset_id)}) + '\n')
        n += 1
print(f'wrote {n} rows to {OUT}')
