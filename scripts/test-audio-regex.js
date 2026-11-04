// Regex validation for the audio-codec scoring added to scoreTorrent.
// Every detection must hit exactly the intended names; neutral names must
// pass through untouched (no false positives).
const BAD_AUDIO = /\bac3\b|\be-?ac3\b|\bddp\b|\bdd\+|\bdd[ .+_-]?[2-9]|\bdd\b|\bdts\b|\bdtshd\b|\btruehd\b|\batmos\b|\bdolby\b/;
const AAC = /\baac(?:[ ._]?[2-9](?:\.[0-9])?)?\b|\bhe-?aac\b/;
const MKV = /\bmkv\b|\[mkv\]|\bavi\b/i;

const cases = [
  // [releaseName, expectBadAudio, expectAAC, expectMKV]
  ["Oppenheimer.2023.1080p.WEB-DL.DDP5.1.Atmos.H.264-HDR", true, false, false],
  ["Show.S01E01.1080p.BluRay.x264.DTS-HD.MA.5.1-RARBG", true, false, false],
  ["Movie.2020.2160p.WEB-DL.x265.EAC3.5.1.HDR-GROUP", true, false, false],
  ["Film.2019.1080p.BluRay.REMUX.AVC.DTS-HD.MA.TrueHD.7.1", true, false, false],
  ["Title.2021.720p.WEBRip.DD5.1.x264-GalaxyRG", true, false, false],
  ["Movie.2022.1080p.WEB-DL.DD+.5.1.H.264-EVO", true, false, false],
  ["Old.1998.DVDRip.AC3.5.1.XviD-DiAMOND", true, false, false],
  ["Series.S02.1080p.BluRay.Dolby.Digital.Plus.x264", true, false, false],
  ["Flick.2017.BluRay.DTSHD.x264-GRP", true, false, false],
  ["Anime.2024.1080p.BluRay.TRUEHD.5.1.FLAC-GROUP", true, false, false],
  // AAC releases — must NOT trip the penalty
  ["Movie.2023.1080p.BluRay.x264.AAC5.1-ETRG", false, true, false],
  ["Show.S01E02.720p.WEBRip.AAC2.0.H.264-SYNCOPY", false, true, false],
  ["Doc.2020.1080p.WEB-DL.AAC.H.264-HANDJOB", false, true, false],
  ["Film.2018.1080p.AAC.5.1.x264-GRP", false, true, false],
  ["Clip.2015.H.264.HE-AAC.2.0-GRP", false, true, false],
  // neutral — neither tag
  ["Movie.2021.1080p.WEB-DL.x264-GRP", false, false, false],
  ["Show.S03E05.480p.x264-mSD", false, false, false],
  ["Ubuntu.22.04.LTS.Desktop.amd64", false, false, false],
  ["Sample.2019.1080p.BluRay.x265-GROUP", false, false, false],
  // container hints
  ["Movie.2022.1080p.WEB-DL.H264.AC3-GROUP.mkv", true, false, true],
  ["Pack.S01.[1080p][MKV][AAC]-GRP", false, true, true],
  ["Cam.2023.HDRip.Avi.XviD-GRP", false, false, true],
  // tricky false-positive probes
  ["Movie.2020.WEB-DL.ADD.5.1.x264", false, false, false], // "ADD" must not match \bdd\b
  ["Anime.2021.Hi10P.1080p.mkv-GRP", false, false, true], // ".mkv-" carries the word boundary → flagged, correct
];

let fails = 0;
for (const [name, bad, aac, mkv] of cases) {
  const n = name.toLowerCase();
  const g = { bad: BAD_AUDIO.test(n), aac: AAC.test(n), mkv: MKV.test(n) };
  const ok = g.bad === bad && g.aac === aac && g.mkv === mkv;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} bad=${g.bad === bad ? g.bad : "MISMATCH exp " + bad} aac=${g.aac === aac ? g.aac : "MISMATCH exp " + aac} mkv=${g.mkv === mkv ? g.mkv : "MISMATCH exp " + mkv}  ${name}`);
}
console.log(fails === 0 ? "ALL PASS" : `${fails} FAILURES`);
