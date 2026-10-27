import json
import threading

class Favorites:
    def __init__(self, root):
        self.path = root / 'favorites.json'
        self.lock = threading.RLock()
        self.items = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else []

    def read(self):
        with self.lock:
            return {'favorites': [dict(s) for s in self.items]}

    @staticmethod
    def clean(s):
        if not isinstance(s, dict): raise ValueError('Station incorrecte')
        f, sid, scids, label = s.get('frequencyKHz'), s.get('sid'), s.get('scids', 0), s.get('label')
        if type(f) is not int or not 174928 <= f <= 239200: raise ValueError('Canal incorrect')
        if not isinstance(sid, str) or not 0 < int(sid, 0) <= 0xFFFFFFFF: raise ValueError('Station incorrecte')
        if type(scids) is not int or not 0 <= scids <= 15: raise ValueError('Composante incorrecte')
        if not isinstance(label, str) or not 1 <= len(label) <= 256: raise ValueError('Nom incorrect')
        return dict(frequencyKHz=f, sid=hex(int(sid, 0)), scids=scids, label=label)

    def update(self, data):
        if not isinstance(data, dict): raise ValueError('Requete incorrecte')
        op = data.get('action')
        if op not in ('add', 'remove', 'merge'): raise ValueError('Action incorrecte')
        values = data.get('favorites') if op == 'merge' else [data.get('station')]
        if not isinstance(values, list) or len(values) > 2000: raise ValueError('Liste incorrecte')
        values = [self.clean(s) for s in values]
        def key(s): return (s['frequencyKHz'], int(s['sid'], 0), s.get('scids', 0))
        with self.lock:
            items = {key(s): s for s in self.items}
            for s in values:
                if op == 'remove': items.pop(key(s), None)
                elif op == 'merge': items.setdefault(key(s), s)
                else: items[key(s)] = s
            result = list(items.values())
            if result != self.items:
                tmp = self.path.with_suffix('.tmp')
                tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
                tmp.replace(self.path)
                self.items = result
            return self.read()
