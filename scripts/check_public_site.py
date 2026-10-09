#!/usr/bin/env python3
"""Check the exported public site for broken local links and conflicting metadata."""
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
facts = json.loads((ROOT / 'docs/project-facts.json').read_text())
assert facts['version'] == json.loads((ROOT / 'desktop/package.json').read_text())['version']
assert facts['version'] == json.loads((ROOT / 'cloud/package.json').read_text())['version']
assert json.loads((SITE / 'project.json').read_text()) == facts
issues, checked = [], 0

class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.links=[]; self.ids=set(); self.canonical=[]; self.description=[]; self.h1=0; self.jsons=[]; self.collect=False; self.buf=''
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if a.get('id'): self.ids.add(a['id'])
        if tag=='h1': self.h1+=1
        if tag=='link' and a.get('rel')=='canonical': self.canonical.append(a.get('href',''))
        if tag=='meta' and a.get('name')=='description': self.description.append(a.get('content',''))
        for k in ['href','src']:
            if k in a: self.links.append(a[k])
        if tag=='img' and not a.get('alt'): issues.append('image missing alt')
        if tag=='script' and a.get('type')=='application/ld+json': self.collect=True; self.buf=''
    def handle_data(self,data):
        if self.collect:self.buf+=data
    def handle_endtag(self,tag):
        if tag=='script' and self.collect: self.jsons.append(json.loads(self.buf));self.collect=False

pages=sorted(SITE.rglob('*.html'))
assert len(pages)==6, len(pages)
for p in pages:
    parser=Page();html=p.read_text();parser.feed(html)
    rel=p.relative_to(SITE).as_posix()
    url=facts['homepage']+(rel[:-10] if rel.endswith('index.html') else rel)
    assert parser.canonical==[url], (p,parser.canonical,url)
    assert parser.h1==1 and len(parser.description)==1 and parser.description[0]
    assert 'noindex' not in html
    assert len(parser.jsons)==1
    app=next(x for x in parser.jsons[0]['@graph'] if x['@type']=='SoftwareApplication')
    assert app['softwareVersion']==facts['version']
    assert len(app['featureList'])==len(facts['features'])
    assert app['license'].endswith('LICENSE-NOTES.md')
    for link in parser.links:
        u=urlsplit(link)
        if u.scheme or u.netloc or not u.path:continue
        target=(p.parent/unquote(u.path)).resolve()
        if target.is_dir():target=target/'index.html'
        if not target.is_file():issues.append(f'{rel}: broken {link}')
        if u.fragment and target.is_file() and target.suffix=='.html':
            other=Page();other.feed(target.read_text())
            if u.fragment not in other.ids:issues.append(f'{rel}: missing anchor {link}')
        checked+=1
    if p.name=='faq.html':
        key='zhQ' if 'en' not in p.relative_to(SITE).parts else 'enQ'
        for q in facts['faq']:assert q[key] in html
sitemap=ET.parse(SITE/'sitemap.xml')
locs=[x.text for x in sitemap.getroot().iter('{http://www.sitemaps.org/schemas/sitemap/0.9}loc')]
assert len(set(locs))==6
assert not issues, issues
print(f'PASS: 6 pages, {checked} local links/assets, structured data, version consistency, 14 bilingual FAQ entries and sitemap.')
