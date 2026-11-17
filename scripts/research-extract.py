"""Bounded public document extraction; source text is untrusted evidence."""
import html
import json
import sys
from html.parser import HTMLParser
from pathlib import Path

class Text(HTMLParser):
    def __init__(self, include_links=False):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.title = []
        self.hidden = 0
        self.in_title = False
        self.include_links = include_links
        self.links = []
        self.anchor = None
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript', 'svg'):
            self.hidden += 1
        if tag == 'a' and self.include_links and not self.hidden and len(self.links) < 80:
            href = dict(attrs).get('href')
            self.anchor = (href, []) if href and len(href) <= 2048 else None
        if tag == 'title':
            self.in_title = True
        if tag in ('p', 'div', 'section', 'article', 'li', 'br', 'h1', 'h2', 'h3', 'tr'):
            self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript', 'svg'):
            self.hidden = max(0, self.hidden - 1)
        if tag == 'a' and self.anchor:
            href, label = self.anchor
            self.links.append({'href': href, 'label': ' '.join(''.join(label).split())[:240]})
            self.anchor = None
        if tag == 'title':
            self.in_title = False
    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)
            if self.anchor and len(self.anchor[1]) < 12:
                self.anchor[1].append(data[:240])
            if self.in_title:
                self.title.append(data)

raw = Path(sys.argv[1]).read_bytes()
if len(raw) > 8 * 1024 * 1024:
    raise ValueError('Source too large')
text = raw.decode('utf-8', errors='replace')
title = ''
include_links = sys.argv[3:] == ['--links']
links = []
if sys.argv[2] in ('text/html', 'application/xhtml+xml'):
    parser = Text(include_links)
    parser.feed(text)
    links = parser.links
    text = ''.join(parser.parts)
    title = ' '.join(''.join(parser.title).split())[:400]
text = '\n'.join(' '.join(line.split()) for line in text.splitlines() if line.strip())
print(json.dumps({'text': text[:250000], 'title': title, 'truncated': len(text) > 250000, **({'links': links} if include_links else {})}, ensure_ascii=False))
