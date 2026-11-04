"""Durable SNR history for the currently monitored channel."""
from contextlib import contextmanager
import math
import sqlite3
import threading
import time

class SignalHistory:
    def __init__(self, root):
        self.path = root / 'signal-history.sqlite3'
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id=1), frequency INTEGER, started REAL)')
            db.execute('CREATE TABLE IF NOT EXISTS samples (t REAL PRIMARY KEY, value REAL)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def reset(self):
        with self.lock, self.connect() as db:
            db.execute('DELETE FROM samples')
            db.execute('DELETE FROM session')

    def record(self, state, stamp=None):
        frequency = state.get('frequencyKHz')
        if not isinstance(frequency, (int, float)) or frequency <= 0:
            return
        stamp = time.time() if stamp is None else stamp
        value = state.get('snr')
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            value = None
        with self.lock, self.connect() as db:
            session = db.execute('SELECT frequency FROM session WHERE id=1').fetchone()
            if not session or session[0] != frequency:
                db.execute('DELETE FROM samples')
                db.execute('INSERT OR REPLACE INTO session VALUES (1,?,?)', (frequency,stamp))
            last = db.execute('SELECT MAX(t) FROM samples').fetchone()[0]
            if last is None or stamp-last >= 5:
                db.execute('INSERT OR REPLACE INTO samples VALUES (?,?)',(stamp,value))

    def read(self, seconds=0, stamp=None):
        stamp = time.time() if stamp is None else stamp
        with self.lock, self.connect() as db:
            session = db.execute('SELECT frequency,started FROM session WHERE id=1').fetchone()
            if not session:
                return dict(frequencyKHz=None, points=[])
            frequency, started = session
            since = max(started, stamp-seconds) if seconds else started
            # At most about 400 buckets; retain extrema for brief peaks.
            bucket = max(5, math.ceil(max(0,stamp-since)/400))
            rows = db.execute('SELECT MIN(t),MAX(t),AVG(value),MIN(value),MAX(value) FROM samples WHERE t>=? GROUP BY CAST((t-?)/? AS INTEGER) ORDER BY MIN(t)',(since,since,bucket)).fetchall()
            return dict(frequencyKHz=frequency, startedAt=started*1000, fromTime=since*1000, toTime=stamp*1000, bucketSeconds=bucket,
                points=[dict(t=(a+b)*500, v=v, low=lo, high=hi) for a,b,v,lo,hi in rows])
