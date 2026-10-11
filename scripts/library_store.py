"""Durable local library. Binary files live in SQLite, never in the source archive.

与 cloud/server.js 是同一套共享库的两侧实现，规则必须逐条对齐：
  * 元数据长度口径（encode_meta：紧凑 JSON 的 UTF-8 字节数，汉字不转义）
  * 元数据上限与「永久失败」错误码（PermanentError.code，供前端区分重试/丢弃）
  * books 的写入裁决（op:'meta' 与 op:'put' 共用 reconcile_book_meta：进度择新、
    笔记按时间戳与删除标记逐条合并、lastOpenedAt 取大）
  * READER_DATA_DIR 的优先级（env 最高，与 Node 的 resolveDataDir 一致）
"""
import base64
import json
import os
import sqlite3
from pathlib import Path

# 元数据上限：两侧（本文件与 cloud/server.js）统一按「紧凑 JSON 的 UTF-8 字节数」判定。
# 早期实现用 json.dumps 默认 ensure_ascii=True 的结果判长，一个汉字算 6 个字符，
# 而 Node 侧 JSON.stringify 不转义 —— 同一个「20 万」上限实际容量差约 6 倍，
# 同一份 meta 会在一侧通过、在另一侧被拒。
MAX_METADATA_BYTES = 2_000_000
MAX_FILE_BYTES = 250 * 1024 * 1024
STORES = ('books', 'backgrounds', 'audio', 'qq')


class PermanentError(ValueError):
    """重试也不会变好的失败（条目超限 / 记录非法）。

    带 code 让 HTTP 层能回传给浏览器，排空循环据此把条目移进 dead 前缀继续往下走，
    而不是让一条坏记录卡死整库落盘。"""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


# JSON 分隔符也必须是紧凑的 (',',':')：Python 的 json.dumps 默认在冒号和逗号后加空格，
# 那样即使都不转义，同一份 meta 的字节数仍比 Node 的 JSON.stringify 大几个百分点。
def encoded_meta_size(meta):
    """紧凑 JSON 的 UTF-8 字节数 —— 与 cloud/server.js 的 encodedMetaSize 逐字节同口径。"""
    return len(json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))


def encode_meta(meta):
    """紧凑（不转义汉字、不加空格）JSON，与 cloud/server.js 的 JSON.stringify 完全一致。"""
    encoded = json.dumps(meta, ensure_ascii=False, separators=(',', ':'))
    size = len(encoded.encode('utf-8'))
    if size > MAX_METADATA_BYTES:
        raise PermanentError('Metadata too large: %d' % size, 'metadata_too_large')
    return encoded


def note_stamp(note):
    """笔记的裁决时间戳：创建/编辑/删除三者取大。"""
    return max((float(note.get(k) or 0) for k in ('createdAt', 'editedAt', 'deletedAt')), default=0)


def is_tombstone(note):
    return isinstance(note, dict) and float(note.get('deletedAt') or 0) > 0


def pick_newer_note(incoming, saved):
    """同 id 二选一：较新者胜；平局判给删除标记（与 js/db.js pickNewerNote 一致）。"""
    mine, theirs = note_stamp(incoming), note_stamp(saved)
    if mine != theirs:
        return incoming if mine > theirs else saved
    if is_tombstone(incoming) or is_tombstone(saved):
        return incoming if is_tombstone(incoming) else saved
    return incoming


def merge_note_lists(incoming, saved):
    """按 id 取并集、同 id 按时间戳裁决 —— 与 op:'note' 用的是同一套墓碑规则。"""
    by_id = {}
    for note in (saved if isinstance(saved, list) else []):
        if isinstance(note, dict) and note.get('id'):
            by_id[note['id']] = note
    for note in (incoming if isinstance(incoming, list) else []):
        if isinstance(note, dict) and note.get('id'):
            previous = by_id.get(note['id'])
            by_id[note['id']] = pick_newer_note(note, previous) if previous else note
    return list(by_id.values())


def _number(value):
    """保持整数写整数：float 100.0 会被 json 写成 100.0，而 Node 写 100，串就不一致了。"""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0
    return int(number) if number.is_integer() else number


def progress_stamp(meta):
    """进度通道的裁决依据：progress.at 与 lastOpenedAt 取大。

    契约：js/reader.js 写出的 progress 带 at:Date.now()。旧记录没有 at 时这里退回
    lastOpenedAt，判定结果与升级前逐字节一致（向后兼容）。"""
    progress = meta.get('progress') if isinstance(meta, dict) else None
    at = _number(progress.get('at')) if isinstance(progress, dict) else 0
    return max(at, _number(meta.get('lastOpenedAt') if isinstance(meta, dict) else 0))


def reconcile_book_meta(meta, saved):
    """整条/元数据写入的落盘裁决：陈旧快照不得回滚另一端刚写的进度与笔记。"""
    out = dict(meta)
    mine = meta.get('progress') or {}
    theirs = saved.get('progress') or {}
    both_stamped = isinstance(mine, dict) and isinstance(theirs, dict) and type(mine.get('at')) in (int, float) and type(theirs.get('at')) in (int, float)
    stale = _number(mine.get('at')) < _number(theirs.get('at')) if both_stamped else progress_stamp(meta) < progress_stamp(saved)
    if stale:
        # saved 没有 progress 时删掉键（而不是写 None），保证与 Node 侧落盘串一致
        if 'progress' in saved:
            out['progress'] = saved['progress']
        else:
            out.pop('progress', None)
    for key in ('tocFlat', 'pdfPages', 'pdfPageCount', 'pdfEmptyPages', 'pdfTextOnly'):
        if key not in meta and key in saved:
            out[key] = saved[key]
    out['notes'] = merge_note_lists(meta.get('notes'), saved.get('notes'))
    out['lastOpenedAt'] = max(_number(meta.get('lastOpenedAt')), _number(saved.get('lastOpenedAt')))
    return out


class LibraryStore:
    def __init__(self, root, port):
        # READER_DATA_DIR 优先级最高（与 cloud/server.js resolveDataDir 一致）：
        # 同一份 env + 同一个端口，两侧必须落在同一个库文件上。
        override = os.environ.get('READER_DATA_DIR')
        if override:
            folder = Path(override).expanduser()
        elif port == 8940:
            folder = Path.home() / 'Library/Application Support/immersive-reader-app/library'
        else:
            folder = root / ('.preview/data-%s' % port)
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
    def read_meta(self, db, store, key):
        row = db.execute('SELECT meta FROM records WHERE store=? AND id=?', (store, key)).fetchone()
        return json.loads(row[0]) if row else None
    def run(self, item):
        op = item.get('op')
        with self.connect() as db:
            if op == 'list':
                return {'records':[{'store':s, **json.loads(m)} for s,m in db.execute('SELECT store,meta FROM records')]}
            store, key = item.get('store'), item.get('id')
            if store not in STORES or not isinstance(key,str) or not 0 < len(key) <= 120:
                raise PermanentError('Invalid record', 'invalid_record')
            if op == 'get':
                row=db.execute('SELECT meta,data,mime FROM records WHERE store=? AND id=?',(store,key)).fetchone()
                if not row: raise ValueError('Record missing')
                return {**json.loads(row[0]),'data':base64.b64encode(row[1]).decode(),'mime':row[2]}
            if op == 'delete':
                db.execute('DELETE FROM records WHERE store=? AND id=?',(store,key));return {'ok':True}
            if op == 'note':
                note = item.get('note')
                if store != 'books' or not isinstance(note, dict) or not isinstance(note.get('id'), str) or not 0 < len(note['id']) <= 120:
                    raise PermanentError('Invalid note', 'invalid_note')
                if not item.get('remove') and (note.get('type') not in ['quote', 'bookmark'] or not isinstance(note.get('cfi'), str) or not note['cfi'].startswith('epubcfi(')):
                    raise PermanentError('Invalid note anchor', 'invalid_note')
                db.execute('BEGIN IMMEDIATE')
                meta = self.read_meta(db, store, key)
                if meta is None: raise ValueError('Record missing')
                old = next((n for n in meta.get('notes', []) if n.get('id') == note['id']), None)
                accept = item.get('remove') or not old or note_stamp(note) > note_stamp(old) or (note_stamp(note) == note_stamp(old) and not old.get('deletedAt'))
                if accept:
                    notes = [n for n in meta.get('notes', []) if n.get('id') != note['id']]
                    if not item.get('remove'): notes.append(note)
                    meta['notes'] = notes
                    encoded = encode_meta(meta)
                    db.execute('UPDATE records SET meta=? WHERE store=? AND id=?', (encoded, store, key))
                return {'notes': meta.get('notes', []), 'lastOpenedAt': meta.get('lastOpenedAt', 0)}
            meta=item.get('meta')
            if not isinstance(meta,dict) or meta.get('id') != key:
                raise PermanentError('Invalid metadata', 'invalid_metadata')
            if op == 'meta':
                db.execute('BEGIN IMMEDIATE')
                saved = self.read_meta(db, store, key)
                if saved is None: raise ValueError('Record missing')
                if store == 'books':
                    # 与 op:'put' 同一套护栏：进度择新、笔记逐条按墓碑时间戳合并、lastOpenedAt 取大
                    meta = reconcile_book_meta(meta, saved)
                db.execute('UPDATE records SET meta=? WHERE store=? AND id=?',
                           (encode_meta(meta), store, key))
            elif op == 'put':
                try:
                    data=base64.b64decode(item.get('data',''),validate=True)
                except Exception:
                    raise PermanentError('Invalid base64', 'invalid_base64')
                if len(data)>MAX_FILE_BYTES:
                    raise PermanentError('File too large', 'file_too_large')
                if store == 'books' and not item.get('replace'):
                    # replace=True 只给「整库替换导入」（js/db.js importAll）：
                    # 用户明确要用这份快照覆盖磁盘，不参与时间戳裁决。
                    db.execute('BEGIN IMMEDIATE')
                    saved = self.read_meta(db, store, key)
                    if saved is not None:
                        meta = reconcile_book_meta(meta, saved)
                encoded = encode_meta(meta)
                db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?)',(store,key,encoded,data,str(item.get('mime','application/octet-stream'))))
            else:
                raise PermanentError('Unknown operation', 'unknown_operation')
            return {'ok':True}
