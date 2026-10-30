"""Explicit searches and persistent user-selected station logos."""
import json
import base64
import io
import hashlib
import urllib.parse
from PIL import Image
from online_logos import fetch, station_name, page_logos
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
            if action == 'slideshow':
                key = f"{int(str(data['sid']),0):x}.{int(data.get('scids',0))}"
                raw = base64.b64decode(data['image'], validate=True)
                if len(raw)>2_000_000: raise ValueError('Image trop grande')
                with Image.open(io.BytesIO(raw)) as image:
                    if min(image.size)<24 or image.width*image.height>4_000_000: raise ValueError('Dimensions incorrectes')
                    output=io.BytesIO()
                    image.convert('RGBA').save(output,format='PNG')
                raw=output.getvalue()
                name=hashlib.sha256(raw).hexdigest()+'.png'
                (self.root/'logos'/name).write_bytes(raw)
                self.save_choice(key,dict(url='/logos/'+name,source='Slideshow choisi'))
                return {'saved':True}
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
                self.save_choice(job['key'],candidate)
                return {'saved':True}
            raise ValueError('Action inconnue')

    def save_choice(self,key,candidate):
        path=self.root/'logos'/'selected.json'
        choices=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        choices[key]=dict(candidate,selected=time.time())
        temp=path.with_suffix('.tmp')
        temp.write_text(json.dumps(choices,indent=2),encoding='utf-8')
        temp.replace(path)

    def expanded_directory(self,variants):
        # Explicit chooser only: wider matches are never applied automatically.
        names=list(dict.fromkeys(station_name(s.get('label','')) for _,s in variants))[:2]
        rows=[]
        for name in names:
            query=urllib.parse.urlencode({'name':name,'limit':100,'hidebroken':'false'})
            rows.extend(json.loads(fetch('https://de1.api.radio-browser.info/json/stations/search?'+query)))
        def tokens(value):
            import re
            return set(re.findall(r'[\w+]+',station_name(value))) - {'radio','dab'}
        wanted=[tokens(n) for n in names]
        matches=[r for r in rows if any(t and t<=tokens(r.get('name','')) for t in wanted)]
        pages=set()
        for row in matches[:12]:
            page=row.get('homepage','')
            if row.get('favicon'): yield row['favicon'],page or row['favicon']
            if page.startswith(('https://','http://')) and page not in pages and len(pages)<3:
                pages.add(page)
                try:
                    for url in list(page_logos(fetch(page),page))[:4]:yield url,page
                except Exception:pass

    def search(self, token, key, variants):
        def source(kind):
            lookup = OnlineLogos(self.root) # fresh RadioDNS and website cache for each explicit search
            if kind == 'RadioDNS':
                for m,s in variants[:6]:
                    yield from ((u,u) for u in lookup.radiodns(m,s))
            elif kind == 'Site de la radio':
                yield from lookup.website(key, variants)
            elif kind == 'Recherche elargie':
                yield from self.expanded_directory(variants)
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
            with ThreadPoolExecutor(max_workers=4) as pool:
                for future in as_completed([pool.submit(collect,k) for k in ('RadioDNS','Site de la radio','Radio Browser','Recherche elargie')]):
                    future.result()
        finally:
            with self.guard:
                if token in self.jobs: self.jobs[token]['done'] = True
