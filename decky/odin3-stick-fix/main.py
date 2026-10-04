# SPDX-License-Identifier: GPL-2.0-or-later
import asyncio
import json
import os
import threading
import time
import uuid
from pathlib import Path

import decky

import stickcal

PRESETS_FILE = Path(decky.DECKY_PLUGIN_SETTINGS_DIR) / "presets.json"
# Hard limits on the input intercept: Steam gets no controller input while it
# is on, so it must end even if the UI disappears.
TEST_MAX_SECONDS = 60
HEARTBEAT_TIMEOUT = 4.0


def _load_store():
    try:
        data = json.loads(PRESETS_FILE.read_text())
        if isinstance(data, dict) and isinstance(data.get("presets"), list):
            return data
    except (OSError, ValueError):
        pass
    return {"presets": [], "active": None}


def _save_store(data):
    PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = PRESETS_FILE.with_name(PRESETS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, PRESETS_FILE)


def _all_presets(store):
    return [dict(p) for p in stickcal.BUILTIN_PRESETS] + [dict(p, builtin=False) for p in store["presets"]]


class Plugin:
    # Class-level defaults: works whether Decky instantiates Plugin or not.
    _lock = threading.RLock()
    _fd = None
    _event = None
    _test_until = 0.0
    _heartbeat = 0.0
    _previewing = False
    _baseline = None

    # ---- helpers (run in worker threads) ----

    def _ensure_fd(self):
        if self._fd is not None:
            return self._fd
        self._fd, self._event = stickcal.open_event()
        return self._fd

    def _close_fd(self):
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
        self._fd = None
        self._event = None

    def _read_axes(self):
        with self._lock:
            for _ in range(2):
                fd = self._ensure_fd()
                if fd is None:
                    return None
                try:
                    return stickcal.read_axes(fd)
                except OSError:
                    # device re-registered (module reload): reopen once
                    self._close_fd()
            return None

    def _base_params(self):
        """What the device should run when nothing is being previewed: the
        stored calibration, over the live values from before any preview."""
        live = self._baseline if self._previewing and self._baseline else stickcal.read_live()
        return stickcal.merge(live, stickcal.read_stored())

    def _begin_preview(self):
        if not self._previewing:
            self._baseline = stickcal.read_live()
            self._previewing = True

    def _end_test(self):
        if self._test_until:
            self._test_until = 0.0
            stickcal.set_intercept(False)

    def _state(self):
        store = _load_store()
        stored = stickcal.read_stored()
        presets = _all_presets(store)
        active = store.get("active")
        active_preset = next((p for p in presets if p["id"] == active), None)
        matches = bool(active_preset and stored and all(
            stored.get(k) == v for k, v in active_preset["params"].items()))
        return {
            "armada": os.access("/usr/libexec/armada/apply-input-calibration", os.X_OK),
            "moduleLoaded": stickcal.module_loaded(),
            "deviceFound": stickcal.find_event() is not None,
            "live": stickcal.read_live(),
            "stored": stored,
            "presets": presets,
            "active": active if matches else None,
            "testing": self._test_until > 0,
        }

    def _apply(self, params, active_id):
        params = stickcal.sanitize(stickcal.merge(self._base_params(), params))
        with self._lock:
            self._end_test()
            stickcal.persist(params)
            stickcal.write_live(params)
            self._previewing = False
            self._baseline = None
            store = _load_store()
            store["active"] = active_id
            _save_store(store)
            stickcal.restart_inputplumber()
        return self._state()

    # ---- Decky lifecycle ----

    async def _main(self):
        while True:
            await asyncio.sleep(0.5)
            now = time.monotonic()
            if self._test_until and (now > self._test_until or now - self._heartbeat > HEARTBEAT_TIMEOUT):
                await asyncio.to_thread(self._end_test)

    async def _unload(self):
        await asyncio.to_thread(self._end_test)
        if self._previewing:
            try:
                await asyncio.to_thread(stickcal.write_live, self._base_params())
            except Exception as error:
                decky.logger.warning(f"preview revert failed: {error}")
        await asyncio.to_thread(self._close_fd)

    # ---- frontend API ----

    async def get_state(self):
        return await asyncio.to_thread(self._state)

    async def poll(self):
        self._heartbeat = time.monotonic()
        axes = await asyncio.to_thread(self._read_axes)
        remaining = max(0.0, self._test_until - time.monotonic()) if self._test_until else 0.0
        return {"axes": axes, "testing": self._test_until > 0, "testRemaining": round(remaining)}

    async def preview(self, params):
        def run():
            merged = stickcal.sanitize(stickcal.merge(self._base_params(), params))
            self._begin_preview()
            stickcal.write_live(merged)
        await asyncio.to_thread(run)
        return True

    async def revert(self):
        def run():
            stickcal.write_live(self._base_params())
            self._previewing = False
            self._baseline = None
        await asyncio.to_thread(run)
        return True

    async def apply_params(self, params):
        return await asyncio.to_thread(self._apply, params, None)

    async def apply_preset(self, preset_id):
        def run():
            preset = next((p for p in _all_presets(_load_store()) if p["id"] == preset_id), None)
            if preset is None:
                raise ValueError("preset inconnu")
            return self._apply(preset["params"], preset_id)
        return await asyncio.to_thread(run)

    async def save_preset(self, name, params):
        def run():
            name_ = str(name or "").strip()[:40] or "Preset perso"
            clean = stickcal.sanitize(stickcal.merge(self._base_params(), params))
            store = _load_store()
            store["presets"].append({"id": uuid.uuid4().hex[:12], "name": name_, "params": clean})
            _save_store(store)
            return self._state()
        return await asyncio.to_thread(run)

    async def delete_preset(self, preset_id):
        def run():
            store = _load_store()
            store["presets"] = [p for p in store["presets"] if p.get("id") != preset_id]
            if store.get("active") == preset_id:
                store["active"] = None
            _save_store(store)
            return self._state()
        return await asyncio.to_thread(run)

    async def start_test(self, seconds=30):
        def run():
            seconds_ = max(5, min(int(seconds), TEST_MAX_SECONDS))
            self._heartbeat = time.monotonic()
            if not stickcal.set_intercept(True):
                raise RuntimeError("InputPlumber n'a pas accepté le mode intercept")
            self._test_until = time.monotonic() + seconds_
            return True
        return await asyncio.to_thread(run)

    async def stop_test(self):
        await asyncio.to_thread(self._end_test)
        return True

    async def measure_rest(self, params):
        def run():
            with self._lock:
                fd = self._ensure_fd()
                if fd is None:
                    raise RuntimeError("manette introuvable")
                base = stickcal.sanitize(stickcal.merge(self._base_params(), params))
                self._begin_preview()
                return stickcal.measure_rest(fd, base)
        return await asyncio.to_thread(run)
