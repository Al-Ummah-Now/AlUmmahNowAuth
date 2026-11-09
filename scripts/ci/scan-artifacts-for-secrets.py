#!/usr/bin/env python3
"""Fail-closed check that E2E output is safe to upload as a (public) workflow artifact.

Playwright records action arguments in traces (`params.value`) and in step titles
(`Fill "<value>"`), which the HTML report embeds as base64 JSON inside index.html, so a
typed password ends up in the report even when tracing is off. This scans the given
paths, including nested zips and the report's embedded zip, for:
  - the values of the named environment variables (raw, JSON-escaped, URL-encoded)
  - Playwright storage-state files (live session cookies)

Usage: scan-artifacts-for-secrets.py --env QA_SEED_PASSWORD [--env NAME ...] [--remove] PATH...
  --remove  delete every top-level PATH that has a finding (upload what is left)
Exit 1 when anything was found. Values are never printed.
Self-test: scan-artifacts-for-secrets.py --self-test
"""
import base64
import io
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.parse
import zipfile

REPORT_ZIP = re.compile(rb'<template id="playwrightReportBase64">data:application/zip;base64,([^<]+)</template>')
MIN_LEN = 6


def needles(values):
    out = set()
    for v in values:
        if len(v) < MIN_LEN:
            continue
        for form in (v, json.dumps(v)[1:-1], urllib.parse.quote(v, safe=''), urllib.parse.quote_plus(v)):
            out.add(form.encode())
    return out


def is_storage_state(name, data):
    if not name.endswith('.json') or b'"cookies"' not in data[:4096] or b'"origins"' not in data:
        return False
    try:
        doc = json.loads(data)
    except ValueError:
        return False
    return isinstance(doc, dict) and isinstance(doc.get('cookies'), list) and isinstance(doc.get('origins'), list) and bool(doc['cookies'])


def scan_blob(name, data, secrets, findings, depth=0):
    if any(s in data for s in secrets):
        findings.append(f'{name}: contains a secret value')
    if is_storage_state(name, data):
        findings.append(f'{name}: Playwright storage state (session cookies)')
    if depth > 4:
        return
    embedded = REPORT_ZIP.search(data) if name.endswith('.html') else None
    if embedded:
        try:
            scan_zip(f'{name}!report', base64.b64decode(embedded.group(1)), secrets, findings, depth + 1)
        except (ValueError, zipfile.BadZipFile):
            findings.append(f'{name}: unreadable embedded report (treated as unsafe)')
    if data[:4] == b'PK\x03\x04':
        try:
            scan_zip(name, data, secrets, findings, depth + 1)
        except zipfile.BadZipFile:
            pass


def scan_zip(name, data, secrets, findings, depth):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for entry in z.namelist():
            scan_blob(f'{name}!{entry}', z.read(entry), secrets, findings, depth)


def scan_path(path, secrets):
    findings = []
    files = [path] if os.path.isfile(path) else [os.path.join(r, f) for r, _, fs in os.walk(path) for f in fs]
    for f in files:
        with open(f, 'rb') as fh:
            scan_blob(f, fh.read(), secrets, findings)
    return findings


def main(argv):
    names, paths, remove = [], [], False
    it = iter(argv)
    for a in it:
        if a == '--env':
            names.append(next(it))
        elif a == '--remove':
            remove = True
        else:
            paths.append(a)
    values = [os.environ.get(n, '') for n in names]
    secrets = needles(values)
    bad = False
    for p in paths:
        if not os.path.exists(p):
            continue
        findings = scan_path(p, secrets)
        if not findings:
            print(f'ok: {p}')
            continue
        bad = True
        for f in findings[:20]:
            print(f'::error::{f}')
        if remove:
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
            print(f'::error::removed {p} so it is not uploaded')
    return 1 if bad else 0


def self_test():
    secret = 'Qa-Example!Pass9'
    os.environ['SCAN_SELF_TEST'] = secret
    with tempfile.TemporaryDirectory() as d:
        clean, leak, report, state = (os.path.join(d, n) for n in ('clean', 'leak', 'report', 'state'))
        for p in (clean, leak, report, state):
            os.mkdir(p)
        open(os.path.join(clean, 'a.png'), 'wb').write(b'\x89PNG nothing here')
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:  # a trace zip whose network body has the url-encoded value
            z.writestr('0-trace.network', 'password=' + urllib.parse.quote_plus(secret))
        open(os.path.join(leak, 'trace.zip'), 'wb').write(buf.getvalue())
        rep = io.BytesIO()
        with zipfile.ZipFile(rep, 'w') as z:  # HTML report: step title in the embedded zip
            z.writestr('abc.json', json.dumps({'title': f'Fill "{secret}"'}))
        html = b'<template id="playwrightReportBase64">data:application/zip;base64,' + base64.b64encode(rep.getvalue()) + b'</template>'
        open(os.path.join(report, 'index.html'), 'wb').write(html)
        open(os.path.join(state, 'user.json'), 'w').write(json.dumps({'cookies': [{'name': '__session', 'value': 'x'}], 'origins': []}))
        code = main(['--env', 'SCAN_SELF_TEST', '--remove', clean, leak, report, state])
        assert code == 1, code
        assert os.path.exists(clean) and not any(os.path.exists(p) for p in (leak, report, state)), 'remove'
        assert main(['--env', 'SCAN_SELF_TEST', clean]) == 0
    print('self-test passed')
    return 0


if __name__ == '__main__':
    sys.exit(self_test() if sys.argv[1:] == ['--self-test'] else main(sys.argv[1:]))
