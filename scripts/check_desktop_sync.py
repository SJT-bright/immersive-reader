#!/usr/bin/env python3
"""Read-only check: ensure the desktop bundle really contains the current source."""
import argparse, hashlib, json, urllib.request
from pathlib import Path

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--live',help='Optional local server URL, for example http://127.0.0.1:8940')
args=parser.parse_args()
site=root/'dist/mac/沉浸阅读器.app/Contents/Resources/app/site'
manifest=site/'build-manifest.json'
if not manifest.exists():raise SystemExit('Desktop build manifest missing; rebuild the app.')
entries=json.loads(manifest.read_text())['files']
failures=[]
digest=lambda b:hashlib.sha256(b).hexdigest()
for relative,item in entries.items():
 for label,path in [('source',root/item['source']),('bundle',site/relative)]:
  if not path.is_file() or digest(path.read_bytes())!=item['sha256']:failures.append(label+': '+relative)
 if args.live and (relative=='index.html' or relative.startswith(('js/','css/'))):
  try:
   request=urllib.request.Request(args.live.rstrip('/')+'/'+relative,headers={'Cache-Control':'no-cache'})
   if digest(urllib.request.urlopen(request,timeout=5).read())!=item['sha256']:failures.append('live: '+relative)
  except Exception as e:failures.append('live: '+relative+' '+str(e))
if failures:raise SystemExit('\n'.join(failures))
print(f'PASS {len(entries)} bundled files match current source'+(' and live JS/CSS/HTML match' if args.live else ''))
