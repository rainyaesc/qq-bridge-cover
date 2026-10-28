#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""RVC 单文件推理 CLI（给 qq-bridge 的本地 TTS 用）。

为什么自己写：这套 RVC 发行版只有 webui.py，没有 infer_cli.py。这里直接调用它
自带的 `infer.modules.vc.modules.VC`，避免去驱动 Gradio 界面。

用法：
  runtime\\python.exe rvc_infer.py --root <RVC根目录> --model <权重.pth> \
      --input <in.wav> --output <out.wav> [--index <x.index>] [--pitch 0] \
      [--f0-method rmvpe] [--index-rate 0.66] [--protect 0.33]

成功时 stdout 打印一行 JSON：{"ok": true, "sr": 40000, "seconds": 3.2}
失败时打印 {"ok": false, "error": "..."} 并以退出码 1 结束。
"""
import argparse
import json
import os
import sys
import traceback


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="RVC 根目录（含 configs/、infer/）")
    ap.add_argument("--model", required=True, help="模型权重 .pth 路径")
    ap.add_argument("--input", required=True, help="输入音频路径")
    ap.add_argument("--output", required=True, help="输出 wav 路径")
    ap.add_argument("--index", default="", help="检索索引 .index（可空）")
    ap.add_argument("--pitch", type=int, default=0, help="变调（半音）")
    ap.add_argument("--f0-method", default="rmvpe", help="音高提取方法")
    ap.add_argument("--index-rate", type=float, default=0.66)
    ap.add_argument("--protect", type=float, default=0.33)
    ap.add_argument("--rms-mix-rate", type=float, default=1.0)
    ap.add_argument("--resample-sr", type=int, default=0)
    args = ap.parse_args()

    for label, path in (("model", args.model), ("input", args.input)):
        if not os.path.exists(path):
            print(json.dumps({"ok": False, "error": f"{label} 不存在：{path}"}, ensure_ascii=False))
            return 1

    sys.path.insert(0, args.root)
    os.chdir(args.root)
    # configs/config.py 在**导入期**就 argparse.parse_args()，会把我们自己的
    # --model/--input 当成非法参数直接退出。导入前先把 argv 清空成只有程序名。
    _argv_backup = sys.argv
    sys.argv = [sys.argv[0]]

    try:
        import soundfile as sf
        from configs.config import Config
        # 这套发行版的包路径是 infer.vc（不是标准 RVC 的 infer.modules.vc）
        from infer.vc.modules import VC

        config = Config()
        vc = VC(config)
        # get_vc 内部用 f'{os.getenv("weight_root")}/{sid}' 拼路径（webui 靠环境变量传根目录），
        # 所以这里把权重目录塞进环境变量、只传文件名。
        model_abs = os.path.abspath(args.model)
        os.environ["weight_root"] = os.path.dirname(model_abs)
        # 推理链路还依赖两个环境变量：rmvpe 音高模型目录、检索索引目录。
        # 缺 rmvpe_root 会在 get_f0 里直接 KeyError（webui 启动时替我们设的）。
        os.environ.setdefault("rmvpe_root", os.path.join(args.root, "assets", "rmvpe"))
        os.environ.setdefault("index_root", os.path.join(args.root, "assets", "indices"))
        os.environ.setdefault("outside_index_root", os.path.join(args.root, "assets", "indices"))
        vc.get_vc(os.path.basename(model_abs))

        index_path = args.index if args.index and os.path.exists(args.index) else None
        if index_path is None:
            # 没有可用索引时 index_rate 必须归零，否则内部会去读 None
            index_rate = 0.0
        else:
            index_rate = args.index_rate

        status, audio = vc.vc_single(
            0,
            args.input,
            args.pitch,
            args.f0_method,
            index_path,
            index_rate,
            args.resample_sr,
            args.rms_mix_rate,
            args.protect,
        )

        if not isinstance(audio, tuple) or len(audio) != 2 or audio[1] is None:
            print(json.dumps({"ok": False, "error": str(status)}, ensure_ascii=False))
            return 1

        sr, data = audio
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        sf.write(args.output, data, int(sr))
        seconds = round(float(len(data)) / float(sr), 2) if sr else None
        print(json.dumps({"ok": True, "sr": int(sr), "seconds": seconds}, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"ok": False, "error": traceback.format_exc()[-1500:]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
