"""Deterministic tests for the independent packet parser and policy inventory."""
import hashlib
import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("runtime_probe", Path(__file__).with_name("runtime_probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def packet(payload):
    ethernet = b"\x00" * 12 + b"\x08\x00"
    ip = bytearray(20)
    ip[0], ip[9] = 0x45, 6
    tcp = bytearray(20)
    tcp[12] = 0x50
    return ethernet + ip + tcp + payload


class ProbeParserTest(unittest.TestCase):
    def test_extracts_only_read_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "trace.pcap"
            p.write_bytes(
                bytes.fromhex("d4c3b2a1") + struct.pack("<HHIIII", 2, 4, 0, 0, 65535, 1)
                + b"".join(
                    struct.pack("<IIII", second, micros, len(frame), len(frame)) + frame
                    for second, micros, frame in [
                        (1, 0, packet(b'{"op":"hello"}\n')),
                        (1, 20000, packet(b'{"op":"read"}\n')),
                        (1, 40000, packet(b'{"op":"read"}\n')),
                    ]
                )
            )
            self.assertEqual(probe.pcap_read_timestamps(p), [1.02, 1.04])

    def test_hashes_every_policy_without_absolute_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "policies" / "current"
            root.mkdir(parents=True)
            (root / "walk.onnx").write_bytes(b"policy")
            self.assertEqual(probe.policy_hashes(Path(tmp)), [{
                "path": "walk.onnx", "bytes": 6,
                "sha256": hashlib.sha256(b"policy").hexdigest(),
            }])


if __name__ == "__main__":
    unittest.main()
