"""Single-file MDX ONNX adapter using UVR hash metadata and CPU spectral DSP."""

import os
import sys

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import argparse
import contextlib
import hashlib
import json
import math
from pathlib import Path
import time


def uvr_hash(path):
    """UVR ModelData.get_model_hash: MD5 of the last 10000 KiB (or all)."""
    with path.open("rb") as stream:
        stream.seek(-min(path.stat().st_size, 10000 * 1024), os.SEEK_END)
        return hashlib.md5(stream.read()).hexdigest()


def model_parameters(model, metadata):
    model_hash = uvr_hash(model)
    data = json.loads(metadata.read_text(encoding="utf-8-sig"))
    params = data.get(model_hash)
    if not isinstance(params, dict):
        raise ValueError(f"Model hash not found in metadata: {model_hash}")
    for key in ("mdx_dim_f_set", "mdx_dim_t_set", "mdx_n_fft_scale_set"):
        value = params.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"Invalid model metadata field: {key}")
    compensate = params.get("compensate")
    if isinstance(compensate, bool) or not isinstance(compensate, (float, int)):
        raise ValueError("Invalid model compensate")
    if not math.isfinite(compensate) or compensate <= 0:
        raise ValueError("Model compensate must be positive and finite")
    if params.get("primary_stem") not in ("Instrumental", "Vocals"):
        raise ValueError("Only Instrumental/Vocals primary stems are supported")
    n_fft = params["mdx_n_fft_scale_set"]
    if params["mdx_dim_f_set"] > n_fft // 2 + 1 or n_fft % 2:
        raise ValueError("Inconsistent MDX frequency dimensions")
    if not 1 <= params["mdx_dim_t_set"] <= 16:
        raise ValueError("Unsupported MDX time dimension")
    return model_hash, params


def make_session(ort, model, device, device_id):
    required = "DmlExecutionProvider" if device == "directml" else "CPUExecutionProvider"
    if required not in ort.get_available_providers():
        raise RuntimeError(f"Requested provider unavailable: {required}")
    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_mem_pattern = False
    providers = (
        [("DmlExecutionProvider", {"device_id": str(device_id)}), "CPUExecutionProvider"]
        if device == "directml" else ["CPUExecutionProvider"]
    )
    session = ort.InferenceSession(str(model), sess_options=options, providers=providers)
    # CPU nodes within a DML graph remain permitted, but a failed run must not
    # silently recreate the entire session on a fallback provider.
    session.disable_fallback()
    active = session.get_providers()
    if not active or active[0] != required:
        raise RuntimeError(f"Requested {required}, session activated {active}")
    return session, (f"DmlExecutionProvider:{device_id}" if device == "directml" else required)


def check_tensor_info(info, expected):
    if info.type != "tensor(float)" or len(info.shape) != len(expected):
        raise ValueError(f"Unexpected ONNX tensor type/shape: {info.type} {info.shape}")
    for actual, wanted in zip(info.shape, expected):
        if isinstance(actual, int) and actual != wanted:
            raise ValueError(f"Model tensor shape {info.shape} conflicts with metadata {expected}")


def separate(mix, session, params, spectral, np, torch, overlap=0.25, denoise=False):
    """UVR-style Hann overlap/add, batch one, no TTA or additional denoiser."""
    chunk_size = spectral.chunk_size
    trim = spectral.n_fft // 2
    gen_size = chunk_size - 2 * trim
    if gen_size <= 0:
        raise ValueError("MDX chunk size is smaller than spectral padding")
    frames = mix.shape[1]
    pad = gen_size + trim - (frames % gen_size)
    mixture = np.pad(mix, ((0, 0), (trim, pad)))
    # Explicit adapter overlap; not inferred from a model filename.
    step = int((1.0-overlap) * chunk_size)
    result = np.zeros_like(mixture)
    divider = np.zeros(mixture.shape[1], dtype=np.float32)
    input_info = session.get_inputs()
    output_info = session.get_outputs()
    expected = (1, 4, spectral.dim_f, spectral.dim_t)
    if len(input_info) != 1 or len(output_info) != 1:
        raise ValueError("The adapter requires one ONNX input and one output")
    check_tensor_info(input_info[0], expected)
    check_tensor_info(output_info[0], expected)
    with torch.no_grad():
        for start in range(0, mixture.shape[1], step):
            end = min(start + chunk_size, mixture.shape[1])
            actual_size = end - start
            chunk = np.pad(mixture[:, start:end], ((0, 0), (0, chunk_size - actual_size)))
            spec = spectral.stft(torch.from_numpy(chunk[None].copy()))
            spec[:, :, :3, :] = 0
            feed = np.ascontiguousarray(spec.numpy(), dtype=np.float32)
            if feed.shape != expected:
                raise RuntimeError(f"Unexpected CPU STFT shape: {feed.shape}")
            prediction = session.run([output_info[0].name], {input_info[0].name: feed})[0]
            if denoise:
                negative = session.run([output_info[0].name], {input_info[0].name: -feed})[0]
                prediction = (prediction-negative)*0.5
            if prediction.shape != expected or not np.isfinite(prediction).all():
                raise RuntimeError(f"Invalid ONNX output: {prediction.shape}")
            wave = spectral.istft(torch.from_numpy(np.ascontiguousarray(prediction)))[0].numpy()
            if wave.shape != (2, chunk_size) or not np.isfinite(wave).all():
                raise RuntimeError(f"Invalid iSTFT output: {wave.shape}")
            window = np.hanning(actual_size).astype(np.float32)
            result[:, start:end] += wave[:, :actual_size] * window
            divider[start:end] += window
    # Hann's zero endpoints lie outside the returned real audio span.
    wanted_weights = divider[trim:trim + frames]
    if len(wanted_weights) != frames or np.any(wanted_weights <= 0):
        raise RuntimeError("Overlap/add left uncovered output samples")
    source = result[:, trim:trim + frames] / wanted_weights
    source *= np.float32(params["compensate"])
    if source.shape != mix.shape or not np.isfinite(source).all():
        raise RuntimeError("Separated source has invalid dimensions or nonfinite values")
    return source


def run(args):
    started = time.perf_counter()
    root = args.root.resolve(strict=True)
    if not root.is_dir() or not (root / "tools/uvr5/mdxnet.py").is_file():
        raise ValueError("--root must contain tools/uvr5/mdxnet.py")
    paths = [path.resolve(strict=True) for path in (args.model, args.metadata, args.input)]
    model, metadata, audio_input = paths
    for path in paths:
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(f"Expected nonempty regular file: {path}")
    if args.device_id < 0:
        raise ValueError("--device-id must be nonnegative")
    model_hash, params = model_parameters(model, metadata)
    if args.compensate is not None:
        if not math.isfinite(args.compensate) or not 0.5 <= args.compensate <= 2:
            raise ValueError('Compensate must be between 0.5 and 2')
        params = {**params, 'compensate': args.compensate}
    output_dir = args.output_dir.resolve()
    for forbidden in (root, model.parent):
        if output_dir == forbidden or forbidden in output_dir.parents:
            raise ValueError("Output directory must be outside the RVC/UVR installations")
    vocals_path = output_dir / f"{audio_input.stem}_Vocals.wav"
    instrumental_path = output_dir / f"{audio_input.stem}_Instrumental.wav"
    if vocals_path.exists() or instrumental_path.exists():
        raise FileExistsError("Expected outputs already exist; use a fresh output directory")
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = output_dir / ".mdx-runtime"
    cache_dir.mkdir(exist_ok=True)
    for variable, suffix in (("NUMBA_CACHE_DIR", "numba"), ("LIBROSA_CACHE_DIR", "librosa"), ("TORCH_HOME", "torch")):
        os.environ[variable] = str(cache_dir / suffix)
    os.environ["TEMP"] = os.environ["TMP"] = str(cache_dir)
    import tempfile
    tempfile.tempdir = str(cache_dir)
    sys.path.insert(0, str(root))
    previous_cwd = Path.cwd()
    try:
        # Any relative dependency cache is kept under the authorized output.
        os.chdir(output_dir)
        with contextlib.redirect_stdout(sys.stderr):
            import numpy as np
            import torch
            import librosa
            import soundfile as sf
            import onnxruntime as ort
            from tools.uvr5.mdxnet import ConvTDFNetTrim

            mix, sr = librosa.load(str(audio_input), sr=44100, mono=False, dtype=np.float32)
            if mix.ndim == 1:
                mix = np.stack((mix, mix))
            if mix.ndim != 2 or mix.shape[0] != 2 or mix.shape[1] == 0 or not np.isfinite(mix).all():
                raise ValueError("Input must decode to finite mono/stereo audio with nonzero duration")
            mix = np.ascontiguousarray(mix, dtype=np.float32)
            spectral = ConvTDFNetTrim(torch.device("cpu"), "Conv-TDF", "vocals", 11,
                                      params["mdx_dim_f_set"], params["mdx_dim_t_set"],
                                      params["mdx_n_fft_scale_set"], hop=1024)
            session, actual_device = make_session(ort, model, args.device, args.device_id)
            source = separate(mix, session, params, spectral, np, torch, args.overlap, args.denoise)
            instrumental = source if params["primary_stem"] == "Instrumental" else mix - source
            vocals = mix - instrumental
            # Float WAV retains the residual relation and avoids PCM clipping.
            for path, audio in ((vocals_path, vocals), (instrumental_path, instrumental)):
                if path.exists():
                    raise FileExistsError(f"Output appeared during processing: {path}")
                sf.write(str(path), audio.T, int(sr), subtype="FLOAT")
                info = sf.info(str(path))
                if info.frames != mix.shape[1] or info.samplerate != 44100 or info.channels != 2:
                    raise RuntimeError(f"Output dimensions are inconsistent: {path}")
    finally:
        os.chdir(previous_cwd)
    return {"vocals": str(vocals_path), "instrumental": str(instrumental_path),
            "device": actual_device, "elapsed": round(time.perf_counter() - started, 3),
            "modelHash": model_hash, "primaryStem": params["primary_stem"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("root", "model", "metadata", "input", "output-dir"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--device", required=True, choices=("directml", "cpu"))
    parser.add_argument("--device-id", type=int, default=0)
    parser.add_argument("--overlap", type=float, choices=(0.25,0.5,0.75), default=0.25)
    parser.add_argument("--denoise", action="store_true")
    parser.add_argument("--compensate", type=float, default=None)
    args = parser.parse_args()
    try:
        result = run(args)
    except Exception as exc:
        print(json.dumps({"error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
