"""Explicit searches and persistent user-selected station logos."""
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from online_logos import OnlineLogos

class LogoChoices:
    def __init__(self, root):
        self.root = root
        self.guard = threading.Lock()
        self.jobs = {}

    def request(self, action, data):
        with self.guard:
            if action == 'search':
                self.jobs = {k:v for k,v in self.jobs.items() if time.time()-v['created'] < 1800}
                if sum(not v['done'] for v in self.jobs.values()) >= 2:
                    raise ValueError('Une recherche est deja en cours. Patientez.')
                sid = int(str(data['sid']), 0)
                scids = int(data.get('scids', 0))
                key = f'{sid:x}.{scids}'
                library = json.loads((self.root/'multiplexes.json').read_text(encoding='utf-8'))
                variants = [(m,s) for m in library['multiplexes'].values() for s in m.get('services', []) if int(str(s['sid']),0)==sid and int(s.get('scids',0))==scids]
                if not variants:
                    raise ValueError('Cette radio doit etre memorisee dans Mes multiplex.')
                token = uuid.uuid4().hex
                self.jobs[token] = dict(created=time.time(), key=key, done=False, candidates=[], errors=[])
                threading.Thread(target=self.search, args=(token, key, variants), daemon=True).start()
                return {'job':token}
            job = self.jobs.get(data.get('job'))
            if not job:
                raise ValueError('Recherche expiree. Relancez la recherche.')
            if action == 'status':
                return dict(done=job['done'], candidates=list(job['candidates']), errors=list(job['errors']))
            if action == 'select':
                candidate = next((c for c in job['candidates'] if c['url']==data.get('url')), None)
                if candidate is None:
                    raise ValueError('Logo non propose par cette recherche.')
                path = self.root/'logos'/'selected.json'
                choices = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
                choices[job['key']] = dict(candidate, selected=time.time())
                temp = path.with_suffix('.tmp')
                temp.write_text(json.dumps(choices, indent=2), encoding='utf-8')
                temp.replace(path)
                return {'saved':True}
            raise ValueError('Action inconnue')

    def search(self, token, key, variants):
        def source(kind):
            lookup = OnlineLogos(self.root) # fresh RadioDNS and website cache for each explicit search
            if kind == 'RadioDNS':
                for m,s in variants[:6]:
                    yield from ((u,u) for u in lookup.radiodns(m,s))
            elif kind == 'Site de la radio':
                yield from lookup.website(key, variants)
            else:
                for m,s in variants[:2]:
                    u = lookup.directory(m,s)
                    if u: yield u,u
        def collect(kind):
            lookup = OnlineLogos(self.root)
            seen = set()
            try:
                for remote, page in source(kind):
                    if remote in seen: continue
                    seen.add(remote)
                    if len(seen)>12: break
                    try:
                        url = lookup.store_image(remote)
                        with self.guard:
                            job = self.jobs.get(token)
                            if not job: return
                            if not any(c['url']==url for c in job['candidates']):
                                job['candidates'].append(dict(url=url, source=kind, page=page))
                    except Exception:
                        continue
            except Exception:
                with self.guard:
                    if token in self.jobs: self.jobs[token]['errors'].append(kind)
        try:
            with ThreadPoolExecutor(max_workers=3) as pool:
                for future in as_completed([pool.submit(collect,k) for k in ('RadioDNS','Site de la radio','Radio Browser')]):
                    future.result()
        finally:
            with self.guard:
                if token in self.jobs: self.jobs[token]['done'] = True
