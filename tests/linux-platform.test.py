import importlib.util
from pathlib import Path
import struct
import os
import socket
import threading
import unittest

spec = importlib.util.spec_from_file_location('linux_platform', Path(__file__).resolve().parents[1] / 'native/linux-platform.py')
platform = importlib.util.module_from_spec(spec)
spec.loader.exec_module(platform)


def sequence(data):
    return bytes([0x35, len(data)]) + data


def attributes(channel=7):
    protocols = sequence(sequence(b'\x19\x01\x00') + sequence(b'\x19\x00\x03\x08' + bytes([channel])))
    return sequence(sequence(b'\x09\x00\x04' + protocols))


class SdpTests(unittest.TestCase):
    def test_rfcomm_receive_continues_while_transmit_is_backpressured(self):
        local, phone = socket.socketpair()
        local.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
        phone.settimeout(2)
        read_fd, write_fd = os.pipe()
        received = threading.Event()
        class Output:
            def write(self, data):
                if data == b'phone-event': received.set()
            def flush(self): pass
        relay = threading.Thread(target=platform.relay, args=(local, read_fd, Output()), daemon=True)
        payload = b'x' * 131072
        def write_payload():
            offset = 0
            while offset < len(payload):
                offset += os.write(write_fd, payload[offset:])
        writer = threading.Thread(target=write_payload, daemon=True)
        try:
            relay.start()
            writer.start()
            phone.sendall(b'phone-event')
            self.assertTrue(received.wait(2), 'TX backpressure must not block RX')
            data = bytearray()
            while len(data) < len(payload):
                data.extend(phone.recv(65536))
            self.assertEqual(bytes(data), payload)
            writer.join(2)
            os.close(write_fd)
            write_fd = None
            relay.join(2)
            self.assertFalse(relay.is_alive())
        finally:
            if write_fd is not None: os.close(write_fd)
            phone.close()
            local.close()
            os.close(read_fd)

    def test_extracts_advertised_channel_and_rejects_invalid_records(self):
        self.assertEqual(platform.rfcomm_channel(attributes()), 7)
        self.assertEqual(platform.rfcomm_channel(attributes(30)), 30)
        for data in (attributes(0), attributes(31), b'\x35\x00', attributes()[:-1]):
            with self.assertRaises((ValueError, RuntimeError)):
                platform.rfcomm_channel(data)

    def test_continuations_reassemble_binary_attributes(self):
        data = attributes(19)
        class Channel:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): self.timeout = value
            def connect(self, address): self.address = address
            def sendall(self, packet): self.packet = packet
            def recv(self, count):
                transaction = struct.unpack('!H', self.packet[1:3])[0]
                part = data[:8] if transaction == 1 else data[8:]
                continuation = b'\x02ab' if transaction == 1 else b'\x00'
                params = struct.pack('!H', len(part)) + part + continuation
                return struct.pack('!BHH', 7, transaction, len(params)) + params
        channel = Channel()
        self.assertEqual(platform.discover_channel('AA:BB:CC:DD:EE:FF', lambda *args: channel), 19)
        self.assertIn(platform.SERVICE, channel.packet)
        self.assertTrue(channel.packet.endswith(b'\x02ab'))
        self.assertEqual(channel.address, ('AA:BB:CC:DD:EE:FF', 1))

    def test_sdp_rejects_mismatched_transaction(self):
        class Channel:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def settimeout(self, value): pass
            def connect(self, address): pass
            def sendall(self, packet): pass
            def recv(self, count): return b'\x07\x00\xff\x00\x03\x00\x00\x00'
        with self.assertRaisesRegex(ValueError, '标识'):
            platform.discover_channel('AA:BB:CC:DD:EE:FF', lambda *args: Channel())


if __name__ == '__main__':
    unittest.main()
