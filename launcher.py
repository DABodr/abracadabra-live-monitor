"""Windows portable launcher: owns and cleanly stops its receiver only."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox
import webbrowser

ASSETS = Path(getattr(sys, '_MEIPASS', Path(__file__).parent))
HOME = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).parent
DATA = HOME / 'data'

def prepare():
    DATA.mkdir(exist_ok=True)
    for name in ('index.html', 'app.js', 'style.css', 'station-sites.json'):
        shutil.copy2(ASSETS / name, DATA / name)
    os.environ['LIVE_MONITOR_ROOT'] = str(DATA)

def receiver_copy(exe):
    """Only patch the exact tested distribution, never the installed files."""
    dll = exe.parent / 'librtlsdr.dll'
    hashes = json.loads((ASSETS / 'filter' / 'sha256.json').read_text())
    if (hashlib.sha256(exe.read_bytes()).hexdigest() != hashes['AbracaDABra.exe']
        or not dll.exists() or hashlib.sha256(dll.read_bytes()).hexdigest() != hashes['rtlsdr_original.dll']):
        raise ValueError('Cette version ne correspond pas à AbracaDABra 4.3.0 Windows testé. Sélectionnez la distribution officielle 4.3.0.')
    target = DATA / 'receiver'
    if exe.parent.resolve() == target.resolve():
        raise ValueError('Sélectionnez le logiciel original, pas la copie du serveur.')
    shutil.copytree(exe.parent, target, dirs_exist_ok=True)
    shutil.copy2(dll, target / 'rtlsdr_original.dll')
    shutil.copy2(ASSETS / 'filter' / 'librtlsdr.dll', target / 'librtlsdr.dll')
    return str(target / exe.name)

def main():
    prepare()
    window = tk.Tk()
    window.title('AbracaDABra Live Monitor — Portable 0.1')
    window.geometry('580x340')
    status = tk.StringVar(value='Prêt. Choisissez AbracaDABra au premier démarrage.')
    state = {'worker': None, 'server': None, 'module': None, 'closing': False, 'ready': threading.Event()}
    tk.Label(window, text='AbracaDABra Live Monitor', font=('Segoe UI', 18, 'bold')).pack(pady=16)
    tk.Label(window, textvariable=status, wraplength=540).pack(pady=10)
    tk.Label(window, text='PC : http://127.0.0.1:7979/').pack()
    try:
        addresses = sorted({a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET) if not a[4][0].startswith('127.')})
    except OSError:
        addresses = []
    tk.Label(window, text='Réseau local : ' + ' / '.join('http://' + a + ':7979/' for a in addresses), wraplength=540).pack(pady=8)
    def announce(text):
        window.after(0, status.set, text)
    def run():
        try:
            import server
            state['module'] = server
            # Bind before starting receiver, so an existing server is never disturbed.
            httpd = server.ThreadingHTTPServer(('0.0.0.0', 7979), server.Handler)
            state['server'] = httpd
            server.start()
            announce('Serveur démarré. Vous pouvez ouvrir l’interface.')
            state['ready'].set()
            httpd.serve_forever()
        except Exception as exc:
            announce('Erreur : ' + str(exc))
        finally:
            module = state['module']
            if module:
                module.scanner.cancel()
                if module.scanner.thread and module.scanner.thread.is_alive():
                    module.scanner.thread.join(timeout=20)
                module.stop()
            if state['server']:
                state['server'].server_close()
            state['server'] = None
    def start():
        if state['worker'] and state['worker'].is_alive():
            return
        try:
            for port in (7979, 17979):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', port))
            config = DATA / 'config.json'
            if not config.exists():
                selected = filedialog.askopenfilename(title='Choisir AbracaDABra.exe (4.3.0)', filetypes=[('AbracaDABra', 'AbracaDABra.exe')])
                if not selected:
                    return
                status.set('Préparation de la copie du récepteur…')
                window.update_idletasks()
                exe = receiver_copy(Path(selected))
                config.write_text(json.dumps(dict(exe=exe, automatic=True, index=2, gains=[0,3.4,6.8,10.2,13.7,17.1,20.7,24,27.8,31.2,34.6,38.2,41.6,45.3,48.8,52.7]), indent=2), encoding='utf-8')
            else:
                cfg = json.loads(config.read_text(encoding='utf-8'))
                cfg['exe'] = str(DATA / 'receiver' / 'AbracaDABra.exe')
                config.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
            status.set('Démarrage…')
            state['worker'] = threading.Thread(target=run, daemon=True)
            state['worker'].start()
        except Exception as exc:
            messagebox.showerror('Démarrage impossible', str(exc))
    def stop():
        if not state['worker'] or not state['worker'].is_alive():
            if state['closing']:
                window.destroy()
            return
        status.set('Arrêt en cours…')
        def shutdown():
            while state['worker'].is_alive() and not state['ready'].wait(.1):
                pass
            if state['server'] and state['worker'].is_alive():
                state['server'].shutdown()
            state['worker'].join()
            announce('Serveur arrêté.')
            if state['closing']:
                window.after(0, window.destroy)
        threading.Thread(target=shutdown, daemon=True).start()
    row = tk.Frame(window)
    row.pack(pady=14)
    for label, command in [('Démarrer', start), ('Ouvrir l’interface', lambda:webbrowser.open('http://127.0.0.1:7979/')), ('Arrêter', stop)]:
        tk.Button(row, text=label, command=command, padx=12, pady=8).pack(side='left', padx=5)
    tk.Label(window, text='Gardez cette fenêtre ouverte (vous pouvez la réduire).\nFermer la fenêtre arrête le serveur.', wraplength=540).pack()
    def close():
        state['closing'] = True
        stop()
    window.protocol('WM_DELETE_WINDOW', close)
    window.mainloop()

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--self-test':
        import tempfile
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary:
            os.environ['LIVE_MONITOR_ROOT'] = temporary
            Path(temporary, 'config.json').write_text(json.dumps(dict(exe='unused', automatic=True, index=2, gains=[])))
            import server
            assert server.ROOT == Path(temporary)
            assert tk.Tcl().eval('info patchlevel')
            for name in ('index.html', 'app.js', 'style.css', 'filter/librtlsdr.dll'):
                assert (ASSETS / name).is_file(), name
            assert Image.new('RGBA', (32,32)).size == (32,32)
            server.log.close()
        Path(sys.argv[2]).write_text('OK: runtime, Tcl, Pillow, server imports, isolated data, assets\n')
    else:
        main()
