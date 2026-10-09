"""Synthetic SQLite contract check. Never opens the user's database."""
import sys, tempfile, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from library_store import LibraryStore
with tempfile.TemporaryDirectory(prefix='reader-python-audit-') as folder:
    store = LibraryStore(Path(folder), 19162)
    common = dict(store='books',id='synthetic')
    store.run(dict(common,op='put',meta=dict(id='synthetic',lastOpenedAt=100,progress=dict(fraction=.8),notes=[]),data='YQ==',mime='text/plain'))
    note = dict(id='n',type='quote',cfi='epubcfi(/6/2)',createdAt=1,editedAt=300,deletedAt=300)
    store.run(dict(common,op='note',note=note))
    for stamp in [200,300]:
        store.run(dict(common,op='note',note=dict(id='n',type='quote',cfi='epubcfi(/6/2)',createdAt=1,editedAt=stamp)))
    got=store.run(dict(common,op='get'))
    assert got['notes'][0]['deletedAt']==300
    assert got['lastOpenedAt']==100
    store.run(dict(common,op='meta',meta=dict(id='synthetic',lastOpenedAt=50,progress=dict(fraction=.1),notes=[])))
    assert store.run(dict(common,op='get'))['progress']['fraction']==.8
    store.run(dict(common,op='note',note=dict(id='n',type='quote',cfi='epubcfi(/6/2)',createdAt=1,editedAt=400,text='New synthetic note')))
    assert not store.run(dict(common,op='get'))['notes'][0].get('deletedAt')
    with store.connect() as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    print('PASS Python SQLite: late/tied note, reading clock, stale progress, newer edit, integrity (6 checks)')
