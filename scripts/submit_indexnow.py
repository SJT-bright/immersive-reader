#!/usr/bin/env python3
"""Notify participating search engines about this public project's six HTML pages.
The key is a generated site verification token, not an account credential.
Dry run is the default; --submit makes a single network request.
"""
import argparse,http.client,json
from pathlib import Path
from urllib.parse import urlsplit

root=Path(__file__).resolve().parents[1]
f=json.loads((root/'docs/project-facts.json').read_text())
k=json.loads((root/'site/indexnow.json').read_text())
base=f['homepage']
# 边界：key 托管位置只允许本项目官方 https 站点；探测与提交均直连字面主机，
# 不构造可变 URL、不跟随重定向（http.client 收到 3xx 只返回状态码）。
parts=urlsplit(base)
if parts.scheme!='https' or parts.hostname!='sjt-bright.github.io':
 raise SystemExit('homepage 必须是 https://sjt-bright.github.io/ 才提交 IndexNow：'+base)
key_path=urlsplit(base+k['keyFile']).path
if not key_path.startswith('/immersive-reader/'):
 raise SystemExit('keyLocation 路径必须位于 /immersive-reader/ 下：'+key_path)
urls=[base+x for x in ['', 'features.html','faq.html','en/','en/features.html','en/faq.html']]
payload={'host':parts.netloc,'key':k['key'],'keyLocation':base+k['keyFile'],'urlList':urls}
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--submit',action='store_true')
args=parser.parse_args()
if not args.submit:
 print(json.dumps({'mode':'dry-run','host':payload['host'],'urls':urls},indent=2));raise SystemExit()
conn=http.client.HTTPSConnection('sjt-bright.github.io',443,timeout=30)
try:
 conn.request('GET',key_path,headers={'User-Agent':'ImmersiveReader-SiteCheck/1.0'})
 resp=conn.getresponse()
 assert resp.status==200 and resp.read().decode().strip()==k['key'], 'Published key unavailable'
finally:
 conn.close()
try:
 conn=http.client.HTTPSConnection('api.indexnow.org',443,timeout=30)
 try:
  conn.request('POST','/indexnow',body=json.dumps(payload).encode(),headers={'Content-Type':'application/json; charset=utf-8','User-Agent':'ImmersiveReader-PublicSite/1.0'})
  resp=conn.getresponse();status=resp.status;body=resp.read().decode()
 finally:
  conn.close()
except (OSError,http.client.HTTPException) as ex:
 status=0;body=str(ex)
print(json.dumps({'status':status,'submittedURLs':len(urls),'result':'received; validation pending' if status==202 else 'received' if status==200 else 'not accepted','body':body},ensure_ascii=False))
raise SystemExit(0 if status in [200,202] else 1)
