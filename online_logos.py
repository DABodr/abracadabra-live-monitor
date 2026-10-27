"""Conservative, cached online fallback for missing broadcast logos."""
import hashlib
import io
import ipaddress
import json
import re
import socket
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from PIL import Image


def fetch(url, limit=4_000_000):
    # External metadata must never point the server at local network services.
    class Redirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            check_url(newurl)
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    check_url(url)
    req = urllib.request.Request(url, headers={'User-Agent': 'AbracaDABra-Live-Monitor/1.0', 'Accept': '*/*'})
    with urllib.request.build_opener(Redirect).open(req, timeout=8) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Response too large')
        return data


def check_url(url):
    p = urllib.parse.urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('Invalid external URL')
    for entry in socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == 'https' else 80)):
        if not ipaddress.ip_address(entry[4][0]).is_global:
            raise ValueError('Non-public address')


def normalized(value):
    return ' '.join(''.join(c for c in unicodedata.normalize('NFKD', value).casefold() if not unicodedata.combining(c)).split())


def station_name(value):
    # Remove transmission labels only, never '+' in a station name such as NRJ+.
    return re.sub(r'\s+(?:\(dab\+?\)|dab\+?)(?:\s+\d{2,3})?$', '', normalized(value)).strip()


def match_name(value):
    value = station_name(value)
    value = re.sub(r'\s*\([^)]*\)\s*$', '', value)
    return ''.join(c for c in value if c.isalnum() or c == '+')


class LogoHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = []
        self.scripts = []
        self.script = None

    def handle_starttag(self, tag, attrs):
        a = {key: value or '' for key, value in attrs}
        if tag == 'script' and a.get('type') == 'application/ld+json':
            self.script = ''
        if tag == 'img':
            label = ' '.join(a.get(k, '') for k in ('alt', 'class', 'id'))
            src = a.get('data-src') or a.get('src', '')
            if 'logo' in label.lower() and 'footer' not in label.lower():
                self.images.append((0, src))
        if tag == 'link' and 'icon' in a.get('rel', ''):
            size = re.search(r'(\d+)x', a.get('sizes', ''))
            rank = 1 if 'apple-touch' in a.get('rel', '') or (size and int(size[1]) >= 96) else 2
            self.images.append((rank, a.get('href', '')))

    def handle_data(self, data):
        if self.script is not None:
            self.script += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.script is not None:
            self.scripts.append(self.script)
            self.script = None


def page_logos(data, page):
    parser = LogoHTML()
    parser.feed(data.decode('utf-8', errors='replace'))
    images = list(parser.images)
    def walk(node):
        if isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            logo = node.get('logo')
            url = logo.get('url') if isinstance(logo, dict) else logo
            if isinstance(url, str):
                images.append((0, url))
            for item in node.values():
                if isinstance(item, (dict, list)):
                    walk(item)
    for script in parser.scripts:
        try:
            walk(json.loads(script))
        except ValueError:
            pass
    seen = set()
    for _, url in sorted(images, key=lambda x: x[0]):
        url = urllib.parse.urljoin(page, url)
        if url not in seen and urllib.parse.urlsplit(url).scheme in ('http', 'https') and '.svg' not in url.lower():
            seen.add(url)
            yield url


def identity(mux, station):
    sid = int(str(station['sid']), 0)
    # AbracaDABra stores audio service IDs with their ECC prefix.
    short = sid & 0xffff
    gcc = f'{short >> 12:x}{int(mux["ecc"]):02x}'
    return gcc, f'{int(mux["eid"]):04x}', f'{short:04x}', str(station.get('scids', 0))


class OnlineLogos:
    def __init__(self, root):
        self.root = root
        self.folder = root / 'logos'
        self.path = self.folder / 'online.json'
        try:
            self.records = json.loads(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            self.records = {}
        self.guard = threading.Lock()
        self.thread = None
        self.last_run = 0
        self.cache = {}

    def snapshot(self, spi):
        with self.guard:
            result = {key: value['url'] for key, value in self.records.items() if value.get('url')}
            try:
                verified = json.loads((self.folder / 'verified.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                verified = {}
            result.update({key: value['url'] for key, value in verified.items() if value.get('url')})
            result.update(spi)
            try:
                selected = json.loads((self.folder / 'selected.json').read_text(encoding='utf-8'))
                result.update({key:value['url'] for key,value in selected.items() if value.get('url')})
            except (OSError, ValueError):
                pass
            if time.time() - self.last_run > 300 and not (self.thread and self.thread.is_alive()):
                self.last_run = time.time()
                self.thread = threading.Thread(target=self.run, args=(set(spi) | set(verified),), daemon=True)
                self.thread.start()
            return result

    def dns(self, name, kind):
        url = 'https://dns.google/resolve?' + urllib.parse.urlencode({'name': name, 'type': kind})
        return [r['data'].rstrip('.') for r in json.loads(fetch(url)).get('Answer', []) if r['type'] == {'CNAME': 5, 'SRV': 33}[kind]]

    def radiodns(self, mux, station):
        gcc, eid, sid, scids = identity(mux, station)
        for host in self.dns(f'{scids}.{sid}.{eid}.{gcc}.dab.radiodns.org', 'CNAME'):
            for record in self.dns('_radioepg._tcp.' + host, 'SRV'):
                _, _, port, target = record.split()
                url = f'{"https" if port == "443" else "http"}://{target}:{port}/radiodns/spi/3.1/SI.xml'
                if url not in self.cache:
                    data = fetch(url)
                    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                        raise ValueError('Unsupported XML')
                    self.cache[url] = ET.fromstring(data)
                bearer = f'dab:{gcc}.{eid}.{sid}.{scids}'
                for service in self.cache[url].iter():
                    if service.tag.split('}')[-1] != 'service':
                        continue
                    if not any(x.tag.split('}')[-1] == 'bearer' and x.get('id', '').lower() == bearer for x in service.iter()):
                        continue
                    images = [x for x in service.iter() if x.tag.split('}')[-1] == 'multimedia' and x.get('url')]
                    images.sort(key=lambda x: (x.get('width') != x.get('height'), abs(int(x.get('width', 128)) - 128)))
                    for item in images:
                        yield urllib.parse.urljoin(url, item.get('url'))

    def directory(self, mux, station):
        gcc = identity(mux, station)[0]
        country = {'fe1': 'FR', '6e0': 'BE', 'de0': 'DE', '1e0': 'DE', '2e0': 'DZ', '7e1': 'LU', '8e3': 'NL', '9e1': 'DK', 'ce1': 'GB', '4e1': 'CH'}.get(gcc)
        if not country:
            return None
        name = station_name(station.get('label', ''))
        query = urllib.parse.urlencode({'name': name, 'countrycode': country, 'limit': 100, 'hidebroken': 'true'})
        key = (name, country)
        if key not in self.cache:
            self.cache[key] = json.loads(fetch('https://de1.api.radio-browser.info/json/stations/search?' + query))
        matches = [r for r in self.cache[key] if station_name(r.get('name', '')) == name and r.get('countrycode') == country and r.get('favicon')]
        urls = {r['favicon'] for r in matches}
        return next(iter(urls)) if len(urls) == 1 else None

    def website(self, key, variants):
        # A small set of verified identities supplements incomplete community data.
        try:
            known = json.loads((self.root / 'station-sites.json').read_text(encoding='utf-8'))
        except (OSError, ValueError):
            known = {}
        pages = [known[key]['url']] if key in known else []
        matching_icons = []
        if not pages:
            mux, station = variants[0]
            gcc = identity(mux, station)[0]
            country = {'fe1':'FR', '6e0':'BE', 'de0':'DE', '1e0':'DE', '7e1':'LU', '8e3':'NL', 'ce1':'GB', '4e1':'CH'}.get(gcc)
            if not country:
                return
            cachefile = self.folder / ('directory-' + country + '.json')
            cachekey = 'directory-' + country
            if cachekey not in self.cache:
                if cachefile.exists() and time.time() - cachefile.stat().st_mtime < 7 * 86400:
                    self.cache[cachekey] = json.loads(cachefile.read_text(encoding='utf-8'))
                else:
                    rows = json.loads(fetch('https://de1.api.radio-browser.info/json/stations/bycountrycodeexact/' + country + '?limit=10000&hidebroken=false', 40_000_000))
                    self.cache[cachekey] = rows
                    cachefile.write_text(json.dumps(rows), encoding='utf-8')
            names = {match_name(s.get('label', '')) for _, s in variants}
            matches = [r for r in self.cache[cachekey] if r.get('countrycode') == country and match_name(r.get('name', '')) in names]
            pages = list({r['homepage'].strip() for r in matches if r.get('homepage', '').startswith(('https://', 'http://'))})
            hosts = {urllib.parse.urlsplit(p).hostname.removeprefix('www.') for p in pages if urllib.parse.urlsplit(p).hostname}
            # Never choose a random website among homonyms or use shared portal branding.
            if len(hosts) != 1 or hosts & {'radiofrance.fr', 'bfmtv.com', 'facebook.com', 'youtube.com', 'radio.fr'}:
                return
            host = next(iter(hosts))
            for row in matches:
                url = row.get('favicon', '')
                image_host = urllib.parse.urlsplit(url).hostname or ''
                if image_host == host or image_host.endswith('.' + host):
                    matching_icons.append((url, row['homepage']))
        for page in sorted(pages, key=lambda p: (not p.startswith('https:'), len(p)))[:2]:
            try:
                cachekey = 'page-' + page
                if cachekey not in self.cache:
                    self.cache[cachekey] = list(page_logos(fetch(page), page))
                for url in self.cache[cachekey]:
                    yield url, page
            except Exception:
                continue
        for url, page in dict.fromkeys(matching_icons):
            yield url, page

    def store_image(self, url):
        data = fetch(url, 2_000_000)
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 4_000_000 or min(image.size) < 24:
                raise ValueError('Unsuitable logo size')
            image.load()
            output = io.BytesIO()
            image.convert('RGBA').save(output, format='PNG')
        data = output.getvalue()
        name = hashlib.sha256(data).hexdigest() + '.png'
        (self.folder / name).write_bytes(data)
        return '/logos/' + name

    def run(self, spi):
        try:
            library = json.loads((self.root / 'multiplexes.json').read_text(encoding='utf-8'))
            candidates = {}
            for mux in library.get('multiplexes', {}).values():
                for station in mux.get('services', []):
                    key = f'{int(str(station["sid"]), 0):x}.{station.get("scids", 0)}'
                    candidates.setdefault(key, []).append((mux, station))
            for key, variants in candidates.items():
                previous = self.records.get(key, {})
                if key in spi or (previous.get('version') == 3 and time.time() - previous.get('checked', 0) < (7 * 86400 if previous.get('url') else 86400)):
                    continue
                result = dict(previous, checked=time.time(), version=3)
                for mux, station in variants:
                    try:
                        for url in self.radiodns(mux, station):
                            try:
                                result.update(url=self.store_image(url), source='RadioDNS', remote=url)
                                break
                            except Exception:
                                continue
                    except Exception:
                        pass
                    if result.get('url'):
                        break
                if not result.get('url'):
                    try:
                        for url, page in self.website(key, variants):
                            try:
                                result.update(url=self.store_image(url), source='Station website', remote=url, page=page)
                                break
                            except Exception:
                                continue
                    except Exception:
                        pass
                if not result.get('url'):
                    mux, station = variants[0]
                    try:
                        url = self.directory(mux, station)
                        if url:
                            result.update(url=self.store_image(url), source='Radio Browser', remote=url)
                    except Exception:
                        pass
                with self.guard:
                    self.records[key] = result
                    temp = self.path.with_suffix('.tmp')
                    temp.write_text(json.dumps(self.records, indent=2), encoding='utf-8')
                    temp.replace(self.path)
                time.sleep(.3)
        except Exception as exc:
            print('Online logos:', exc, flush=True)
