"""Test-only entrypoint. Production never imports this protocol peer."""

import asyncio
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from conftest import StubWorker, peer_server

from herdr_broker.context import Context
from herdr_broker.herdr import Herdr
from herdr_broker.server import create_server
from herdr_broker.service import Broker


async def main():
    with TemporaryDirectory(dir="/tmp", prefix="hb-stdio-") as directory:
        path = Path(directory) / "h.sock"
        async with peer_server(path):
            context = Context(Herdr(path), "w1", "w1:p1", "term_1", os.getpid(), [])
            worker = StubWorker()
            try:
                await create_server(Broker(context, worker)).run_stdio_async()
            finally:
                await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
