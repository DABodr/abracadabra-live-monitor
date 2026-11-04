"""Band III scanning and durable multiplex library, independent of browser sessions."""
import copy
import datetime
import json
import threading
import time
import uuid
from signal_history import SignalHistory


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class Scanner:
    def __init__(self, root, request, receiver_lock, save_station):
        self.path = root / 'multiplexes.json'
        self.signal_history = SignalHistory(root)
        self.request, self.receiver_lock, self.save_station = request, receiver_lock, save_station
        self.guard = threading.RLock()
        self.cancelled = threading.Event()
        self.thread = None
        self.monitor_stop = threading.Event()
        self.monitor_thread = None
        self.last_reception = None
        self.resolve_transmitters = lambda state: {}
        self.data = {'multiplexes': {}, 'lastScan': None}
        if self.path.exists():
            # Never silently overwrite a damaged library.
            self.data = json.loads(self.path.read_text(encoding='utf-8'))
        self.state = dict(active=False, phase='idle', channel='', completed=0, total=38, found=0, error='', message='Prêt à explorer la bande DAB.')
        if (self.data.get('lastScan') or {}).get('status') == 'running':
            self.data['lastScan']['status'] = 'interrupted'
            self.persist()
        last = self.data.get('lastScan')
        if last:
            self.state.update(phase=last['status'], completed=last.get('completed', 0), found=last.get('found', 0),
                error=last.get('error', ''), message={'completed':'Dernier scan terminé.', 'cancelled':'Dernier scan arrêté. Les découvertes sont conservées.',
                    'interrupted':'Le dernier scan a été interrompu par l’arrêt du serveur. Les découvertes sont conservées.',
                    'failed':'Le dernier scan a rencontré une erreur.'}.get(last['status'], 'Prêt à explorer la bande DAB.'))

    def persist(self):
        with self.guard:
            temp = self.path.with_suffix('.tmp')
            temp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding='utf-8')
            temp.replace(self.path)

    def status(self):
        with self.guard:
            result = copy.deepcopy(self.state)
            result['detections'] = copy.deepcopy(list((self.data.get('lastScan') or {}).get('detections', {}).values()))
            return result

    def library(self):
        with self.guard:
            return {'multiplexes': sorted(copy.deepcopy(list(self.data['multiplexes'].values())), key=lambda x: (x['frequencyKHz'], x['label'])), 'lastScan': copy.deepcopy(self.data['lastScan']), 'scanArchives': copy.deepcopy(self.data.get('scanArchives', []))}

    def delete_archive(self, archive_id):
        if not isinstance(archive_id, str) or not archive_id:
            raise ValueError('Identifiant incorrect')
        with self.guard:
            previous = self.data.get('scanArchives', [])
            self.data['scanArchives'] = [a for a in previous if a.get('id') != archive_id]
            try:
                self.persist()
            except OSError:
                self.data['scanArchives'] = previous
                raise
            return self.library()

    def remember(self, state, scan_id=None):
        ensemble = state.get('ensemble', {})
        services = state.get('services', [])
        if state.get('syncLevel') != 2 or not ensemble.get('valid') or not services:
            return False
        key = f"{state['frequencyKHz']}:{ensemble.get('ecc',0)}:{ensemble.get('eid',0)}"
        with self.guard:
            previous = self.data['multiplexes'].get(key, {})
            if key in self.data.get('deleted', []): self.data['deleted'].remove(key)
            self.data['multiplexes'][key] = dict(id=key, channel=state.get('channel',''), frequencyKHz=state['frequencyKHz'],
                label=ensemble.get('label') or state.get('channel', 'Multiplex'), eid=ensemble.get('eid'), ecc=ensemble.get('ecc'),
                services=services, snr=state.get('snr'), firstSeen=previous.get('firstSeen', now()), lastSeen=now(),
                lastScanId=scan_id or previous.get('lastScanId'))
            if scan_id and self.data.get('lastScan') is not None:
                detections = self.data['lastScan'].setdefault('detections', {})
                old = detections.get(key, {})
                detected = self.data['multiplexes'][key]
                tii_sites = {item['key']: item for item in old.get('tiiSites', [])}
                for item in state.get('scanTiiSites', []):
                    tii_sites[item['key']] = item
                detections[key] = dict(tiiSites=list(tii_sites.values()), id=key, label=detected['label'], channel=detected['channel'],
                    frequencyKHz=detected['frequencyKHz'], snr=detected['snr'],
                    firstSeen=old.get('firstSeen', detected['lastSeen']), lastSeen=detected['lastSeen'],
                    count=old.get('count', 0)+1)
            self.persist()
        return True

    def delete(self, key):
        if not isinstance(key, str):
            raise ValueError('Identifiant incorrect')
        with self.guard:
            previous = copy.deepcopy(self.data)
            self.data['multiplexes'].pop(key, None)
            deleted = self.data.setdefault('deleted', [])
            if key not in deleted: deleted.append(key)
            try:
                self.persist()
            except OSError:
                self.data = previous
                raise
            return self.library()

    def start_monitor(self):
        if self.monitor_thread and self.monitor_thread.is_alive():
            return
        self.monitor_stop.clear()
        self.monitor_thread = threading.Thread(target=self.monitor, name='channel-monitor', daemon=True)
        self.monitor_thread.start()

    def stop_monitor(self):
        self.monitor_stop.set()
        if self.monitor_thread:
            self.monitor_thread.join(timeout=7)

    def monitor_once(self):
        if not self.receiver_lock.acquire(blocking=False):
            return False
        try:
            if self.state.get('active'):
                return False
            state = self.request('GET', '/api/status')
            self.signal_history.record(state)
            changed = self.observe(state)
            self.prepare_reception(state)
            return changed
        finally:
            self.receiver_lock.release()

    def prepare_reception(self, state):
        frequency = state.get('frequencyKHz')
        ensemble = state.get('ensemble') or {}
        with self.guard:
            if self.last_reception and self.last_reception['frequencyKHz'] != frequency:
                self.last_reception = None
            if state.get('syncLevel') != 2 or not ensemble.get('valid'):
                return
            identity = (frequency, ensemble.get('ecc'), ensemble.get('eid'))
            previous_identity = self.last_reception.get('identity') if self.last_reception else None
            if previous_identity != identity:
                self.last_reception = dict(frequencyKHz=frequency, identity=identity, ensemble=copy.deepcopy(ensemble), station={}, firstSeen=now(), tiiSites={})
            self.last_reception['lastSeen'] = now()
            for detection in self.resolve_transmitters(state).get('detections', []):
                code = str(detection['mainId']) + ':' + str(detection['subId'])
                self.last_reception['tiiSites'][code] = dict(copy.deepcopy(detection), lastSeen=now())
            services = state.get('services') or []
            if not services:
                return
            current = state.get('current') or {}
            selected = next((s for s in services if str(s.get('sid')).lower() == str(current.get('sid')).lower() and s.get('scids', 0) == current.get('scids', 0)), None)
            if not selected:
                selected = services[0]
                self.request('POST', '/api/service', {'sid': selected['sid'], 'scids': selected.get('scids', 0)})
            self.last_reception['station'] = copy.deepcopy(selected)

    def reception_snapshot(self, state):
        with self.guard:
            if self.state.get('active') or not self.last_reception or self.last_reception['frequencyKHz'] != state.get('frequencyKHz'):
                return None
            ensemble = state.get('ensemble') or {}
            if state.get('syncLevel') == 2 and ensemble.get('valid') and (ensemble.get('ecc'), ensemble.get('eid')) != self.last_reception['identity'][1:]:
                return None
            return copy.deepcopy(self.last_reception)

    def monitor(self):
        while not self.monitor_stop.is_set():
            try:
                self.monitor_once()
            except Exception:
                # A receiver restart or temporary outage must not stop monitoring.
                pass
            self.monitor_stop.wait(1)

    def observe(self, state):
        """Persist discoveries after tuning has completed, without writing every SNR tick."""
        ensemble = state.get('ensemble') or {}
        if self.state['active'] or state.get('syncLevel') != 2 or not ensemble.get('valid') or not state.get('services'):
            return False
        key = f"{state['frequencyKHz']}:{ensemble.get('ecc',0)}:{ensemble.get('eid',0)}"
        with self.guard:
            if key in self.data.get('deleted', []): return False
            previous = self.data['multiplexes'].get(key)
            if previous and previous['label'] == (ensemble.get('label') or state.get('channel', 'Multiplex')) and previous['services'] == state['services']:
                return False
            return self.remember(state)

    def begin(self, repeat=False):
        if not self.receiver_lock.acquire(blocking=False):
            raise RuntimeError('Le récepteur est déjà occupé. Réessaie dans un instant.')
        try:
            previous = self.request('GET', '/api/status')
            channels = [x for x in self.request('GET', '/api/channels')['channels'] if 174928 <= x['frequencyKHz'] <= 239200]
            if len(channels) != 38 or channels[0]['channel'] != '5A' or channels[-1]['channel'] != '13F':
                raise RuntimeError('La liste des canaux DAB est incomplète.')
            self.save_station(previous)
            self.remember(previous)
            self.signal_history.reset()
            self.cancelled.clear()
            scan_id = uuid.uuid4().hex
            with self.guard:
                self.state.update(repeat=repeat, cycle=1, active=True, phase='scanning', channel='', completed=0, total=len(channels), found=0, error='', message='Recherche des multiplex…')
                old_scan = self.data.get('lastScan')
                if old_scan:
                    archives = self.data.setdefault('scanArchives', [])
                    if not any(item.get('id') == old_scan.get('id') for item in archives):
                        archives.insert(0, copy.deepcopy(old_scan))
                self.data['lastScan'] = dict(id=scan_id, startedAt=now(), status='running', completed=0, total=len(channels), found=0)
                self.persist()
            self.thread = threading.Thread(target=self.run, args=(channels, previous, scan_id), daemon=True)
            self.thread.start()
        except Exception:
            self.receiver_lock.release()
            raise
        return self.status()

    def cancel(self):
        self.cancelled.set()
        return self.status()

    def select(self, frequency, sid=None, scids=0):
        current = self.request('GET', '/api/status')
        if current.get('frequencyKHz') == frequency:
            services = current.get('services', [])
            if services:
                if not sid or sid == '0x0':
                    return
                if any(str(s['sid']).lower() == str(sid).lower() and s.get('scids', 0) == scids for s in services):
                    self.request('POST', '/api/service', {'sid': sid, 'scids': scids})
                    return
                raise RuntimeError('Cette station n’est plus présente dans le multiplex reçu.')
            # AbracaDABra clears its service cache on a same-frequency tune but the
            # engine does not resend the list. Force a real retune to recover it.
            other = 174928 if frequency != 174928 else 176640
            self.request('POST', '/api/tune', {'frequencyKHz': other})
            time.sleep(.5)
        self.request('POST', '/api/tune', {'frequencyKHz': frequency})
        if not sid or sid == '0x0':
            return
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = self.request('GET', '/api/status')
            if state.get('frequencyKHz') == frequency and any(str(s['sid']).lower() == str(sid).lower() and s.get('scids', 0) == scids for s in state.get('services', [])):
                self.request('POST', '/api/service', {'sid': sid, 'scids': scids})
                return
            time.sleep(.3)
        raise RuntimeError('Canal sélectionné, mais cette station n’est pas reçue actuellement.')

    def run(self, channels, previous, scan_id):
        result, error = 'completed', ''
        try:
            if previous.get('frequencyKHz') == channels[0]['frequencyKHz']:
                self.request('POST', '/api/tune', {'frequencyKHz': channels[-1]['frequencyKHz']})
                time.sleep(.5)
            while True:
                for channel in channels:
                    if self.cancelled.is_set():
                        result = 'cancelled'
                        break
                    with self.guard:
                        self.state['channel'] = channel['channel']
                    self.request('POST', '/api/tune', {'channel': channel['channel']})
                    started, stable_since, signature, candidate = time.monotonic(), None, None, None
                    collected_tii = {}
                    while not self.cancelled.wait(.35):
                        state = self.request('GET', '/api/status')
                        elapsed = time.monotonic() - started
                        # The receiver retains old ensemble metadata while tuning; only accept
                        # fresh services on the requested frequency after synchronisation.
                        fresh = state.get('frequencyKHz') == channel['frequencyKHz'] and state.get('syncLevel') == 2
                        if elapsed >= 2 and fresh and state.get('ensemble', {}).get('valid') and state.get('services'):
                            identity = (state['frequencyKHz'], state['ensemble'].get('ecc'), state['ensemble'].get('eid'))
                            bucket = collected_tii.setdefault(identity, {})
                            levels = {(d.get('mainId'), d.get('subId')): d.get('level') for d in (state.get('tii') or {}).get('detections', [])}
                            for detection in self.resolve_transmitters(state).get('detections', []):
                                for site in detection.get('sites') or [None]:
                                    site_key = ':'.join(map(str, (detection['mainId'], detection['subId'], site.get('name') if site else '', site.get('latitude') if site else '', site.get('longitude') if site else '')))
                                    bucket[site_key] = dict(key=site_key, mainId=detection['mainId'], subId=detection['subId'], level=levels.get((detection['mainId'], detection['subId'])), site=site, ambiguous=len(detection.get('sites', [])) > 1, lastSeen=now())
                            state['scanTiiSites'] = list(bucket.values())
                            candidate = state
                            current = (state['ensemble'].get('ecc'), state['ensemble'].get('eid'), tuple(sorted((str(s['sid']), s.get('scids', 0), s.get('label', '')) for s in state['services'])))
                            if current != signature:
                                signature, stable_since = current, time.monotonic()
                            elif time.monotonic() - stable_since >= 2 and (not (state.get('tii') or {}).get('supported') or (elapsed >= 8 and bucket)):
                                break
                        if not fresh or not state.get('services'):
                            candidate, signature, stable_since = None, None, None
                        if elapsed >= 12 or (elapsed >= 6 and not fresh and candidate is None):
                            break
                    if candidate and self.remember(candidate, scan_id):
                        with self.guard:
                            self.state['found'] += 1
                    with self.guard:
                        self.state['completed'] += 1
                        self.data['lastScan'].update(completed=self.state['completed'], found=self.state['found'])
                        self.persist()
                    if self.cancelled.is_set():
                        result = 'cancelled'
                        break
                if self.cancelled.is_set() or not self.state.get('repeat'):
                    break
                with self.guard:
                    self.state.update(completed=0, found=0, cycle=self.state.get('cycle', 1)+1)
                    self.data['lastScan'].update(completed=0, found=0, cycle=self.state['cycle'])
                    self.persist()
        except Exception as exc:
            result, error = 'failed', str(exc)
        finally:
            with self.guard:
                self.state.update(phase='restoring', message='Retour à la station précédente…')
            try:
                if previous.get('frequencyKHz'):
                    current = previous.get('current', {})
                    self.select(previous['frequencyKHz'], current.get('sid') if current.get('playing') else None, current.get('scids', 0))
            except Exception as exc:
                error = (error + ' ' + str(exc)).strip()
            try:
                with self.guard:
                    self.state.update(active=False, phase=result, error=error, message={'completed':'Scan terminé.', 'cancelled':'Scan arrêté. Les découvertes sont conservées.', 'failed':'Le scan a rencontré une erreur.'}[result])
                    self.data['lastScan'].update(status=result, endedAt=now(), error=error)
                    self.persist()
            finally:
                self.receiver_lock.release()
