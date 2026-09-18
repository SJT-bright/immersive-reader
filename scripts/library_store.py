"""Durable local library. Binary files live in SQLite, never in the source archive."""
import base64
import json
import os
import time
import sqlite3
from pathlib import Path

class LibraryStore:
    def __init__(self, root, port):
        folder = (Path(os.environ.get('READER_DATA_DIR', str(Path.home() / 'Library/Application Support/immersive-reader-app/library')))
                  if port == 8940 else root / ('.preview/data-%s' % port))
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / 'library.sqlite3'
        legacy = root / 'data/library.sqlite3'
        if port == 8940 and not self.path.exists() and legacy.exists():
            with sqlite3.connect(str(legacy)) as source, sqlite3.connect(str(self.path)) as destination:
                source.backup(destination)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS records (store TEXT, id TEXT, meta TEXT, data BLOB, mime TEXT, PRIMARY KEY(store,id))')
    def connect(self):
        return sqlite3.connect(self.path, timeout=20)
    def run(self, item):
        op = item.get('op')
        with self.connect() as db:
            if op == 'list':
                return {'records':[{'store':s, **json.loads(m)} for s,m in db.execute('SELECT store,meta FROM records')]}
            store, key = item.get('store'), item.get('id')
            if store not in ['books','backgrounds','audio','qq'] or not isinstance(key,str) or not 0 < len(key) <= 120:
                raise ValueError('Invalid record')
            if op == 'get':
                row=db.execute('SELECT meta,data,mime FROM records WHERE store=? AND id=?',(store,key)).fetchone()
                if not row: raise ValueError('Record missing')
                return {**json.loads(row[0]),'data':base64.b64encode(row[1]).decode(),'mime':row[2]}
            if op == 'delete':
                db.execute('DELETE FROM records WHERE store=? AND id=?',(store,key));return {'ok':True}
            if op == 'note':
                note = item.get('note')
                if store != 'books' or not isinstance(note, dict) or not isinstance(note.get('id'), str) or not 0 < len(note['id']) <= 120:
                    raise ValueError('Invalid note')
                if not item.get('remove') and (note.get('type') not in ['quote', 'bookmark'] or not isinstance(note.get('cfi'), str) or not note['cfi'].startswith('epubcfi(')):
                    raise ValueError('Invalid note anchor')
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT meta FROM records WHERE store=? AND id=?', (store, key)).fetchone()
                if not row: raise ValueError('Record missing')
                meta = json.loads(row[0])
                notes = [n for n in meta.get('notes', []) if n.get('id') != note['id']]
                if not item.get('remove'): notes.append(note)
                meta['notes'] = notes
                meta['lastOpenedAt'] = max(int(time.time()*1000), meta.get('lastOpenedAt', 0)+1)
                encoded = json.dumps(meta)
                if len(encoded)>200000: raise ValueError('Metadata too large')
                db.execute('UPDATE records SET meta=? WHERE store=? AND id=?', (encoded, store, key))
                return {'notes': notes, 'lastOpenedAt': meta['lastOpenedAt']}
            meta=item.get('meta')
            if not isinstance(meta,dict) or meta.get('id') != key: raise ValueError('Invalid metadata')
            encoded=json.dumps(meta,ensure_ascii=False)
            if len(encoded)>200000: raise ValueError('Metadata too large')
            if op == 'meta':
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT meta FROM records WHERE store=? AND id=?', (store, key)).fetchone()
                if row and store == 'books':
                    saved = json.loads(row[0])
                    meta['notes'] = saved.get('notes', [])
                    meta['lastOpenedAt'] = max(meta.get('lastOpenedAt',0), saved.get('lastOpenedAt',0))
                    encoded = json.dumps(meta)
                db.execute('UPDATE records SET meta=? WHERE store=? AND id=?',(encoded,store,key))
            elif op == 'put':
                data=base64.b64decode(item['data'],validate=True)
                if len(data)>250*1024*1024: raise ValueError('File too large')
                db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?)',(store,key,encoded,data,str(item.get('mime','application/octet-stream'))))
            else: raise ValueError('Unknown operation')
            return {'ok':True}
