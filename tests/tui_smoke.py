"""Real, isolated Herdr TUI + actual metadata publisher; never uses live sockets."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import shlex
import socket
import struct
import subprocess
import tempfile
import termios
import time

import pyte

parser = argparse.ArgumentParser()
parser.add_argument('--output', default='.local-validation/tui-evidence.json')
args = parser.parse_args()
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
module = (Path(__file__).resolve().parents[1] / 'metadata.ts').as_uri()
herdr = shutil.which('herdr')
pi = shutil.which('pi')
assert herdr and pi
results = {}
with tempfile.TemporaryDirectory(prefix='pica-tui-') as temporary:
    root = Path(temporary)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HERDR_', 'PI_'))}
    env.update(HOME=temporary, XDG_CONFIG_HOME=temporary+'/config', XDG_STATE_HOME=temporary+'/state',
               XDG_DATA_HOME=temporary+'/data', XDG_CACHE_HOME=temporary+'/cache', XDG_RUNTIME_DIR=temporary+'/runtime',
               HERDR_SOCKET_PATH=temporary+'/api.sock', HERDR_CLIENT_SOCKET_PATH=temporary+'/client.sock',
               HERDR_CONFIG_PATH=temporary+'/config.toml', SHELL='/bin/sh', TERM='xterm-256color', LANG='C.UTF-8')
    (root/'runtime').mkdir(mode=0o700)
    (root/'config.toml').write_text('''onboarding = false
[update]
version_check = false
manifest_check = false
[ui]
status_indicators = "symbols"
[ui.sound]
enabled = false
[ui.sidebar.agents]
rows = [
  ["state_icon", "tab"],
  [{ token = "$pica_context", fg = "#b58900", bold = true }],
  [{ token = "state_text", rules = [
    { equals = "◉ Antwort offen", fg = "#b58900", bold = true },
    { contains = "", hide = true },
  ] }],
]
''')

    def rpc(method, params=None):
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(4)
            sock.connect(env['HERDR_SOCKET_PATH'])
            sock.sendall((json.dumps({'id': 'pica-tui', 'method': method, 'params': params or {}})+'\n').encode())
            with sock.makefile('rb') as stream:
                response = json.loads(stream.readline())
            if 'error' in response:
                raise RuntimeError(response['error'])
            return response['result']

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 140, 0, 0))

    class Screen(pyte.Screen):
        def report_device_status(self, mode, **_kwargs):
            return super().report_device_status(mode)

        def write_process_input(self, data):
            os.write(master, data.encode())

    screen = Screen(140, 48)
    stream = pyte.ByteStream(screen)
    raw = bytearray()
    server = client = publisher = None

    def pump(seconds=.6):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            readable, _, _ = select.select([master], [], [], min(.05, max(0, until-time.monotonic())))
            if readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                raw.extend(data)
                stream.feed(data)

    def capture(label):
        pump()
        lines = [line.split('│', 1)[0].rstrip() for line in screen.display]
        results[label] = lines
        print(label + ': ' + ' | '.join(l.strip() for l in lines if l.strip()))
        return lines

    def publish(command):
        publisher.stdin.write(command+'\n')
        publisher.stdin.flush()
        ready, _, _ = select.select([publisher.stdout], [], [], 5)
        assert ready, 'metadata publisher response timeout'
        response = publisher.stdout.readline().strip()
        assert response == 'acknowledged', response

    def stop_owned(process):
        if process is None:
            return
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    try:
        with (root/'server.log').open('wb') as log:
            server = subprocess.Popen([herdr, 'server'], env=env, cwd=root, stdout=log, stderr=log)
            deadline = time.monotonic()+8
            while not (root/'api.sock').exists():
                if server.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError((root/'server.log').read_text()[-2000:])
                time.sleep(.05)
            workspace = rpc('workspace.create', {'cwd': temporary, 'label': 'fixtures', 'focus': True})
            tab = rpc('tab.create', {'workspace_id': workspace['workspace']['workspace_id'],
                                     'label': 'CONTEXT-TEST', 'cwd': temporary, 'focus': False})
            pane = tab['root_pane']['pane_id']
            # Install the real native lifecycle integration only inside this temp HOME.
            (root / '.pi/agent/extensions').mkdir(parents=True)
            installed = subprocess.run([herdr, 'integration', 'install', 'pi'], env=env, cwd=root,
                                       capture_output=True, text=True, timeout=8)
            assert installed.returncode == 0, installed.stdout + installed.stderr
            native = root / '.pi/agent/extensions/herdr-agent-state.ts'
            assert native.is_file()
            command = f'exec env PI_CODING_AGENT_DIR={shlex.quote(temporary + "/pi-agent")} {shlex.quote(pi)} --offline --no-extensions -e {shlex.quote(str(native))} --no-skills --no-context-files --no-session'
            subprocess.run([herdr, 'pane', 'run', pane, command], env=env, cwd=root, capture_output=True, text=True, check=True, timeout=8)
            deadline = time.monotonic()+10
            while rpc('pane.get', {'pane_id': pane})['pane'].get('agent_status') not in ('idle', 'done'):
                assert time.monotonic() < deadline, 'isolated Pi integration did not report idle'
                time.sleep(.05)
            rpc('pane.focus', {'pane_id': pane})
            rpc('pane.report_metadata', {'pane_id': pane, 'source': 'test:foreign',
                                        'state_labels': {'idle': '◉ Antwort offen'}, 'tokens': {'foreign': 'keep'}})
            client = subprocess.Popen([herdr], env=env, cwd=root, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            pump(1)
            os.write(master, b'\x1b[I')
            script = f'''import {{ MetadataPublisher }} from {json.dumps(module)};
import {{ createInterface }} from 'node:readline';
const p = new MetadataPublisher(process.env.HERDR_SOCKET_PATH, {json.dumps(pane)}, {{ttlMs:1200, refreshMs:200}});
for await (const line of createInterface({{input:process.stdin}})) {{
 if (line === 'quit') {{ await p.close(); console.log(p.status); break; }}
 await p.set(line === 'compacting' ? 'compacting' : line === 'full'); console.log(p.status);
}}
'''
            def start_publisher():
                return subprocess.Popen(['node', '--input-type=module', '-e', script], env=env, cwd=root,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            publisher = start_publisher()
            before = capture('before')
            assert not any('Context full' in line for line in before)
            native_before = rpc('pane.get', {'pane_id': pane})['pane']['agent_status']
            results['native_state'] = native_before
            assert native_before == 'idle', native_before
            assert any('◉ Antwort offen' in line for line in before), 'Real reply row must be visible'
            publish('full')
            full = capture('full')
            assert sum('⚠ Context full' in line for line in full) == 1
            snapshot = rpc('pane.get', {'pane_id': pane})['pane']
            assert snapshot['agent_status'] == native_before, snapshot
            assert snapshot['tokens']['pica_context'] == '⚠ Context full'
            assert snapshot['tokens']['foreign'] == 'keep'
            assert snapshot['state_labels']['idle'] == '◉ Antwort offen'
            assert not any('×' in line for line in full if 'CONTEXT-TEST' in line), 'No native attention X'
            # A later competing presentation update cannot hide the dedicated token.
            rpc('pane.report_metadata', {'pane_id': pane, 'source': 'test:priority-plus',
                                        'state_labels': {'idle': '◉ Antwort offen'}})
            assert sum('⚠ Context full' in line for line in capture('foreign_label_update')) == 1
            publish('compacting')
            compacting = capture('compacting')
            assert sum('⌛ Compacting context' in line for line in compacting) == 1
            assert not any('Context full' in line for line in compacting)
            assert rpc('pane.get', {'pane_id': pane})['pane']['agent_status'] == native_before
            publish('full')
            failed = capture('compaction_failed')
            assert any('⚠ Context full' in line for line in failed)
            assert not any('Compacting context' in line for line in failed)
            publish('compacting')
            publish('clear')
            assert not any('Context full' in line or 'Compacting context' in line for line in capture('recovered'))
            snapshot = rpc('pane.get', {'pane_id': pane})['pane']
            assert 'pica_context' not in snapshot.get('tokens', {})
            assert snapshot['tokens']['foreign'] == 'keep'
            assert snapshot['state_labels']['idle'] == '◉ Antwort offen'
            publish('full')
            publish('quit')
            assert not any('Context full' in line for line in capture('shutdown'))
            publisher.stdin.close()
            publisher.wait(timeout=4)
            publisher.stdout.close()
            publisher.stderr.close()
            publisher = start_publisher()
            publish('full')
            pump(1.5)  # Longer than this test publisher's real server-side lease.
            assert any('⚠ Context full' in line for line in capture('lease_renewed'))
            publisher.kill()  # Deliberate crash of our own fixture: no orderly clear.
            publisher.wait(timeout=4)
            pump(1.5)
            assert not any('Context full' in line for line in capture('crash_expired'))
            assert 'pica_context' not in rpc('pane.get', {'pane_id': pane})['pane'].get('tokens', {})
            results['passed'] = True
    finally:
        if publisher:
            if publisher.stdin and not publisher.stdin.closed:
                publisher.stdin.close()
            stop_owned(publisher)
            results['publisher_stderr'] = publisher.stderr.read()
        if server:
            try:
                rpc('server.stop')
            except (OSError, ValueError, RuntimeError):
                pass
        stop_owned(server)
        stop_owned(client)
        os.close(master)
        os.close(slave)
        output.write_text(json.dumps(results, ensure_ascii=False, indent=2)+'\n')
        output.with_suffix('.ansi').write_bytes(raw)
print('PASS: actual TUI warning, no native X, foreign metadata survives, recovery and shutdown clear')
