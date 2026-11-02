#!/usr/bin/env python3
"""Verify every Otama legal-catalog source on archive.org.

For each unique item identifier in /tmp/catalog.json:
  1. fetch https://archive.org/metadata/<iaId>
  2. confirm the catalog's file exists (exact name) and has size > 0
  3. confirm the item's BitTorrent file (<iaId>_archive.torrent) exists
  4. download the .torrent, bencode-parse it, sha1 the info dict -> infohash
  5. confirm the torrent's payload actually contains the catalog file
  6. count web seeds (url-list)

Writes /tmp/ia-verified.json:  iaId -> {infoHash, torrentUrl, files:{name:size}, webseeds}
Prints a per-item PASS/FAIL table. Exit 1 if any item fails.
"""

import hashlib
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

METADATA = "https://archive.org/metadata/{id}"
DOWNLOAD = "https://archive.org/download/{id}/{torrent}"


def http_get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "otama-catalog-verify/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def bencode_parse(data: bytes, pos: int = 0):
    """Return (value, next_pos). Handles int/bytes/list/dict."""
    c = data[pos:pos + 1]
    if c == b"i":
        end = data.index(b"e", pos)
        return int(data[pos + 1:end]), end + 1
    if c == b"l":
        pos += 1
        out = []
        while data[pos:pos + 1] != b"e":
            v, pos = bencode_parse(data, pos)
            out.append(v)
        return out, pos + 1
    if c == b"d":
        pos += 1
        out = {}
        while data[pos:pos + 1] != b"e":
            k, pos = bencode_parse(data, pos)
            v, pos = bencode_parse(data, pos)
            out[k] = v
        return out, pos + 1
    # string: <len>:<bytes>
    colon = data.index(b":", pos)
    n = int(data[pos:colon])
    start = colon + 1
    return data[start:start + n], start + n


def torrent_infohash(raw: bytes):
    top, _ = bencode_parse(raw)
    info = top[b"info"]
    # re-encode info dict exactly as it appears in the file: find the raw span
    # by re-encoding the parsed dict (bencode is canonical for our needs as
    # archive.org writes standard bencode; verify against announced hash via
    # the file list instead of trusting re-encode).
    # Safer: locate the raw info dict bytes by scanning the original file.
    start = raw.index(b"4:info") + len(b"4:info")
    _, end = bencode_parse(raw, start)
    digest = hashlib.sha1(raw[start:end]).hexdigest()
    name = info.get(b"name", b"").decode("utf-8", "replace")
    files = []
    if b"files" in info:
        for f in info[b"files"]:
            path = b"/".join(f.get(b"path", [])).decode("utf-8", "replace")
            files.append((path, f.get(b"length", 0)))
    else:
        files.append((name, info.get(b"length", 0)))
    return digest, name, files, top


def verify_one(item: dict):
    ia_id = item["iaId"]
    res = {"iaId": ia_id, "ok": False, "error": None, "infoHash": None,
           "torrentUrl": None, "files": {}, "webseeds": 0}
    try:
        meta = json.loads(http_get(METADATA.format(id=ia_id)))
        files = {}
        for f in meta.get("files", []):
            try:
                files[f["name"]] = int(float(f.get("size", 0) or 0))
            except (TypeError, ValueError):
                files[f["name"]] = 0
        if not files:
            res["error"] = "metadata has no files"
            return res
        wanted = item["iaFile"]
        base = wanted.split("/")[-1]
        match = next((n for n in files if n == wanted or n.split("/")[-1] == base), None)
        if not match:
            res["error"] = f"file '{wanted}' not in item ({len(files)} files)"
            return res
        if files[match] <= 0:
            res["error"] = f"file '{match}' has size 0"
            return res
        tname = f"{ia_id}_archive.torrent"
        if tname not in files:
            res["error"] = f"{tname} not in item (no BitTorrent copy)"
            return res
        res["torrentUrl"] = DOWNLOAD.format(id=ia_id, torrent=tname)
        raw = http_get(res["torrentUrl"])
        digest, tname_in, tfiles, top = torrent_infohash(raw)
        res["infoHash"] = digest
        # the catalog file must be inside the torrent payload
        tb = base.lower()
        hit = any(p.lower().endswith(tb) for p, _ in tfiles)
        if not hit:
            res["error"] = f"torrent payload does not contain '{base}' ({len(tfiles)} files)"
            return res
        seeds = top.get(b"url-list", [])
        if isinstance(seeds, bytes):
            seeds = [seeds]
        res["webseeds"] = len(seeds)
        res["files"] = {match: files[match]}
        res["ok"] = True
        return res
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"[:160]
        return res


def main() -> int:
    catalog = json.load(open("/tmp/catalog.json"))
    items = {}
    for t in catalog:
        items.setdefault(t["iaId"], {"iaId": t["iaId"], "iaFile": t["iaFile"]})
        for e in t.get("episodes", []):
            items.setdefault(e["iaId"], {"iaId": e["iaId"], "iaFile": e["iaFile"]})
    print(f"verifying {len(items)} unique archive.org items ...")
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(verify_one, items.values()))
    ok = [r for r in results if r["ok"]]
    bad = [r for r in results if not r["ok"]]
    for r in sorted(results, key=lambda x: (not x["ok"], x["iaId"])):
        size_mb = sum(r["files"].values()) / 1e6
        print(f"{'PASS' if r['ok'] else 'FAIL'}  {r['iaId'][:52]:52s} "
              f"hash={r['infoHash'] or '-':40s} {size_mb:7.1f}MB seeds={r['webseeds']}"
              + ("" if r["ok"] else f"  -> {r['error']}"))
    out = {r["iaId"]: {"infoHash": r["infoHash"], "torrentUrl": r["torrentUrl"],
                       "files": r["files"], "webseeds": r["webseeds"]}
           for r in ok}
    with open("/tmp/ia-verified.json", "w") as f:
        json.dump(out, f, indent=1)
    print(f"\n{len(ok)} verified, {len(bad)} failed -> /tmp/ia-verified.json")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
