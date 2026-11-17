import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("icloud_inbox", Path(__file__).parents[1] / "scripts/icloud-inbox.py")
inbox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inbox)


class InboxTests(unittest.TestCase):
    def setUp(self):
        self.client = Mock()
        self.client.select.return_value = "OK", [b"18"]
        self.client.response.return_value = "UIDVALIDITY", [b"7"]

    def test_recent_headers_use_readonly_inbox_and_bounded_fetch(self):
        self.client.fetch.return_value = "OK", [(b'18 (UID 42 BODY[HEADER.FIELDS] {15}', b'Subject: Demo\r\n'), b')']
        result = inbox.extract(self.client, "icloud_inbox", {"limit": 2})
        self.client.select.assert_called_once_with("INBOX", readonly=True)
        self.client.fetch.assert_called_once_with("17:18", "(UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]<0.4096>)")
        self.assertEqual(result["epoch"], 7)
        self.assertEqual(result["messages"][0]["subject"], "Demo")

    def test_message_read_preserves_seen_and_requires_current_epoch(self):
        with self.assertRaises(RuntimeError):
            inbox.extract(self.client, "icloud_read", {"uid": 42, "epoch": 6})
        self.client.uid.assert_not_called()
        self.client.uid.return_value = "OK", [(b'18 (UID 42 BODY[] {31}', b'Subject: Demo\r\n\r\nPlain message.'), b')']
        result = inbox.extract(self.client, "icloud_read", {"uid": 42, "epoch": 7})
        self.client.uid.assert_called_once_with("FETCH", "42", "(UID BODY.PEEK[]<0.65536>)")
        self.assertEqual(result["text"], "Plain message.")
