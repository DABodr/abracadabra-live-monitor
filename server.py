import atexit, http.client, json, os, pathlib, subprocess, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from scanner import Scanner
from logos import Logos
from logo_choices import LogoChoices
from favorites import Favorites
from receiver_boundary import ReceiverBoundary

ROOT = pathlib.Path(os.environ.get('LIVE_MONITOR_ROOT', pathlib.Path(__file__).resolve().parent))
CONFIG = ROOT / 'config.json'
cfg = json.loads(CONFIG.read_text(encoding='utf-8-sig'))
lock = threading.Lock()
child = None
generation = 0
log = open(ROOT / 'receiver.log', 'ab', buffering=0)

def raw_backend_request(method, path, data=None):
    c = http.client.HTTPConnection('127.0.0.1', 17979, timeout=5)
    try:
        c.request(method, path, json.dumps(data) if data is not None else None, {'Content-Type': 'application/json'})
        r = c.getresponse()
        result = json.loads(r.read())
        if r.status >= 400:
            raise RuntimeError(result.get('error', 'Erreur du récepteur'))
        return result
    finally:
        c.close()

backend_request = ReceiverBoundary(raw_backend_request)

def save_station(state):
    cfg['station'] = state
    temp = CONFIG.with_suffix('.tmp')
    temp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(CONFIG)

scanner = Scanner(ROOT, backend_request, lock, save_station)
logos = Logos(ROOT)
logo_choices = LogoChoices(ROOT)
favorites = Favorites(ROOT)

def backend_status():
    return backend_request('GET', '/api/status')

def stop():
    global child
    if child and child.poll() is None:
        child.terminate()
        child.wait(timeout=8)

def start(state=None):
    global child, generation
    backend_request.reset()
    args = [cfg['exe'], '--cli', '-p', '17979', '--bind', '127.0.0.1']
    if not cfg['automatic']:
        args += ['--gain', str(cfg['index'])]
    state = state or cfg.get('station', {})
    if state.get('frequencyKHz'):
        args += ['-f', str(state['frequencyKHz'])]
        cur = state.get('current', {})
        if cur.get('sid') and cur['sid'] != '0x0':
            args += ['--sid', str(cur['sid']), '--scids', str(cur.get('scids', 0))]
    env = dict(os.environ, QT_QPA_PLATFORM='offscreen', QT_FORCE_STDERR_LOGGING='1')
    child = subprocess.Popen(args, cwd=str(pathlib.Path(cfg['exe']).parent), env=env,
        stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(50):
        if child.poll() is not None:
            raise RuntimeError('Le récepteur a quitté. Consultez receiver.log.')
        try:
            backend_status()
            generation += 1
            return
        except (OSError, ValueError, http.client.HTTPException):
            time.sleep(.2)
    stop()
    raise RuntimeError('Le récepteur ne répond pas.')

def settings():
    return dict(automatic=cfg['automatic'], index=cfg['index'], gains=cfg['gains'], generation=generation)

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def handle(self):
        try: super().handle()
        except (ConnectionError, TimeoutError): pass
    def log_message(self, *args):
        pass
    def send(self, code, data, content_type='application/json; charset=utf-8'):
        if not isinstance(data, bytes): data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path == '/favorites': return self.send(200, favorites.read())
        if self.path == '/api/status':
            acquired = lock.acquire(blocking=False)
            try:
                state = backend_request('GET', '/api/status')
                state['libraryChanged'] = scanner.observe(state) if acquired else False
                return self.send(200, state)
            except Exception as exc:
                return self.send(503, {'error': str(exc)})
            finally:
                if acquired: lock.release()
        if self.path == '/api/logos': return self.send(200, logos.refresh())
        if self.path.startswith('/logos/'):
            data = logos.image(self.path)
            return self.send(200, data, 'image/png') if data else self.send(404, {'error':'Logo indisponible'})
        if self.path == '/gain-control': return self.send(200, settings())
        if self.path == '/scan/status': return self.send(200, scanner.status())
        if self.path == '/library': return self.send(200, scanner.library())
        static = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
        # Shared links may carry fbclid or other tracking parameters. They must
        # still serve our interface, rather than fall through to the receiver UI.
        page_path = urlsplit(self.path).path
        if page_path in ('/index.html', '/index.htm'):
            page_path = '/'
        if page_path in static:
            name, kind = static[page_path]
            return self.send(200, (ROOT / name).read_bytes(), kind)
        self.proxy()
    def do_POST(self):
        # Browser requests must originate from this interface; never accept cross-site controls.
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host', ''):
            return self.send(403, {'error': 'Origine refusée'})
        if self.path in ('/api/logos/search', '/api/logos/status', '/api/logos/select'):
            if self.headers.get('X-Gain-Control') != '1': return self.send(403, {'error':'Requete refusee'})
            try:
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 < n <= 4096: raise ValueError('Requete incorrecte')
                return self.send(200, logo_choices.request(self.path.rsplit('/',1)[1], json.loads(self.rfile.read(n))))
            except (ValueError, TypeError, KeyError) as exc: return self.send(400, {'error':str(exc)})
            except OSError: return self.send(503, {'error':'Enregistrement indisponible'})
        if self.path == '/favorites':
            if self.headers.get('X-Gain-Control') != '1': return self.send(403, {'error': 'Requete refusee'})
            try:
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 < n <= 1048576: raise ValueError('Requete incorrecte')
                return self.send(200, favorites.update(json.loads(self.rfile.read(n))))
            except (ValueError, TypeError): return self.send(400, {'error': 'Favoris incorrects'})
            except OSError: return self.send(503, {'error': 'Enregistrement impossible'})
        if self.path in ('/scan/start', '/scan/cancel', '/receiver/select', '/library/delete'):
            if self.headers.get('X-Gain-Control') != '1':
                return self.send(403, {'error': 'Requête refusée'})
            try:
                n = int(self.headers.get('Content-Length', '0'))
                if not 0 <= n <= 4096: raise ValueError('Requête incorrecte')
                data = json.loads(self.rfile.read(n)) if n else {}
                if not isinstance(data, dict): raise ValueError('Requête incorrecte')
                if self.path == '/library/delete': return self.send(200, scanner.delete(data.get('id')))
                if self.path == '/scan/start':
                    repeat = data.get('repeat', False)
                    if type(repeat) is not bool: raise ValueError('Mode incorrect')
                    return self.send(200, scanner.begin(repeat=repeat))
                if self.path == '/scan/cancel': return self.send(200, scanner.cancel())
                frequency = data.get('frequencyKHz')
                channels = backend_request('GET', '/api/channels')['channels']
                if type(frequency) is not int or frequency not in [x['frequencyKHz'] for x in channels]:
                    raise ValueError('Fréquence incorrecte')
                sid, scids = data.get('sid'), data.get('scids', 0)
                if sid is not None and (not isinstance(sid, str) or not 0 < int(sid, 0) <= 0xFFFFFFFF): raise ValueError('Station incorrecte')
                if type(scids) is not int or not 0 <= scids <= 15: raise ValueError('Composante incorrecte')
                if not lock.acquire(blocking=False): return self.send(409, {'error':'Le récepteur est occupé par un scan ou un réglage.'})
                try:
                    scanner.select(frequency, sid, scids)
                    state = backend_status()
                    save_station(state)
                    scanner.remember(state)
                    return self.send(200, {'ok':True})
                finally:
                    lock.release()
            except (ValueError, TypeError): return self.send(400, {'error':'Requête incorrecte'})
            except Exception as exc: return self.send(409, {'error':str(exc)})
        if self.path in ('/api/tune', '/api/service'):
            if not lock.acquire(blocking=False): return self.send(409, {'error':'Le récepteur est occupé.'})
            try: return self.proxy()
            finally: lock.release()
        if self.path != '/gain-control': return self.proxy()
        if self.headers.get('X-Gain-Control') != '1': return self.send(403, {'error':'Requête refusée'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if n < 1 or n > 4096: raise ValueError('Requête incorrecte')
            data = json.loads(self.rfile.read(n))
            if not isinstance(data, dict): raise ValueError('Requête incorrecte')
            if type(data.get('automatic')) is not bool: raise ValueError('Mode incorrect')
            idx = data.get('index')
            if type(idx) is not int or not 0 <= idx < len(cfg['gains']): raise ValueError('Gain incorrect')
        except (ValueError, TypeError): return self.send(400, {'error':'Réglage invalide'})
        if not lock.acquire(blocking=False): return self.send(409, {'error':'Un changement est déjà en cours'})
        try:
            state = backend_status()
            previous = dict(cfg)
            cfg.update(automatic=data['automatic'], index=idx, station=state)
            stop()
            try:
                start(state)
            except Exception:
                cfg.clear(); cfg.update(previous)
                start(state)
                raise RuntimeError('Changement impossible ; ancien réglage rétabli.')
            tmp = CONFIG.with_suffix('.tmp')
            tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')
            tmp.replace(CONFIG)
            self.send(200, settings())
        except Exception as exc:
            self.send(503, {'error':str(exc)})
        finally:
            lock.release()
    def proxy(self):
        if self.path.split('?')[0] not in ('/', '/api/status', '/api/channels', '/api/tune', '/api/service', '/api/slideshow', '/stream/audio'):
            return self.send(404, {'error':'Page inconnue'})
        c = http.client.HTTPConnection('127.0.0.1', 17979, timeout=10)
        sent = False
        try:
            n = int(self.headers.get('Content-Length','0'))
            if not 0 <= n <= 65536: return self.send(413, {'error':'Requête trop grande'})
            body = self.rfile.read(n) if n else None
            headers = {'Content-Type': self.headers.get('Content-Type','application/json')}
            c.request(self.command, self.path, body, headers)
            r = c.getresponse()
            if self.path.startswith('/stream/audio') and r.status == 200:
                self.send_response(200)
                self.send_header('Content-Type', r.getheader('Content-Type'))
                self.send_header('Connection','close')
                self.end_headers(); sent = True; self.close_connection = True
                while True:
                    block = r.read1(8192)
                    if not block: break
                    self.wfile.write(block); self.wfile.flush()
            else:
                data = r.read()
                if self.path == '/' and r.status == 200:
                    panel = (ROOT / 'panel.html').read_text(encoding='utf-8')
                    data = data.decode('utf-8').replace('</h1>', '</h1>' + panel, 1).encode('utf-8')
                self.send(r.status, data, r.getheader('Content-Type','application/octet-stream'))
        except (OSError, http.client.HTTPException):
            if not sent:
                try: self.send(503, {'error':'Récepteur en cours de redémarrage'})
                except OSError: pass
        finally:
            c.close()

if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', 7979), Handler)
    atexit.register(stop)
    try:
        start()
        print('AbracaDABra Web : http://127.0.0.1:7979/ — Ctrl+C pour arrêter.', flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        scanner.cancel()
        if scanner.thread and scanner.thread.is_alive(): scanner.thread.join(timeout=20)
        server.server_close()
        stop()
