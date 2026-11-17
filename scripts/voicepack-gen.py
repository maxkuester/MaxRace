# MaxRace voice pack: every piece MaxRace says (voicepack.js), spoken by a natural voice made on this Mac with
# Chatterbox Multilingual (Resemble AI, MIT licence). Nothing leaves the Mac.
#
#   ~/Documents/MaxRace/voce-clone/.venv/bin/python scripts/voicepack-gen.py  [voice.m4a] [--ex=0.5] [--only=key1,key2] [--force]
#
# voice.m4a: optional, 10 s to 1 min of someone talking (who agreed to it) to clone that voice; without it the model's
# own voice is used. --ex: how lively (0.3 calm .. 0.8 sharp). The clips go to voicepack/ (one .m4a each, plus
# index.json); pieces already made are kept unless --force. voicepack/ is not committed (a voice is personal and the
# repository is public); scripts/build-native-web.js copies it into the app when it is there.
import json, os, subprocess, sys, time, tempfile
import numpy as np, soundfile as sf, librosa, torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "voicepack")
args = [a for a in sys.argv[1:] if not a.startswith("--")]
only = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--only=")), None)
force = "--force" in sys.argv
ex = float(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--ex=")), 0.5))
tmp = tempfile.mkdtemp()
ref = None
if args:   # the reference: to 24 kHz mono wav (macOS afconvert reads m4a, mp3, wav, caf)
    ref = os.path.join(tmp, "ref.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@24000", "-c", "1", os.path.abspath(args[0]), ref], check=True)

units = json.loads(subprocess.run(["node", "-e", "process.stdout.write(JSON.stringify(require(%r).units().map(u=>Object.assign(u,{f:require(%r).file(u.k)}))))"
                                   % (os.path.join(ROOT, "voicepack.js"), os.path.join(ROOT, "voicepack.js"))],
                                  capture_output=True, text=True, check=True).stdout)
if only:
    keep = set(only.split(","))
    units = [u for u in units if u["k"] in keep]
os.makedirs(OUT, exist_ok=True)
idx_path = os.path.join(OUT, "index.json")
idx = json.load(open(idx_path)) if os.path.exists(idx_path) else {"files": {}}

from chatterbox.mtl_tts import ChatterboxMultilingualTTS
dev = "mps" if torch.backends.mps.is_available() else "cpu"
m = ChatterboxMultilingualTTS.from_pretrained(device=dev)
if ref:
    m.prepare_conditionals(ref, exaggeration=ex)
print("model ready on", dev, "-", len(units), "pieces", flush=True)

def take(text):
    wav = m.generate(text, language_id="it", exaggeration=ex, cfg_weight=0.5, temperature=0.7).squeeze(0).cpu().numpy()
    y, _ = librosa.effects.trim(wav, top_db=38)
    return y

t0 = time.time()
for i, u in enumerate(units):
    dst = os.path.join(OUT, u["f"])
    if os.path.exists(dst) and not force and u["k"] in idx["files"]:
        continue
    # a short piece sometimes comes out with extra sounds: keep the take whose length fits the text best
    expect = 0.25 + 0.065 * len(u["say"])
    best = None
    for attempt in range(3):
        y = take(u["say"])
        d = len(y) / m.sr
        score = abs(d - expect) / expect
        if best is None or score < best[0]:
            best = (score, y)
        if score < 0.6:
            break
    y = best[1]
    y = y / max(1e-6, np.max(np.abs(y))) * 0.89                  # same loudness for every piece
    w = os.path.join(tmp, "c.wav")
    sf.write(w, y, m.sr)
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", w, dst], check=True)
    idx["files"][u["k"]] = u["f"]
    if i % 10 == 0:
        json.dump(idx, open(idx_path, "w"), ensure_ascii=False, indent=0)
    print("%3d/%d %5.1fs  %-40s %.2fs" % (i + 1, len(units), time.time() - t0, u["k"], len(y) / m.sr), flush=True)
idx["sr"] = m.sr
idx["made"] = time.strftime("%Y-%m-%d %H:%M")
json.dump(idx, open(idx_path, "w"), ensure_ascii=False, indent=0)
print("done:", len(idx["files"]), "pieces in", OUT)
