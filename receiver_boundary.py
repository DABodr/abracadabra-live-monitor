"""Protect service lists when the CLI changes ensemble without changing frequency."""
import threading
import time

class ReceiverBoundary:
    def __init__(self, request):
        self.request = request
        self.guard = threading.RLock()
        self.identity = None

    def reset(self):
        with self.guard:
            self.identity = None

    def __call__(self, method, path, data=None):
        with self.guard:
            if method == 'POST' and path == '/api/tune':
                self.identity = None
            state = self.request(method, path, data)
            if method != 'GET' or path != '/api/status':
                return state
            ens = state.get('ensemble') or {}
            if state.get('syncLevel') != 2 or not ens.get('valid'):
                state['services'] = []
                return state
            identity = (state.get('frequencyKHz'), ens.get('ecc'), ens.get('eid'))
            if self.identity and identity[0] == self.identity[0] and identity != self.identity:
                frequency = identity[0]
                self.identity = None
                # Same-frequency tune clears the CLI cache but does not make the
                # decoder resend services. A genuine away/back tune is required.
                other = 174928 if frequency != 174928 else 176640
                self.request('POST', '/api/tune', {'frequencyKHz': other})
                time.sleep(.2)
                self.request('POST', '/api/tune', {'frequencyKHz': frequency})
                state['services'] = []
                state['current'] = {'playing': False}
                state['reacquiringEnsemble'] = True
                return state
            self.identity = identity
            return state
