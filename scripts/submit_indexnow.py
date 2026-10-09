#!/usr/bin/env python3
"""Notify participating search engines about this public project's six HTML pages.
The key is a generated site verification token, not an account credential.
Dry run is the default; --submit makes a single network request.
"""
import argparse,json
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from urllib.parse import urlsplit

root=Path(__file__).resolve().parents[1]
f=json.loads((root/'docs/project-facts.json').read_text())
k=json.loads((root/'site/indexnow.json').read_text())
base=f['homepage']
urls=[base+x for x in ['', 'features.html','faq.html','en/','en/features.html','en/faq.html']]
payload={'host':urlsplit(base).netloc,'key':k['key'],'keyLocation':base+k['keyFile'],'urlList':urls}
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--submit',action='store_true')
args=parser.parse_args()
if not args.submit:
 print(json.dumps({'mode':'dry-run','host':payload['host'],'urls':urls},indent=2));raise SystemExit()
with urlopen(Request(payload['keyLocation'],headers={'User-Agent':'ImmersiveReader-SiteCheck/1.0'}),timeout=30) as r:
 assert r.status==200 and r.read().decode().strip()==k['key'], 'Published key unavailable'
req=Request('https://api.indexnow.org/indexnow',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json; charset=utf-8','User-Agent':'ImmersiveReader-PublicSite/1.0'},method='POST')
try:
 with urlopen(req,timeout=30) as r:status=r.status;body=r.read().decode()
except HTTPError as ex:
 status=ex.code;body=ex.read().decode()
print(json.dumps({'status':status,'submittedURLs':len(urls),'result':'received; validation pending' if status==202 else 'received' if status==200 else 'not accepted','body':body},ensure_ascii=False))
raise SystemExit(0 if status in [200,202] else 1)
