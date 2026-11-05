# Live-verification: recompute the OLD scoreTorrent (pre-audio-fix) for each
# result the deployed site returns and compare with the returned score.
# If Dolby/DTS rows come back ~9 points BELOW the old formula, the deployed
# site is running the new audio-aware scoring.
import json, math, re, sys, urllib.request

BAD = re.compile(r"\b(ac-?3|e-?ac-?3|ddp|dd\+|dd[ .+_-]?[2-9]|dd|dts|dtshd|truehd|atmos|dolby)\b")
AAC = re.compile(r"\baac(?:[ ._]?[2-9](?:\.[0-9])?)?\b|\bhe-?aac\b")
MKV = re.compile(r"\bmkv\b|\[mkv\]|\bavi\b", re.I)

def quality_of(name):
    if re.search(r"\b(2160p|4k)\b", name): return "2160p"
    if re.search(r"\b1080p\b", name): return "1080p"
    if re.search(r"\b720p\b", name): return "720p"
    if re.search(r"\b480p\b", name): return "480p"
    return None

def old_score(t):
    n = t["releaseName"].lower()
    s = min(math.log10(t["seeders"] + 1) * 4, 13)
    q = quality_of(n)
    if q == "1080p": s += 5
    elif q == "720p": s += 4
    elif q == "2160p": s += 2
    elif q == "480p": s += 1
    if re.search(r"x265|h\.?265|hevc", n): s -= 10
    if re.search(r"10[\s._-]?bit|hi10\w*", n): s -= 20
    if re.search(r"av1", n): s += 1
    if re.search(r"x264|h\.?264|xvid", n) and not re.search(r"10[\s._-]?bit|hi10", n): s += 2
    if re.search(r"\b(cam|ts|telesync|screener|dvdscr|hdts|\btc\b)\b", n): s -= 12
    if re.search(r"\b3d\b", n): s -= 6
    if re.search(r"\.mp4\b", n) or re.search(r"yts", t["releaseName"], re.I): s += 1.5
    if t["sizeBytes"] > 0 and t["sizeBytes"] < 120 * 1024 * 1024: s -= 2
    if t["sizeBytes"] > 25 * 1024 * 1024 * 1024: s -= 3
    return round(s, 1)

def new_delta(t):
    n = t["releaseName"].lower()
    d = 0.0
    if BAD.search(n): d -= 9
    if AAC.search(n): d += 2.5
    if MKV.search(n): d -= 1
    return d

url = sys.argv[1]
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
d = json.load(urllib.request.urlopen(req, timeout=120))
rows = d.get("results", [])[:10]
print(f"X-Cache visible in headers only; {len(d.get('results', []))} results, checking top 10:")
verdicts = []
for t in rows:
    name = (t.get("releaseName") or "?")[:58]
    got = t.get("score")
    old = old_score(t)
    delta = got - old if (got is not None) else None
    bad = bool(BAD.search((t.get("releaseName") or "").lower()))
    tag = "BAD-AUDIO" if bad else ("AAC" if AAC.search((t.get("releaseName") or "").lower()) else "neutral")
    # expected delta under new code for this row
    exp = new_delta(t)
    match = "≈new" if (delta is not None and abs(delta - exp) <= 1.6) else "≈old" if (delta is not None and abs(delta) <= 1.6) else "???"
    verdicts.append((tag, match))
    print(f"  [{tag:9}] score={got} old={old} Δ={delta} expΔ={exp:+.1f} [{match}] {name}")

bad_rows = [v for v in verdicts if v[0] == "BAD-AUDIO"]
if bad_rows and all(m == "≈new" for _, m in bad_rows):
    print("VERDICT: NEW audio-aware scoring is LIVE on the deployed site")
elif bad_rows and all(m == "≈old" for _, m in bad_rows):
    print("VERDICT: OLD scoring still live — site not redeployed yet (or cache)")
else:
    print("VERDICT: inconclusive from this sample — inspect deltas above")
