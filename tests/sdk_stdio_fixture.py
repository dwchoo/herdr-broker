"""Test-only MCP process for SDK warmup, EOF and signal ownership checks."""
import asyncio
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

from conftest import peer_server

from herdr_broker.cli import run_stdio
from herdr_broker.context import Context
from herdr_broker.herdr import Herdr
from herdr_broker.server import create_server
from herdr_broker.service import Broker
from herdr_broker.worker import Worker


async def main():
    with TemporaryDirectory(dir="/tmp", prefix="hb-sdk-stdio-") as directory:
        async with peer_server(Path(directory) / "h.sock"):
            context = Context(Herdr(Path(directory) / "h.sock"),
                              "w1", "w1:p1", "term_1", os.getpid(), [])
            worker = Worker()
            worker.warmup()

            async def ready():
                if len(sys.argv) > 2:
                    while worker.runtime is None or worker.runtime.process is None:
                        await asyncio.sleep(0.001)
                else:
                    await worker.startup
                path = Path(sys.argv[1])
                staging = path.with_suffix('.pending')
                staging.write_text(str(worker.runtime.process.pid))
                staging.replace(path)

            notify = asyncio.create_task(ready())
            try:
                await run_stdio(create_server(Broker(context, worker)), worker)
            finally:
                await worker.close()
                await asyncio.gather(notify, return_exceptions=True)


try:
    asyncio.run(main())
except asyncio.CancelledError:
    pass
