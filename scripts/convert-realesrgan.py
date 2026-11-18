# Convert the official realesr-general-x4v3.pth (SRVGGNetCompact) to ONNX without PyTorch.
# Used for the app: python3 convert-realesrgan.py realesr-general-x4v3.pth realesr-general-x4v3-dn05.onnx realesr-general-wdn-x4v3.pth 0.5
# (the same 50/50 mix as the official --denoise_strength 0.5 default). Weights: github.com/xinntao/Real-ESRGAN releases v0.2.5.0.
import sys, zipfile, pickle, numpy as np, onnx
from onnx import helper, TensorProto, numpy_helper

src, dst = sys.argv[1], sys.argv[2]
src2 = sys.argv[3] if len(sys.argv) > 3 else None
strength = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0

class Storage:
    def __init__(self, key, dtype): self.key, self.dtype = key, dtype

def rebuild_tensor(storage, offset, size, stride, *args):
    raw = np.frombuffer(z.read(f"{prefix}/data/{storage.key}"), dtype=storage.dtype)
    return np.lib.stride_tricks.as_strided(raw[offset:], shape=size, strides=[s * raw.itemsize for s in stride]).copy() if size else raw[offset:offset+1].copy()

DT = {"FloatStorage": np.float32, "HalfStorage": np.float16}
class U(pickle.Unpickler):
    def find_class(self, mod, name):
        if name == "_rebuild_tensor_v2": return rebuild_tensor
        if name in DT: return name
        if mod == "collections" and name == "OrderedDict":
            import collections; return collections.OrderedDict
        if name == "_rebuild_parameter": return lambda data, *a: data
        raise RuntimeError(f"unexpected {mod}.{name}")
    def persistent_load(self, pid):
        _, typ, key, loc, numel = pid
        return Storage(key, DT[typ])

def load(path):
    global z, prefix
    z = zipfile.ZipFile(path)
    prefix = z.namelist()[0].split("/")[0]
    d = U(z.open(f"{prefix}/data.pkl")).load()
    return d["params"] if "params" in d else d
sd = load(src)
if src2:
    sd2 = load(src2)
    sd = {k: strength * sd[k] + (1 - strength) * sd2[k] for k in sd}
keys = sorted({int(k.split(".")[1]) for k in sd}, key=int)
print("layers:", len(keys), "first:", list(sd)[:4])

nodes, inits = [], []
x = "input"
for idx in keys:
    w = sd.get(f"body.{idx}.weight"); b = sd.get(f"body.{idx}.bias")
    if w is not None and w.ndim == 4:
        wn, bn = f"w{idx}", f"b{idx}"
        inits += [numpy_helper.from_array(w.astype(np.float32), wn), numpy_helper.from_array(b.astype(np.float32), bn)]
        nodes.append(helper.make_node("Conv", [x, wn, bn], [f"c{idx}"], pads=[1, 1, 1, 1], kernel_shape=[3, 3]))
        x = f"c{idx}"
    elif w is not None:  # PReLU weight [C]
        sn = f"s{idx}"
        inits.append(numpy_helper.from_array(w.astype(np.float32).reshape(-1, 1, 1), sn))
        nodes.append(helper.make_node("PRelu", [x, sn], [f"p{idx}"]))
        x = f"p{idx}"
# PixelShuffle(4): [1,48,H,W] -> [1,3,4H,4W]
nodes.append(helper.make_node("DepthToSpace", [x], ["ps"], blocksize=4, mode="CRD"))
# Add nearest-upsampled input
inits.append(numpy_helper.from_array(np.array([1, 1, 4, 4], dtype=np.float32), "scales"))
nodes.append(helper.make_node("Resize", ["input", "", "scales"], ["up"], mode="nearest"))
nodes.append(helper.make_node("Add", ["ps", "up"], ["output"]))
g = helper.make_graph(nodes, "realesr_general_x4v3",
    [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "h", "w"])],
    [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, "h4", "w4"])], inits)
m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)], producer_name="universal-ai")
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, dst)
print("saved", dst)
