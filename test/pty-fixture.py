# External terminal adapter for public-console acceptance; never packaged.
import os
import pty
import select
import signal
import sys

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

def stop(*_):
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, stop)
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [])
        if master in ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            os.write(1, chunk)
        if 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            os.write(master, chunk)
finally:
    stop()
    os.close(master)
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
