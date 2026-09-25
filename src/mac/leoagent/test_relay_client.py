"""The Mac's relay client (relay_client.py): streams it forwards for the phone."""
import asyncio
import unittest
from unittest import mock

from aiohttp import web
from aiohttp.test_utils import TestServer

from . import relay_client
from .relay_client import RelayClient


class _WS:
    def __init__(self):
        self.frames = []

    async def send_json(self, frame):
        self.frames.append(frame)


class RelayClientStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_idle_stream_gets_keepalives_until_data_arrives(self):
        async def events(request):
            resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
            await resp.prepare(request)
            await asyncio.sleep(0.35)   # idle, like a session with nothing happening
            await resp.write(b'data: {"seq": 1}\n\n')
            return resp

        app = web.Application()
        app.router.add_get("/harness/sessions/s1/events", events)
        server = TestServer(app)
        await server.start_server()
        try:
            client = RelayClient("http://relay.invalid", "k", local_port=server.port, local_key="lk")
            ws = _WS()
            with mock.patch.object(relay_client, "KEEPALIVE_S", 0.1):
                import aiohttp
                async with aiohttp.ClientSession() as session:
                    await client._handle_stream(session, ws, {"id": "st1", "path": "/harness/sessions/s1/events"})
        finally:
            await server.close()
        kinds = [f["type"] for f in ws.frames]
        self.assertGreaterEqual(kinds.count("stream_keepalive"), 2)
        self.assertEqual([f for f in ws.frames if f["type"] == "stream_data"], [
            {"type": "stream_data", "id": "st1", "data": '{"seq": 1}'}])
        self.assertEqual(kinds[-1], "stream_close")


if __name__ == "__main__":
    unittest.main()
