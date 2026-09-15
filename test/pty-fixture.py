# External terminal adapter for public-console acceptance; never packaged.
import os
import pty
import select
import signal
import sys
import json
import fcntl
import struct
import termios

def resize(fd):
    path = os.environ.get('HB_TEST_WINSIZE_PATH')
    if path:
        with open(path) as file:
            size = json.load(file)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', size['rows'], size['columns'], 0, 0))

master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    resize(0)
    os.execv(sys.argv[1], sys.argv[1:])

def stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGWINCH, lambda *_: resize(master))
status = None
restored = None
recent_output = b''
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [], 0.05)
        if status is None:
            stopped_pid, stopped_status = os.waitpid(pid, os.WNOHANG)
            if stopped_pid:
                status = stopped_status
        if status is not None and master not in ready:
            break
        if master in ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            os.write(1, chunk)
            recent_output = (recent_output + chunk)[-256:]
            if b'\x1b[?1049l' in recent_output and restored is None:
                restored = termios.tcgetattr(slave)
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            os.write(master, chunk)
finally:
    if restored is not None:
        os.write(2, ('PTY_STATE ' + json.dumps({'canonical': bool(restored[3] & termios.ICANON), 'echo': bool(restored[3] & termios.ECHO)}) + '\n').encode())
    if status is None:
        stopped_pid, stopped_status = os.waitpid(pid, os.WNOHANG)
        if stopped_pid:
            status = stopped_status
        else:
            stop()
    os.close(master)
    os.close(slave)
    if status is None:
        _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
