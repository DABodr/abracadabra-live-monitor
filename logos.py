"""Import genuine SPI/RadioDNS station logos from AbracaDABra's local cache."""
import hashlib
import json
import os
import pathlib
import re
import threading
import time
from online_logos import OnlineLogos

class Logos:
    def __init__(self, root):
        self.root = root / 'logos'
        self.root.mkdir(exist_ok=True)
        self.manifest = self.root / 'index.json'
        self.cache = pathlib.Path(os.environ['LOCALAPPDATA']) / 'AbracaDABra' / 'cache'
        self.items = json.loads(self.manifest.read_text(encoding='utf-8')) if self.manifest.exists() else {}
        self.guard = threading.Lock()
        self.last_import = 0
        self.online = OnlineLogos(root)

    def refresh(self):
        with self.guard:
            if time.monotonic() - self.last_import < 60:
                return self.online.snapshot(self.items)
            self.last_import = time.monotonic()
            if self.cache.is_dir():
                for directory in self.cache.iterdir():
                    if not directory.is_dir() or not re.fullmatch(r'[a-fA-F0-9]{6,8}\.\d+', directory.name):
                        continue
                    files = [p for p in directory.rglob('*.png') if p.name in ('128x128.png', '32x32.png', '320x240.png')]
                    if not files:
                        continue
                    ranks = {'128x128.png':0, '32x32.png':1, '320x240.png':2}
                    files.sort(key=lambda p:(ranks[p.name], -p.stat().st_mtime))
                    for source in files:
                        try:
                            data = source.read_bytes()
                            if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data)>2_000_000:
                                continue
                            name = hashlib.sha256(data).hexdigest()+'.png'
                            target = self.root / name
                            if not target.exists():
                                target.write_bytes(data)
                            self.items[directory.name.lower()] = '/logos/'+name
                            break
                        except OSError:
                            continue
                temp = self.manifest.with_suffix('.tmp')
                temp.write_text(json.dumps(self.items, indent=2), encoding='utf-8')
                temp.replace(self.manifest)
            return self.online.snapshot(self.items)

    def image(self, path):
        name = path.removeprefix('/logos/')
        if not re.fullmatch(r'[a-f0-9]{64}\.png', name):
            return None
        target = self.root / name
        return target.read_bytes() if target.is_file() else None
