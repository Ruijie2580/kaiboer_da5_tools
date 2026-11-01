#!/usr/bin/env python3
"""开博尔 DA5 硬件均衡器。

DA5（USB VID 3302 / PID 4351）的播放走 Windows 自带的 USB Audio 2.0。
音量键和均衡都在同一路 HID 上，报告号 0x4B，由声卡里的 DSP 执行。
直接运行会在本机打开网页，由 Edge 或 Chrome 通过 WebHID 连接声卡。
这个程序不替换声卡驱动。改完之后，电脑、手机上的所有播放都会经过它。
"""

from __future__ import annotations

import argparse
import ctypes
import math
import sys
import time
import uuid
from ctypes import wintypes
from dataclasses import dataclass

VENDOR_ID = 0x3302
PRODUCT_ID = 0x4351
REPORT_ID = 0x4B
REPORT_BYTES = 64
BAND_COUNT = 10
SAMPLE_RATE = 96000

READ = 0x80
WRITE = 0x01
CMD_FLASH = 0x01
CMD_GAIN = 0x03
CMD_PEQ = 0x09
CMD_TEMP = 0x0A
CMD_VERSION = 0x0C

TYPE_TO_BYTE = {"LSQ": 1, "PK": 2, "HSQ": 3, "LP": 4, "HP": 5}
BYTE_TO_TYPE = {value: key for key, value in TYPE_TO_BYTE.items()}
TYPE_LABELS = {
    "PK": "峰值",
    "LSQ": "低架",
    "HSQ": "高架",
    "LP": "低通",
    "HP": "高通",
}

DEFAULT_Q = 0.707


@dataclass
class Band:
    type: str = "PK"
    freq: int = 1000
    gain: float = 0.0
    q: float = DEFAULT_Q

    def clamped(self) -> "Band":
        freq = min(20000, max(20, int(round(self.freq))))
        gain = min(12.0, max(-12.0, float(self.gain)))
        q = min(10.0, max(0.1, float(self.q)))
        kind = self.type if self.type in TYPE_TO_BYTE else "PK"
        return Band(kind, freq, gain, q)


def design(kind: str, freq: float, gain_db: float, q: float, fs: float = SAMPLE_RATE):
    """RBJ biquad. Returns b0, b1, b2, a1, a2 with a0 normalized to 1."""
    kind = kind if kind in TYPE_TO_BYTE else "PK"
    amp = 10 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * freq / fs
    cos_w = math.cos(w0)
    sin_w = math.sin(w0)
    if kind in ("LSQ", "HSQ"):
        shelf = max(0.0, (amp + 1.0 / amp) * (1.0 / q - 1.0) + 2.0)
        alpha = sin_w / 2.0 * math.sqrt(shelf)
    else:
        alpha = sin_w / (2.0 * q)

    if kind == "PK":
        b0 = 1 + alpha * amp
        b1 = -2 * cos_w
        b2 = 1 - alpha * amp
        a0 = 1 + alpha / amp
        a1 = -2 * cos_w
        a2 = 1 - alpha / amp
    elif kind == "LSQ":
        sqrt_a = math.sqrt(amp)
        b0 = amp * ((amp + 1) - (amp - 1) * cos_w + 2 * sqrt_a * alpha)
        b1 = 2 * amp * ((amp - 1) - (amp + 1) * cos_w)
        b2 = amp * ((amp + 1) - (amp - 1) * cos_w - 2 * sqrt_a * alpha)
        a0 = (amp + 1) + (amp - 1) * cos_w + 2 * sqrt_a * alpha
        a1 = -2 * ((amp - 1) + (amp + 1) * cos_w)
        a2 = (amp + 1) + (amp - 1) * cos_w - 2 * sqrt_a * alpha
    elif kind == "HSQ":
        sqrt_a = math.sqrt(amp)
        b0 = amp * ((amp + 1) + (amp - 1) * cos_w + 2 * sqrt_a * alpha)
        b1 = -2 * amp * ((amp - 1) + (amp + 1) * cos_w)
        b2 = amp * ((amp + 1) + (amp - 1) * cos_w - 2 * sqrt_a * alpha)
        a0 = (amp + 1) - (amp - 1) * cos_w + 2 * sqrt_a * alpha
        a1 = 2 * ((amp - 1) - (amp + 1) * cos_w)
        a2 = (amp + 1) - (amp - 1) * cos_w - 2 * sqrt_a * alpha
    elif kind == "LP":
        b0 = (1 - cos_w) / 2
        b1 = 1 - cos_w
        b2 = (1 - cos_w) / 2
        a0 = 1 + alpha
        a1 = -2 * cos_w
        a2 = 1 - alpha
    else:
        b0 = (1 + cos_w) / 2
        b1 = -(1 + cos_w)
        b2 = (1 + cos_w) / 2
        a0 = 1 + alpha
        a1 = -2 * cos_w
        a2 = 1 - alpha
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


def _q30(value: float) -> int:
    return int(round(value * (1 << 30))) & 0xFFFFFFFF


def _le(value: int, length: int) -> list[int]:
    value = int(value) & ((1 << (8 * length)) - 1)
    return [(value >> (8 * i)) & 0xFF for i in range(length)]


def filter_packet(index: int, band: Band, slot: int) -> list[int]:
    band = band.clamped()
    b0, b1, b2, a1, a2 = design(band.type, band.freq, band.gain, band.q)
    words = [_q30(b0), _q30(b1), _q30(b2), _q30(-a1), _q30(-a2)]
    coeffs = [byte for word in words for byte in _le(word, 4)]
    gain_q8 = int(round(band.gain * 256)) & 0xFFFF
    return (
        [WRITE, CMD_PEQ, 0x18, 0x00, index & 0xFF, 0x00, 0x00]
        + coeffs
        + _le(band.freq, 2)
        + _le(int(round(band.q * 256)), 2)
        + _le(gain_q8, 2)
        + [TYPE_TO_BYTE[band.type], 0x00, slot & 0xFF, 0x00]
    )


def parse_band(report: bytes) -> Band:
    payload = report[1:]
    freq = payload[27] | (payload[28] << 8)
    q = (payload[29] | (payload[30] << 8)) / 256.0
    gain_raw = payload[31] | (payload[32] << 8)
    if gain_raw >= 0x8000:
        gain_raw -= 0x10000
    kind = BYTE_TO_TYPE.get(payload[33], "PK")
    return Band(kind, freq, gain_raw / 256.0, q)


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
hid = ctypes.WinDLL("hid", use_last_error=True)
setupapi = ctypes.WinDLL("setupapi", use_last_error=True)

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 1
FILE_SHARE_WRITE = 2
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
DIGCF_PRESENT = 0x02
DIGCF_DEVICEINTERFACE = 0x10
INVALID_HANDLE = ctypes.c_void_p(-1).value


class SP_DEVICE_INTERFACE_DATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("InterfaceClassGuid", ctypes.c_byte * 16),
        ("Flags", wintypes.DWORD),
        ("Reserved", ctypes.c_void_p),
    ]


class OVERLAPPED(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_void_p),
        ("InternalHigh", ctypes.c_void_p),
        ("Offset", wintypes.DWORD),
        ("OffsetHigh", wintypes.DWORD),
        ("hEvent", wintypes.HANDLE),
    ]


setupapi.SetupDiGetClassDevsW.restype = ctypes.c_void_p
setupapi.SetupDiGetClassDevsW.argtypes = [
    ctypes.c_void_p, wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD
]
setupapi.SetupDiEnumDeviceInterfaces.argtypes = [
    ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
    ctypes.POINTER(SP_DEVICE_INTERFACE_DATA),
]
setupapi.SetupDiEnumDeviceInterfaces.restype = wintypes.BOOL
setupapi.SetupDiGetDeviceInterfaceDetailW.argtypes = [
    ctypes.c_void_p, ctypes.POINTER(SP_DEVICE_INTERFACE_DATA),
    ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
]
setupapi.SetupDiGetDeviceInterfaceDetailW.restype = wintypes.BOOL
setupapi.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]
setupapi.SetupDiDestroyDeviceInfoList.restype = wintypes.BOOL
kernel32.CreateFileW.restype = wintypes.HANDLE
kernel32.CreateFileW.argtypes = [
    wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
    wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
]
kernel32.CreateEventW.restype = wintypes.HANDLE
kernel32.CreateEventW.argtypes = [
    ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR
]
kernel32.ReadFile.argtypes = [
    wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OVERLAPPED),
]
kernel32.ReadFile.restype = wintypes.BOOL
kernel32.GetOverlappedResult.argtypes = [
    wintypes.HANDLE, ctypes.POINTER(OVERLAPPED),
    ctypes.POINTER(wintypes.DWORD), wintypes.BOOL,
]
kernel32.GetOverlappedResult.restype = wintypes.BOOL
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.WaitForSingleObject.restype = wintypes.DWORD
kernel32.CancelIo.argtypes = [wintypes.HANDLE]
kernel32.CancelIo.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
hid.HidD_SetOutputReport.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.ULONG]
hid.HidD_SetOutputReport.restype = wintypes.BOOL
hid.HidD_SetNumInputBuffers.argtypes = [wintypes.HANDLE, wintypes.ULONG]
hid.HidD_SetNumInputBuffers.restype = wintypes.BOOL
hid.HidD_GetProductString.argtypes = [wintypes.HANDLE, ctypes.c_wchar_p, wintypes.ULONG]
hid.HidD_GetProductString.restype = wintypes.BOOL


def hid_path() -> str:
    guid = ctypes.create_string_buffer(uuid.UUID("{4d1e55b2-f16f-11cf-88cb-001111000030}").bytes_le)
    info = setupapi.SetupDiGetClassDevsW(
        ctypes.cast(guid, ctypes.c_void_p), None, None,
        DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
    )
    if not info or info == INVALID_HANDLE:
        raise OSError("无法枚举 HID 设备")
    try:
        index = 0
        while True:
            data = SP_DEVICE_INTERFACE_DATA()
            data.cbSize = ctypes.sizeof(SP_DEVICE_INTERFACE_DATA)
            if not setupapi.SetupDiEnumDeviceInterfaces(
                info, None, ctypes.cast(guid, ctypes.c_void_p), index, ctypes.byref(data)
            ):
                break
            needed = wintypes.DWORD(0)
            setupapi.SetupDiGetDeviceInterfaceDetailW(
                info, ctypes.byref(data), None, 0, ctypes.byref(needed), None
            )
            buffer = ctypes.create_string_buffer(needed.value)
            ctypes.cast(buffer, ctypes.POINTER(wintypes.DWORD))[0] = 8
            if not setupapi.SetupDiGetDeviceInterfaceDetailW(
                info, ctypes.byref(data), buffer, needed.value, ctypes.byref(needed), None
            ):
                index += 1
                continue
            path = ctypes.wstring_at(ctypes.addressof(buffer) + 4)
            lowered = path.lower()
            if f"vid_{VENDOR_ID:04x}" in lowered and f"pid_{PRODUCT_ID:04x}" in lowered:
                return path
            index += 1
    finally:
        setupapi.SetupDiDestroyDeviceInfoList(info)
    raise FileNotFoundError("没有找到开博尔 DA5。请确认它已经插上，并且 Windows 里能看到“扬声器 (DA5)”。")


class Da5:
    def __init__(self) -> None:
        self._handle = None

    def __enter__(self) -> "Da5":
        path = hid_path()
        handle = kernel32.CreateFileW(
            path, GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None,
        )
        if not handle or handle == INVALID_HANDLE:
            error = ctypes.get_last_error()
            raise OSError(f"无法打开 DA5 的控制接口（Windows 错误 {error}）")
        hid.HidD_SetNumInputBuffers(handle, 64)
        self._handle = handle
        self._drain(0.05)
        return self

    def __exit__(self, *_args) -> None:
        if self._handle:
            kernel32.CloseHandle(self._handle)
            self._handle = None

    def _read(self, timeout_ms: int) -> bytes | None:
        event = kernel32.CreateEventW(None, True, False, None)
        if not event:
            raise OSError("CreateEvent 失败")
        try:
            overlapped = OVERLAPPED()
            overlapped.hEvent = event
            buffer = ctypes.create_string_buffer(REPORT_BYTES)
            read = wintypes.DWORD(0)
            ok = kernel32.ReadFile(
                self._handle, buffer, REPORT_BYTES, ctypes.byref(read), ctypes.byref(overlapped)
            )
            if not ok:
                error = ctypes.get_last_error()
                if error != 997:
                    return None
                if kernel32.WaitForSingleObject(event, timeout_ms) != 0:
                    kernel32.CancelIo(self._handle)
                    kernel32.WaitForSingleObject(event, 50)
                    return None
                if not kernel32.GetOverlappedResult(
                    self._handle, ctypes.byref(overlapped), ctypes.byref(read), False
                ):
                    return None
            return bytes(buffer)[: read.value]
        finally:
            kernel32.CloseHandle(event)

    def _drain(self, seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self._read(20) is None:
                return

    def write(self, payload: list[int]) -> None:
        buffer = (ctypes.c_ubyte * REPORT_BYTES)()
        buffer[0] = REPORT_ID
        for index, value in enumerate(payload[: REPORT_BYTES - 1]):
            buffer[index + 1] = value & 0xFF
        ok = hid.HidD_SetOutputReport(
            self._handle, ctypes.cast(buffer, ctypes.c_void_p), REPORT_BYTES
        )
        if not ok:
            error = ctypes.get_last_error()
            raise OSError(f"写入 DA5 失败（Windows 错误 {error}）")

    def request(self, payload: list[int], command: int, timeout: float = 1.5) -> bytes:
        self.write(payload)
        deadline = time.time() + timeout
        while time.time() < deadline:
            report = self._read(200)
            if report and report[0] == REPORT_ID and len(report) > 2 and report[2] == command:
                return report
        raise TimeoutError(f"DA5 没有回应命令 0x{command:02X}")

    def firmware(self) -> str:
        report = self.request([READ, CMD_VERSION, 0x00], CMD_VERSION)
        text = bytes(report[4:8]).split(b"\x00", 1)[0]
        return text.decode("ascii", errors="replace") or "未知"

    def read_preamp(self) -> int:
        report = self.request([READ, CMD_GAIN, 0x00], CMD_GAIN)
        raw = report[5]
        return raw - 256 if raw > 127 else raw

    def read_bands(self) -> list[Band]:
        self._drain(0.05)
        bands: list[Band] = []
        for index in range(BAND_COUNT):
            band = None
            for _attempt in range(3):
                self.write([READ, CMD_PEQ, 0x00, 0x00, index, 0x00])
                deadline = time.time() + 0.8
                while time.time() < deadline:
                    report = self._read(200)
                    if not report or report[0] != REPORT_ID or len(report) < 36 or report[2] != CMD_PEQ:
                        continue
                    if report[5] == index:
                        band = parse_band(report)
                        break
                if band is not None:
                    break
            if band is None:
                raise TimeoutError(f"没有读到第 {index + 1} 段")
            bands.append(band)
        return bands

    def write_profile(self, bands: list[Band], preamp: int, slot: int = 0) -> None:
        if len(bands) != BAND_COUNT:
            raise ValueError(f"DA5 需要正好 {BAND_COUNT} 段")
        preamp = max(-20, min(6, int(round(preamp))))
        for index, band in enumerate(bands):
            self.write(filter_packet(index, band, slot))
            time.sleep(0.02)
        time.sleep(0.08)
        self.write([WRITE, CMD_GAIN, 0x02, 0x00, preamp & 0xFF])
        time.sleep(0.05)
        for payload, pause in (
            ([WRITE, 0x05, 0x00], 0.02),
            ([WRITE, 0x17, 0x00], 0.02),
            ([WRITE, CMD_TEMP, 0x04, 0x00, 0x00, 0xFF, 0xFF, 0x00], 0.05),
            ([WRITE, CMD_FLASH, 0x00], 0.08),
            ([WRITE, CMD_FLASH, 0x01, slot & 0xFF, 0x00], 0.12),
        ):
            self.write(payload)
            time.sleep(pause)
        self._drain(0.15)

    def set_enabled(self, enabled: bool, slot: int = 0) -> None:
        if enabled:
            self.write([WRITE, CMD_FLASH, 0x01, slot & 0xFF, 0x00])
        else:
            self.write([WRITE, CMD_FLASH, 0x00, 0x00, 0x00])
        time.sleep(0.05)


def format_bands(bands: list[Band], preamp: int) -> str:
    lines = [f"前级 {preamp:+d} dB"]
    for index, band in enumerate(bands, start=1):
        lines.append(
            f"{index:2d}  {TYPE_LABELS.get(band.type, band.type):<4}  "
            f"{band.freq:5d} Hz   {band.gain:+5.1f} dB   Q {band.q:.2f}"
        )
    return "\n".join(lines)


def read_device() -> tuple[str, int, list[Band]]:
    with Da5() as device:
        return device.firmware(), device.read_preamp(), device.read_bands()


def roundtrip() -> str:
    """Write the current curve back, nudge one band, then restore it."""
    with Da5() as device:
        firmware = device.firmware()
        preamp = device.read_preamp()
        original = device.read_bands()
        device.write_profile(original, preamp)
        echoed_preamp = device.read_preamp()
        echoed = device.read_bands()
        problems = []
        if echoed_preamp != preamp:
            problems.append(f"前级读回 {echoed_preamp}，写入的是 {preamp}")
        for index, (before, after) in enumerate(zip(original, echoed)):
            if after.type != before.type or after.freq != before.freq:
                problems.append(f"第 {index + 1} 段类型或频率不一致")
            if abs(after.gain - before.gain) > 0.05 or abs(after.q - before.q) > 0.02:
                problems.append(
                    f"第 {index + 1} 段读回 {after.gain:+.2f} dB Q {after.q:.3f}，"
                    f"原来是 {before.gain:+.2f} dB Q {before.q:.3f}"
                )
        nudged = [Band(band.type, band.freq, band.gain, band.q) for band in original]
        nudged[0] = Band(nudged[0].type, nudged[0].freq, nudged[0].gain + 1.0, nudged[0].q).clamped()
        try:
            device.write_profile(nudged, preamp)
            changed = device.read_bands()
            if abs(changed[0].gain - nudged[0].gain) > 0.05:
                problems.append(
                    f"增益没有写进去：期望 {nudged[0].gain:+.1f} dB，读回 {changed[0].gain:+.1f} dB"
                )
        finally:
            device.write_profile(original, preamp)
            restored = device.read_bands()
            if abs(restored[0].gain - original[0].gain) > 0.05:
                problems.append("恢复原始均衡失败，请在程序里再写入一次“直通”")
        if problems:
            raise RuntimeError("；".join(problems))
        return (
            f"固件 {firmware}。10 段已原样写回，第 1 段 +1 dB 读写成功，并已恢复。"
            f"\n当前前级 {preamp:+d} dB。\n" + format_bands(original, preamp)
        )


def _utf8_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if not reconfigure:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def _chromium_browsers() -> list[str]:
    import os

    roots = [
        os.environ.get(name, "")
        for name in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")
    ]
    relative = (
        ("Microsoft", "Edge", "Application", "msedge.exe"),
        ("Google", "Chrome", "Application", "chrome.exe"),
    )
    found: list[str] = []
    for parts in relative:
        for root in roots:
            if not root:
                continue
            path = os.path.join(root, *parts)
            if os.path.isfile(path) and path not in found:
                found.append(path)
    return found


def _open_app(url: str) -> None:
    import subprocess
    import webbrowser

    for exe in _chromium_browsers():
        try:
            subprocess.Popen([exe, f"--app={url}", "--window-size=1240,900"])
            return
        except OSError:
            continue
    webbrowser.open(url)


def serve_web(open_browser: bool = True) -> int:
    """Serve the WebHID page on 127.0.0.1. Edge or Chrome talks to the DA5."""
    import os
    import threading
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    _utf8_stdio()
    web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
    if not os.path.isfile(os.path.join(web_dir, "index.html")):
        print(f"找不到网页：{web_dir}", file=sys.stderr)
        return 1

    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=web_dir, **kwargs)

        def guess_type(self, path: str) -> str:
            if path.endswith(".js"):
                return "text/javascript"
            if path.endswith(".css"):
                return "text/css"
            return super().guess_type(path)

        def end_headers(self) -> None:
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
            try:
                status = int(code)
            except (TypeError, ValueError):
                status = 0
            if status >= 400:
                super().log_request(code, size)

    class Server(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    host = "127.0.0.1"
    server = None
    port = 0
    for candidate in range(8755, 8765):
        try:
            server = Server((host, candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        print("8755 到 8764 这些端口都已被占用。", file=sys.stderr)
        return 1

    url = f"http://{host}:{port}/"
    print(f"DA5 均衡页面：{url}")
    print("请用 Edge 或 Chrome。点「连接声卡」，在弹出的列表里选 DA5。")
    print("Firefox 和 Safari 不能直接访问 HID。关掉这个窗口，页面就会停。")

    if open_browser:
        opener = threading.Timer(0.3, lambda: _open_app(url))
        opener.daemon = True
        opener.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n页面已关闭。")
    finally:
        server.server_close()
    return 0


def main(argv: list[str] | None = None) -> int:
    _utf8_stdio()
    parser = argparse.ArgumentParser(description="调节开博尔 DA5 声卡内部的 10 段均衡")
    parser.add_argument("--read", action="store_true", help="读取当前均衡并打印")
    parser.add_argument("--roundtrip", action="store_true", help="写回当前曲线，试写 +1 dB，然后恢复")
    parser.add_argument("--no-open", action="store_true", help="只在本机提供网页，不自动打开浏览器")
    args = parser.parse_args(argv)
    try:
        if args.roundtrip:
            print(roundtrip())
            return 0
        if args.read:
            firmware, preamp, bands = read_device()
            print(f"固件 {firmware}")
            print(format_bands(bands, preamp))
            return 0
    except Exception as error:
        print(f"错误：{error}", file=sys.stderr)
        return 1
    return serve_web(open_browser=not args.no_open)


if __name__ == "__main__":
    raise SystemExit(main())
