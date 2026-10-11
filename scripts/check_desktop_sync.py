#!/usr/bin/env python3
"""Read-only check: ensure the desktop bundle really contains the current source."""
import argparse, hashlib, ipaddress, json, socket, urllib.request
from pathlib import Path
from urllib.parse import urlsplit

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--live',help='Optional local server URL, for example http://127.0.0.1:8940')
args=parser.parse_args()

def live_allowed(target):
	# 请求边界：仅 http(s)；允许回环（本机服务自检）或解析为公网的地址；拒绝内网/保留/链路本地网段。
	parts=urlsplit(target)
	if parts.scheme not in ('http','https') or not parts.hostname:return False
	if parts.hostname in ('127.0.0.1','localhost','::1'):return True
	try:
		infos=socket.getaddrinfo(parts.hostname,None)
	except OSError:
		return False
	for info in infos:
		ip=ipaddress.ip_address(info[4][0])
		if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
			return False
	return True

if args.live and not live_allowed(args.live):
	raise SystemExit('--live 仅接受 http(s) 的回环地址或解析为公网的主机；已拒绝: '+args.live)

class _NoRedirect(urllib.request.HTTPRedirectHandler):
	def redirect_request(self,req,fp,code,msg,headers,newurl):return None

# 直连已校验目标且拒绝重定向，避免校验后被 30x 带去其他地址。
_opener=urllib.request.build_opener(_NoRedirect)
site=root/'dist/mac/沉浸阅读器.app/Contents/Resources/app/site'
manifest=site/'build-manifest.json'
if not manifest.exists():raise SystemExit('Desktop build manifest missing; rebuild the app.')
entries=json.loads(manifest.read_text())['files']
failures=[]
digest=lambda b:hashlib.sha256(b).hexdigest()

# A hash-only check cannot find newly added source files absent from an older
# bundle's manifest. Mirror build_desktop.py's input set before checking hashes.
expected={}
for folder in ('js','css','assets','licenses','icons'):
 for path in (root/folder).rglob('*'):
  if path.is_file() and not any(part in ('.DS_Store','__pycache__') for part in path.relative_to(root).parts):
   expected[path.relative_to(root).as_posix()]=path
vendor_record=json.loads((root/'licenses/foliate-js-sha256.json').read_text())
for relative in vendor_record['files']:
 name='vendor/foliate-js/'+relative
 expected[name]=root/name
for name in ('index.html','sw.js','manifest.webmanifest','THIRD_PARTY_NOTICES.md'):
 expected[name]=root/name
expected['server.cjs']=root/'cloud/server.js'
for relative in sorted(expected.keys()-entries.keys()):failures.append('missing: '+relative)
for relative in sorted(entries.keys()-expected.keys()):failures.append('unexpected: '+relative)
for relative,item in entries.items():
 for label,path in [('source',root/item['source']),('bundle',site/relative)]:
  if not path.is_file() or digest(path.read_bytes())!=item['sha256']:failures.append(label+': '+relative)
 if args.live and (relative=='index.html' or relative.startswith(('js/','css/'))):
  try:
   request=urllib.request.Request(args.live.rstrip('/')+'/'+relative,headers={'Cache-Control':'no-cache'})
   if digest(_opener.open(request,timeout=5).read())!=item['sha256']:failures.append('live: '+relative)
  except Exception as e:failures.append('live: '+relative+' '+str(e))
# Also catch files added to the bundle without a manifest entry.
for path in site.rglob('*'):
 if path.is_file():
  relative=path.relative_to(site).as_posix()
  if relative!='build-manifest.json' and relative not in entries:failures.append('unlisted: '+relative)
if failures:raise SystemExit('\n'.join(failures))
print(f'PASS {len(entries)} bundled files match current source'+(' and live JS/CSS/HTML match' if args.live else ''))
