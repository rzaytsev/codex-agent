#!/usr/bin/env python3
"""Send structured mailbox requests through an existing SSH connection."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid


def request(config, operation, arguments):
    host = config.get('host', '')
    command = config.get('command')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*', host):
        raise ValueError('Invalid SSH host alias')
    if not isinstance(command, list) or not command or any(not isinstance(p, str) or not p for p in command):
        raise ValueError('Configure a fixed remote command array')
    result = subprocess.run(
        ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, shlex.join(command)],
        input=json.dumps({'operation': operation, 'args': arguments}),
        text=True, capture_output=True, timeout=30, check=False,
    )
    if result.returncode:
        raise RuntimeError('SSH/mailbox call failed; delivery may be uncertain. Check status or retry with the same ID.')
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('AGENT_MAIL_CONFIG', '~/.config/agent-mail/config.json')).expanduser())
    commands = parser.add_subparsers(dest='operation', required=True)
    commands.add_parser('list')
    send = commands.add_parser('send')
    send.add_argument('to')
    send.add_argument('--kind', choices=['message', 'task_request', 'reply'], default='message')
    content = send.add_mutually_exclusive_group(required=True)
    content.add_argument('--text')
    content.add_argument('--text-file', type=Path)
    send.add_argument('--context', default='')
    send.add_argument('--id')
    send.add_argument('--reply-to')
    commands.add_parser('status').add_argument('id')
    commands.add_parser('ack').add_argument('id')
    commands.add_parser('replies').add_argument('--after', type=int, default=0)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        if args.operation == 'send':
            body = args.text if args.text is not None else args.text_file.read_text()
            message_id = args.id or str(uuid.uuid4())
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{7,79}', message_id):
                raise ValueError('Invalid request ID')
            if not body.strip() or len(body) > 12000 or len(args.context) > 200:
                raise ValueError('Text must be 1–12000 characters and context at most 200')
            if (args.kind == 'reply') != bool(args.reply_to):
                raise ValueError('Replies require --reply-to; other kinds must omit it')
            payload = dict(id=message_id, to=args.to, kind=args.kind, text=body, context=args.context)
            if args.reply_to:
                payload['reply_to'] = args.reply_to
            print('Request ID: ' + message_id, file=sys.stderr, flush=True)
        elif args.operation in ('status', 'ack'):
            payload = {'id': args.id}
        elif args.operation == 'replies':
            if args.after < 0:
                raise ValueError('Cursor must be nonnegative')
            payload = {'after': args.after}
        else:
            payload = {}
        print(json.dumps(request(config, args.operation, payload), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        print('Messaging failed. Check local configuration and SSH access. For a send, delivery is unknown; check the printed ID before retrying.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
