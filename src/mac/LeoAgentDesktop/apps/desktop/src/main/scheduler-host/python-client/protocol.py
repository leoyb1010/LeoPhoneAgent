#!/usr/bin/env python3
"""Cindy Desktop Python client's synchronous cindy-script/1 JSONL transport."""

from __future__ import annotations

import itertools
import json
import os
import sys
from typing import IO, Any

PROTOCOL = "cindy-script/1"
LEGACY_PROTOCOL = "xdt-maker-script/1"
SUPPORTED_PROTOCOLS = {PROTOCOL, LEGACY_PROTOCOL}


class RpcError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if code else message)


class DuplexClient:
    """Writes protocol frames to stdout and reads host responses from stdin."""

    def __init__(self, reader: IO[str] | None = None, writer: IO[str] | None = None):
        self._reader = reader if reader is not None else sys.stdin
        if reader is None and hasattr(self._reader, "reconfigure"):
            # 宿主两个方向都写 UTF-8,但中文 Windows 上 pipe stdin 默认按 locale
            # (cp936)解码:GBK 双字节解码会把中文字节后面的 JSON 转义符 0x5C 吞进
            # 乱码字符,帧随之解析失败(BAD_FRAME)。必须显式改回 UTF-8。
            self._reader.reconfigure(encoding="utf-8")
        self._ids = itertools.count(1)
        self.context: dict[str, Any] = {}
        self._started = False
        self._write_protocol = PROTOCOL
        if writer is not None:
            # 测试 / 显式注入模式:不碰全局 fd。
            self._writer = writer
            self._owns_stdout = False
        else:
            self._writer = sys.stdout
            self._owns_stdout = True
            # Cindy script runner spawn 时带此标记 -> import 即接管,越早越好
            # (后续 import 的三方库在 import 期的 print 也一并改道)。无标记时
            # (老宿主 / 手工调试)推迟到首次协议交互前接管,避免"仅 import 本模块"
            # 就产生全局 fd 副作用。
            if (
                os.environ.get("CINDY_SCRIPT_PROTOCOL") == "1"
                or os.environ.get("XDT_MAKER_SCRIPT_PROTOCOL") == "1"
            ):
                self._hijack_stdout()

    def _hijack_stdout(self) -> None:
        """把真 stdout 的 fd 私有化给协议通道,fd 1 重定向到 stderr。

        宿主对 stdout 是严格 JSONL 契约(任何杂音都会让整轮任务 failed)。接管后,
        脚本本体的 print、三方库的 stdout 输出、乃至所有子进程继承到的 fd 1,全部
        无害地流向 stderr(宿主截留进日志),协议通道只剩本客户端一个写入方。
        """
        if not self._owns_stdout:
            return
        sys.stdout.flush()
        protocol_fd = os.dup(1)
        os.dup2(2, 1)
        self._writer = os.fdopen(protocol_fd, "w", encoding="utf-8", newline="\n")
        self._owns_stdout = False

    def _read_frame(self) -> dict[str, Any]:
        while True:
            line = self._reader.readline()
            if line == "":
                raise RpcError("TRANSPORT_CLOSED", "host closed the script channel")
            if not line.strip():
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                raise RpcError("BAD_FRAME", "host sent a non-JSON protocol frame") from None
            # 新 host 的首帧仍使用旧名称，以便已部署的旧客户端可以启动；新客户端
            # 接受两者，但自己的出站帧一律使用 Cindy 名称完成迁移。
            if frame.get("protocol") not in SUPPORTED_PROTOCOLS:
                raise RpcError("BAD_PROTOCOL", "unsupported script protocol version")
            return frame

    def _ensure_started(self) -> None:
        if self._started:
            return
        self._hijack_stdout()
        frame = self._read_frame()
        if frame.get("type") != "start" or not isinstance(frame.get("context"), dict):
            raise RpcError("BAD_FRAME", "expected the host start frame")
        # 当前 host 用 CINDY_SCRIPT_PROTOCOL 明示支持新名称；只有旧标记或手工
        # 接入时跟随 start 帧，保证新版客户端复制到旧版 host 也仍可工作。
        self._write_protocol = (
            PROTOCOL
            if os.environ.get("CINDY_SCRIPT_PROTOCOL") == "1"
            else frame["protocol"]
        )
        self.context = frame["context"]
        self._started = True

    def call(self, method: str, params: dict, timeout: int = 30) -> Any:
        del timeout  # Whole-run and host-call timeouts are enforced by Cindy.
        self._ensure_started()
        request_id = f"py-{next(self._ids)}"
        self._write_frame({
            "type": "call",
            "id": request_id,
            "method": method,
            "params": params,
        })
        while True:
            response = self._read_frame()
            if response.get("type") != "call_result" or response.get("id") != request_id:
                raise RpcError("BAD_FRAME", "unexpected host response frame")
            if response.get("ok") is True:
                return response.get("result")
            error = response.get("error") if isinstance(response.get("error"), dict) else {}
            raise RpcError(error.get("code", "INTERNAL"), error.get("message", "host call failed"))

    def emit_complete(self, result_text: str, primary_session_id: str | None = None) -> None:
        self._ensure_started()
        self._write_frame({
            "type": "complete",
            "resultText": result_text,
            "primarySessionId": primary_session_id,
        })

    def _write_frame(self, frame: dict[str, Any]) -> None:
        self._writer.write(
            json.dumps({"protocol": self._write_protocol, **frame}, ensure_ascii=False) + "\n"
        )
        self._writer.flush()
