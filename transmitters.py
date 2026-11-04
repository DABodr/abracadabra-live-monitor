"""Local transmitter matching. Database contents are never bundled with releases."""
import json
import csv
import io
import math
import os
import pathlib
import threading

# Same country/ECC mapping as AbracaDABra's TxDataLoader (MIT, Petr Kopecky).
ECC = dict(AT=0xE0, AU=0xF0, AZ=0xE3, BE=0xE0, CH=0xE1, CZ=0xE2,
           DE=0xE0, DK=0xE1, ES=0xE2, FR=0xE1, GB=0xE1, GI=0xE1,
           GR=0xE1, HR=0xE3, ID=0xF2, IE=0xE3, IR=0xF1, IT=0xE0,
           KR=0xF1, KW=0xF2, LU=0xE1, MC=0xE2, ME=0xE3, MK=0xE4,
           MT=0xE0, MY=0xF0, NL=0xE3, NO=0xE2, OM=0xF1, PL=0xE2,
           QA=0xF2, RS=0xE2, SE=0xE3, SI=0xE4, SK=0xE2, TH=0xF3,
           TM=0xE4, TN=0xE2, TR=0xE3, UA=0xE4, VA=0xE2, ZA=0xD0)


class Transmitters:
    def __init__(self, root):
        self.path = pathlib.Path(root) / 'transmitters.csv'
        self.position_path = pathlib.Path(root) / "receiver-position.json"
        self.lock = threading.RLock()
        self.index = {}
        self.signature = None
        self.error = ''
        self.count = 0

    @staticmethod
    def parse(text):
        reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')), delimiter=';')
        if not {'country', 'block', 'eid', 'tii', 'location', 'latidec', 'longidec', 'frequency'}.issubset(reader.fieldnames or []):
            raise ValueError('Format attendu : CSV des emetteurs FMLIST / AbracaDABra.')
        index, count = {}, 0
        for row in reader:
            try:
                country = row['country'].strip().upper()
                code = int(row['tii'])
                main, sub = divmod(code, 100)
                lat, lon = float(row['latidec']), float(row['longidec'])
                frequency = round(float(row['frequency']) * 1000)
                eid = int(row['eid'], 16)
                name = row['location'].strip()
                if not (country in ECC and name and 0 <= main <= 69 and 1 <= sub <= 23
                        and -90 <= lat <= 90 and -180 <= lon <= 180 and 0 <= eid <= 65535):
                    continue
                key = (frequency, ECC[country], eid, main, sub)
                site = dict(name=name, country=country, latitude=lat, longitude=lon,
                            channel=row['block'].strip(), ensemble=row.get('ensemblelabel', '').strip())
                try:
                    erp = float(row.get('erp', ''))
                    if math.isfinite(erp) and erp > 0:
                        site['erpKw'] = erp
                except (ValueError, TypeError):
                    pass
                if site not in index.setdefault(key, []):
                    index[key].append(site)
                    count += 1
            except (ValueError, TypeError, OverflowError):
                continue
        if not count:
            raise ValueError('Aucun emetteur avec TII valide dans ce fichier.')
        return index, count

    def refresh(self):
        with self.lock:
            source = self.path
            if not source.exists():
                source = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'AbracaDABra/cache/TII/dab-tx-list.csv'
            try:
                st = source.stat()
                signature = (str(source), st.st_mtime_ns, st.st_size)
                if signature != self.signature:
                    if st.st_size > 8_000_000:
                        raise ValueError('Base trop volumineuse.')
                    self.index, self.count = self.parse(source.read_text(encoding='utf-8-sig', errors='replace'))
                    self.signature, self.error = signature, ''
                return dict(available=True, count=self.count, source='Import local' if source == self.path else 'Cache AbracaDABra', updated=st.st_mtime)
            except (OSError, ValueError) as e:
                self.index, self.count, self.signature = {}, 0, None
                self.error = 'Base emetteurs absente ou illisible.'
                return dict(available=False, count=0, error=self.error)

    def import_csv(self, text):
        if not isinstance(text, str) or len(text.encode('utf-8')) > 8_000_000:
            raise ValueError('Fichier trop volumineux.')
        self.parse(text)
        with self.lock:
            temp = self.path.with_suffix('.tmp')
            temp.write_text(text, encoding='utf-8')
            temp.replace(self.path)
            self.signature = None
            return self.refresh()

    def position(self):
        try:
            data = json.loads(self.position_path.read_text(encoding='utf-8'))
            return self.validate_position(data)
        except (OSError, ValueError, TypeError, KeyError):
            return None

    @staticmethod
    def validate_position(data):
        lat, lon = data['latitude'], data['longitude']
        if type(lat) not in (int, float) or type(lon) not in (int, float) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError('Coordonnees invalides.')
        return dict(latitude=lat, longitude=lon)

    def set_position(self, data):
        position = self.validate_position(data)
        with self.lock:
            temp = self.position_path.with_suffix('.tmp')
            temp.write_text(json.dumps(position), encoding='utf-8')
            temp.replace(self.position_path)
        return position

    @staticmethod
    def distance(position, site):
        lat1, lat2 = map(math.radians, (position['latitude'], site['latitude']))
        dlat = lat2 - lat1
        dlon = math.radians(site['longitude'] - position['longitude'])
        h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
        return round(6371.0088 * 2 * math.asin(math.sqrt(min(1, max(0, h)))), 1)

    def enrich(self, state):
        with self.lock:
            db = self.refresh()
            tii = state.get('tii') or {}
            result = dict(supported=tii.get('supported') is True, database=db, detections=[])
            position = self.position()
            result['receiverPosition'] = position
            ensemble = state.get('ensemble') or {}
            if state.get('syncLevel') != 2 or not ensemble.get('valid'):
                return result
            identity = (state.get('frequencyKHz'), ensemble.get('ecc'), ensemble.get('eid'))
            result['knownSites'] = [dict(site, mainId=key[3], subId=key[4],
                ambiguous=len(sites) > 1, distanceKm=self.distance(position, site) if position else None)
                for key, sites in self.index.items() if key[:3] == identity for site in sites]
            for detection in tii.get('detections', [])[:24]:
                main, sub = detection.get('mainId'), detection.get('subId')
                if type(main) is not int or type(sub) is not int or not (0 <= main <= 69 and 1 <= sub <= 23):
                    continue
                key = (state.get('frequencyKHz'), ensemble.get('ecc'), ensemble.get('eid'), main, sub)
                result['detections'].append(dict(mainId=main, subId=sub,
                    sites=[dict(site, distanceKm=self.distance(position, site) if position else None) for site in self.index.get(key, [])]))
            return result
