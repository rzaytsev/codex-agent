"""Private owner inbox reads. No SMTP, mutation, attachments or HTML rendering."""
import email
import email.policy
import imaplib
import json
import os
import re
import ssl
import sys

BODY_LIMIT = 65536


def extract(client, operation, args):
    status, count = client.select("INBOX", readonly=True)
    if status != "OK":
        raise RuntimeError()
    _, values = client.response("UIDVALIDITY")
    epoch = int(values[0])
    if operation == "icloud_inbox":
        total = int(count[0])
        if total == 0:
            return {"epoch": epoch, "messages": []}
        status, rows = client.fetch(
            f"{max(1, total - args['limit'] + 1)}:{total}",
            "(UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]<0.4096>)",
        )
    elif operation == "icloud_read" and epoch == args["epoch"]:
        status, rows = client.uid(
            "FETCH", str(args["uid"]), f"(UID BODY.PEEK[]<0.{BODY_LIMIT}>)"
        )
    else:
        raise RuntimeError()
    if status != "OK":
        raise RuntimeError()
    messages = []
    for row in rows:
        if not isinstance(row, tuple):
            continue
        meta, raw = row
        match = re.search(rb"\bUID ([0-9]+)\b", meta)
        if not match or len(raw) > BODY_LIMIT:
            raise RuntimeError()
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        data = {key.lower(): str(msg.get(key, ""))[:500] for key in ("From", "Subject", "Date")}
        data["uid"] = int(match[1])
        if operation == "icloud_read":
            if data["uid"] != args["uid"]:
                raise RuntimeError()
            part = msg.get_body(preferencelist=("plain",))
            body = part.get_content() if part and part.get_content_type() == "text/plain" else ""
            data.update(text=body[:12000], truncated=len(raw) >= BODY_LIMIT or len(body) > 12000)
        messages.append(data)
    if operation == "icloud_read":
        if len(messages) != 1:
            raise RuntimeError()
        return messages[0]
    return {"epoch": epoch, "messages": list(reversed(messages[-args["limit"]:]))}


def main():
    operation, raw_args = sys.argv[1:]
    args = json.loads(raw_args)
    with imaplib.IMAP4_SSL("imap.mail.me.com", 993, ssl_context=ssl.create_default_context(), timeout=8) as client:
        client.login(os.environ["ICLOUD_IMAP_USER"], os.environ["ICLOUD_IMAP_PASSWORD"])
        result = extract(client, operation, args)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
